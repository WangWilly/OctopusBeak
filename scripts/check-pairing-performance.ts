import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cpus, platform, release, totalmem, version as osVersion } from "node:os";
import { Worker } from "node:worker_threads";

const TRANSACTION_COUNT = 100_000;
const INVOICE_COUNT = 10_000;
const EXISTING_LINK_COUNT = 10_000;
const SLA_MS = 1_000;
const electronPackage = JSON.parse(readFileSync(new URL("../node_modules/electron/package.json", import.meta.url), "utf8")) as { version?: string };

type PairingBenchmarkResult = Readonly<{
  coldIndexMs: number;
  coldRankMs: number;
  warmRankMs: number;
  targetedPatchMs: number;
  transactionCount: number;
  invoiceCount: number;
  existingLinkCount: number;
}>;

function runWorker(): Promise<PairingBenchmarkResult> {
  const matchingUrl = new URL("../src/lib/spending/purchase-matching.ts", import.meta.url).href;
  const patchUrl = new URL("../src/lib/spending/purchase-report-patch.ts", import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    (async () => {
      const { createSpendingManualPairingIndex, rankSpendingManualPaymentCandidates } = await import(${JSON.stringify(matchingUrl)});
      const { createSpendingPurchaseReportPatch } = await import(${JSON.stringify(patchUrl)});
      const transactionCount = ${TRANSACTION_COUNT};
      const invoiceCount = ${INVOICE_COUNT};
      const existingLinkCount = ${EXISTING_LINK_COUNT};
      const transactions = Array.from({ length: transactionCount }, (_, index) => ({
        transactionId: "tx-" + String(index).padStart(6, "0"),
        effectiveOn: "2026-" + String((index % 12) + 1).padStart(2, "0") + "-" + String((index % 28) + 1).padStart(2, "0"),
        consumeDate: null,
        postingDate: null,
        description: index % 3 === 0 ? "Synthetic Shop" : "Synthetic Merchant " + (index % 2_000),
        amount: { coefficient: String(500 + (index % 15_000)), scale: 0, currency: index % 11 === 0 ? "USD" : "TWD" },
      }));
      const invoices = Array.from({ length: invoiceCount }, (_, index) => ({
        revision: {
          seller: { name: index % 3 === 0 ? "Synthetic Shop" : "Synthetic Merchant " + (index % 2_000) },
          occurrence: { value: "2026-" + String((index % 12) + 1).padStart(2, "0") + "-" + String((index % 28) + 1).padStart(2, "0") },
          total: { coefficient: String(500 + (index % 15_000)), scale: 0, currency: index % 11 === 0 ? "USD" : "TWD" },
        },
      }));
      const linkedTransactionIds = new Set(transactions.slice(0, existingLinkCount).map((value) => value.transactionId));
      const eligibleTransactions = transactions.filter((value) => !linkedTransactionIds.has(value.transactionId));
      const invoice = invoices[0];
      const coldStartedAt = performance.now();
      const index = createSpendingManualPairingIndex(17, eligibleTransactions);
      const coldIndexMs = performance.now() - coldStartedAt;
      const coldRankStartedAt = performance.now();
      rankSpendingManualPaymentCandidates(invoice, index);
      const coldRankMs = performance.now() - coldRankStartedAt;
      const warmRankStartedAt = performance.now();
      rankSpendingManualPaymentCandidates(invoice, index);
      const warmRankMs = performance.now() - warmRankStartedAt;

      const record = (purchaseId) => ({
        purchaseId,
        basis: "bank-transaction",
        amount: { coefficient: "1", scale: 0, currency: "TWD" },
        occurrence: { value: "2026-01-01", precision: "date", timeZone: "Asia/Taipei", basis: "purchase-date" },
        description: purchaseId,
        invoice: null,
        transaction: null,
        items: [],
        possibleDuplicate: false,
        candidateIds: [],
        link: null,
        difference: null,
        refund: null,
      });
      const beforeRecords = Array.from({ length: transactionCount }, (_, index) => record("record-" + index));
      const afterRecords = beforeRecords.filter((_, index) => index !== 40_000 && index !== 40_001);
      afterRecords.splice(40_000, 0, { ...record("link:synthetic"), basis: "linked" });
      const before = {
        status: "ok", kind: "current", knowledgeAt: 17, financialAt: null,
        records: beforeRecords,
        totalsByCurrency: [{ currency: "TWD", coefficient: String(transactionCount), scale: 0, count: transactionCount }],
        totalStatus: "complete", candidates: [],
      };
      const after = { ...before, knowledgeAt: 18, records: afterRecords };
      const targetedPatchStartedAt = performance.now();
      createSpendingPurchaseReportPatch(before, after);
      const targetedPatchMs = performance.now() - targetedPatchStartedAt;
      parentPort.postMessage({ coldIndexMs, coldRankMs, warmRankMs, targetedPatchMs, transactionCount, invoiceCount, existingLinkCount });
    })().catch((error) => parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }));
  `, { eval: true });
  return new Promise((resolve, reject) => {
    worker.once("message", (value: PairingBenchmarkResult | { error: string }) => {
      void worker.terminate();
      if ("error" in value) reject(new Error(value.error));
      else resolve(value);
    });
    worker.once("error", reject);
  });
}

const startedAt = performance.now();
let expectedTick = performance.now() + 10;
let maxMainThreadTimerDelayMs = 0;
const timer = setInterval(() => {
  const now = performance.now();
  maxMainThreadTimerDelayMs = Math.max(maxMainThreadTimerDelayMs, now - expectedTick);
  expectedTick = now + 10;
}, 10);
try {
  const result = await runWorker();
  clearInterval(timer);
  const totalMs = performance.now() - startedAt;
  const metadata = {
    machine: `${process.arch}/${platform()}`,
    cpuModel: cpus()[0]?.model ?? "unknown",
    memoryBytes: totalmem(),
    os: `${release()} (${osVersion()})`,
    node: process.version,
    electron: process.versions.electron ?? electronPackage.version ?? "unknown",
  };
  console.log(JSON.stringify({ ...metadata, ...result, totalMs, maxMainThreadTimerDelayMs }, null, 2));
  assert.ok(result.coldIndexMs + result.coldRankMs <= SLA_MS, `cold pairing exceeded ${SLA_MS}ms`);
  assert.ok(result.warmRankMs <= SLA_MS, `warm pairing exceeded ${SLA_MS}ms`);
  assert.ok(result.targetedPatchMs <= SLA_MS, `targeted confirm patch exceeded ${SLA_MS}ms`);
  assert.ok(totalMs < 5 * 60_000, "pairing performance suite exceeded five minutes");
  assert.ok(maxMainThreadTimerDelayMs < 200, "main-thread timer response exceeded 200ms");
} finally {
  clearInterval(timer);
}
