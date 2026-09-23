import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteBaseline } from "./baseline.ts";
import { PGliteStore } from "./transaction.ts";
import { createPGliteSpendingQuery } from "./spending-query.ts";
import { confirmPGliteSpendingCandidate } from "./spending-command.ts";
import { applySpendingPurchaseReportPatch } from "../../lib/spending/purchase-report-patch.ts";
import { spendingPairingReportContext } from "../../lib/spending/model.ts";
import { rankSpendingManualPaymentCandidates } from "../../lib/spending/purchase-matching.ts";

const transactions = Number(process.env.PGLITE_BENCHMARK_TRANSACTIONS ?? 100_000);
// Keep one extra invoice so 10,000 active links can coexist with the reserved
// target invoice/transaction pair at identity 0.
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
const encodeId = (namespace: number, expression: string) => `decode(lpad(to_hex(${namespace}::bigint), 8, '0') || lpad(to_hex(${expression}), 24, '0'), 'hex')`;
const uuid = (namespace: number, value: number) => {
  const hex = `${namespace.toString(16).padStart(8, "0")}${value.toString(16).padStart(24, "0")}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

async function createFixture(): Promise<Readonly<{ database: PGlite; store: PGliteStore; setupMs: number }>> {
const database = await PGlite.create();
const store = new PGliteStore(database);
const started = performance.now();
await applyPgliteBaseline(database);
await store.exec(`
  INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind)
    VALUES (decode(repeat('01', 16), 'hex'), 1, 1, 'benchmark/source/v1', 'source_capture');
  INSERT INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id)
    VALUES ('benchmark/source/v1', 'benchmark', 'personal-invoices', 'v1', decode(repeat('01', 16), 'hex'));
  INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id)
    VALUES (decode(repeat('02', 16), 'hex'), 'benchmark', 'benchmark-connection', decode(repeat('01', 16), 'hex'));
  INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id)
    VALUES (decode(repeat('03', 16), 'hex'), decode(repeat('02', 16), 'hex'), 'benchmark-epoch', decode(repeat('01', 16), 'hex'));
  INSERT INTO source_subjects(source_subject_id, source_connection_id, identity_epoch_id, stream, record_kind, subject_digest, created_commit_id)
    VALUES (decode(repeat('04', 16), 'hex'), decode(repeat('02', 16), 'hex'), decode(repeat('03', 16), 'hex'), 'personal-invoices', 'personal-invoice', 'benchmark-subject', decode(repeat('01', 16), 'hex'));
  INSERT INTO source_captures(capture_id, capture_key, source_connection_id, identity_epoch_id, authority_route, stream, record_kind, source_account_key, observed_at, scope_start, scope_end, completeness, completeness_basis, completeness_rule_version, commit_id)
    VALUES (decode(repeat('05', 16), 'hex'), 'benchmark-bank', decode(repeat('02', 16), 'hex'), decode(repeat('03', 16), 'hex'), 'benchmark/source/v1', 'deposit', 'benchmark-bank', NULL, '2026-01-01', '2026-01-01', '2026-12-31', 'complete-range', 'benchmark', 'benchmark/v1', decode(repeat('01', 16), 'hex')),
           (decode(repeat('06', 16), 'hex'), 'benchmark-invoice', decode(repeat('02', 16), 'hex'), decode(repeat('03', 16), 'hex'), 'benchmark/source/v1', 'personal-invoices', 'personal-invoice', NULL, '2026-01-01', '2026-01-01', '2026-12-31', 'complete-range', 'benchmark', 'benchmark/v1', decode(repeat('01', 16), 'hex'));
  INSERT INTO financial_accounts(account_id, source_connection_id, identity_epoch_id, stream, source_account_key, account_no, account_type, currency, created_commit_id)
    VALUES (decode(repeat('07', 16), 'hex'), decode(repeat('02', 16), 'hex'), decode(repeat('03', 16), 'hex'), 'credit-card', 'benchmark-account', '****0000', 'credit', 'TWD', decode(repeat('01', 16), 'hex'));
  INSERT INTO canonical_credit_card_instruments(instrument_id, integration_namespace, account_id, instrument_key, card_mask, role, lifecycle)
    VALUES (decode(repeat('09', 16), 'hex'), 'benchmark', decode(repeat('07', 16), 'hex'), 'benchmark-card', '****0000', 'primary', 'active');
`);
const route = (await store.query<{ route_id: string; producer_id: string; producer_version: string; taxonomy_id: string; taxonomy_version: string }>("SELECT route_id, producer_id, producer_version, taxonomy_id, taxonomy_version FROM automatic_enrichment_authority_routes WHERE field_name = 'kind' ORDER BY route_id LIMIT 1")).rows[0]!;
await store.exec(`
  INSERT INTO source_records(source_record_id, capture_id, source_subject_id, commit_id, record_kind, sequence_lexeme, provider_key, content_hash, occurrence_key, collision_key, description, payload_json)
    SELECT ${encodeId(1381387776, 'g')}, decode(repeat('05', 16), 'hex'), NULL, decode(repeat('01', 16), 'hex'), 'benchmark-bank', 'tx-' || g, 'tx-' || g, 'tx-hash-' || g, 'tx-' || g, 'tx-' || g, 'Benchmark purchase ' || g, '{}'
      FROM generate_series(0, ${transactions - 1}) AS series(g);
  INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id)
    SELECT ${encodeId(1415073280, 'g')}, decode(repeat('07', 16), 'hex'), 'tx-' || g, decode(repeat('01', 16), 'hex')
      FROM generate_series(0, ${transactions - 1}) AS series(g);
  INSERT INTO transaction_revisions(revision_id, transaction_id, source_record_id, capture_id, commit_id, revision_number, amount_coefficient, amount_scale, currency, direction, posting_status, posting_origin, posting_basis, posting_rule_version, description, economic_status, administrative_state, semantic_rule_version, effective_on, transaction_date_time_local, time_zone, time_precision, time_origin, effective_time_basis, effective_time_rule_version, utc_instant_utc_us)
    SELECT ${encodeId(1381387777, 'g')}, ${encodeId(1415073280, 'g')}, ${encodeId(1381387776, 'g')}, decode(repeat('05', 16), 'hex'), decode(repeat('01', 16), 'hex'), 1, (1000 + (g % ${invoices}))::text, 0, 'TWD', 'outflow', 'posted', 'synthetic_benchmark', 'synthetic_benchmark', 'synthetic-benchmark-v1', 'Benchmark purchase ' || g, 'normal', 'active', 'synthetic-benchmark-v1', (date '2026-01-01' + (g % 365)), (date '2026-01-01' + (g % 365))::text || 'T00:00:00', 'Asia/Taipei', 'date', 'defaulted_local_midnight', 'accounting', 'synthetic-benchmark-v1', g
      FROM generate_series(0, ${transactions - 1}) AS series(g);
  INSERT INTO canonical_credit_card_transaction_details(integration_namespace, account_id, transaction_id, revision_id, source_record_id, capture_id, instrument_id, billing_status, consume_date, posting_date, effective_date_basis, statement_key)
    SELECT 'benchmark', decode(repeat('07', 16), 'hex'), ${encodeId(1415073280, 'g')}, ${encodeId(1381387777, 'g')}, ${encodeId(1381387776, 'g')}, decode(repeat('05', 16), 'hex'), decode(repeat('09', 16), 'hex'), 'billed',
           (date '2026-01-01' + (g % 365) - (g % 3))::text,
           (date '2026-01-01' + (g % 365))::text,
           'consume-date', NULL
      FROM generate_series(0, ${transactions - 1}) AS series(g);
  INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id)
    SELECT ${encodeId(1096024064, 'g')}, ${encodeId(1415073280, 'g')}, 'kind', 'transaction', 'derived', 'benchmark-pairing', 'benchmark/pairing/v1', NULL, 'purchase', decode(repeat('01', 16), 'hex')
      FROM generate_series(0, ${transactions - 1}) AS series(g);
  INSERT INTO current_transactions(transaction_id, revision_id, commit_id, projection_commit_id, revision_commit_id)
    SELECT ${encodeId(1415073280, 'g')}, ${encodeId(1381387777, 'g')}, decode(repeat('01', 16), 'hex'), decode(repeat('01', 16), 'hex'), decode(repeat('01', 16), 'hex')
      FROM generate_series(0, ${transactions - 1}) AS series(g);
  INSERT INTO current_transaction_enrichment(transaction_id, field_name, assertion_id, value_text, origin, producer_id, producer_version, route_id, taxonomy_id, taxonomy_version, taxonomy_dimension, taxonomy_code, projection_commit_id)
    SELECT ${encodeId(1415073280, 'g')}, 'kind', ${encodeId(1096024064, 'g')}, 'purchase', 'derived', '${route.producer_id}', '${route.producer_version}', '${route.route_id}', '${route.taxonomy_id}', '${route.taxonomy_version}', 'kind', 'purchase', decode(repeat('01', 16), 'hex')
      FROM generate_series(0, ${transactions - 1}) AS series(g);
  INSERT INTO source_records(source_record_id, capture_id, source_subject_id, commit_id, record_kind, sequence_lexeme, provider_key, content_hash, occurrence_key, collision_key, description, payload_json)
    SELECT ${encodeId(1229062144, 'g')}, decode(repeat('06', 16), 'hex'), decode(repeat('04', 16), 'hex'), decode(repeat('01', 16), 'hex'), 'benchmark-einvoice', 'invoice-' || g, 'invoice-' || g, 'invoice-hash-' || g, 'invoice-' || g, 'invoice-' || g, 'Benchmark shop ' || g, '{}'
      FROM generate_series(0, ${invoices - 1}) AS series(g);
  INSERT INTO einvoice_invoices(invoice_id, source_connection_id, identity_epoch_id, source_subject_id, stable_invoice_key, created_commit_id)
    SELECT ${encodeId(1229870592, 'g')}, decode(repeat('02', 16), 'hex'), decode(repeat('03', 16), 'hex'), decode(repeat('04', 16), 'hex'), 'invoice-' || g, decode(repeat('01', 16), 'hex')
      FROM generate_series(0, ${invoices - 1}) AS series(g);
  INSERT INTO einvoice_invoice_revisions(revision_id, invoice_id, source_record_id, capture_id, commit_id, source_revision_key, revision_number, revision_kind, state, invoice_number, random_number, seller_tax_id, seller_name, amount_coefficient, amount_scale, currency, currency_authority, occurrence_value, occurrence_precision, occurrence_time_zone, occurrence_origin, authority_route, contract_version, provenance_kind, provenance_reference, provenance_source_field, revocation_reason, fact_fingerprint)
    SELECT ${encodeId(1230132736, 'g')}, ${encodeId(1229870592, 'g')}, ${encodeId(1229062144, 'g')}, decode(repeat('06', 16), 'hex'), decode(repeat('01', 16), 'hex'), 'invoice-' || g || '-v1', 1, 'issued', 'active', 'BM' || lpad(g::text, 8, '0'), NULL, '12345678', 'Benchmark shop ' || g, (1000 + g)::text, 0, 'TWD', 'taiwan/e-invoice/twd/v1', (date '2026-01-01' + (g % 365)), 'date', 'Asia/Taipei', 'source-reported', 'benchmark/source/v1', 'taiwan/e-invoice/personal/v1', 'fixture', 'benchmark:invoice-' || g, NULL, NULL, 'benchmark-invoice-' || g
      FROM generate_series(0, ${invoices - 1}) AS series(g);
`);
const setupCommit = Buffer.from("08".repeat(16), "hex");
await store.exec(`
  INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind)
    VALUES (decode(repeat('08', 16), 'hex'), 2, 2, 'benchmark/setup', 'relation_resolution');
  INSERT INTO spending_dedup_decision_events(event_id, decision_key, invoice_id, transaction_id, event_kind, decision_origin, user_id, authority_route, stable_cross_source_reference, evidence_json, evidence_knowledge_sequence, commit_id)
    SELECT ${encodeId(1279874560, 'g')}, 'benchmark/setup/' || g, ${encodeId(1229870592, 'g')}, ${encodeId(1415073280, 'g')}, 'confirmed', 'user', 'benchmark', NULL, NULL, '{"fixture":"pglite-benchmark"}', 1, decode(repeat('08', 16), 'hex')
      FROM generate_series(1, ${links}) AS series(g);
  INSERT INTO current_spending_dedup_links(invoice_id, transaction_id, confirmed_event_id, projection_commit_id)
    SELECT ${encodeId(1229870592, 'g')}, ${encodeId(1415073280, 'g')}, ${encodeId(1279874560, 'g')}, decode(repeat('08', 16), 'hex')
      FROM generate_series(1, ${links}) AS series(g);
`);
return { database, store, setupMs: performance.now() - started };
}

const { database, store, setupMs } = await createFixture();
const query = createPGliteSpendingQuery(store);
const targetInvoiceId = uuid(1229870592, 0);
const targetTransactionId = uuid(1415073280, 0);
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
const hintedInput = (report: typeof before.purchaseReport, targetCandidateId: string) => {
  const invoiceRecord = report.records.find((record) => record.purchaseId === `invoice:${targetInvoiceId}`);
  const paymentRecord = report.records.find((record) => record.purchaseId === `transaction:${targetTransactionId}`);
  if (!invoiceRecord || !paymentRecord) throw new Error("target report pair is missing");
  return {
    kind: "candidate" as const,
    candidateId: targetCandidateId,
    invoiceIdentityId: targetInvoiceId,
    transactionIdentityId: targetTransactionId,
    dataVersion: report.knowledgeAt,
    totalsByCurrency: report.totalsByCurrency,
    pairingReportContext: spendingPairingReportContext(report, invoiceRecord, paymentRecord, targetCandidateId),
  };
};
const coldConfirmStart = performance.now();
const coldConfirmed = await confirmPGliteSpendingCandidate(coldWriter, hintedInput(coldFixtureReport.purchaseReport, coldCandidate.candidateId));
const coldConfirmMs = performance.now() - coldConfirmStart;
const coldAfter = await coldFixtureQuery.current();
const coldPatched = applySpendingPurchaseReportPatch(coldFixtureReport.purchaseReport, coldConfirmed.patch);
if (JSON.stringify(coldPatched) !== JSON.stringify(coldAfter.purchaseReport)) throw new Error("cold candidate patch does not reproduce the committed report");
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
const warmStart = performance.now();
const confirmed = await confirmPGliteSpendingCandidate(store, hintedInput(before.purchaseReport, candidate.candidateId));
const warmConfirmMs = performance.now() - warmStart;
const directFixture = await createFixture();
const directQuery = createPGliteSpendingQuery(directFixture.store);
const directBefore = await directQuery.current();
const directAction = () => {
  const report = directBefore.purchaseReport;
  const invoiceRecord = report.records.find((record) => record.purchaseId === `invoice:${targetInvoiceId}`);
  const paymentRecord = report.records.find((record) => record.purchaseId === `transaction:${targetTransactionId}`);
  if (!invoiceRecord || !paymentRecord) throw new Error("direct report pair is missing");
  const pairCandidate = report.candidates.find((entry) => entry.invoiceId === targetInvoiceId && entry.transactionId === targetTransactionId);
  return {
    kind: "direct" as const,
    invoiceIdentityId: targetInvoiceId,
    transactionIdentityId: targetTransactionId,
    dataVersion: report.knowledgeAt,
    totalsByCurrency: report.totalsByCurrency,
    pairingReportContext: spendingPairingReportContext(report, invoiceRecord, paymentRecord, pairCandidate?.candidateId),
  };
};
const directColdWriter = new PGliteStore(directFixture.database);
const coldDirectStart = performance.now();
const directConfirmed = await confirmPGliteSpendingCandidate(directColdWriter, directAction());
const coldDirectConfirmMs = performance.now() - coldDirectStart;
const directAfter = await directQuery.current();
if (JSON.stringify(applySpendingPurchaseReportPatch(directBefore.purchaseReport, directConfirmed.patch)) !== JSON.stringify(directAfter.purchaseReport))
  throw new Error("cold direct patch does not reproduce the committed report");
const totalStart = performance.now();
const after = await query.current();
if (JSON.stringify(applySpendingPurchaseReportPatch(before.purchaseReport, confirmed.patch)) !== JSON.stringify(after.purchaseReport))
  throw new Error("warm candidate patch does not reproduce the committed report");
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
    fixture: { linkRange: "1..links", reservedTarget: "invoice/transaction 0", targetRemainsUnlinked: true, coldSemantics: "command store report cache cold; click-time compact context from displayed report included; same PGlite WASM database warm" },
  },
  setupMs,
  coldFixtureSetupMs: coldFixture.setupMs,
  coldRankMs,
  coldConfirmMs,
  coldConfirmPatchOperations: coldConfirmed.patch.recordOperations.length,
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
  patchOperations: confirmed.patch.recordOperations.length,
  actualCounts,
  timingGates,
  adr0028Pass,
}, null, 2));
await store.close();
await directColdWriter.close();
if (!adr0028Pass) process.exitCode = 1;
