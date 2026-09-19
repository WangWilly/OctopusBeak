import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { cpus, platform, release, totalmem, version as osVersion } from "node:os";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { chromium } from "playwright";
import { createFinancialPageWorkerClient } from "../electron/financial-page-worker-client.ts";
import { createPairingBenchmarkFixture } from "./check-pairing-performance.ts";
import { record, singleCategory, view } from "./spending-canonical-fixture.mjs";
import {
  createSpendingViteServer,
  spendingDesktopApiInitScript,
} from "./spending-browser-harness.mjs";

const SLA_MS = 1_000;
const EXPECTED_FIXTURE_SHAPE = {
  transactions: 100_000,
  invoices: 10_000,
  links: 10_000,
};
const RENDERER_FIXTURE_SHAPE = {
  records: 100_000,
  invoiceIdentities: 10_000,
  linkedRecords: 9_999,
  bankTransactionRecords: 90_000,
};
const FEEDBACK_MS = 200;
const electronPackage = JSON.parse(
  readFileSync(new URL("../node_modules/electron/package.json", import.meta.url), "utf8"),
);

function money(coefficient, currency = "TWD") {
  return { coefficient: String(coefficient), scale: 0, currency };
}

function sumMoney(left, right) {
  assert.equal(left.currency, right.currency);
  return money(Number(left.coefficient) + Number(right.coefficient), left.currency);
}

function transactionRecord(candidate) {
  return {
    purchaseId: candidate.purchaseId,
    basis: "bank-transaction",
    amount: candidate.amount,
    occurrence: candidate.occurrence,
    description: candidate.description,
    invoice: null,
    transaction: {
      transactionId: candidate.transactionId,
      effectiveOn: candidate.occurrence.value,
      consumeDate: null,
      postingDate: null,
      description: candidate.description,
      amount: candidate.amount,
      stream: candidate.stream,
      effectiveDateBasis: candidate.effectiveDateBasis,
    },
    items: [],
    possibleDuplicate: false,
    candidateIds: [],
    link: null,
    difference: null,
    refund: null,
  };
}

function benchmarkDate(index) {
  const monthOffset = index % 60;
  const year = 2020 + Math.floor(monthOffset / 12);
  const month = monthOffset % 12 + 1;
  const day = index % 28 + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function syntheticCandidate(index) {
  const transactionId = `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`;
  const occurrence = benchmarkDate(index);
  return {
    purchaseId: `transaction:${transactionId}`,
    transactionId,
    amount: money(1000 + (index % 17)),
    occurrence: { value: occurrence, precision: "date", timeZone: "Asia/Taipei", basis: "purchase-date" },
    description: `Benchmark payment ${index + 1}`,
    stream: "checking",
    effectiveDateBasis: null,
  };
}

function invoiceRecord(invoiceId, occurrenceValue = "2025-01-01") {
  const amount = money("1000");
  const occurrence = {
    value: occurrenceValue,
    precision: "date",
    timeZone: "Asia/Taipei",
    basis: "purchase-date",
  };
  return {
    purchaseId: `invoice:${invoiceId}`,
    basis: "invoice",
    amount,
    occurrence,
    description: "Benchmark shop 0",
    invoice: {
      invoiceId,
      revision: {
        seller: { name: "Benchmark shop 0" },
        occurrence,
        total: amount,
        items: [],
      },
    },
    transaction: null,
    items: [],
    possibleDuplicate: false,
    candidateIds: [],
    link: null,
    difference: null,
    refund: null,
  };
}

function linkedRecord(index) {
  const invoice = invoiceRecord(`benchmark-invoice-${index}`, "2024-01-01");
  const payment = transactionRecord(syntheticCandidate(100_000 + index));
  const invoiceView = invoice.invoice;
  const transactionView = payment.transaction;
  assert.ok(invoiceView && transactionView);
  const eventId = `benchmark-link-${index}`;
  return {
    purchaseId: `link:${eventId}`,
    basis: "linked",
    amount: payment.amount,
    occurrence: invoice.occurrence,
    description: invoice.description,
    invoice: invoiceView,
    transaction: transactionView,
    items: [],
    possibleDuplicate: false,
    candidateIds: [],
    link: {
      invoiceId: invoiceView.invoiceId,
      transactionId: transactionView.transactionId,
      eventId,
      origin: "user",
      evidenceKnowledgeSequence: 1,
      evidence: { fixture: "pairing-ui-renderer-scale" },
    },
    difference: {
      invoiceAmount: invoice.amount,
      bankAmount: payment.amount,
      sameCurrency: true,
      exactAmountEqual: true,
    },
    refund: null,
  };
}

export function makeRendererModel(invoiceId, candidate) {
  const invoice = invoiceRecord(invoiceId);
  const payment = transactionRecord(candidate);
  const records = [
    ...Array.from({ length: 9_999 }, (_, index) => linkedRecord(index)),
    invoice,
    payment,
    ...Array.from({ length: 89_999 }, (_, index) => transactionRecord(syntheticCandidate(index))),
  ];
  assert.equal(records.length, 100_000);
  const totalCoefficient = records.reduce(
    (total, record) => total + BigInt(record.amount?.coefficient ?? "0"),
    0n,
  ).toString();
  return {
    canonical: view([
      record({
        id: "fixture-canonical-payment",
        date: candidate.occurrence.value,
        value: Number(candidate.amount.coefficient),
        category: singleCategory("dining"),
        label: candidate.description,
      }),
    ], { selectedMonth: candidate.occurrence.value.slice(0, 7) }),
    purchaseReport: {
      status: "ok",
      kind: "current",
      knowledgeAt: null,
      financialAt: null,
      records,
      totalsByCurrency: [{ ...money(totalCoefficient), count: records.length }],
      totalStatus: "complete",
      candidates: [],
    },
    invoices: [],
  };
}

async function startWorker() {
  const worker = new Worker(new URL("../electron/financial-page-worker.ts", import.meta.url), { type: "module" });
  await new Promise((resolve, reject) => {
    worker.once("message", (message) => message.id === 0 ? resolve() : reject(new Error("Financial worker readiness handshake failed.")));
    worker.once("error", reject);
  });
  return { worker, client: createFinancialPageWorkerClient(worker) };
}

async function runSingle(runNumber) {
  const overallStartedAt = performance.now();
  const fixture = await createPairingBenchmarkFixture();
  let preflight;
  let actual;
  let server;
  let browser;
  try {
    process.env.LEDGER_DIR = fixture.directory;

    preflight = await startWorker();
    const ranked = await preflight.client.rankPairingCandidates({
      invoiceIdentityId: fixture.targetInvoiceId,
      dataVersion: fixture.dataVersion,
      limit: 50,
    });
    const selectedCandidate = ranked.candidates[0];
    assert.ok(selectedCandidate, "100k fixture must expose at least one eligible payment candidate");
    assert.equal(ranked.totalCandidateCount, 100_000 - 9_999);
    await preflight.client.close();
    preflight = null;

    const model = makeRendererModel(fixture.targetInvoiceId, selectedCandidate);
    const rendererInvoiceIds = new Set(model.purchaseReport.records.flatMap((record) =>
      record.invoice ? [record.invoice.invoiceId] : []));
    assert.equal(model.purchaseReport.records.length, RENDERER_FIXTURE_SHAPE.records);
    assert.equal(model.purchaseReport.records.filter((record) => record.basis === "linked").length, RENDERER_FIXTURE_SHAPE.linkedRecords);
    assert.equal(model.purchaseReport.records.filter((record) => record.basis === "bank-transaction").length, RENDERER_FIXTURE_SHAPE.bankTransactionRecords);
    assert.equal(rendererInvoiceIds.size, RENDERER_FIXTURE_SHAPE.invoiceIdentities);
    model.purchaseReport.knowledgeAt = fixture.dataVersion;
    server = await createSpendingViteServer();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === "object");
    browser = await chromium.launch({ headless: true });
    actual = await startWorker();

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    const bridgeTimings = [];
    const prewarmVersions = [];
    let rankBridgeCallCount = 0;
    let confirmBridgeCallCount = 0;
    let prewarmBridgeCallCount = 0;
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.exposeFunction("__pairingRankThroughWorker", async (input) => {
      rankBridgeCallCount += 1;
      const startedAt = performance.now();
      try {
        return await actual.client.rankPairingCandidates(input);
      } finally {
        const elapsedMs = performance.now() - startedAt;
        bridgeTimings.push({ kind: "rank", elapsedMs });
        if (process.env.PAIRING_UI_PROGRESS === "1") console.error(`[pairing-ui] rank bridge: ${elapsedMs.toFixed(1)}ms`);
      }
    });
    await page.exposeFunction("__pairingConfirmThroughWorker", async (input) => {
      confirmBridgeCallCount += 1;
      const startedAt = performance.now();
      try {
        return await actual.client.confirmCandidate({
          ...input,
          pairingReportContext: {
            recordInsertIndex: 0,
            candidateIds: [],
            totalStatusAfter: "complete",
          },
        });
      } finally {
        const elapsedMs = performance.now() - startedAt;
        bridgeTimings.push({ kind: "confirm", elapsedMs });
        if (process.env.PAIRING_UI_PROGRESS === "1") console.error(`[pairing-ui] confirm bridge: ${elapsedMs.toFixed(1)}ms`);
      }
    });
    await page.exposeFunction("__pairingPrewarmThroughWorker", async (input) => {
      prewarmBridgeCallCount += 1;
      const startedAt = performance.now();
      try {
        const result = await actual.client.prewarmPairingCandidates(input);
        prewarmVersions.push(result.dataVersion);
        return result;
      } finally {
        const elapsedMs = performance.now() - startedAt;
        bridgeTimings.push({ kind: "prewarm", elapsedMs });
        if (process.env.PAIRING_UI_PROGRESS === "1") console.error(`[pairing-ui] prewarm bridge: ${elapsedMs.toFixed(1)}ms`);
      }
    });
    // The harness supplies shell data APIs; these Pairing methods are replaced
    // below before navigation, so Pairing never uses no-op action defaults.
    await page.addInitScript({ content: spendingDesktopApiInitScript(model) });
    await page.addInitScript(() => {
      window.__pairingPerformance = {
        longTasks: [],
        rafGaps: [],
        windows: {},
        longTaskObserverAvailable: "PerformanceObserver" in window,
      };
      window.__pairingPrewarmVersions = [];
      window.__pairingPrewarmStarted = false;
      let previousRafAt = performance.now();
      const observeRaf = (now) => {
        window.__pairingPerformance.rafGaps.push({
          end: now,
          gap: now - previousRafAt,
          start: previousRafAt,
        });
        previousRafAt = now;
        requestAnimationFrame(observeRaf);
      };
      requestAnimationFrame(observeRaf);
      if ("PerformanceObserver" in window) {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__pairingPerformance.longTasks.push({ start: entry.startTime, duration: entry.duration });
          }
        }).observe({ type: "longtask", buffered: true });
      }
      window.__pairingStartInteraction = (kind) => {
        const start = performance.now();
        window.__pairingPerformance.windows[kind] = { start, end: null };
        performance.mark(`pairing-${kind}-start`);
        return start;
      };
      window.__pairingFinishInteraction = (kind) => {
        const end = performance.now();
        const windowValue = window.__pairingPerformance.windows[kind];
        if (!windowValue) throw new Error(`Pairing interaction ${kind} was not started.`);
        windowValue.end = end;
        performance.mark(`pairing-${kind}-end`);
        performance.measure(`pairing-${kind}`, {
          start: `pairing-${kind}-start`,
          end: `pairing-${kind}-end`,
        });
        return performance.getEntriesByName(`pairing-${kind}`).at(-1).duration;
      };
      window.octopusBeak.spending.rankPairingCandidates = (input) => window.__pairingRankThroughWorker(input);
      window.octopusBeak.spending.confirmCandidate = (input) => window.__pairingConfirmThroughWorker(input);
      window.octopusBeak.spending.prewarmPairingCandidates = async (input) => {
        window.__pairingPrewarmStarted = true;
        const result = await window.__pairingPrewarmThroughWorker(input);
        window.__pairingPrewarmVersions.push(result.dataVersion);
        window.__pairingPrewarmDone = true;
        return result;
      };
    });
    await page.addInitScript(() => {
      localStorage.setItem("octopusbeak-locale", "en");
    });
    await page.goto(`http://127.0.0.1:${address.port}/#/spending`);
    await page.locator("[data-purchase-report]").waitFor({ timeout: 30_000 });
    const initialRenderedRecordCount = await page.locator("[data-purchase-record]").count();
    await page.waitForFunction(() => window.__pairingPrewarmStarted === true, undefined, { timeout: 30_000 });
    const prewarmDoneAtClick = await page.evaluate(() => window.__pairingPrewarmDone === true);
    assert.equal(prewarmDoneAtClick, false, "cold Pairing must start while prewarm is still pending");
    const prewarmStartedAt = performance.now();

    await page.evaluate(() => {
      window.__pairingStartInteraction("open-feedback");
      window.__pairingStartInteraction("open-complete");
    });
    await page.locator("[data-open-pairing]").first().click();
    await page.locator('[data-pairing-dialog][data-pairing-feedback="open-dialog"]').waitFor({ state: "visible", timeout: 30_000 });
    const openFeedbackElapsedMs = await page.evaluate(() => window.__pairingFinishInteraction("open-feedback"));
    await page.locator(`[data-pairing-dialog] input[value="${selectedCandidate.transactionId}"]`).waitFor({ timeout: 30_000 });
    const openElapsedMs = await page.evaluate(() => window.__pairingFinishInteraction("open-complete"));
    await page.locator(`[data-pairing-dialog] input[value="${selectedCandidate.transactionId}"]`).check();

    await page.evaluate(() => {
      window.__pairingStartInteraction("confirm-feedback");
      window.__pairingStartInteraction("confirm-complete");
    });
    await page.locator("[data-confirm-direct-pair]").click();
    await page.locator('[data-pairing-dialog] [data-pairing-feedback="confirm-busy"]').waitFor({ state: "visible", timeout: 30_000 });
    const confirmFeedbackElapsedMs = await page.evaluate(() => window.__pairingFinishInteraction("confirm-feedback"));
    await page.locator("[data-pairing-dialog]").waitFor({ state: "detached", timeout: 30_000 });
    await page.locator(`[data-purchase-record][data-basis="linked"][data-transaction-id="${selectedCandidate.transactionId}"]`).waitFor({ timeout: 30_000 });
    const confirmElapsedMs = await page.evaluate(() => window.__pairingFinishInteraction("confirm-complete"));
    await page.waitForFunction(
      (version) => window.__pairingPrewarmVersions.includes(version),
      fixture.dataVersion + 1,
      { timeout: 30_000 },
    );

    const publicReadStartedAt = performance.now();
    const postConfirmRank = await actual.client.rankPairingCandidates({
      invoiceIdentityId: fixture.targetInvoiceId,
      dataVersion: fixture.dataVersion + 1,
      limit: 100,
    });
    const publicReadMs = performance.now() - publicReadStartedAt;
    assert.equal(postConfirmRank.dataVersion, fixture.dataVersion + 1);
    assert.equal(postConfirmRank.candidates.some((candidate) => candidate.transactionId === selectedCandidate.transactionId), false,
      "public worker reads must exclude the transaction after the committed link");
    const verificationDb = new DatabaseSync(join(fixture.directory, "canonical.sqlite"), { readOnly: true });
    const persistedLink = verificationDb.prepare(`
      SELECT COUNT(*) AS count
      FROM current_spending_dedup_links
      WHERE invoice_id = ? AND transaction_id = ?
    `).get(
      Buffer.from(fixture.targetInvoiceId.replaceAll("-", ""), "hex"),
      Buffer.from(selectedCandidate.transactionId.replaceAll("-", ""), "hex"),
    );
    const activeLinkCount = verificationDb.prepare(
      "SELECT COUNT(*) AS count FROM current_spending_dedup_links",
    ).get();
    verificationDb.close();
    assert.equal(persistedLink.count, 1, "the canonical store must persist the selected Pairing link");
    assert.equal(activeLinkCount.count, 10_000);
    const postConfirmRenderedRecordCount = await page.locator("[data-purchase-record]").count();
    const prewarmElapsedMs = performance.now() - prewarmStartedAt;
    assert.deepEqual(errors, []);
    assert.equal(rankBridgeCallCount, 1);
    assert.equal(confirmBridgeCallCount, 1);
    assert.deepEqual([...new Set(prewarmVersions)].sort((left, right) => left - right), [
      fixture.dataVersion,
      fixture.dataVersion + 1,
    ]);
    const browserEvidence = await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const windows = Object.values(window.__pairingPerformance.windows);
      const overlaps = (entry, windowValue) =>
        entry.start < windowValue.end && entry.start + entry.duration > windowValue.start;
      const measures = Object.fromEntries(["open-feedback", "open-complete", "confirm-feedback", "confirm-complete"].map((kind) => {
        const entry = performance.getEntriesByName(`pairing-${kind}`).at(-1);
        return [kind, entry ? { start: entry.startTime, duration: entry.duration } : null];
      }));
      const longTasks = window.__pairingPerformance.longTasks.filter((entry) =>
        windows.some((windowValue) => windowValue.end !== null && overlaps(entry, windowValue)));
      const rafGaps = window.__pairingPerformance.rafGaps.filter((entry) =>
        windows.some((windowValue) => windowValue.end !== null &&
          entry.end > windowValue.start && entry.start < windowValue.end));
      return {
        measures,
        longTasks,
        longTaskObserverAvailable: window.__pairingPerformance.longTaskObserverAvailable,
        maxRafGapMs: Math.max(0, ...rafGaps.map((entry) => entry.gap)),
      };
    });

    const totalMs = performance.now() - overallStartedAt;
    const evidence = {
      runNumber,
      machine: `${process.arch}/${platform()}`,
      machineModel: cpus()[0]?.model ?? "unknown",
      memoryBytes: totalmem(),
      macOSVersion: osVersion(),
      macOSRelease: release(),
      node: process.version,
      electron: process.versions.electron ?? electronPackage.version ?? "unknown",
      transactionCount: EXPECTED_FIXTURE_SHAPE.transactions,
      invoiceCount: EXPECTED_FIXTURE_SHAPE.invoices,
      existingLinkCountBefore: EXPECTED_FIXTURE_SHAPE.links - 1,
      existingLinkCountAfter: EXPECTED_FIXTURE_SHAPE.links,
      rendererModelRecordCount: model.purchaseReport.records.length,
      rendererModelInvoiceIdentityCount: rendererInvoiceIds.size,
      rendererModelLinkedRecordCount: model.purchaseReport.records.filter((record) => record.basis === "linked").length,
      rendererModelBankTransactionRecordCount: model.purchaseReport.records.filter((record) => record.basis === "bank-transaction").length,
      initialRenderedRecordCount,
      postConfirmRenderedRecordCount,
      setupMs: fixture.setupMs,
      prewarmElapsedMs,
      prewarmDoneAtClick,
      openFeedbackElapsedMs,
      openElapsedMs,
      confirmFeedbackElapsedMs,
      confirmElapsedMs,
      publicReadMs,
      totalMs,
      rendererMeasures: browserEvidence.measures,
      rendererLongTaskObserverAvailable: browserEvidence.longTaskObserverAvailable,
      rendererLongTasks: browserEvidence.longTasks,
      maxRendererRafGapMs: browserEvidence.maxRafGapMs,
      bridgeTimings,
      rankBridgeCallCount,
      confirmBridgeCallCount,
      prewarmBridgeCallCount,
      transport: "Playwright Svelte UI -> exposed Node binding -> FinancialPageWorkerClient -> worker_threads -> canonical store",
      store: "temporary canonical SQLite",
    };
    console.log(JSON.stringify(evidence, null, 2));
    const timingFailures = [
      openFeedbackElapsedMs > FEEDBACK_MS ? `open feedback ${openFeedbackElapsedMs.toFixed(1)}ms > ${FEEDBACK_MS}ms` : null,
      confirmFeedbackElapsedMs > FEEDBACK_MS ? `confirm feedback ${confirmFeedbackElapsedMs.toFixed(1)}ms > ${FEEDBACK_MS}ms` : null,
      openElapsedMs > SLA_MS ? `open ${openElapsedMs.toFixed(1)}ms > ${SLA_MS}ms` : null,
      confirmElapsedMs > SLA_MS ? `confirm ${confirmElapsedMs.toFixed(1)}ms > ${SLA_MS}ms` : null,
      browserEvidence.longTasks.some((entry) => entry.duration > 200)
        ? `renderer long task ${JSON.stringify(browserEvidence.longTasks)}`
        : null,
      browserEvidence.maxRafGapMs > 200
        ? `renderer rAF gap ${browserEvidence.maxRafGapMs.toFixed(1)}ms > 200ms`
        : null,
    ].filter(Boolean);
    assert.deepEqual(timingFailures, [], `Pairing UI timing contract failed: ${timingFailures.join("; ")}`);
    assert.ok(totalMs < 5 * 60_000, "real UI Pairing suite exceeded five minutes");
    return evidence;
  } finally {
    await actual?.client.close();
    await preflight?.client.close();
    await browser?.close();
    await server?.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

async function main() {
  for (const [environmentName, expected] of [
    ["PAIRING_BENCHMARK_TRANSACTIONS", EXPECTED_FIXTURE_SHAPE.transactions],
    ["PAIRING_BENCHMARK_INVOICES", EXPECTED_FIXTURE_SHAPE.invoices],
    ["PAIRING_BENCHMARK_LINKS", EXPECTED_FIXTURE_SHAPE.links],
  ]) {
    if (process.env[environmentName] !== undefined && Number(process.env[environmentName]) !== expected)
      throw new Error(`${environmentName} must remain ${expected} for the real UI acceptance check.`);
  }
  const suiteStartedAt = performance.now();
  const evidence = [];
  for (let runNumber = 1; runNumber <= 5; runNumber += 1)
    evidence.push(await runSingle(runNumber));
  const suiteElapsedMs = performance.now() - suiteStartedAt;
  assert.ok(suiteElapsedMs < 5 * 60_000, "five fresh real UI Pairing runs exceeded five minutes");
  console.log(JSON.stringify({
    suiteRuns: evidence.length,
    suiteElapsedMs,
    openFeedbackElapsedMs: evidence.map((run) => run.openFeedbackElapsedMs),
    openElapsedMs: evidence.map((run) => run.openElapsedMs),
    confirmFeedbackElapsedMs: evidence.map((run) => run.confirmFeedbackElapsedMs),
    confirmElapsedMs: evidence.map((run) => run.confirmElapsedMs),
    maxRendererRafGapMs: evidence.map((run) => run.maxRendererRafGapMs),
    longTaskCounts: evidence.map((run) => run.rendererLongTasks.length),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
