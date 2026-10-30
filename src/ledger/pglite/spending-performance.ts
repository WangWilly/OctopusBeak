import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { readFileSync } from "node:fs";
import { PGliteStore } from "./transaction.ts";
import {
  createPGlitePairingPerformanceFixture,
  PGLITE_PAIRING_PERFORMANCE_TARGET,
} from "./spending-performance-fixture.ts";
import { createPGliteSpendingQuery } from "./spending-query.ts";
import { queryCurrentSpendingSummary } from "./purchase-report.ts";
import { applyPGliteSpendingPageAction } from "./spending-command.ts";
import { applySpendingSummaryDelta, type SpendingPageActionRequest } from "../../lib/spending/model.ts";
import { rankSpendingManualPaymentCandidates } from "../canonical/spending-manual-pairing.ts";

const transactions = Number(process.env.PGLITE_BENCHMARK_TRANSACTIONS ?? 100_000);
const invoices = Number(process.env.PGLITE_BENCHMARK_INVOICES ?? 10_001);
const links = Number(process.env.PGLITE_BENCHMARK_LINKS ?? 10_000);
const electronVersion = JSON.parse(readFileSync(new URL("../../../node_modules/electron/package.json", import.meta.url), "utf8")) as { version?: string };
const macosVersion = (): string | null => {
  if (process.platform !== "darwin") return null;
  try {
    return execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
if (invoices <= links || transactions <= links) throw new Error("Benchmark fixture needs one reserved invoice/transaction plus every active link.");
async function createFixture() {
  return createPGlitePairingPerformanceFixture({
    shape: { transactions, invoices, links },
  });
}

const { database, store, setupMs } = await createFixture();
const query = createPGliteSpendingQuery(store);
const targetInvoiceId = PGLITE_PAIRING_PERFORMANCE_TARGET.invoiceId;
const targetTransactionId = PGLITE_PAIRING_PERFORMANCE_TARGET.transactionId;
const coldRankStart = performance.now();
const coldRanked = await query.pairingCandidates({ invoiceIdentityId: targetInvoiceId, dataVersion: 2, limit: 50 });
const coldRankMs = performance.now() - coldRankStart;
const coldStart = performance.now();
const before = await query.current();
const coldOpenMs = performance.now() - coldStart;
const candidate = before.purchaseReport.candidates.find((value) => value.invoiceId === targetInvoiceId && value.transactionId === targetTransactionId);
if (!candidate) throw new Error(`target candidate missing; saw ${before.purchaseReport.candidates.length}`);
const countRows = (await store.query<{ transactions: number | string; invoices: number | string; activeLinks: number | string; eligibleTransactions: number | string; dateFacts: number | string; projectedEligible: number | string }>(`
  SELECT
    (SELECT COUNT(*) FROM current_transactions) AS transactions,
    (SELECT COUNT(*) FROM einvoice_invoices) AS invoices,
    (SELECT COUNT(*) FROM current_spending_dedup_links) AS "activeLinks",
    (SELECT COUNT(*) FROM canonical_credit_card_transaction_details) AS "dateFacts",
    (SELECT COUNT(*) FROM current_spending_pairing_entries) AS "projectedEligible",
    (SELECT COUNT(*)
       FROM current_transactions current_row
       JOIN financial_transactions transaction_row ON transaction_row.transaction_id = current_row.transaction_id
       JOIN financial_accounts account ON account.account_id = transaction_row.account_id
       JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
       JOIN current_transaction_enrichment kind ON kind.transaction_id = current_row.transaction_id AND kind.field_name = 'kind'
      WHERE revision.administrative_state = 'active'
        AND revision.economic_status = 'normal'
        AND revision.posting_status = 'posted'
        AND revision.direction = 'outflow'
        AND kind.taxonomy_code IS NOT NULL
        AND kind.taxonomy_code NOT IN ('transfer', 'cash', 'investment', 'payment.credit_card', 'payment.loan')
        AND kind.taxonomy_code NOT LIKE 'transfer.%'
        AND kind.taxonomy_code NOT LIKE 'cash.%'
        AND kind.taxonomy_code NOT LIKE 'investment.%'
        AND kind.taxonomy_code NOT LIKE 'payment.credit_card.%'
        AND kind.taxonomy_code NOT LIKE 'payment.loan.%'
        AND NOT EXISTS (SELECT 1 FROM current_spending_dedup_links active_link WHERE active_link.transaction_id = current_row.transaction_id)
    ) AS "eligibleTransactions"
`)).rows[0]!;
const coldFixture = await createFixture();
const coldFixtureQuery = createPGliteSpendingQuery(coldFixture.store);
const coldFixtureReport = await coldFixtureQuery.current();
const coldCandidate = coldFixtureReport.purchaseReport.candidates.find((value) => value.invoiceId === targetInvoiceId && value.transactionId === targetTransactionId);
if (!coldCandidate) throw new Error("cold confirm target candidate missing");
const coldWriter = new PGliteStore(coldFixture.database);
const candidateAction = (knowledgeAt: number, targetCandidateId: string): SpendingPageActionRequest => ({
  action: "confirm",
  kind: "candidate",
  candidateId: targetCandidateId,
  invoiceIdentityId: targetInvoiceId,
  transactionIdentityId: targetTransactionId,
  dataVersion: knowledgeAt,
});
/** Time one page action, then require its summary delta to reproduce the recomputed summary. */
async function timedPageAction(writer: PGliteStore, request: SpendingPageActionRequest, label: string) {
  const summaryBefore = await queryCurrentSpendingSummary(writer);
  const startedAt = performance.now();
  const result = await applyPGliteSpendingPageAction(writer, request);
  const elapsedMs = performance.now() - startedAt;
  const summaryAfter = await queryCurrentSpendingSummary(writer);
  const patched = applySpendingSummaryDelta(summaryBefore.purchaseReport, result.baseKnowledgeAt, result.knowledgeAt, result.summaryDelta);
  if (patched.recordCount !== summaryAfter.purchaseReport.recordCount
      || JSON.stringify(patched.totalsByCurrency) !== JSON.stringify(summaryAfter.purchaseReport.totalsByCurrency))
    throw new Error(`${label} summary delta does not reproduce the committed summary`);
  if (!result.affectedRecords.some((record) => record.basis === "linked")) throw new Error(`${label} did not return its linked record`);
  return { result, elapsedMs };
}
const coldConfirmed = await timedPageAction(coldWriter, candidateAction(coldFixtureReport.purchaseReport.knowledgeAt, coldCandidate.candidateId), "cold candidate");
const coldConfirmMs = coldConfirmed.elapsedMs;
await coldWriter.close();
const rankStart = performance.now();
const ranked = await query.pairingCandidates({ invoiceIdentityId: targetInvoiceId, dataVersion: before.purchaseReport.knowledgeAt, limit: 50 });
const rankMs = performance.now() - rankStart;
const coldOrder = coldRanked.candidates.map((value) => value.transactionId).join(",");
const cachedOrder = ranked.candidates.map((value) => value.transactionId).join(",");
if (coldOrder !== cachedOrder) throw new Error("cold pairing order differs from cached pairing order");
const pagingStart = performance.now();
const pagedIds: string[] = [];
for (let offset = 0; offset < ranked.totalCandidateCount; offset += 100) {
  const page = await query.pairingCandidates({ invoiceIdentityId: targetInvoiceId, dataVersion: before.purchaseReport.knowledgeAt, offset, limit: 100 });
  if (page.candidates.length === 0) throw new Error(`pairing page ${offset} was unexpectedly empty`);
  pagedIds.push(...page.candidates.map((value) => value.transactionId));
}
const pagingMs = performance.now() - pagingStart;
if (pagedIds.length !== ranked.totalCandidateCount) throw new Error(`pairing paging count mismatch: ${pagedIds.length}/${ranked.totalCandidateCount}`);
if (new Set(pagedIds).size !== pagedIds.length) throw new Error("pairing paging returned duplicate transaction identities");
if (pagedIds.slice(0, ranked.candidates.length).join(",") !== cachedOrder) throw new Error("pairing paging prefix differs from cached ordering");
const targetInvoice = before.invoices.find((value) => value.invoiceId === targetInvoiceId);
if (!targetInvoice) throw new Error("target invoice missing from report");
const linkedTransactionIds = new Set(before.purchaseReport.records.filter((record) => record.basis === "linked" && record.transaction).map((record) => record.transaction!.transactionId));
const independentOrder = rankSpendingManualPaymentCandidates({
  revision: {
    seller: { name: targetInvoice.revision.seller.name },
    occurrence: { value: targetInvoice.revision.occurrence.value },
    total: targetInvoice.revision.total,
  },
}, before.spending.includedTransactions.filter((value) => !linkedTransactionIds.has(value.transactionId)))
  .map((value) => value.transactionId);
if (independentOrder.length !== pagedIds.length || independentOrder.some((id, index) => id !== pagedIds[index]))
  throw new Error("all pairing pages differ from the independent canonical rank order");
const confirmed = await timedPageAction(store, candidateAction(before.purchaseReport.knowledgeAt, candidate.candidateId), "warm candidate");
const warmConfirmMs = confirmed.elapsedMs;
const directFixture = await createFixture();
const directBefore = await createPGliteSpendingQuery(directFixture.store).current();
const directColdWriter = new PGliteStore(directFixture.database);
const directConfirmed = await timedPageAction(directColdWriter, {
  action: "confirm",
  kind: "direct",
  invoiceIdentityId: targetInvoiceId,
  transactionIdentityId: targetTransactionId,
  dataVersion: directBefore.purchaseReport.knowledgeAt,
}, "cold direct");
const coldDirectConfirmMs = directConfirmed.elapsedMs;
const totalStart = performance.now();
const after = await query.current();
if (after.purchaseReport.knowledgeAt !== confirmed.result.knowledgeAt)
  throw new Error("warm candidate action version differs from the committed report");
const verifyMs = performance.now() - totalStart;
const actualCounts = {
  transactions: Number(countRows.transactions),
  invoices: Number(countRows.invoices),
  activeLinks: Number(countRows.activeLinks),
  dateFacts: Number(countRows.dateFacts),
  projectedEligible: Number(countRows.projectedEligible),
  eligibleTransactions: Number(countRows.eligibleTransactions),
  unlinkedEligibleTransactions: Number(coldRanked.totalCandidateCount),
};
if (actualCounts.unlinkedEligibleTransactions !== actualCounts.eligibleTransactions)
  throw new Error(`candidate completeness mismatch: ${JSON.stringify(actualCounts)}`);
if (actualCounts.activeLinks !== links) throw new Error(`active link count mismatch: ${actualCounts.activeLinks}/${links}`);
if (actualCounts.dateFacts !== transactions) throw new Error(`date fact count mismatch: ${actualCounts.dateFacts}/${transactions}`);
if (actualCounts.projectedEligible !== actualCounts.eligibleTransactions) throw new Error(`projection completeness mismatch: ${JSON.stringify(actualCounts)}`);
if (!coldRanked.candidates.some((value) => value.transactionId === targetTransactionId))
  throw new Error("cold pairing page omitted the reserved target transaction");
const timingGates = {
  coldRankMs: coldRankMs <= 1_000,
  coldConfirmMs: coldConfirmMs <= 1_000,
  cachedRankMs: rankMs <= 1_000,
  warmConfirmMs: warmConfirmMs <= 1_000,
  coldDirectConfirmMs: coldDirectConfirmMs <= 1_000,
};
const adr0028Pass = Object.values(timingGates).every(Boolean);
console.log(JSON.stringify({
  metadata: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    machine: os.cpus()[0]?.model ?? "unknown",
    cpuCount: os.cpus().length,
    memoryBytes: os.totalmem(),
    macos: macosVersion(),
    kernel: os.release(),
    electron: process.versions.electron ?? electronVersion.version ?? null,
    benchmark: "pglite-spending-performance",
    requested: { transactions, invoices, links },
    fixture: { linkRange: "1..links", reservedTarget: "invoice/transaction 0", targetRemainsUnlinked: true, coldSemantics: "fresh command store on the same warm PGlite WASM database; times the renderer's pageAction" },
  },
  setupMs,
  coldFixtureSetupMs: coldFixture.setupMs,
  coldRankMs,
  coldConfirmMs,
  coldConfirmAffectedRecords: coldConfirmed.result.affectedRecords.length,
  coldRankedCount: coldRanked.totalCandidateCount,
  coldOpenMs,
  rankMs,
  pagingMs,
  pagingPages: Math.ceil(ranked.totalCandidateCount / 100),
  warmConfirmMs,
  coldDirectConfirmMs,
  verifyMs,
  beforeKnowledge: before.purchaseReport.knowledgeAt,
  afterKnowledge: after.purchaseReport.knowledgeAt,
  candidateCount: before.purchaseReport.candidates.length,
  rankedCount: ranked.totalCandidateCount,
  affectedRecords: confirmed.result.affectedRecords.length,
  actualCounts,
  timingGates,
  adr0028Pass,
}, null, 2));
await store.close();
await directColdWriter.close();
if (!adr0028Pass) process.exitCode = 1;
