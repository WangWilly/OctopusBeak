import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createBaselinePGlite } from "./baseline-test-template.ts";
import { PGliteStore } from "./transaction.ts";
import {
  createPGliteSpendingQuery,
  queryCurrentSpending,
  queryCurrentSpendingRecordPage,
  queryCurrentSpendingSummary,
  queryHistoricalSpending,
  querySpendingRecognition,
  rankPGliteSpendingPaymentCandidates,
  resolvePGliteSpendingCandidate,
} from "./spending-query.ts";
import type { PurchaseReport } from "../canonical/spending-purchase-contracts.ts";
import {
  commitPGliteSpendingRefundRevision,
  applyPGliteSpendingPageAction,
  confirmPGliteSpendingCandidate,
  denyPGliteSpendingCandidate,
  recordPGliteSpendingMatchCandidate,
  revokePGliteSpendingLink,
} from "./spending-command.ts";
import {
  E_INVOICE_CONTRACT_VERSION,
  E_INVOICE_COMPLETENESS_RULE_VERSION,
  E_INVOICE_CURRENCY_AUTHORITY,
} from "../canonical/einvoice-contract.ts";
import { applySpendingPurchaseReportPatch } from "../../lib/spending/purchase-report-patch.ts";
import {
  applySpendingSummaryDelta,
  spendingPairingReportContext,
} from "../../lib/spending/model.ts";

const id = (value: number): Uint8Array => Uint8Array.from({ length: 16 }, () => value);
const BANK_ROUTE = "fubon/credit-card/human-attested-v2";

function textId(value: Uint8Array): string {
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function assertCompactActionSummaryParity(
  fixture: Fixture,
  input: Parameters<typeof applyPGliteSpendingPageAction>[1],
) {
  const before = await queryCurrentSpendingSummary(fixture.store);
  const result = await applyPGliteSpendingPageAction(fixture.store, input);
  const after = await queryCurrentSpendingSummary(fixture.store);
  const patched = applySpendingSummaryDelta(
    before.purchaseReport,
    result.baseKnowledgeAt,
    result.knowledgeAt,
    result.summaryDelta,
  );
  assert.equal(result.baseKnowledgeAt, before.knowledgeAt);
  assert.equal(result.knowledgeAt, after.knowledgeAt);
  assert.deepEqual(normalizedCompactSummary(patched), normalizedCompactSummary(after.purchaseReport));
  return { before, result, after };
}

type Fixture = Readonly<{
  database: PGlite;
  store: PGliteStore;
  invoiceOne: string;
  invoiceTwo: string;
  transactionOne: string;
  transactionTwo: string;
}>;

async function setupFixture(options: Readonly<{
  invoiceOneAmount?: string;
  invoiceOneScale?: number;
  invoiceOneDate?: string;
  transactionOneDate?: string;
  transactionOneScale?: number;
}> = {}): Promise<Fixture> {
  const database = await createBaselinePGlite();
  const store = new PGliteStore(database);

  const sourceCommit = id(1);
  const sourceConnection = id(2);
  const epoch = id(3);
  const subjectOne = id(4);
  const subjectTwo = id(5);
  const bankCapture = id(6);
  const invoiceCaptureOne = id(7);
  const invoiceCaptureTwo = id(8);
  const bankRecordOne = id(9);
  const bankRecordTwo = id(10);
  const invoiceRecordOne = id(11);
  const invoiceRecordTwo = id(12);
  const account = id(13);
  const transactionOne = id(14);
  const transactionTwo = id(15);
  const transactionRevisionOne = id(16);
  const transactionRevisionTwo = id(17);
  const invoiceOne = id(18);
  const invoiceTwo = id(19);
  const invoiceRevisionOne = id(20);
  const invoiceRevisionTwo = id(21);
  const sourceAssertionOne = id(22);
  const sourceAssertionTwo = id(23);
  const kindAssertionOne = id(24);
  const kindAssertionTwo = id(25);

  await store.query(
    "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES ($1, 1, 1, $2, 'source_capture')",
    [sourceCommit, BANK_ROUTE],
  );
  await store.query(
    `INSERT INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id)
     VALUES ($1, 'fubon', 'credit-card', $1, $3),
            ($2, 'einvoice', 'personal-invoices', $2, $3)`,
    [BANK_ROUTE, E_INVOICE_CONTRACT_VERSION, sourceCommit],
  );
  await store.query(
    "INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id) VALUES ($1, 'fixture', 'fixture-connection', $2)",
    [sourceConnection, sourceCommit],
  );
  await store.query(
    "INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id) VALUES ($1, $2, 'fixture-epoch', $3)",
    [epoch, sourceConnection, sourceCommit],
  );
  await store.query(
    `INSERT INTO source_subjects(
       source_subject_id, source_connection_id, identity_epoch_id, stream,
       record_kind, subject_digest, created_commit_id
     ) VALUES ($1, $2, $3, 'personal-invoices', 'personal-invoice', 'fixture-subject-1', $4),
              ($5, $2, $3, 'personal-invoices', 'personal-invoice', 'fixture-subject-2', $4)`,
    [subjectOne, sourceConnection, epoch, sourceCommit, subjectTwo],
  );

  const captureSql = `INSERT INTO source_captures(
    capture_id, capture_key, source_connection_id, identity_epoch_id,
    authority_route, stream, record_kind, source_account_key, observed_at,
    scope_start, scope_end, completeness, completeness_basis,
    completeness_rule_version, commit_id
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL,
            '2026-09-01', '2026-09-01', '2026-11-01', 'complete-range',
            $8, $9, $10)`;
  await store.query(captureSql, [bankCapture, "fixture-bank", sourceConnection, epoch, BANK_ROUTE, "credit-card", "bank-transaction", BANK_ROUTE, BANK_ROUTE, sourceCommit]);
  await store.query(captureSql, [invoiceCaptureOne, "fixture-invoice-1", sourceConnection, epoch, E_INVOICE_CONTRACT_VERSION, "personal-invoices", "personal-invoice", "fixture", E_INVOICE_COMPLETENESS_RULE_VERSION, sourceCommit]);
  await store.query(captureSql, [invoiceCaptureTwo, "fixture-invoice-2", sourceConnection, epoch, E_INVOICE_CONTRACT_VERSION, "personal-invoices", "personal-invoice", "fixture", E_INVOICE_COMPLETENESS_RULE_VERSION, sourceCommit]);
  await store.query(
    `INSERT INTO source_records(
       source_record_id, capture_id, source_subject_id, commit_id,
       record_kind, sequence_lexeme, provider_key, content_hash,
       occurrence_key, collision_key, description, payload_json
     ) VALUES ($1, $2, NULL, $3, 'bank-transaction', 'bank-1', 'bank-1', 'bank-hash-1', 'bank-1', 'bank-1', 'Seed purchase 1', '{}'),
              ($4, $2, NULL, $3, 'bank-transaction', 'bank-2', 'bank-2', 'bank-hash-2', 'bank-2', 'bank-2', 'Seed purchase 2', '{}'),
              ($5, $6, $7, $3, 'personal-invoice', 'invoice-1', 'invoice-1', 'invoice-hash-1', 'invoice-1', 'invoice-1', 'Seed invoice 1', '{}'),
              ($8, $9, $10, $3, 'personal-invoice', 'invoice-2', 'invoice-2', 'invoice-hash-2', 'invoice-2', 'invoice-2', 'Seed invoice 2', '{}')`,
    [bankRecordOne, bankCapture, sourceCommit, bankRecordTwo, invoiceRecordOne, invoiceCaptureOne, subjectOne, invoiceRecordTwo, invoiceCaptureTwo, subjectTwo],
  );
  await store.query(
    `INSERT INTO financial_accounts(
       account_id, source_connection_id, identity_epoch_id, stream,
       source_account_key, account_no, account_type, currency, institution_key, created_commit_id
     ) VALUES ($1, $2, $3, 'credit-card', 'fixture-account', '****0001', 'credit', 'TWD', 'fubon', $4)`,
    [account, sourceConnection, epoch, sourceCommit],
  );
  await store.query(
    `INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id)
     VALUES ($1, $3, 'payment-1', $2), ($4, $3, 'payment-2', $2)`,
    [transactionOne, sourceCommit, account, transactionTwo],
  );
  const revisionSql = `INSERT INTO transaction_revisions(
    revision_id, transaction_id, source_record_id, capture_id, commit_id,
    revision_number, amount_coefficient, amount_scale, currency, direction,
    posting_status, posting_origin, posting_basis, posting_rule_version,
    description, economic_status, administrative_state, semantic_rule_version,
    effective_on, transaction_date_time_local, time_zone, time_precision,
    time_origin, effective_time_basis, effective_time_rule_version,
    utc_instant_utc_us
  ) VALUES ($1, $2, $3, $4, $5, 1, $7, $12, 'TWD', 'outflow', 'posted',
            'human-attested', 'statement-posted-history', $6, $8, 'normal',
            'active', $6, $10, $11,
            'Asia/Taipei', 'second', 'source_reported', 'accounting',
            $6, $9)`;
  const transactionOneDate = options.transactionOneDate ?? "2026-09-01";
  await store.query(revisionSql, [transactionRevisionOne, transactionOne, bankRecordOne, bankCapture, sourceCommit, BANK_ROUTE, "1234", "Seed purchase 1", 0, transactionOneDate, `${transactionOneDate}T12:00:00`, options.transactionOneScale ?? 2]);
  await store.query(revisionSql, [transactionRevisionTwo, transactionTwo, bankRecordTwo, bankCapture, sourceCommit, BANK_ROUTE, "2345", "Seed purchase 2", 1, "2026-09-01", "2026-09-01T12:00:00", 2]);
  await store.query(
    `INSERT INTO assertions(
       assertion_id, transaction_id, field_name, target_kind, origin,
       producer_id, rule_lineage, revision_id, value_text, created_commit_id
     ) VALUES ($1, $2, 'transaction_revision', 'transaction', 'source',
               'fubon-credit-card', 'fubon/credit-card/human-attested-v2', $3, NULL, $4),
              ($5, $6, 'transaction_revision', 'transaction', 'source',
               'fubon-credit-card', 'fubon/credit-card/human-attested-v2', $7, NULL, $4),
              ($8, $2, 'kind', 'transaction', 'derived', 'fixture/kind',
               'fixture/kind/v1', NULL, 'purchase', $4),
              ($9, $6, 'kind', 'transaction', 'derived', 'fixture/kind',
               'fixture/kind/v1', NULL, 'purchase', $4)`,
    [sourceAssertionOne, transactionOne, transactionRevisionOne, sourceCommit, sourceAssertionTwo, transactionTwo, transactionRevisionTwo, kindAssertionOne, kindAssertionTwo],
  );
  await store.query(
    `INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id)
     VALUES ($1, $2, NULL, NULL, NULL, $3), ($4, $5, NULL, NULL, NULL, $3)`,
    [sourceAssertionOne, bankRecordOne, sourceCommit, sourceAssertionTwo, bankRecordTwo],
  );
  await store.query(
    `INSERT INTO current_transactions(transaction_id, revision_id, commit_id, projection_commit_id, revision_commit_id)
     VALUES ($1, $2, $3, $3, $3), ($4, $5, $3, $3, $3)`,
    [transactionOne, transactionRevisionOne, sourceCommit, transactionTwo, transactionRevisionTwo],
  );
  const route = (await store.query<{ route_id: string; producer_id: string; producer_version: string; taxonomy_id: string; taxonomy_version: string }>(
    "SELECT route_id, producer_id, producer_version, taxonomy_id, taxonomy_version FROM automatic_enrichment_authority_routes WHERE field_name = 'kind' ORDER BY route_id LIMIT 1",
  )).rows[0];
  assert.ok(route, "baseline must seed a kind enrichment route");
  await store.query(
    `INSERT INTO current_transaction_enrichment(
       transaction_id, field_name, assertion_id, value_text, origin,
       producer_id, producer_version, route_id, taxonomy_id, taxonomy_version,
       taxonomy_dimension, taxonomy_code, projection_commit_id
     ) VALUES ($1, 'kind', $2, 'purchase', 'derived', $3, $4, $5, $6, $7, 'kind', 'purchase', $8),
              ($9, 'kind', $10, 'purchase', 'derived', $3, $4, $5, $6, $7, 'kind', 'purchase', $8)`,
    [transactionOne, kindAssertionOne, route.producer_id, route.producer_version, route.route_id, route.taxonomy_id, route.taxonomy_version, sourceCommit, transactionTwo, kindAssertionTwo],
  );
  await store.query(
    `INSERT INTO einvoice_invoices(
       invoice_id, source_connection_id, identity_epoch_id, source_subject_id,
       stable_invoice_key, created_commit_id
     ) VALUES ($1, $3, $4, $5, 'fixture-invoice-1', $6),
              ($2, $3, $4, $7, 'fixture-invoice-2', $6)`,
    [invoiceOne, invoiceTwo, sourceConnection, epoch, subjectOne, sourceCommit, subjectTwo],
  );
  const invoiceRevisionSql = `INSERT INTO einvoice_invoice_revisions(
    revision_id, invoice_id, source_record_id, capture_id, commit_id,
    source_revision_key, revision_number, revision_kind, state, invoice_number,
    random_number, seller_tax_id, seller_name, amount_coefficient, amount_scale,
    currency, currency_authority, occurrence_value, occurrence_precision,
    occurrence_time_zone, occurrence_origin, authority_route, contract_version,
    provenance_kind, provenance_reference, provenance_source_field,
    revocation_reason, fact_fingerprint
  ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'issued', 'active', $7, NULL,
            '12345678', $8, $9, $15, 'TWD', $10, '2026-09-01', 'date',
            'Asia/Taipei', 'source-reported', $16, $11,
            'fixture', $12, NULL, NULL, $13)`;
  const datedInvoiceRevisionSql = invoiceRevisionSql.replace("'2026-09-01', 'date'", "$14, 'date'");
  await store.query(datedInvoiceRevisionSql, [invoiceRevisionOne, invoiceOne, invoiceRecordOne, invoiceCaptureOne, sourceCommit, "invoice-1-v1", "INV-0001", "Seed seller 1", options.invoiceOneAmount ?? "1234", E_INVOICE_CURRENCY_AUTHORITY, E_INVOICE_CONTRACT_VERSION, "fixture/invoice/1", "fingerprint-1", options.invoiceOneDate ?? "2026-09-01", options.invoiceOneScale ?? 2, E_INVOICE_CONTRACT_VERSION]);
  await store.query(datedInvoiceRevisionSql, [invoiceRevisionTwo, invoiceTwo, invoiceRecordTwo, invoiceCaptureTwo, sourceCommit, "invoice-2-v1", "INV-0002", "Seed seller 2", "2345", E_INVOICE_CURRENCY_AUTHORITY, E_INVOICE_CONTRACT_VERSION, "fixture/invoice/2", "fingerprint-2", "2026-09-01", 2, E_INVOICE_CONTRACT_VERSION]);

  return {
    database,
    store,
    invoiceOne: textId(invoiceOne),
    invoiceTwo: textId(invoiceTwo),
    transactionOne: textId(transactionOne),
    transactionTwo: textId(transactionTwo),
  };
}

function reportSummary(report: PurchaseReport) {
  type RecordRow = PurchaseReport["records"][number];
  const totals = (records: PurchaseReport["records"]) => {
    const amounts = new Map<string, { coefficient: bigint; scale: number; count: number }>();
    for (const record of records) {
      if (!record.amount) continue;
      const previous = amounts.get(record.amount.currency);
      if (!previous) {
        amounts.set(record.amount.currency, {
          coefficient: BigInt(record.amount.coefficient), scale: record.amount.scale, count: 1,
        });
        continue;
      }
      const scale = Math.max(previous.scale, record.amount.scale);
      amounts.set(record.amount.currency, {
        coefficient: previous.coefficient * 10n ** BigInt(scale - previous.scale)
          + BigInt(record.amount.coefficient) * 10n ** BigInt(scale - record.amount.scale),
        scale,
        count: previous.count + 1,
      });
    }
    return [...amounts].sort(([left], [right]) => left.localeCompare(right)).map(([currency, value]) => ({
      currency, coefficient: value.coefficient.toString(), scale: value.scale, count: value.count,
    }));
  };
  const months = new Map<string, RecordRow[]>();
  const days = new Map<string, RecordRow[]>();
  for (const record of report.records) {
    const month = record.occurrence.value.slice(0, 7);
    const day = record.occurrence.value.slice(0, 10);
    (months.get(month) ?? months.set(month, []).get(month)!).push(record);
    (days.get(day) ?? days.set(day, []).get(day)!).push(record);
  }
  const monthTotals = [...months].sort(([left], [right]) => left.localeCompare(right)).map(([month, records]) => ({
    month,
    recordCount: records.length,
    activeDayCount: new Set(records.map((record) => record.occurrence.value.slice(0, 10))).size,
    pendingCandidateCount: report.candidates.filter((candidate) => candidate.status === "candidate"
      && records.some((record) => record.candidateIds.includes(candidate.candidateId))).length,
    totalsByCurrency: totals(records),
  }));
  const dayTotals = [...days].sort(([left], [right]) => left.localeCompare(right)).map(([date, records]) => ({
    month: date.slice(0, 7), date, recordCount: records.length, totalsByCurrency: totals(records),
  }));
  const totalsByCurrency = totals(report.records);
  return {
    recordCount: report.records.length,
    candidateCount: report.candidates.length,
    pendingCandidateCount: report.candidates.filter((candidate) => candidate.status === "candidate").length,
    currencies: totalsByCurrency.map((amount) => amount.currency),
    totalsByCurrency,
    monthTotals,
    dayTotals,
  };
}

function normalizedSummaryMoney(rows: readonly { currency: string; coefficient: string; scale: number; count: number }[]) {
  return rows.map((row) => {
    let coefficient = BigInt(row.coefficient);
    let scale = row.scale;
    while (scale > 0 && coefficient % 10n === 0n) {
      coefficient /= 10n;
      scale -= 1;
    }
    return { ...row, coefficient: coefficient.toString(), scale };
  });
}

async function assertSummaryMatches(query: ReturnType<typeof createPGliteSpendingQuery>, report: PurchaseReport) {
  const summary = await query.summary({ knowledgeAt: report.knowledgeAt });
  assert.equal(summary.knowledgeAt, report.knowledgeAt);
  assert.equal(summary.purchaseReport.candidateState, "unloaded");
  assert.equal(summary.purchaseReport.candidateCount, null);
  assert.equal(summary.purchaseReport.pendingCandidateCount, null);
  const expected = reportSummary(report);
  assert.deepEqual({
    recordCount: summary.purchaseReport.recordCount,
    currencies: summary.purchaseReport.currencies,
    totalsByCurrency: normalizedSummaryMoney(summary.purchaseReport.totalsByCurrency),
    monthTotals: summary.purchaseReport.monthTotals.map(({ pendingCandidateCount: _pending, totalsByCurrency, ...month }) => ({
      ...month,
      totalsByCurrency: normalizedSummaryMoney(totalsByCurrency),
    })),
    dayTotals: summary.purchaseReport.dayTotals.map(({ totalsByCurrency, ...day }) => ({
      ...day,
      totalsByCurrency: normalizedSummaryMoney(totalsByCurrency),
    })),
  }, {
    recordCount: expected.recordCount,
    currencies: expected.currencies,
    totalsByCurrency: normalizedSummaryMoney(expected.totalsByCurrency),
    monthTotals: expected.monthTotals.map(({ pendingCandidateCount: _pending, totalsByCurrency, ...month }) => ({
      ...month,
      totalsByCurrency: normalizedSummaryMoney(totalsByCurrency),
    })),
    dayTotals: expected.dayTotals.map(({ totalsByCurrency, ...day }) => ({
      ...day,
      totalsByCurrency: normalizedSummaryMoney(totalsByCurrency),
    })),
  });
  return summary;
}

function normalizedCompactSummary(summary: import("../../lib/spending/model.ts").SpendingPurchaseReportSummaryDto) {
  return {
    recordCount: summary.recordCount,
    candidateCount: summary.candidateCount,
    pendingCandidateCount: summary.pendingCandidateCount,
    candidateState: summary.candidateState,
    currencies: summary.currencies,
    totalsByCurrency: normalizedSummaryMoney(summary.totalsByCurrency),
    monthTotals: summary.monthTotals.map(({ totalsByCurrency, ...month }) => ({
      ...month,
      totalsByCurrency: normalizedSummaryMoney(totalsByCurrency),
    })),
    dayTotals: summary.dayTotals.map(({ totalsByCurrency, ...day }) => ({
      ...day,
      totalsByCurrency: normalizedSummaryMoney(totalsByCurrency),
    })),
  };
}

test("PGlite Spending keeps current/historical snapshots and atomic recognition semantics", async () => {
  const fixture = await setupFixture();
  try {
    const query = createPGliteSpendingQuery(fixture.store);
    const arrayRows = await fixture.store.transaction((transaction) =>
      transaction.query<readonly unknown[]>("SELECT 7 AS one, 'ok' AS two", [], { rowMode: "array" }));
    assert.deepEqual(arrayRows.rows, [[7, "ok"]]);
    assert.deepEqual((await fixture.store.query<{ one: number }>("SELECT 7 AS one")).rows, [{ one: 7 }]);
    const before = await query.current();
    await assertSummaryMatches(query, before.purchaseReport);
    assert.equal(before.purchaseReport.knowledgeAt, 1);
    const expectedMonthRecords = before.purchaseReport.records
      .filter((record) => record.occurrence.value.startsWith("2026-09-"))
      .slice()
      .sort((left, right) => right.occurrence.value.localeCompare(left.occurrence.value) || left.purchaseId.localeCompare(right.purchaseId));
    const firstRecordPage = await fixture.store.transaction((transaction) => queryCurrentSpendingRecordPage(transaction, {
      knowledgeAt: before.purchaseReport.knowledgeAt,
      month: "2026-09",
      limit: 2,
    }));
    assert.deepEqual(firstRecordPage.records.map((record) => record.purchaseId), expectedMonthRecords.slice(0, 2).map((record) => record.purchaseId));
    assert.ok(firstRecordPage.nextCursor);
    const secondRecordPage = await fixture.store.transaction((transaction) => queryCurrentSpendingRecordPage(transaction, {
      knowledgeAt: before.purchaseReport.knowledgeAt,
      month: "2026-09",
      cursor: firstRecordPage.nextCursor,
      limit: 2,
    }));
    assert.deepEqual(secondRecordPage.records.map((record) => record.purchaseId), expectedMonthRecords.slice(2, 4).map((record) => record.purchaseId));
    const firstCandidatePage = await query.candidatePage({ knowledgeAt: 1, month: "2026-09", limit: 1 });
    assert.equal(firstCandidatePage.totalCandidateCount, 2);
    assert.equal(firstCandidatePage.items.length, 1);
    assert.ok(firstCandidatePage.nextOffset !== null);
    assert.ok(firstCandidatePage.items[0]?.invoiceRecord?.candidateIds.includes(firstCandidatePage.items[0]!.candidate.candidateId));
    const secondCandidatePage = await query.candidatePage({ knowledgeAt: 1, month: "2026-09", offset: firstCandidatePage.nextOffset!, limit: 1 });
    assert.equal(secondCandidatePage.items.length, 1);
    assert.notEqual(firstCandidatePage.items[0]?.candidate.candidateId, secondCandidatePage.items[0]?.candidate.candidateId);
    assert.equal(before.purchaseReport.records.some((record) => record.occurrence.value.startsWith("2026-10-")), false);
    const emptyMonthRecords = await fixture.store.transaction((transaction) => queryCurrentSpendingRecordPage(transaction, {
      knowledgeAt: before.purchaseReport.knowledgeAt,
      month: "2026-10",
    }));
    assert.deepEqual([emptyMonthRecords.records, emptyMonthRecords.nextCursor], [[], null], "a month without purchases pages as empty");
    const emptyMonthCandidates = await query.candidatePage({ knowledgeAt: 1, month: "2026-10" });
    assert.deepEqual([emptyMonthCandidates.items, emptyMonthCandidates.totalCandidateCount, emptyMonthCandidates.nextOffset], [[], 0, null]);
    await assert.rejects(query.candidatePage({ knowledgeAt: 0, month: "2026-09" }), /data version is stale/u);
    await assert.rejects(fixture.store.transaction((transaction) => queryCurrentSpendingRecordPage(transaction, {
      knowledgeAt: 0,
      month: "2026-09",
    })), /data version is stale/u);
    assert.deepEqual(before.purchaseReport.records.map((record) => record.basis), ["invoice", "invoice", "bank-transaction", "bank-transaction"]);
    assert.equal(before.purchaseReport.candidates.length, 2);
    assert.deepEqual(before.purchaseReport.totalsByCurrency, [{ currency: "TWD", coefficient: "7158", scale: 2, count: 4 }]);
    const plannerBefore = (await fixture.store.query<{ enable_nestloop: string }>("SHOW enable_nestloop")).rows[0]?.enable_nestloop;
    const pairing = await fixture.store.transaction((transaction) => rankPGliteSpendingPaymentCandidates(transaction, {
      invoiceIdentityId: fixture.invoiceOne, dataVersion: before.purchaseReport.knowledgeAt,
    }));
    assert.equal(pairing.totalCandidateCount, 2);
    const selectedOutsidePage = pairing.candidates[1];
    assert.ok(selectedOutsidePage);
    const preserved = await fixture.store.transaction((transaction) => rankPGliteSpendingPaymentCandidates(transaction, {
      invoiceIdentityId: fixture.invoiceOne,
      dataVersion: before.purchaseReport.knowledgeAt,
      selectedTransactionId: selectedOutsidePage.transactionId,
      limit: 1,
    }));
    assert.equal(preserved.candidates.length, 1);
    assert.notEqual(preserved.candidates[0]?.transactionId, selectedOutsidePage.transactionId);
    assert.deepEqual(preserved.selectedCandidate, selectedOutsidePage);
    const invalidated = await fixture.store.transaction((transaction) => rankPGliteSpendingPaymentCandidates(transaction, {
      invoiceIdentityId: fixture.invoiceOne,
      dataVersion: before.purchaseReport.knowledgeAt,
      selectedTransactionId: "missing-payment",
      limit: 1,
    }));
    assert.equal(invalidated.selectedCandidate, null);
    assert.equal((await fixture.store.query<{ enable_nestloop: string }>("SHOW enable_nestloop")).rows[0]?.enable_nestloop, plannerBefore);

    const historical = await query.historical({ financialAt: "2026-09-01", knowledgeAt: 1 });
    assert.equal(historical.projection.knowledgeAt, 1);
    assert.deepEqual(historical.projection.records.map((record) => record.basis), before.purchaseReport.records.map((record) => record.basis));
    assert.deepEqual(historical.projection.totalsByCurrency, before.purchaseReport.totalsByCurrency);
    const initialLineage = await query.lineage({ subject: { kind: "spending-pair", id: `${fixture.invoiceOne}/${fixture.transactionOne}` } });
    assert.equal(initialLineage.lineage[0]?.invoice?.revisions.length, 1);
    assert.deepEqual(initialLineage.lineage[0]?.recognition, []);

    const candidateOne = before.purchaseReport.candidates.find((candidate) => candidate.invoiceId === fixture.invoiceOne && candidate.transactionId === fixture.transactionOne);
    const candidateTwo = before.purchaseReport.candidates.find((candidate) => candidate.invoiceId === fixture.invoiceTwo && candidate.transactionId === fixture.transactionTwo);
    assert.ok(candidateOne);
    assert.ok(candidateTwo);

    const confirmed = await confirmPGliteSpendingCandidate(fixture.store, { kind: "candidate", candidateId: candidateOne.candidateId });
    assert.equal(confirmed.patch.knowledgeAt, 3);
    await assert.rejects(
      confirmPGliteSpendingCandidate(fixture.store, { kind: "candidate", candidateId: candidateTwo.candidateId }),
      /stale or missing/u,
      "a candidate opened from the previous report version must not be confirmed after a commit",
    );

    const afterConfirm = await query.current();
    const summaryAfterConfirm = await assertSummaryMatches(query, afterConfirm.purchaseReport);
    assert.deepEqual(summaryAfterConfirm.purchaseReport.totalsByCurrency, [
      { currency: "TWD", coefficient: "5924", scale: 2, count: 3 },
    ]);
    assert.deepEqual(applySpendingPurchaseReportPatch(before.purchaseReport, confirmed.patch), afterConfirm.purchaseReport);
    assert.deepEqual(afterConfirm.purchaseReport.records.map((record) => record.basis), ["invoice", "linked", "bank-transaction"]);
    assert.deepEqual(afterConfirm.purchaseReport.totalsByCurrency, [{ currency: "TWD", coefficient: "5924", scale: 2, count: 3 }]);
    assert.equal((await query.recognition()).activeLinks.length, 1);

    const denied = await denyPGliteSpendingCandidate(fixture.store, { kind: "candidate", candidateId: candidateTwo.candidateId });
    assert.ok(denied.patch.knowledgeAt > confirmed.patch.knowledgeAt);
    const afterDeny = await query.current();
    await assertSummaryMatches(query, afterDeny.purchaseReport);
    assert.deepEqual(applySpendingPurchaseReportPatch(afterConfirm.purchaseReport, denied.patch), afterDeny.purchaseReport);
    assert.equal((await query.recognition()).denied.length, 1);

    const beforeRevoke = afterDeny;
    const revoked = await revokePGliteSpendingLink(fixture.store, { invoiceId: fixture.invoiceOne, transactionId: fixture.transactionOne });
    assert.ok(revoked.patch.recordOperations.some((operation) => operation.kind === "upsert"));
    const afterRevoke = await query.current();
    await assertSummaryMatches(query, afterRevoke.purchaseReport);
    assert.deepEqual(applySpendingPurchaseReportPatch(beforeRevoke.purchaseReport, revoked.patch), afterRevoke.purchaseReport);
    assert.equal(afterRevoke.purchaseReport.records.some((record) => record.basis === "linked"), false);
    assert.equal(afterRevoke.purchaseReport.records.filter((record) => record.basis === "invoice").length, 2);
    assert.equal(afterRevoke.purchaseReport.records.filter((record) => record.basis === "bank-transaction").length, 2);
    assert.equal((await query.recognition()).activeLinks.length, 0);
    const recognitionLineage = await query.lineage({ subject: { kind: "spending-pair", id: `${fixture.invoiceOne}/${fixture.transactionOne}` } });
    assert.deepEqual(recognitionLineage.lineage[0]?.recognition.map((event) => event.kind), ["confirmed", "revoked"]);

    const refund = await fixture.store.transaction((transaction) => commitPGliteSpendingRefundRevision(transaction, {
      stableRefundKey: "fixture-refund",
      transactionId: fixture.transactionTwo,
      sourceRevisionKey: "refund-v1",
      revisionNumber: 1,
      revisionKind: "asserted",
      amount: { coefficient: "-100", scale: 2, currency: "TWD" },
      occurrence: { value: "2026-09-02", precision: "date", timeZone: "Asia/Taipei", basis: "source-occurrence" },
      authorityRoute: BANK_ROUTE,
      provenanceReference: "fixture/refund/1",
      evidence: { sourceProvesRefund: true },
    }));
    assert.equal(refund.amount?.coefficient, "-100");
    assert.equal((await query.recognition()).refunds.length, 1);
    const afterRefund = await query.current();
    const summaryAfterRefund = await assertSummaryMatches(query, afterRefund.purchaseReport);
    assert.deepEqual(summaryAfterRefund.purchaseReport.totalsByCurrency, [
      { currency: "TWD", coefficient: "4713", scale: 2, count: 4 },
    ]);
    const refundLineage = await query.lineage({ subject: { kind: "refund", id: "fixture-refund" } });
    assert.equal(refundLineage.lineage[0]?.refunds.length, 1);

    const beforeRollback = await query.recognition();
    await assert.rejects(
      fixture.store.transaction(async (transaction) => {
        await recordPGliteSpendingMatchCandidate(transaction, {
          invoiceId: fixture.invoiceOne,
          transactionId: fixture.transactionTwo,
          candidateKey: "fixture-rollback-candidate",
          algorithm: "test",
          algorithmVersion: "v1",
          similarityEvidence: { test: true },
        });
        throw new Error("rollback spending fixture");
      }),
      /rollback spending fixture/u,
    );
    const afterRollback = await query.recognition();
    assert.deepEqual(afterRollback, beforeRollback);
    assert.equal(Number((await fixture.store.query<{ count: string | number }>("SELECT COUNT(*) AS count FROM spending_match_candidates WHERE candidate_key = 'fixture-rollback-candidate'")).rows[0]?.count), 0);
  } finally {
    await fixture.store.close();
  }
});

test("PGlite Spending summary uses linked payment money instead of the invoice amount", async () => {
  const fixture = await setupFixture({ invoiceOneAmount: "1134" });
  try {
    const query = createPGliteSpendingQuery(fixture.store);
    const before = await query.current();
    assert.equal(before.purchaseReport.totalsByCurrency[0]?.coefficient, "7058");
    await assertSummaryMatches(query, before.purchaseReport);

    await confirmPGliteSpendingCandidate(fixture.store, {
      kind: "direct",
      invoiceIdentityId: fixture.invoiceOne,
      transactionIdentityId: fixture.transactionOne,
      dataVersion: before.purchaseReport.knowledgeAt,
    });
    const after = await query.current();
    const summary = await assertSummaryMatches(query, after.purchaseReport);
    assert.deepEqual(summary.purchaseReport.totalsByCurrency, [
      { currency: "TWD", coefficient: "5924", scale: 2, count: 3 },
    ]);
  } finally {
    await fixture.store.close();
  }
});

test("PGlite month candidate pages include invoice-or-payment month and reject an open Pairing version after confirmation", async () => {
  const fixture = await setupFixture({ invoiceOneDate: "2026-09-30", transactionOneDate: "2026-10-02" });
  try {
    const query = createPGliteSpendingQuery(fixture.store);
    const before = await query.current();
    const crossMonthCandidate = before.purchaseReport.candidates.find((candidate) =>
      candidate.invoiceId === fixture.invoiceOne && candidate.transactionId === fixture.transactionOne);
    assert.ok(crossMonthCandidate);

    const september = await query.candidatePage({ knowledgeAt: before.purchaseReport.knowledgeAt, month: "2026-09", limit: 20 });
    const october = await query.candidatePage({ knowledgeAt: before.purchaseReport.knowledgeAt, month: "2026-10", limit: 20 });
    assert.equal(september.totalCandidateCount, 2);
    assert.equal(october.totalCandidateCount, 1);
    const septemberPair = september.items.find((item) => item.candidate.candidateId === crossMonthCandidate.candidateId);
    const octoberPair = october.items.find((item) => item.candidate.candidateId === crossMonthCandidate.candidateId);
    assert.ok(septemberPair, "a September invoice keeps the pair in September's pending list");
    assert.ok(octoberPair, "an October payment keeps the pair in October's pending list");
    assert.equal(septemberPair.invoiceRecord?.occurrence.value, "2026-09-30");
    assert.equal(septemberPair.paymentRecord?.occurrence.value, "2026-10-02");
    assert.equal(octoberPair.invoiceRecord?.occurrence.value, "2026-09-30");
    assert.equal(octoberPair.paymentRecord?.occurrence.value, "2026-10-02");

    const modalPage = await fixture.store.transaction((transaction) => rankPGliteSpendingPaymentCandidates(transaction, {
      invoiceIdentityId: fixture.invoiceOne,
      dataVersion: before.purchaseReport.knowledgeAt,
      limit: 1,
    }));
    assert.equal(modalPage.totalCandidateCount, 2, "the invoice modal keeps global transaction coverage across both months");
    assert.equal(modalPage.candidates[0]?.transactionId, fixture.transactionOne);
    await confirmPGliteSpendingCandidate(fixture.store, { kind: "candidate", candidateId: crossMonthCandidate.candidateId });
    await assert.rejects(fixture.store.transaction((transaction) => rankPGliteSpendingPaymentCandidates(transaction, {
      invoiceIdentityId: fixture.invoiceOne,
      dataVersion: before.purchaseReport.knowledgeAt,
      limit: 1,
    })), /data version is stale/u, "an open Pairing page must be invalidated by a newer commit");
    await assert.rejects(query.candidatePage({ knowledgeAt: before.purchaseReport.knowledgeAt, month: "2026-10" }), /data version is stale/u);
  } finally {
    await fixture.store.close();
  }
});

test("PGlite candidate resolution stays isolated across equal-version databases", async () => {
  const first = await setupFixture();
  const second = await setupFixture();
  try {
    const firstQuery = createPGliteSpendingQuery(first.store);
    const secondQuery = createPGliteSpendingQuery(second.store);
    const firstBefore = await firstQuery.current();
    const secondBefore = await secondQuery.current();
    const firstCandidate = firstBefore.purchaseReport.candidates.find((candidate) => candidate.invoiceId === first.invoiceOne && candidate.transactionId === first.transactionOne);
    const secondCandidate = secondBefore.purchaseReport.candidates.find((candidate) => candidate.invoiceId === second.invoiceOne && candidate.transactionId === second.transactionOne);
    assert.ok(firstCandidate);
    assert.ok(secondCandidate);
    assert.equal(firstBefore.purchaseReport.knowledgeAt, secondBefore.purchaseReport.knowledgeAt);
    assert.equal(firstCandidate.candidateId, secondCandidate.candidateId);
    await confirmPGliteSpendingCandidate(first.store, { kind: "candidate", candidateId: firstCandidate.candidateId });
    const isolated = await resolvePGliteSpendingCandidate(second.store, secondCandidate.candidateId);
    assert.equal(isolated.candidate.invoiceId, second.invoiceOne);
    assert.equal(isolated.candidate.transactionId, second.transactionOne);
    assert.equal((await secondQuery.current()).purchaseReport.candidates.some((candidate) => candidate.candidateId === secondCandidate.candidateId), true);
  } finally {
    await first.store.close();
    await second.store.close();
  }
});

test("PGlite cold hinted candidate decisions and direct confirmation patches equal recomputed reports", async () => {
  for (const action of ["candidate", "candidate-deny", "direct"] as const) {
    const fixture = await setupFixture();
    try {
      const query = createPGliteSpendingQuery(fixture.store);
      const before = await query.current();
      const invoiceRecord = before.purchaseReport.records.find((record) => record.purchaseId === `invoice:${fixture.invoiceOne}`)!;
      const paymentRecord = before.purchaseReport.records.find((record) => record.purchaseId === `transaction:${fixture.transactionOne}`)!;
      const candidate = before.purchaseReport.candidates.find((entry) => entry.invoiceId === fixture.invoiceOne && entry.transactionId === fixture.transactionOne)!;
      const coldWriter = new PGliteStore(fixture.database);
      const context = spendingPairingReportContext(before.purchaseReport, invoiceRecord, paymentRecord, candidate.candidateId);
      const input = action !== "direct" ? {
        kind: "candidate" as const, candidateId: candidate.candidateId,
        invoiceIdentityId: fixture.invoiceOne, transactionIdentityId: fixture.transactionOne,
        dataVersion: before.purchaseReport.knowledgeAt,
        totalsByCurrency: before.purchaseReport.totalsByCurrency,
        pairingReportContext: context,
      } : {
        kind: "direct" as const, invoiceIdentityId: fixture.invoiceOne,
        transactionIdentityId: fixture.transactionOne,
        dataVersion: before.purchaseReport.knowledgeAt,
        totalsByCurrency: before.purchaseReport.totalsByCurrency,
        pairingReportContext: context,
      };
      if (action !== "direct") {
        await assert.rejects(
          confirmPGliteSpendingCandidate(coldWriter, { kind: "candidate", candidateId: candidate.candidateId,
            invoiceIdentityId: fixture.invoiceOne, transactionIdentityId: fixture.transactionTwo,
            dataVersion: before.purchaseReport.knowledgeAt,
            totalsByCurrency: before.purchaseReport.totalsByCurrency,
            pairingReportContext: context }),
          /hint does not match/u,
        );
        assert.equal((await fixture.store.query<{ value: string | number }>("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits")).rows[0]?.value, 1);
      }
      const confirmed = action === "candidate-deny"
        ? await denyPGliteSpendingCandidate(coldWriter, input as Extract<typeof input, { kind: "candidate" }>)
        : await confirmPGliteSpendingCandidate(coldWriter, input);
      const after = await query.current();
      assert.deepEqual(applySpendingPurchaseReportPatch(before.purchaseReport, confirmed.patch), after.purchaseReport);
    } finally {
      await fixture.store.close();
    }
  }
});

test("PGlite direct targeted patch preserves a durable candidate's decided row", async () => {
  const fixture = await setupFixture();
  try {
    const query = createPGliteSpendingQuery(fixture.store);
    const initial = await query.current();
    const inferred = initial.purchaseReport.candidates.find((entry) => entry.invoiceId === fixture.invoiceOne && entry.transactionId === fixture.transactionOne)!;
    await fixture.store.transaction((transaction) => recordPGliteSpendingMatchCandidate(transaction, {
      invoiceId: inferred.invoiceId, transactionId: inferred.transactionId,
      candidateKey: inferred.candidateId,
      algorithm: inferred.algorithm, algorithmVersion: inferred.algorithmVersion,
      similarityEvidence: inferred.similarityEvidence,
    }));
    const before = await query.current();
    const candidate = before.purchaseReport.candidates.find((entry) => entry.invoiceId === fixture.invoiceOne && entry.transactionId === fixture.transactionOne)!;
    const invoiceRecord = before.purchaseReport.records.find((record) => record.purchaseId === `invoice:${fixture.invoiceOne}`)!;
    const paymentRecord = before.purchaseReport.records.find((record) => record.purchaseId === `transaction:${fixture.transactionOne}`)!;
    const coldWriter = new PGliteStore(fixture.database);
    const result = await confirmPGliteSpendingCandidate(coldWriter, {
      kind: "direct", invoiceIdentityId: fixture.invoiceOne, transactionIdentityId: fixture.transactionOne,
      dataVersion: before.purchaseReport.knowledgeAt,
      totalsByCurrency: before.purchaseReport.totalsByCurrency,
      pairingReportContext: spendingPairingReportContext(before.purchaseReport, invoiceRecord, paymentRecord, candidate.candidateId),
    });
    const after = await query.current();
    assert.deepEqual(applySpendingPurchaseReportPatch(before.purchaseReport, result.patch), after.purchaseReport);
  } finally {
    await fixture.store.close();
  }
});

test("PGlite compact candidate confirmation delta matches exact summary across months and stale versions reject", async () => {
  const fixture = await setupFixture({
    invoiceOneAmount: "12340",
    invoiceOneScale: 3,
    invoiceOneDate: "2026-09-30",
    transactionOneDate: "2026-10-02",
    transactionOneScale: 2,
  });
  try {
    const query = createPGliteSpendingQuery(fixture.store);
    const current = await query.current();
    const candidate = current.purchaseReport.candidates.find((entry) =>
      entry.invoiceId === fixture.invoiceOne && entry.transactionId === fixture.transactionOne);
    assert.ok(candidate);
    const input = {
      action: "confirm" as const,
      kind: "candidate" as const,
      candidateId: candidate.candidateId,
      invoiceIdentityId: fixture.invoiceOne,
      transactionIdentityId: fixture.transactionOne,
      dataVersion: current.purchaseReport.knowledgeAt,
    };
    const { before, result, after } = await assertCompactActionSummaryParity(fixture, input);
    assert.equal(before.purchaseReport.monthTotals.some((month) => month.month === "2026-10"), true);
    assert.equal(after.purchaseReport.monthTotals.some((month) => month.month === "2026-10"), false);
    assert.equal(after.purchaseReport.recordCount, before.purchaseReport.recordCount - 1);
    assert.deepEqual(result.summaryDelta.before.map((line) => line.date).sort(), ["2026-09-30", "2026-10-02"]);
    assert.deepEqual(result.summaryDelta.after.map((line) => line.date), ["2026-09-30"]);
    const linked = result.affectedRecords.find((record) => record.basis === "linked");
    assert.ok(linked);
    assert.equal(linked.occurrence.value, "2026-09-30");
    assert.deepEqual(linked.amount, { coefficient: "1234", scale: 2, currency: "TWD" });
    assert.equal(result.summaryDelta.after[0]?.amount?.coefficient, "1234");
    await assert.rejects(applyPGliteSpendingPageAction(fixture.store, input), /data version is stale/u);
  } finally {
    await fixture.store.close();
  }
});

test("PGlite compact direct confirm and revoke deltas preserve exact amounts and day counts", async () => {
  const fixture = await setupFixture({
    invoiceOneAmount: "100001",
    invoiceOneScale: 3,
    invoiceOneDate: "2026-09-30",
    transactionOneDate: "2026-10-02",
    transactionOneScale: 2,
  });
  try {
    const query = createPGliteSpendingQuery(fixture.store);
    const current = await query.current();
    const confirm = await assertCompactActionSummaryParity(fixture, {
      action: "confirm",
      kind: "direct",
      invoiceIdentityId: fixture.invoiceOne,
      transactionIdentityId: fixture.transactionOne,
      dataVersion: current.purchaseReport.knowledgeAt,
    });
    const linked = confirm.result.affectedRecords.find((record) => record.basis === "linked");
    assert.ok(linked);
    assert.deepEqual(linked.amount, { coefficient: "1234", scale: 2, currency: "TWD" });
    assert.equal(confirm.after.purchaseReport.dayTotals.some((day) => day.date === "2026-10-02"), false);

    const revoke = await assertCompactActionSummaryParity(fixture, {
      action: "revoke",
      kind: "revoke",
      invoiceIdentityId: fixture.invoiceOne,
      transactionIdentityId: fixture.transactionOne,
      dataVersion: confirm.after.knowledgeAt,
    });
    assert.equal(revoke.result.summaryDelta.before.length, 1);
    assert.equal(revoke.result.summaryDelta.after.length, 2);
    assert.equal(revoke.after.purchaseReport.dayTotals.some((day) => day.date === "2026-10-02"), true);
    assert.equal(revoke.after.purchaseReport.dayTotals.find((day) => day.date === "2026-10-02")?.recordCount, 1);
  } finally {
    await fixture.store.close();
  }
});

test("PGlite compact candidate denial advances version without changing exact summary", async () => {
  const fixture = await setupFixture();
  try {
    const query = createPGliteSpendingQuery(fixture.store);
    const current = await query.current();
    const candidate = current.purchaseReport.candidates.find((entry) =>
      entry.invoiceId === fixture.invoiceOne && entry.transactionId === fixture.transactionOne);
    assert.ok(candidate);
    const { before, result, after } = await assertCompactActionSummaryParity(fixture, {
      action: "deny",
      kind: "candidate",
      candidateId: candidate.candidateId,
      invoiceIdentityId: fixture.invoiceOne,
      transactionIdentityId: fixture.transactionOne,
      dataVersion: current.purchaseReport.knowledgeAt,
    });
    assert.ok(result.knowledgeAt > result.baseKnowledgeAt);
    assert.deepEqual(result.summaryDelta, { before: [], after: [] });
    assert.deepEqual(normalizedCompactSummary(before.purchaseReport), normalizedCompactSummary(after.purchaseReport));
    assert.equal(result.affectedRecords.some((record) => record.basis === "linked"), false);
  } finally {
    await fixture.store.close();
  }
});
