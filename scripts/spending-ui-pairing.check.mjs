import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { cpus, platform, release, totalmem, version as osVersion } from "node:os";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
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

function invoiceRecord(invoiceId) {
  const amount = money("1000");
  const occurrence = {
    value: "2025-01-01",
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

function makeRendererModel(invoiceId, candidate) {
  const invoice = invoiceRecord(invoiceId);
  const payment = transactionRecord(candidate);
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
      records: [invoice, payment],
      totalsByCurrency: [sumMoney(invoice.amount, payment.amount)].map((amount) => ({ ...amount, count: 2 })),
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

async function main() {
  const overallStartedAt = performance.now();
  for (const [environmentName, expected] of [
    ["PAIRING_BENCHMARK_TRANSACTIONS", EXPECTED_FIXTURE_SHAPE.transactions],
    ["PAIRING_BENCHMARK_INVOICES", EXPECTED_FIXTURE_SHAPE.invoices],
    ["PAIRING_BENCHMARK_LINKS", EXPECTED_FIXTURE_SHAPE.links],
  ]) {
    if (process.env[environmentName] !== undefined && Number(process.env[environmentName]) !== expected)
      throw new Error(`${environmentName} must remain ${expected} for the real UI acceptance check.`);
  }
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
    model.purchaseReport.knowledgeAt = fixture.dataVersion;
    server = await createSpendingViteServer();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === "object");
    browser = await chromium.launch({ headless: true });
    actual = await startWorker();

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    const bridgeTimings = [];
    let rankBridgeCallCount = 0;
    let confirmBridgeCallCount = 0;
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
    // The harness supplies shell data APIs; these two methods are replaced below
    // before navigation, so Pairing never uses its no-op action defaults.
    await page.addInitScript({ content: spendingDesktopApiInitScript(model) });
    await page.addInitScript(() => {
      window.__pairingLongTasks = [];
      window.__pairingInteractionStarts = [];
      window.__pairingTimerDelay = 0;
      let expectedTick = performance.now() + 10;
      setInterval(() => {
        const now = performance.now();
        window.__pairingTimerDelay = Math.max(window.__pairingTimerDelay, now - expectedTick);
        expectedTick = now + 10;
      }, 10);
      if ("PerformanceObserver" in window) {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const activeStart = window.__pairingInteractionStarts.at(-1);
            if (activeStart !== undefined && entry.startTime >= activeStart)
              window.__pairingLongTasks.push({ start: activeStart, duration: entry.duration });
          }
        }).observe({ type: "longtask", buffered: true });
      }
      window.octopusBeak.spending.rankPairingCandidates = (input) => window.__pairingRankThroughWorker(input);
      window.octopusBeak.spending.confirmCandidate = (input) => window.__pairingConfirmThroughWorker(input);
    });
    await page.addInitScript(() => {
      localStorage.setItem("octopusbeak-locale", "en");
    });
    await page.goto(`http://127.0.0.1:${address.port}/#/spending`);
    await page.locator("[data-purchase-report]").waitFor({ timeout: 30_000 });

    const openStartedAt = await page.evaluate(() => {
      const now = performance.now();
      window.__pairingInteractionStarts.push(now);
      return now;
    });
    await page.locator("[data-open-pairing]").first().click();
    await page.locator(`[data-pairing-dialog] input[value="${selectedCandidate.transactionId}"]`).waitFor({ timeout: 30_000 });
    const openElapsedMs = await page.evaluate((startedAt) => performance.now() - startedAt, openStartedAt);
    assert.ok(openElapsedMs <= SLA_MS, `real UI Pairing opening exceeded ${SLA_MS}ms: ${openElapsedMs.toFixed(1)}ms`);
    await page.locator(`[data-pairing-dialog] input[value="${selectedCandidate.transactionId}"]`).check();

    const confirmStartedAt = await page.evaluate(() => {
      const now = performance.now();
      window.__pairingInteractionStarts.push(now);
      return now;
    });
    await page.locator("[data-confirm-direct-pair]").click();
    await page.locator("[data-pairing-dialog]").waitFor({ state: "detached", timeout: 30_000 });
    await page.locator('[data-purchase-record][data-basis="linked"]').waitFor({ timeout: 30_000 });
    const confirmElapsedMs = await page.evaluate((startedAt) => performance.now() - startedAt, confirmStartedAt);
    assert.ok(confirmElapsedMs <= SLA_MS, `real UI Pairing confirmation exceeded ${SLA_MS}ms: ${confirmElapsedMs.toFixed(1)}ms`);

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
    assert.deepEqual(errors, []);
    assert.equal(rankBridgeCallCount, 1);
    assert.equal(confirmBridgeCallCount, 1);
    const browserEvidence = await page.evaluate(() => ({
      longTasks: window.__pairingLongTasks,
      maxTimerDelayMs: window.__pairingTimerDelay,
    }));
    assert.equal(browserEvidence.longTasks.some((entry) => entry.duration > 200), false,
      `Pairing UI had a >200ms long task: ${JSON.stringify(browserEvidence.longTasks)}`);
    assert.ok(browserEvidence.maxTimerDelayMs < 200,
      `Pairing UI timer response exceeded 200ms: ${browserEvidence.maxTimerDelayMs.toFixed(1)}ms`);

    const totalMs = performance.now() - overallStartedAt;
    const evidence = {
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
      setupMs: fixture.setupMs,
      openElapsedMs,
      confirmElapsedMs,
      publicReadMs,
      totalMs,
      maxTimerDelayMs: browserEvidence.maxTimerDelayMs,
      longTasks: browserEvidence.longTasks,
      bridgeTimings,
      rankBridgeCallCount,
      confirmBridgeCallCount,
      transport: "Playwright Svelte UI -> exposed Node binding -> FinancialPageWorkerClient -> worker_threads -> canonical store",
      store: "temporary canonical SQLite",
    };
    console.log(JSON.stringify(evidence, null, 2));
    assert.ok(totalMs < 5 * 60_000, "real UI Pairing suite exceeded five minutes");
  } finally {
    await actual?.client.close();
    await preflight?.client.close();
    await browser?.close();
    await server?.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

await main();
