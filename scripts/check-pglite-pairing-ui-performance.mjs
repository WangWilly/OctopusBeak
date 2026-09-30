import assert from "node:assert/strict";
import { cpus, platform, release, totalmem, version as osVersion } from "node:os";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { chromium } from "playwright";
import { PGlite } from "@electric-sql/pglite";
import { createPGliteViewWorkerClient } from "../electron/pglite-view-worker-client.ts";
import { createPGliteFinancialPageClient } from "../electron/pglite-financial-registry.ts";
import { PGliteStore } from "../src/ledger/pglite/transaction.ts";
import { createPGlitePairingPerformanceFixture } from "../src/ledger/pglite/spending-performance-fixture.ts";
import { spendingPairingReportContext } from "../src/lib/spending/model.ts";
import { record, singleCategory, view } from "./spending-canonical-fixture.mjs";
import {
  createSpendingViteServer,
  spendingDesktopApiInitScript,
} from "./spending-browser-harness.mjs";

const SLA_MS = 1_000;
const EXPECTED_FIXTURE_SHAPE = {
  transactions: 100_000,
  invoices: 10_001,
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

function progress(stage) {
  if (process.env.PGLITE_PAIRING_UI_PROGRESS === "1") console.error(`[pglite-pairing-ui] ${stage}`);
}

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
  const invoice = invoiceRecord(invoiceId, candidate.occurrence.value);
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

async function startWorker(dataDir) {
  progress(`starting worker for ${dataDir}`);
  const worker = new Worker(new URL("../electron/pglite-view-worker.ts", import.meta.url), {
    type: "module",
    workerData: { dataDir },
  });
  const client = createPGliteViewWorkerClient(worker);
  const startupAt = performance.now();
  let dataVersion;
  try {
    dataVersion = await client.financial.registry.spendingVersion();
  } catch (error) {
    progress(`worker startup/version request failed for ${dataDir}: ${String(error)}`);
    await client.close().catch(() => undefined);
    throw error;
  }
  progress(`worker ready for ${dataDir}, dataVersion=${dataVersion}`);
  return { worker, client, dataVersion, startupMs: performance.now() - startupAt };
}

async function runSingle(runNumber) {
  const overallStartedAt = performance.now();
  const temporaryDir = await mkdtemp(join(tmpdir(), "octopus-beak-pglite-pairing-ui-"));
  const dataDir = join(temporaryDir, "seed");
  let fixture;
  let rankingDataDir;
  let coldConfirmDataDir;
  let preflight;
  let coldConfirmWorker;
  let actual;
  let server;
  let browser;
  try {
    fixture = await createPGlitePairingPerformanceFixture({ dataDir });
    progress(`seeded fixture ${JSON.stringify(fixture.counts)} in ${fixture.setupMs.toFixed(1)}ms`);
    await fixture.store.close();
    rankingDataDir = join(temporaryDir, "ranking-worker");
    coldConfirmDataDir = join(temporaryDir, "cold-confirm-worker");
    await cp(dataDir, rankingDataDir, { recursive: true });
    await cp(dataDir, coldConfirmDataDir, { recursive: true });
    progress("created independent worker database copies");
    preflight = await startWorker(rankingDataDir);
    const dataVersion = preflight.dataVersion;
    const rankInput = {
      invoiceIdentityId: fixture.targetInvoiceId,
      dataVersion,
      limit: 50,
    };
    const coldRankStartedAt = performance.now();
    const ranked = await preflight.client.financial.registry.spendingPairing(rankInput).catch((error) => {
      progress(`cold ranking RPC failed: ${String(error)}`);
      throw error;
    });
    const coldRankRpcMs = performance.now() - coldRankStartedAt;
    progress(`cold rank completed (${coldRankRpcMs.toFixed(1)}ms, ${ranked.totalCandidateCount} candidates)`);
    const warmRankStartedAt = performance.now();
    const warmRanked = await preflight.client.financial.registry.spendingPairing(rankInput).catch((error) => {
      progress(`warm ranking RPC failed: ${String(error)}`);
      throw error;
    });
    const warmRankRpcMs = performance.now() - warmRankStartedAt;
    progress(`warm rank completed (${warmRankRpcMs.toFixed(1)}ms)`);
    const selectedCandidate = ranked.candidates.find((candidate) => candidate.transactionId === fixture.targetTransactionId);
    assert.ok(selectedCandidate, "100k fixture must expose at least one eligible payment candidate");
    assert.equal(ranked.totalCandidateCount, 100_000 - 10_000);
    assert.deepEqual(
      warmRanked.candidates.map((candidate) => candidate.transactionId),
      ranked.candidates.map((candidate) => candidate.transactionId),
      "warm ranking must preserve the full ranking order",
    );
    const rendererModel = makeRendererModel(fixture.targetInvoiceId, selectedCandidate);
    const currentPage = await preflight.client.financial.registry.spendingCurrent();
    assert.equal(currentPage.purchaseReport.knowledgeAt, dataVersion);
    const model = {
      ...currentPage,
      purchaseReport: { ...currentPage.purchaseReport, records: [] },
    };
    const invoiceRecord = rendererModel.purchaseReport.records.find((record) => record.purchaseId === `invoice:${fixture.targetInvoiceId}`);
    const paymentRecord = rendererModel.purchaseReport.records.find((record) => record.basis === "bank-transaction" && record.transaction?.transactionId === fixture.targetTransactionId);
    assert.ok(invoiceRecord && paymentRecord, "renderer fixture must expose the direct-confirm target records");
    const pairingReportContext = spendingPairingReportContext(rendererModel.purchaseReport, invoiceRecord, paymentRecord);
    const directConfirmInput = {
      kind: "direct",
      invoiceIdentityId: fixture.targetInvoiceId,
      transactionIdentityId: fixture.targetTransactionId,
      dataVersion,
      totalsByCurrency: rendererModel.purchaseReport.totalsByCurrency,
      pairingReportContext,
    };
    const warmConfirmStartedAt = performance.now();
    const warmConfirmation = await preflight.client.financial.registry.confirmCandidate(directConfirmInput).catch((error) => {
      progress(`warm confirmation RPC failed: ${String(error)}`);
      throw error;
    });
    const warmConfirmRpcMs = performance.now() - warmConfirmStartedAt;
    progress(`warm confirm completed (${warmConfirmRpcMs.toFixed(1)}ms)`);
    assert.ok(warmConfirmation.patch.recordOperations.length > 0, "warm confirmation must return the targeted affected-record patch");
    await preflight.client.close();
    preflight = null;

    coldConfirmWorker = await startWorker(coldConfirmDataDir);
    const coldConfirmStartedAt = performance.now();
    const coldConfirmation = await coldConfirmWorker.client.financial.registry.confirmCandidate({
      ...directConfirmInput,
      dataVersion: coldConfirmWorker.dataVersion,
    }).catch((error) => {
      progress(`cold confirmation RPC failed: ${String(error)}`);
      throw error;
    });
    const coldConfirmRpcMs = performance.now() - coldConfirmStartedAt;
    progress(`cold confirm completed (${coldConfirmRpcMs.toFixed(1)}ms)`);
    assert.ok(coldConfirmation.patch.recordOperations.length > 0, "cold confirmation must return the targeted affected-record patch");
    await coldConfirmWorker.client.close();
    coldConfirmWorker = null;

    const rendererInvoiceIds = new Set(rendererModel.purchaseReport.records.flatMap((record) =>
      record.invoice ? [record.invoice.invoiceId] : []));
    assert.equal(rendererModel.purchaseReport.records.length, RENDERER_FIXTURE_SHAPE.records);
    assert.equal(rendererModel.purchaseReport.records.filter((record) => record.basis === "linked").length, RENDERER_FIXTURE_SHAPE.linkedRecords);
    assert.equal(rendererModel.purchaseReport.records.filter((record) => record.basis === "bank-transaction").length, RENDERER_FIXTURE_SHAPE.bankTransactionRecords);
    assert.equal(rendererInvoiceIds.size, RENDERER_FIXTURE_SHAPE.invoiceIdentities);
    server = await createSpendingViteServer();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === "object");
    browser = await chromium.launch({ headless: true });
    actual = await startWorker(dataDir);
    const actualPage = createPGliteFinancialPageClient(actual.client.financial);
    progress("started UI worker");
    const uiWorkerStartupMs = actual.startupMs;

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
        const value = await actual.client.financial.registry.spendingPairing(input);
        progress(`UI rank RPC completed (${(performance.now() - startedAt).toFixed(1)}ms)`);
        return value;
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
        const value = await actualPage.applySpendingPageAction(input);
        progress(`UI confirm RPC completed (${(performance.now() - startedAt).toFixed(1)}ms)`);
        return value;
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
        const currentVersion = await actual.client.financial.registry.spendingVersion();
        const result = currentVersion === input.dataVersion
          ? { status: "ready", dataVersion: input.dataVersion, reused: false }
          : { status: "stale", dataVersion: currentVersion, requestedVersion: input.dataVersion };
        progress(`UI prewarm RPC completed (${(performance.now() - startedAt).toFixed(1)}ms, ${result.status})`);
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
    await page.addInitScript(({ invoiceRecord, paymentRecord, targetMonth }) => {
      let affectedRecords = null;
      window.octopusBeak.spending.loadRecordPage = async (input) => ({
        schemaVersion: 1,
        knowledgeAt: input.knowledgeAt,
        month: input.month ?? null,
        day: input.day ?? null,
        records: input.month === targetMonth
          ? (affectedRecords ?? [invoiceRecord, paymentRecord])
          : [],
        nextCursor: null,
      });
      window.octopusBeak.spending.loadCandidatePage = async (input) => ({
        schemaVersion: 1,
        knowledgeAt: input.knowledgeAt,
        month: input.month,
        items: [],
        totalCandidateCount: 0,
        nextOffset: null,
      });
      window.octopusBeak.spending.cancelCandidatePage = async () => undefined;
      window.octopusBeak.spending.applyPageAction = async (input) => {
        const result = await window.__pairingConfirmThroughWorker(input);
        affectedRecords = result.affectedRecords;
        return result;
      };
      window.__pairingPerformance = {
        longTasks: [],
        rafGaps: [],
        windows: {},
        longTaskObserverAvailable: "PerformanceObserver" in window,
      };
      window.__pairingCandidateRenderedAt = null;
      window.__pairingConfirmRenderedAt = null;
      window.__pairingConfirmArmed = false;
      window.__pairingSelectedTransactionId = null;
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
      const observePairingDom = () => {
        const observer = new MutationObserver(() => {
          if (
            window.__pairingCandidateRenderedAt === null &&
            document.querySelector("[data-pairing-dialog] input[name='spending-payment']")
          ) window.__pairingCandidateRenderedAt = performance.now();
          if (document.querySelector('[data-pairing-feedback="confirm-busy"]'))
            window.__pairingConfirmArmed = true;
          if (
            window.__pairingConfirmArmed &&
            window.__pairingConfirmRenderedAt === null &&
            !document.querySelector("[data-pairing-dialog]") &&
            [...document.querySelectorAll('[data-purchase-record][data-basis="linked"]')]
              .some((element) => element.getAttribute("data-transaction-id") === window.__pairingSelectedTransactionId)
          ) window.__pairingConfirmRenderedAt = performance.now();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      };
      if (document.documentElement) observePairingDom();
      else addEventListener("DOMContentLoaded", observePairingDom, { once: true });
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
      window.__pairingFinishInteractionAt = (kind, end) => {
        if (typeof end !== "number") throw new Error(`Pairing interaction ${kind} has no in-page completion timestamp.`);
        const windowValue = window.__pairingPerformance.windows[kind];
        if (!windowValue) throw new Error(`Pairing interaction ${kind} was not started.`);
        windowValue.end = end;
        performance.mark(`pairing-${kind}-end`);
        performance.measure(`pairing-${kind}`, {
          start: `pairing-${kind}-start`,
          end,
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
    }, { invoiceRecord, paymentRecord, targetMonth: selectedCandidate.occurrence.value.slice(0, 7) });
    await page.addInitScript(() => {
      localStorage.setItem("octopusbeak-locale", "en");
    });
    await page.goto(`http://127.0.0.1:${address.port}/#/spending`);
    await page.locator("[data-purchase-report]").waitFor({ timeout: 30_000 });
    await page.locator(".month-picker select").selectOption(selectedCandidate.occurrence.value.slice(0, 7));
    await page.locator("[data-open-pairing]").first().waitFor({ timeout: 30_000 });
    const initialRenderedRecordCount = await page.locator("[data-purchase-record]").count();
    await page.waitForFunction(() => window.__pairingPrewarmStarted === true, undefined, { timeout: 30_000 });
    const prewarmDoneAtClick = await page.evaluate(() => window.__pairingPrewarmDone === true);
    const prewarmStartedAt = performance.now();

    await page.evaluate(() => {
      window.__pairingStartInteraction("open-feedback");
      window.__pairingStartInteraction("open-complete");
    });
    await page.locator("[data-open-pairing]").first().click();
    await page.locator('[data-pairing-dialog][data-pairing-feedback="open-dialog"]').waitFor({ state: "visible", timeout: 30_000 });
    const openFeedbackElapsedMs = await page.evaluate(() => window.__pairingFinishInteraction("open-feedback"));
    await page.locator(`[data-pairing-dialog] input[value="${selectedCandidate.transactionId}"]`).waitFor({ timeout: 30_000 });
    const openElapsedMs = await page.evaluate(() => window.__pairingFinishInteractionAt(
      "open-complete",
      window.__pairingCandidateRenderedAt,
    ));
    await page.locator(`[data-pairing-dialog] input[value="${selectedCandidate.transactionId}"]`).check();
    await page.evaluate((transactionId) => {
      window.__pairingSelectedTransactionId = transactionId;
    }, selectedCandidate.transactionId);

    await page.evaluate(() => {
      window.__pairingStartInteraction("confirm-feedback");
      window.__pairingStartInteraction("confirm-complete");
    });
    await page.locator("[data-confirm-direct-pair]").click();
    await page.locator('[data-pairing-dialog] [data-pairing-feedback="confirm-busy"]').waitFor({ state: "visible", timeout: 30_000 });
    const confirmFeedbackElapsedMs = await page.evaluate(() => window.__pairingFinishInteraction("confirm-feedback"));
    await page.locator("[data-pairing-dialog]").waitFor({ state: "detached", timeout: 30_000 });
    await page.locator(`[data-purchase-record][data-basis="linked"][data-transaction-id="${selectedCandidate.transactionId}"]`).waitFor({ timeout: 30_000 });
    const confirmElapsedMs = await page.evaluate(() => window.__pairingFinishInteractionAt(
      "confirm-complete",
      window.__pairingConfirmRenderedAt,
    ));
    await page.waitForFunction(
      (version) => window.__pairingPrewarmVersions.includes(version),
      dataVersion + 1,
      { timeout: 30_000 },
    );

    const publicReadStartedAt = performance.now();
    const postConfirmRank = await actual.client.financial.registry.spendingPairing({
      invoiceIdentityId: fixture.targetInvoiceId,
      dataVersion: dataVersion + 1,
      limit: 100,
    });
    const publicReadMs = performance.now() - publicReadStartedAt;
    assert.equal(postConfirmRank.dataVersion, dataVersion + 1);
    assert.equal(postConfirmRank.candidates.some((candidate) => candidate.transactionId === selectedCandidate.transactionId), false,
      "public worker reads must exclude the transaction after the committed link");
    await actual.client.close();
    actual = null;
    const verificationDb = new PGliteStore(await PGlite.create(dataDir));
    const persisted = (await verificationDb.query(`
      SELECT
        (SELECT COUNT(*) FROM current_spending_dedup_links WHERE invoice_id = $1 AND transaction_id = $2) AS "selectedLinks",
        (SELECT COUNT(*) FROM current_spending_dedup_links) AS "activeLinks",
        (SELECT COUNT(*) FROM current_transactions) AS transactions,
        (SELECT COUNT(*) FROM einvoice_invoices) AS invoices
    `, [
      Buffer.from(fixture.targetInvoiceId.replaceAll("-", ""), "hex"),
      Buffer.from(selectedCandidate.transactionId.replaceAll("-", ""), "hex"),
    ])).rows[0];
    await verificationDb.close();
    assert.equal(Number(persisted.selectedLinks), 1, "the canonical PGlite store must persist the selected Pairing link");
    assert.equal(Number(persisted.activeLinks), EXPECTED_FIXTURE_SHAPE.links + 1);
    assert.equal(Number(persisted.transactions), EXPECTED_FIXTURE_SHAPE.transactions);
    assert.equal(Number(persisted.invoices), EXPECTED_FIXTURE_SHAPE.invoices);
    const postConfirmRenderedRecordCount = await page.locator("[data-purchase-record]").count();
    const prewarmElapsedMs = performance.now() - prewarmStartedAt;
    assert.deepEqual(errors, []);
    assert.equal(rankBridgeCallCount, 1);
    assert.equal(confirmBridgeCallCount, 1);
    assert.deepEqual([...new Set(prewarmVersions)].sort((left, right) => left - right), [
      dataVersion,
      dataVersion + 1,
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
        candidateRenderedAt: window.__pairingCandidateRenderedAt,
        confirmRenderedAt: window.__pairingConfirmRenderedAt,
      };
    });

    const totalMs = performance.now() - overallStartedAt;
    const uiRankRpcMs = bridgeTimings.find((timing) => timing.kind === "rank")?.elapsedMs ?? null;
    const uiConfirmRpcMs = bridgeTimings.find((timing) => timing.kind === "confirm")?.elapsedMs ?? null;
    const hasLongRendererTask = browserEvidence.longTasks.some((entry) => entry.duration > 200);
    const timingGates = {
      openFeedbackWithin200ms: openFeedbackElapsedMs <= FEEDBACK_MS,
      confirmFeedbackWithin200ms: confirmFeedbackElapsedMs <= FEEDBACK_MS,
      coldRankWithin1s: coldRankRpcMs <= SLA_MS,
      warmRankWithin1s: warmRankRpcMs <= SLA_MS,
      coldConfirmWithin1s: coldConfirmRpcMs <= SLA_MS,
      warmConfirmWithin1s: warmConfirmRpcMs <= SLA_MS,
      uiOpenWithin1s: openElapsedMs <= SLA_MS,
      uiConfirmWithin1s: confirmElapsedMs <= SLA_MS,
      uiRankRpcWithin1s: uiRankRpcMs !== null && uiRankRpcMs <= SLA_MS,
      uiConfirmRpcWithin1s: uiConfirmRpcMs !== null && uiConfirmRpcMs <= SLA_MS,
      noRendererLongTaskOver200ms: !hasLongRendererTask,
      rendererFrameGapWithin200ms: browserEvidence.maxRafGapMs <= 200,
    };
    const adr0028Pass = Object.values(timingGates).every(Boolean);
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
      existingLinkCountBefore: fixture.counts.activeLinks,
      existingLinkCountAfter: Number(persisted.activeLinks),
      actualFixtureCounts: fixture.counts,
      comparisonFixtureRecordCount: rendererModel.purchaseReport.records.length,
      initialLivePayloadRecordCount: model.purchaseReport.records.length,
      rendererModelInvoiceIdentityCount: rendererInvoiceIds.size,
      rendererModelLinkedRecordCount: rendererModel.purchaseReport.records.filter((record) => record.basis === "linked").length,
      rendererModelBankTransactionRecordCount: rendererModel.purchaseReport.records.filter((record) => record.basis === "bank-transaction").length,
      initialRenderedRecordCount,
      postConfirmRenderedRecordCount,
      setupMs: fixture.setupMs,
      workerStartupMs: uiWorkerStartupMs,
      coldRankRpcMs,
      warmRankRpcMs,
      coldConfirmRpcMs,
      warmConfirmRpcMs,
      prewarmElapsedMs,
      prewarmDoneAtClick,
      openFeedbackElapsedMs,
      openElapsedMs,
      confirmFeedbackElapsedMs,
      confirmElapsedMs,
      uiRankRpcMs,
      uiConfirmRpcMs,
      publicReadMs,
      totalMs,
      rendererMeasures: browserEvidence.measures,
      rendererLongTaskObserverAvailable: browserEvidence.longTaskObserverAvailable,
      rendererLongTasks: browserEvidence.longTasks,
      maxRendererRafGapMs: browserEvidence.maxRafGapMs,
      rendererCandidateRenderedAt: browserEvidence.candidateRenderedAt,
      rendererConfirmRenderedAt: browserEvidence.confirmRenderedAt,
      bridgeTimings,
      rankBridgeCallCount,
      confirmBridgeCallCount,
      prewarmBridgeCallCount,
      coldConfirmationPatchOperations: coldConfirmation.patch.recordOperations.length,
      warmConfirmationPatchOperations: warmConfirmation.patch.recordOperations.length,
      timingGates,
      adr0028Pass,
      transport: "Playwright Svelte UI -> exposed Node binding -> PGliteFinancialRpcClient -> named worker_threads RPC -> PGlite store",
      store: "temporary PGlite worker database",
    };
    console.log(JSON.stringify(evidence, null, 2));
    assert.equal(adr0028Pass, true, `Pairing UI timing contract failed: ${JSON.stringify(timingGates)}`);
    assert.ok(totalMs < 5 * 60_000, "real UI Pairing suite exceeded five minutes");
    return evidence;
  } finally {
    await actual?.client.close();
    await preflight?.client.close();
    await coldConfirmWorker?.client.close();
    await browser?.close();
    await server?.close();
    await fixture?.store.close().catch(() => undefined);
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function main() {
  for (const [environmentName, expected] of [
    ["PGLITE_BENCHMARK_TRANSACTIONS", EXPECTED_FIXTURE_SHAPE.transactions],
    ["PGLITE_BENCHMARK_INVOICES", EXPECTED_FIXTURE_SHAPE.invoices],
    ["PGLITE_BENCHMARK_LINKS", EXPECTED_FIXTURE_SHAPE.links],
  ]) {
    if (process.env[environmentName] !== undefined && Number(process.env[environmentName]) !== expected)
      throw new Error(`${environmentName} must remain ${expected} for the real UI acceptance check.`);
  }
  const suiteStartedAt = performance.now();
  const evidence = [];
  const runCount = Number(process.env.PGLITE_PAIRING_UI_RUNS ?? 1);
  assert.ok(Number.isSafeInteger(runCount) && runCount > 0 && runCount <= 5, "PGLITE_PAIRING_UI_RUNS must be an integer from 1 to 5.");
  for (let runNumber = 1; runNumber <= runCount; runNumber += 1)
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
    coldRankRpcMs: evidence.map((run) => run.coldRankRpcMs),
    warmRankRpcMs: evidence.map((run) => run.warmRankRpcMs),
    coldConfirmRpcMs: evidence.map((run) => run.coldConfirmRpcMs),
    warmConfirmRpcMs: evidence.map((run) => run.warmConfirmRpcMs),
    maxRendererRafGapMs: evidence.map((run) => run.maxRendererRafGapMs),
    longTaskCounts: evidence.map((run) => run.rendererLongTasks.length),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
