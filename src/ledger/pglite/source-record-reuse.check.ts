/**
 * Reusing a stored Source Record must not change canonical state (ADR 0152).
 * Each scenario runs the same captures twice: once through the commit that
 * reuses unchanged records, and once declaring that domain rows may cite any
 * record, which stores every record as before. Everything but the record
 * copies themselves must then be equal: transactions, assertions, transitions,
 * expected occurrences, capture membership, relations and projection rows.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assignOccurrenceSlots, canonicalOccurrenceGroupKey } from "../canonical/occurrence-groups.ts";
import { canonicalLoanOccurrenceScopeKey } from "../canonical/loan-admission.ts";
import { encodeCreditCardQueryBucket } from "../canonical/credit-card-query-inventory.ts";
import { createTestPGlite } from "./baseline-test-template.ts";
import { resetPGliteCanonicalStore } from "./canonical-reset.ts";
import {
  admitPGliteCanonicalFinancialCaptureInTransaction,
  commitPGliteCanonicalFinancialCapture,
  listPGliteExpectedOccurrences,
  refreshPGliteAdmittedFinancialProjection,
  type PGliteCanonicalFinancialCommitRequest,
  type PGliteDomainRecordCitation,
} from "./canonical-source-store.ts";
import { captureSourceRecordIdsSql } from "./capture-manifest.ts";
import {
  commitPGliteCanonicalCreditCardBalanceCapture,
  commitPGliteCanonicalCreditCardCapture,
  type PGliteCanonicalCreditCardBalanceCaptureRequest,
  type PGliteCanonicalCreditCardCaptureRequest,
  type PGliteCanonicalCreditCardCommitResult,
} from "./credit-card.ts";
import {
  commitPGliteCanonicalEInvoiceCapture,
  PGLITE_EINVOICE_CONTRACT_VERSION,
  PGLITE_EINVOICE_CURRENCY_AUTHORITY,
  PGLITE_EINVOICE_ROUTE,
} from "./einvoice.ts";
import type { CanonicalEInvoiceCaptureInput, CanonicalEInvoiceInput } from "../canonical/einvoice-contract.ts";
import { commitPGliteCanonicalInvestmentCapture, type PGliteCanonicalInvestmentCommitRequest } from "./investment.ts";
import { commitPGliteCanonicalLoanCapture, type PGliteCanonicalLoanCommitRequest } from "./loan.ts";
import {
  readTdccPositions,
  tdccPassbookMovementCapture,
  tdccSecuritiesHoldingCapture,
} from "../canonical/tdcc-investment-admission.ts";
import { resolvePGliteCanonicalLoanRepaymentRelations } from "./relations.ts";
import { PGliteCanonicalSourceAdmissionError } from "./source-admission-validation.ts";
import { PGliteStore } from "./transaction.ts";

const token = (value: string): string => `sha256:${createHash("sha256").update(value, "utf8").digest("base64url")}`;

const ROUTES = {
  deposit: {
    routeKey: "fubon/domestic-deposit/human-attested-v1",
    contractVersion: "human-attested-v1",
    namespace: "fubon",
    stream: "domestic-deposit",
    recordKind: "fubon-domestic-deposit",
    accountType: "depository",
    accountKind: "depository-account",
  },
  card: {
    routeKey: "fubon/credit-card/human-attested-v2",
    contractVersion: "fubon/credit-card/human-attested-v2",
    namespace: "fubon",
    stream: "credit-card",
    recordKind: "fubon-credit-card-transaction",
    accountType: "credit",
    accountKind: "credit-portfolio-account",
  },
  // Its route declares `descriptionDigest` revisable (ADR 0055).
  revisable: {
    routeKey: "yuanta/domestic-deposit/human-attested-v2",
    contractVersion: "human-attested-v2",
    namespace: "yuanta",
    stream: "domestic-deposit",
    recordKind: "yuanta-domestic-deposit",
    accountType: "depository",
    accountKind: "depository-account",
  },
} as const;

type SourceRow = Readonly<{
  /** Rows sharing an id and a date are members of one occurrence group. */
  id: string;
  date: string;
  amount?: string;
  bucketKey?: string;
  descriptionDigest?: string;
  /** Text of the fact only; the record's payload does not carry it. */
  note?: string;
  /** Stored record columns outside the payload, each set apart from its default. */
  record?: Readonly<Partial<Record<"contentHash" | "sequenceLexeme" | "collisionKey" | "description", string>>>;
}>;

type Window = Readonly<{ startDate: string; endDate: string }>;

const JANUARY: Window = { startDate: "2026-01-01", endDate: "2026-01-31" };
const SCOPE_KEY = token("scope");

function grouped(
  route: keyof typeof ROUTES,
  captureId: string,
  rows: readonly SourceRow[],
  options: Readonly<{
    window?: Window;
    coverage?: Window;
    bucketKeys?: readonly string[];
    occurrenceWithdrawals?: readonly string[];
    /** Key each fact by its occurrence, as the deposit command does. */
    sequenceByOccurrence?: boolean;
  }> = {},
): PGliteCanonicalFinancialCommitRequest {
  const contract = ROUTES[route];
  const window = options.window ?? JANUARY;
  const revisable = route === "revisable";
  const sequenceByOccurrence = revisable || options.sequenceByOccurrence === true;
  const slots = assignOccurrenceSlots({
    rows,
    complete: true,
    scopeKey: () => SCOPE_KEY,
    fingerprint: (row) => token(`row-${row.id}`),
    partitionDate: (row) => row.date,
    // A revisable field feeds the occurrence key but not the collision key.
    ...(revisable ? {
      key: (row: SourceRow, ordinal: number) => token(JSON.stringify([row.id, row.date, ordinal, row.descriptionDigest])),
      collisionKey: (row: SourceRow, ordinal: number) => token(JSON.stringify([row.id, row.date, ordinal])),
    } : {}),
  });
  const bucketKeys = options.bucketKeys ??
    (route === "card" ? [...new Set(rows.map((row) => row.bucketKey!))] : undefined);
  return {
    capture: {
      captureId,
      integrationNamespace: contract.namespace,
      sourceConnectionKey: token("connection"),
      identityEpoch: token("epoch"),
      stream: contract.stream,
      recordKind: contract.recordKind,
      routeKey: contract.routeKey,
      contractVersion: contract.contractVersion,
      subjectDigest: token("subject"),
      observedAt: "2026-09-30T00:00:00.000Z",
      accountNumber: {
        value: "123456",
        kind: contract.accountKind,
        evidenceVersion: "synthetic-v1",
        sourceField: "accountNumber",
      },
      scope: {
        ...window,
        dateFormat: "YYYY-MM-DD",
        kind: "bounded-range",
        completeness: "complete-range",
        completenessBasis: "full-bounded-range",
        ruleVersion: contract.routeKey,
        sourceAccountKey: "checking-account",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: rows.length, terminal: true, metadata: { pageCount: 1 } }],
      records: slots.map(({ row, occurrenceKey, collisionKey, group }) => ({
        occurrenceKey,
        collisionKey: row.record?.collisionKey ?? collisionKey,
        sequenceLexeme: row.record?.sequenceLexeme ?? `${row.date}/${group.fingerprint}/${group.ordinal}`,
        providerKey: "human-attested:no-provider-key",
        contentHash: row.record?.contentHash ?? token(JSON.stringify([row.date, row.id])),
        ...(row.record?.description === undefined ? {} : { description: row.record.description }),
        compact: {
          amount: { coefficient: row.amount ?? "100", scale: 0 },
          ...(row.descriptionDigest === undefined ? {} : { descriptionDigest: row.descriptionDigest }),
        },
        occurrenceGroup: group,
        ...(row.bucketKey === undefined ? {} : { occurrenceGroupBucketKey: row.bucketKey }),
      })),
      occurrenceGroupCoverage: [{
        scopeKey: SCOPE_KEY,
        ...(options.coverage ?? window),
        contractVersion: contract.contractVersion,
        ...(bucketKeys ? { bucketKeys } : {}),
      }],
    },
    account: {
      sourceAccountKey: "checking-account",
      accountNo: "123456",
      accountType: contract.accountType,
      currency: "TWD",
    },
    transactions: slots.map(({ row, occurrenceKey, group }) => ({
      sourceOccurrenceKey: occurrenceKey,
      sourceSequence: sequenceByOccurrence ? occurrenceKey : `${row.date}-${row.id}-${group.ordinal}`,
      amount: { coefficient: row.amount ?? "100", scale: 0 },
      currency: "TWD",
      direction: "outflow" as const,
      postingStatus: "posted" as const,
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: contract.routeKey,
      description: `row ${row.id} ${row.note ?? ""}`,
      economicStatus: "normal" as const,
      administrativeState: "active" as const,
      semanticRuleVersion: contract.routeKey,
      effectiveOn: row.date,
      transactionDateTimeLocal: `${row.date}T00:00:00+08:00`,
      timeZone: "Asia/Taipei" as const,
      timePrecision: "second" as const,
      timeOrigin: "source_reported" as const,
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: contract.routeKey,
      utcInstantUtcUs: Date.parse(`${row.date}T00:00:00.000+08:00`) * 1000,
    })),
    withdrawalPolicy: "never-infer",
    ...(options.occurrenceWithdrawals
      ? { occurrenceWithdrawals: options.occurrenceWithdrawals.map((withdrawnTransactionId) => ({ withdrawnTransactionId })) }
      : {}),
  };
}

/** A capture on a route without occurrence groups, whose omissions withdraw (ADR 0008). */
function ungrouped(
  captureId: string,
  ids: readonly string[],
  window: Window,
  options: Readonly<{
    /** A ledger balance read from the first record, measured at this instant. */
    balanceEffectiveAt?: string;
    /** Conversion evidence on the first record's fact. */
    conversion?: boolean;
  }> = {},
): PGliteCanonicalFinancialCommitRequest {
  const rule = "cathay/domestic-deposit/v1";
  return {
    capture: {
      captureId,
      integrationNamespace: "cathay",
      sourceConnectionKey: token("connection"),
      identityEpoch: token("epoch"),
      stream: "domestic-deposit",
      recordKind: "source-record",
      routeKey: rule,
      contractVersion: "v1",
      subjectDigest: token("subject"),
      observedAt: "2026-08-19T00:00:00.000Z",
      accountNumber: { value: "123456", kind: "depository-account", evidenceVersion: "synthetic-v1", sourceField: "accountNumber" },
      scope: { ...window, kind: "point-in-time", completeness: "single-page", ruleVersion: rule, sourceAccountKey: "synthetic-account-1" },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: ids.length, terminal: true, metadata: { pageCount: 1 } }],
      records: ids.map((id) => ({
        occurrenceKey: token(`occurrence-${id}`),
        collisionKey: token(`collision-${id}`),
        providerKey: token(`provider-${id}`),
        contentHash: token(`content-${id}`),
        compact: { amount: { coefficient: "100", scale: 0 } },
      })),
    },
    account: { sourceAccountKey: "synthetic-account-1", accountNo: "123456", accountType: "depository", currency: "TWD" },
    transactions: ids.map((id) => ({
      sourceOccurrenceKey: token(`occurrence-${id}`),
      sourceSequence: `sequence-${id}`,
      amount: { coefficient: "100", scale: 0 },
      currency: "TWD",
      direction: "inflow" as const,
      postingStatus: "posted" as const,
      postingOrigin: "provider_booked_history",
      postingBasis: "query-status-success-with-accounting-date",
      postingRuleVersion: rule,
      description: `row ${id}`,
      economicStatus: "normal" as const,
      administrativeState: "active" as const,
      semanticRuleVersion: rule,
      effectiveOn: "2026-01-01",
      transactionDateTimeLocal: "2026-01-01T00:00:00+08:00",
      timeZone: "Asia/Taipei" as const,
      timePrecision: "second" as const,
      timeOrigin: "source_reported" as const,
      effectiveTimeBasis: "accounting" as const,
      effectiveTimeRuleVersion: rule,
      utcInstantUtcUs: 1,
      ...(options.conversion && id === ids[0] ? { conversionEvidence: CONVERSION } : {}),
    })),
    ...(options.balanceEffectiveAt === undefined ? {} : {
      balanceObservations: [{
        observationKey: "ledger-balance",
        balanceKind: "ledger" as const,
        balance: { coefficient: "500", scale: 0 },
        currency: "TWD",
        effectiveAt: options.balanceEffectiveAt,
        effectiveTimeBasis: "source-reported" as const,
        effectiveTimeRuleVersion: rule,
        evidenceSourceRecordKey: `provider-${ids[0]}`,
        evidenceSourceField: "balance",
        evidenceSourceValue: "500",
        evidenceContractVersion: "v1",
        sourceOccurrenceKey: token(`occurrence-${ids[0]}`),
      }],
    }),
    withdrawalPolicy: "allow-inference",
  };
}

const CONVERSION = {
  originalAmount: { coefficient: "250", scale: 2 },
  originalCurrency: "USD",
  bookedAmount: { coefficient: "100", scale: 0 },
  bookedCurrency: "TWD",
  sourceReportedRate: {
    amount: { coefficient: "40", scale: 2 },
    baseCurrency: "USD",
    quoteCurrency: "TWD",
    observedOn: "2026-01-01",
  },
  impliedRate: null,
  comparison: "not-comparable" as const,
  feeAmount: null,
  feeCurrency: null,
  evidenceOrigin: "synthetic-conversion-v1",
};

type Ledger = Readonly<{
  arm: PGliteDomainRecordCitation;
  store: PGliteStore;
  clock: () => number;
  commit(request: PGliteCanonicalFinancialCommitRequest): Promise<void>;
  /** The commit must fail the same way in both arms and leave no rows. */
  rejects(request: PGliteCanonicalFinancialCommitRequest, reason: string): Promise<void>;
  /**
   * How the capture holds its records where records are reused. Where every
   * record is stored, the capture must own all of them.
   */
  holds(captureId: string, expected: Readonly<{ stored: number; reused: number }>): Promise<void>;
  transactionId(sourceSequence: string): Promise<string>;
  /**
   * Commit through the credit-card command. Where every record is stored,
   * the command still writes its own rows only where they changed.
   */
  commitCard(request: PGliteCanonicalCreditCardCaptureRequest): Promise<PGliteCanonicalCreditCardCommitResult>;
  commitCardBalance(request: PGliteCanonicalCreditCardBalanceCaptureRequest): Promise<void>;
  /** The card command must fail the same way in both arms. */
  rejectsCard(request: PGliteCanonicalCreditCardCaptureRequest, message: RegExp): Promise<void>;
  /** Commit through the e-invoice command, which also writes its observations only on change. */
  commitEInvoice(input: CanonicalEInvoiceCaptureInput): Promise<void>;
  /** Commit through the loan command, which also writes its relation provenance only on change. */
  commitLoan(request: PGliteCanonicalLoanCommitRequest): Promise<void>;
  /** Commit through the investment command, which also writes its name observations only on change. */
  commitInvestment(request: PGliteCanonicalInvestmentCommitRequest): Promise<void>;
}>;

function openLedger(store: PGliteStore, arm: PGliteDomainRecordCitation): Ledger {
  let tick = 1_000;
  const clock = () => (tick += 1);
  const commit = async (request: PGliteCanonicalFinancialCommitRequest) => {
    if (arm === "none") {
      await commitPGliteCanonicalFinancialCapture(store, request, { clock });
      return;
    }
    await store.transaction(async (transaction) => {
      const admitted = await admitPGliteCanonicalFinancialCaptureInTransaction(transaction, request, { clock }, "any");
      await refreshPGliteAdmittedFinancialProjection(transaction, [admitted], { clock });
    });
  };
  const cardOptions = () => ({ clock, ...(arm === "any" ? { reuseSourceRecords: false as const } : {}) });
  const domainOptions = cardOptions;
  return {
    arm,
    store,
    clock,
    commit,
    commitCard: (request) => commitPGliteCanonicalCreditCardCapture(store, request, cardOptions()),
    async commitEInvoice(input) {
      await commitPGliteCanonicalEInvoiceCapture(store, input, domainOptions());
    },
    async commitLoan(request) {
      await commitPGliteCanonicalLoanCapture(store, request, domainOptions());
    },
    async commitInvestment(request) {
      await commitPGliteCanonicalInvestmentCapture(store, request, domainOptions());
    },
    async commitCardBalance(request) {
      await commitPGliteCanonicalCreditCardBalanceCapture(store, request, cardOptions());
    },
    async rejectsCard(request, message) {
      await assert.rejects(
        commitPGliteCanonicalCreditCardCapture(store, request, cardOptions()),
        message,
        `${request.capture.captureId} is rejected (${arm})`,
      );
    },
    async rejects(request, reason) {
      await assert.rejects(
        commit(request).catch((error: unknown) => {
          // The second arm commits in its own transaction, so it sees the unclassified error.
          if (error instanceof PGliteCanonicalSourceAdmissionError) throw error;
          throw new PGliteCanonicalSourceAdmissionError("infrastructure", String(error), { cause: error });
        }),
        (error: unknown) => error instanceof PGliteCanonicalSourceAdmissionError && error.reason === reason,
        `${request.capture.captureId} is rejected as ${reason} (${arm})`,
      );
    },
    async holds(captureId, expected) {
      const { rows: [row] } = await store.query<{ stored: number; reused: number }>(
        `SELECT (SELECT count(*)::int FROM source_records record WHERE record.capture_id = capture.capture_id) AS stored,
                COALESCE((SELECT manifest.record_count FROM capture_source_record_manifests manifest
                           WHERE manifest.capture_id = capture.capture_id), 0)::int AS reused
           FROM source_captures capture WHERE capture.capture_key = $1`,
        [captureId],
      );
      assert.deepEqual(
        row,
        arm === "none" ? expected : { stored: expected.stored + expected.reused, reused: 0 },
        `${captureId} holds its records as expected (${arm})`,
      );
    },
    async transactionId(sourceSequence) {
      const { rows: [row] } = await store.query<{ id: string }>(
        "SELECT encode(transaction_id, 'hex')::uuid::text AS id FROM financial_transactions WHERE source_sequence = $1",
        [sourceSequence],
      );
      assert.ok(row, `transaction ${sourceSequence} exists`);
      return row.id;
    },
  };
}

/** Tables that hold the record copies themselves; `canonicalState` compares what readers derive from them instead. */
const RECORD_COPY_TABLES = new Set([
  "source_records",
  "source_record_scopes",
  "source_record_provenance",
  "assertion_provenance",
  "capture_source_record_manifests",
]);

/**
 * Columns no two runs agree on: a Canonical Reset stamps its commit with the
 * wall clock, and the others are digests over generated ids.
 */
const UNSTABLE_COLUMNS = new Set(["recorded_at_utc_us", "event_digest", "resolution_key", "relation_key"]);

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex").slice(0, 16);

/**
 * Every table as sorted rows, with each generated id replaced by a name built
 * from what the row means, so two runs of one scenario compare equal. A Source
 * Record is named by its content, not by the capture that stores it.
 */
async function canonicalState(store: PGliteStore): Promise<Record<string, readonly string[]>> {
  const names = new Map<string, string>();
  const name = async (sql: string) => {
    for (const row of (await store.query<{ id: string; name: string }>(sql)).rows) names.set(row.id, row.name);
  };
  const named = (alias: string) => `encode(${alias}, 'hex') AS id`;
  await name(`SELECT ${named("commit_id")}, 'commit#' || commit_sequence AS name FROM canonical_commits`);
  await name(`SELECT ${named("capture_id")}, 'capture:' || capture_key AS name FROM source_captures`);
  await name(`SELECT ${named("scope.scope_id")}, 'scope:' || capture.capture_key AS name
                FROM capture_scopes scope JOIN source_captures capture ON capture.capture_id = scope.capture_id`);
  await name(`SELECT ${named("source_connection_id")}, 'connection:' || integration_namespace AS name FROM source_connections`);
  await name(`SELECT ${named("identity_epoch_id")}, 'epoch:' || epoch_key AS name FROM identity_epochs`);
  await name(`SELECT ${named("source_subject_id")}, 'subject:' || stream || '/' || record_kind AS name FROM source_subjects`);
  await name(`SELECT ${named("account_id")}, 'account:' || stream || '/' || source_account_key AS name FROM financial_accounts`);
  await name(`SELECT ${named("transaction_id")}, 'transaction:' || source_sequence AS name FROM financial_transactions`);
  await name(`SELECT ${named("revision.revision_id")}, 'revision:' || financial.source_sequence || '#' || revision.revision_number AS name
                FROM transaction_revisions revision
                JOIN financial_transactions financial ON financial.transaction_id = revision.transaction_id`);
  await name(`SELECT ${named("assertion.assertion_id")},
                     'assertion:' || assertion.origin || '/' || assertion.field_name || '/'
                       || COALESCE(financial.source_sequence, '') || '#' || COALESCE(revision.revision_number::text, '')
                       || '/' || COALESCE(assertion.value_text, '') AS name
                FROM assertions assertion
                LEFT JOIN financial_transactions financial ON financial.transaction_id = assertion.transaction_id
                LEFT JOIN transaction_revisions revision ON revision.revision_id = assertion.revision_id`);
  await name(`SELECT ${named("coverage.coverage_id")},
                     'coverage:' || capture.capture_key || '/' || coverage.scope_key || '/' || coverage.scope_start AS name
                FROM source_occurrence_group_coverages coverage
                JOIN source_captures capture ON capture.capture_id = coverage.capture_id`);
  await name(`SELECT ${named("observation_id")}, 'balance:' || observation_key || '/' || balance_kind AS name FROM balance_observations`);
  const records = await store.query<{ id: string; occurrence_key: string; content: Record<string, unknown> }>(
    `SELECT ${named("source_record_id")}, occurrence_key,
            to_jsonb(record) - 'source_record_id' - 'capture_id' - 'commit_id' AS content
       FROM source_records record`,
  );
  const normalize = (value: unknown): unknown => {
    if (typeof value === "string") {
      const id = /^\\x([0-9a-f]{32})$/u.exec(value)?.[1];
      if (id !== undefined) return names.get(id) ?? "<generated id>";
      // Ids also appear as UUID text inside JSON a row stores as a string.
      return value.replace(
        /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gu,
        (uuid) => names.get(uuid.replaceAll("-", "")) ?? "<generated id>",
      );
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !UNSTABLE_COLUMNS.has(key))
        .map(([key, nested]) => [key, normalize(nested)]));
    return value;
  };
  for (const record of records.rows)
    names.set(record.id, `record:${record.occurrence_key}/${digest(normalize(record.content))}`);
  const rows = async (sql: string, params: readonly unknown[] = []) =>
    (await store.query<{ row: unknown }>(sql, [...params])).rows.map(({ row }) => JSON.stringify(normalize(row))).sort();

  const state: Record<string, readonly string[]> = {};
  const tables = await store.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  for (const { name: table } of tables.rows)
    if (!RECORD_COPY_TABLES.has(table)) state[table] = await rows(`SELECT to_jsonb(entry) AS row FROM "${table}" entry`);

  state["distinct source records"] = [...new Set(records.rows.map((record) => names.get(record.id)!))].sort();
  // What a capture saw: the records it owns or reused, each with the account its scope row names.
  state["capture members"] = await rows(
    `SELECT jsonb_build_object('capture', capture.capture_id, 'record', member.source_record_id,
                               'account', record_scope.account_id) AS row
       FROM source_captures capture
       JOIN LATERAL (${captureSourceRecordIdsSql("capture.capture_id")}) member ON TRUE
       JOIN source_record_scopes record_scope ON record_scope.source_record_id = member.source_record_id`,
  );
  // The assertions a capture saw, which withdrawal by omission reads (ADR 0008).
  state["capture sightings"] = [...new Set(await rows(
    `SELECT jsonb_build_object('capture', capture.capture_id, 'assertion', provenance.assertion_id) AS row
       FROM source_captures capture
       JOIN LATERAL (${captureSourceRecordIdsSql("capture.capture_id")}) member ON TRUE
       JOIN assertion_provenance provenance ON provenance.source_record_id = member.source_record_id`,
  ))];
  state["assertion sources"] = [...new Set(await rows(
    `SELECT to_jsonb(provenance) - 'commit_id' AS row FROM assertion_provenance provenance`,
  ))];
  const coverages = await store.query<{
    subject: string;
    record_kind: string;
    scope_key: string;
    contract_version: string;
    bucket_inventory_json: string;
  }>(
    `SELECT DISTINCT encode(source_subject_id, 'hex') AS subject, record_kind, scope_key, contract_version, bucket_inventory_json
       FROM source_occurrence_group_coverages WHERE bucket_inventory_json IS NOT NULL`,
  );
  const expected: string[] = [];
  for (const coverage of coverages.rows) {
    const bucketKeys = JSON.parse(coverage.bucket_inventory_json) as string[];
    const occurrences = await store.transaction((transaction) => listPGliteExpectedOccurrences(
      transaction,
      Uint8Array.from(Buffer.from(coverage.subject, "hex")),
      coverage.record_kind,
      { scopeKey: coverage.scope_key, contractVersion: coverage.contract_version, bucketKeys },
    ));
    for (const occurrence of occurrences)
      expected.push(JSON.stringify({
        ...occurrence,
        coverage: [names.get(coverage.subject), coverage.contract_version, bucketKeys],
        sourceRecordId: names.get(occurrence.sourceRecordId.replaceAll("-", "")),
        transactionId: occurrence.transactionId && names.get(occurrence.transactionId.replaceAll("-", "")),
      }));
  }
  state["expected occurrences"] = expected.sort();
  return state;
}

/**
 * Rows a commit writes as new evidence cite a Source Record their own capture
 * stored, never one it reused (ADR 0152). `canonicalState` names records by
 * content, so it cannot see a row that cites the right record through the
 * wrong capture.
 */
async function assertEvidenceCitesItsOwnCapture(store: PGliteStore, arm: PGliteDomainRecordCitation): Promise<void> {
  for (const [table, recordColumn] of [
    ["transaction_revisions", "source_record_id"],
    ["balance_observation_revisions", "source_record_id"],
    ["transaction_conversion_evidence", "source_record_id"],
    ["canonical_credit_card_instrument_evidence", "source_record_id"],
    ["canonical_credit_card_transaction_details", "source_record_id"],
    ["canonical_credit_card_transaction_lifecycle", "source_record_id"],
    ["canonical_credit_card_statement_summary_evidence", "evidence_source_record_id"],
    ["canonical_credit_card_relations", "evidence_source_record_id"],
    ["einvoice_invoice_revisions", "source_record_id"],
    ["einvoice_revision_observations", "source_record_id"],
    ["einvoice_revision_events", "source_record_id"],
    ["loan_transaction_facts", "source_record_id"],
    // The loan command's and the repayment resolver's, which cites the record of an endpoint's revision.
    ["transaction_relation_provenance", "source_record_id"],
    ["investment_security_name_observations", "source_record_id"],
    ["investment_holding_observations", "source_record_id"],
    ["investment_transactions", "source_record_id"],
    ["investment_passbook_movements", "source_record_id"],
    ["investment_margin_balance_observations", "source_record_id"],
  ] as const) {
    const { rows: [row] } = await store.query<{ rows: number; foreign: number }>(
      `SELECT count(*)::int AS rows,
              count(*) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM source_records record
                 WHERE record.source_record_id = entry.${recordColumn}
                   AND record.capture_id = entry.capture_id
              ))::int AS foreign
         FROM "${table}" entry`,
    );
    assert.equal(row!.foreign, 0, `every ${table} row cites a record its own capture stored (${arm}, ${row!.rows} rows)`);
  }
}

/** Run one sequence of commits with reuse and without, and require the same canonical state. */
function equivalent(name: string, scenario: (ledger: Ledger) => Promise<void>): void {
  test(`${name}: reusing records leaves canonical state as storing them does`, async () => {
    const states: Record<string, readonly string[]>[] = [];
    for (const arm of ["none", "any"] as const) {
      const store = new PGliteStore(await createTestPGlite("full"));
      try {
        await scenario(openLedger(store, arm));
        await assertEvidenceCitesItsOwnCapture(store, arm);
        states.push(await canonicalState(store));
      } finally {
        await store.close();
      }
    }
    const [reusing, storing] = states;
    assert.deepEqual(Object.keys(reusing!), Object.keys(storing!));
    for (const table of Object.keys(storing!)) {
      const onlyReusing = reusing![table]!.filter((entry) => !storing![table]!.includes(entry));
      const onlyStoring = storing![table]!.filter((entry) => !reusing![table]!.includes(entry));
      assert.deepEqual(
        { rows: reusing![table]!.length, onlyReusing },
        { rows: storing![table]!.length, onlyReusing: onlyStoring },
        `${table} is the same with reuse and without`,
      );
    }
  });
}

const row = (id: string, day: number, extra: Partial<SourceRow> = {}): SourceRow =>
  ({ id, date: `2026-01-${String(day).padStart(2, "0")}`, ...extra });

for (const route of ["deposit", "card"] as const) {
  const bucket = route === "card" ? { bucketKey: "2026-01" } : {};
  // Rows `b` form one occurrence group of two members.
  const rows = [row("a", 5, bucket), row("b", 6, bucket), row("b", 6, bucket), row("c", 7, bucket)];

  equivalent(`an unchanged re-sync (${route})`, async (ledger) => {
    await ledger.commit(grouped(route, "sync-1", rows));
    await ledger.holds("sync-1", { stored: 4, reused: 0 });
    for (const sync of ["sync-2", "sync-3"]) {
      await ledger.commit(grouped(route, sync, rows));
      await ledger.holds(sync, { stored: 0, reused: 4 });
    }
    const counts = await ledger.store.query<{ count: number }>("SELECT count(*)::int AS count FROM source_occurrence_group_counts");
    assert.equal(counts.rows[0]!.count, 3, "an unchanged re-sync adds no count row to the three groups");
    // The stored counts and copies still guard a group that loses a member.
    await ledger.rejects(grouped(route, "sync-shrunk", [rows[0]!, rows[1]!, rows[3]!]), "occurrence-conflict");
    // A grown group stores the new member and one raised count, which then guards it.
    const grown = [...rows, row("b", 6, bucket)];
    await ledger.commit(grouped(route, "sync-grown", grown));
    await ledger.holds("sync-grown", { stored: 1, reused: 4 });
    await ledger.rejects(grouped(route, "sync-shrunk-again", rows), "occurrence-conflict");
  });

  equivalent(`a changed fact (${route})`, async (ledger) => {
    await ledger.commit(grouped(route, "sync-1", rows));
    const revised = rows.map((entry) => (entry.id === "c" ? { ...entry, amount: "250" } : entry));
    // A changed amount changes the payload; ADR 0008 forbids overwriting the occurrence.
    await ledger.rejects(grouped(route, "sync-overwrite", revised), "occurrence-conflict");
    await ledger.commit(grouped(route, "sync-2", rows));
    await ledger.holds("sync-2", { stored: 0, reused: 4 });
  });

  equivalent(`a changed contract version (${route})`, async (ledger) => {
    await ledger.commit(grouped(route, "sync-1", rows));
    await ledger.commit(grouped(route, "sync-2", rows));
    // A route registers one contract version, so an upgrade is staged by
    // filing the stored coverage under the version that preceded it.
    await ledger.store.exec(`
      ALTER TABLE source_occurrence_group_coverages DISABLE TRIGGER USER;
      UPDATE source_occurrence_group_coverages SET contract_version = 'superseded-contract';
      ALTER TABLE source_occurrence_group_coverages ENABLE TRIGGER USER;`);
    await ledger.commit(grouped(route, "sync-3", rows));
    await ledger.holds("sync-3", { stored: 4, reused: 0 });
    const counted = await ledger.store.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM source_occurrence_group_counts group_count
         JOIN source_occurrence_group_coverages coverage ON coverage.coverage_id = group_count.coverage_id
         JOIN source_captures capture ON capture.capture_id = coverage.capture_id
        WHERE capture.capture_key = 'sync-3'`,
    );
    assert.equal(counted.rows[0]!.count, 3, "counts under the old contract version do not stand in for the new one");
    await ledger.rejects(grouped(route, "sync-shrunk", [rows[0]!, rows[1]!, rows[3]!]), "occurrence-conflict");
    await ledger.commit(grouped(route, "sync-4", rows));
    await ledger.holds("sync-4", { stored: 0, reused: 4 });
  });
}

equivalent("a changed bucket", async (ledger) => {
  const september = row("a", 5, { bucketKey: "2026-01" });
  const moving = (bucketKey: string) => row("b", 6, { bucketKey });
  const october = row("c", 7, { bucketKey: "2026-02" });
  const both = ["2026-01", "2026-02"];
  await ledger.commit(grouped("card", "sync-1", [september, moving("2026-01"), october], { bucketKeys: both }));
  await ledger.commit(grouped("card", "sync-2", [september, moving("2026-02"), october], { bucketKeys: both }));
  await ledger.holds("sync-2", { stored: 1, reused: 2 });
  await ledger.commit(grouped("card", "sync-3", [september, moving("2026-02"), october], { bucketKeys: both }));
  await ledger.holds("sync-3", { stored: 0, reused: 3 });
  // The moved record is now expected in its new bucket and no longer in its old one.
  await ledger.commit(grouped("card", "sync-old-bucket", [september], { bucketKeys: ["2026-01"] }));
  await ledger.holds("sync-old-bucket", { stored: 0, reused: 1 });
  await ledger.rejects(grouped("card", "sync-new-bucket", [october], { bucketKeys: ["2026-02"] }), "occurrence-conflict");
});

equivalent("a revisable payload field (ADR 0055)", async (ledger) => {
  const rows = (descriptionDigest: string, note: string) => [
    row("a", 5, { descriptionDigest: "digest-a" }),
    row("b", 6, { descriptionDigest, note }),
  ];
  const revisions = async () =>
    (await ledger.store.query<{ count: number }>("SELECT count(*)::int AS count FROM transaction_revisions")).rows[0]!.count;
  await ledger.commit(grouped("revisable", "sync-1", rows("digest-1", "first")));
  // The revised field changes the payload alone: the record is stored again, the fact stands.
  await ledger.commit(grouped("revisable", "sync-2", rows("digest-2", "first")));
  await ledger.holds("sync-2", { stored: 1, reused: 1 });
  assert.equal(await revisions(), 2, "an unchanged fact on a continued occurrence adds no revision");
  await ledger.commit(grouped("revisable", "sync-3", rows("digest-3", "second")));
  await ledger.holds("sync-3", { stored: 1, reused: 1 });
  assert.equal(await revisions(), 3, "a changed fact on a continued occurrence revises its transaction");
  await ledger.commit(grouped("revisable", "sync-4", rows("digest-3", "second")));
  await ledger.holds("sync-4", { stored: 0, reused: 2 });
});

equivalent("restore after an explicit withdrawal", async (ledger) => {
  const bucket = { bucketKey: "2026-01" };
  const rows = [row("a", 5, bucket), row("b", 6, bucket)];
  await ledger.commit(grouped("card", "sync-1", rows));
  const withdrawn = await ledger.transactionId("2026-01-06-b-1");
  await ledger.commit(grouped("card", "sync-2", [rows[0]!], { occurrenceWithdrawals: [withdrawn] }));
  await ledger.holds("sync-2", { stored: 0, reused: 1 });
  await ledger.commit(grouped("card", "sync-3", rows));
  await ledger.holds("sync-3", { stored: 0, reused: 2 });
  const events = await ledger.store.query<{ event_kind: string }>(
    `SELECT transition.event_kind FROM assertion_transitions transition
       JOIN canonical_commits commit_row ON commit_row.commit_id = transition.commit_id
      WHERE encode(transition.transaction_id, 'hex')::uuid::text = $1
        AND transition.field_name = 'transaction_revision'
      ORDER BY commit_row.commit_sequence`,
    [withdrawn],
  );
  assert.deepEqual(events.rows.map((event) => event.event_kind), ["observed", "withdrawn", "restored"]);
  // Restored, the member is expected again.
  await ledger.rejects(grouped("card", "sync-4", [rows[0]!]), "occurrence-conflict");
});

equivalent("several captures of one subject in one sync", async (ledger) => {
  const early: Window = { startDate: "2026-01-01", endDate: "2026-01-20" };
  const late: Window = { startDate: "2026-01-10", endDate: "2026-01-31" };
  const earlyRows = [row("a", 5), row("b", 12), row("c", 15)];
  const lateRows = [row("b", 12), row("c", 15), row("d", 25)];
  await ledger.commit(grouped("deposit", "early-1", earlyRows, { window: early }));
  await ledger.commit(grouped("deposit", "late-1", lateRows, { window: late }));
  // The rows both captures see were stored once by the first; the second
  // capture and every later sync reuse them.
  await ledger.holds("late-1", { stored: 1, reused: 2 });
  for (const sync of ["2", "3"]) {
    await ledger.commit(grouped("deposit", `early-${sync}`, earlyRows, { window: early }));
    await ledger.holds(`early-${sync}`, { stored: 0, reused: 3 });
    await ledger.commit(grouped("deposit", `late-${sync}`, lateRows, { window: late }));
    await ledger.holds(`late-${sync}`, { stored: 0, reused: 3 });
  }
});

equivalent("a rolling window", async (ledger) => {
  const rows = [row("a", 12), row("b", 15)];
  await ledger.commit(grouped("deposit", "sync-1", rows, { window: { startDate: "2026-01-01", endDate: "2026-01-29" } }));
  // The window and the coverage dates move a day per sync, as a collection window does.
  await ledger.commit(grouped("deposit", "sync-2", rows, { window: { startDate: "2026-01-02", endDate: "2026-01-30" } }));
  await ledger.holds("sync-2", { stored: 0, reused: 2 });
  await ledger.commit(grouped("deposit", "sync-3", rows, { window: { startDate: "2026-01-03", endDate: "2026-01-31" } }));
  await ledger.holds("sync-3", { stored: 0, reused: 2 });
  // A row the window has moved past is no longer covered, so its absence is not a loss.
  await ledger.commit(grouped("deposit", "sync-4", [rows[1]!], { window: { startDate: "2026-01-13", endDate: "2026-01-31" } }));
  await ledger.holds("sync-4", { stored: 0, reused: 1 });
  // Inside the window it is still guarded by the counts stored for its date.
  await ledger.rejects(grouped("deposit", "sync-5", [rows[1]!], { window: { startDate: "2026-01-12", endDate: "2026-01-31" } }), "occurrence-conflict");
});

equivalent("withdrawal by omission across a reusing capture, and its restore", async (ledger) => {
  const first: Window = { startDate: "20260101", endDate: "20260102" };
  const second: Window = { startDate: "20260102", endDate: "20260103" };
  await ledger.commit(ungrouped("owner", ["a", "b"], first));
  // Only this capture ties the records to the second window, and it stores none of them.
  await ledger.commit(ungrouped("reuser", ["a", "b"], second));
  await ledger.holds("reuser", { stored: 0, reused: 2 });
  await ledger.commit(ungrouped("omitter", ["a"], second));
  await ledger.holds("omitter", { stored: 0, reused: 1 });
  const withdrawals = await ledger.store.query<{ capture_key: string }>(
    `SELECT capture.capture_key FROM assertion_transitions transition
       JOIN source_captures capture ON capture.capture_id = transition.capture_id
      WHERE transition.event_kind = 'withdrawn' AND transition.field_name = 'transaction_revision'`,
  );
  assert.deepEqual(withdrawals.rows, [{ capture_key: "omitter" }], "the omitted record was withdrawn through the reusing capture");
  await ledger.commit(ungrouped("restorer", ["a", "b"], second));
  await ledger.holds("restorer", { stored: 0, reused: 2 });
  const latest = await ledger.store.query<{ event_kind: string }>(
    `SELECT transition.event_kind FROM assertion_transitions transition
       JOIN canonical_commits commit_row ON commit_row.commit_id = transition.commit_id
       JOIN financial_transactions financial ON financial.transaction_id = transition.transaction_id
      WHERE financial.source_sequence = 'sequence-b' AND transition.field_name = 'transaction_revision'
      ORDER BY commit_row.commit_sequence DESC LIMIT 1`,
  );
  assert.equal(latest.rows[0]!.event_kind, "restored");
});

equivalent("a record seen without its fact", async (ledger) => {
  const first: Window = { startDate: "20260101", endDate: "20260102" };
  const second: Window = { startDate: "20260102", endDate: "20260103" };
  await ledger.commit(ungrouped("owner", ["a", "b"], first));
  // The record of `b` arrives without its fact, so its copy backs no assertion:
  // reusing the stored one would make this capture a sighting of the fact.
  const bare = ungrouped("bare", ["a", "b"], second);
  await ledger.commit({ ...bare, transactions: bare.transactions.slice(0, 1), withdrawalPolicy: "never-infer" });
  await ledger.holds("bare", { stored: 1, reused: 1 });
  // No capture of the second window saw the fact of `b`, so omitting it there withdraws nothing.
  await ledger.commit(ungrouped("omitter", ["a"], second));
  const withdrawn = await ledger.store.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM assertion_transitions WHERE event_kind = 'withdrawn'",
  );
  assert.equal(withdrawn.rows[0]!.count, 0);
});

equivalent("a new balance measurement on an unchanged record", async (ledger) => {
  const window: Window = { startDate: "20260101", endDate: "20260102" };
  await ledger.commit(ungrouped("sync-1", ["a", "b"], window, { balanceEffectiveAt: "2026-01-02T00:00:00+08:00" }));
  await ledger.commit(ungrouped("sync-2", ["a", "b"], window, { balanceEffectiveAt: "2026-01-02T00:00:00+08:00" }));
  await ledger.holds("sync-2", { stored: 0, reused: 2 });
  // The record that carries the balance is unchanged, but its balance is
  // measured at a new instant, so a new balance revision cites it.
  await ledger.commit(ungrouped("sync-3", ["a", "b"], window, { balanceEffectiveAt: "2026-01-03T00:00:00+08:00" }));
  await ledger.holds("sync-3", { stored: 1, reused: 1 });
  const revisions = await ledger.store.query<{ count: number }>("SELECT count(*)::int AS count FROM balance_observation_revisions");
  assert.equal(revisions.rows[0]!.count, 2);
});

equivalent("a fact arriving for a record first seen without it", async (ledger) => {
  const window: Window = { startDate: "20260101", endDate: "20260102" };
  const bare = ungrouped("bare", ["a", "b"], window);
  await ledger.commit({ ...bare, transactions: bare.transactions.slice(1), withdrawalPolicy: "never-infer" });
  // The stored copy of `a` backs no assertion, and the fact of `a` now opens a
  // revision that cites its record, so the record is stored again.
  await ledger.commit(ungrouped("full", ["a", "b"], window));
  await ledger.holds("full", { stored: 1, reused: 1 });
  await ledger.commit(ungrouped("again", ["a", "b"], window));
  await ledger.holds("again", { stored: 0, reused: 2 });
});

equivalent("conversion evidence added to an unchanged record", async (ledger) => {
  const window: Window = { startDate: "20260101", endDate: "20260102" };
  await ledger.commit(ungrouped("sync-1", ["a", "b"], window));
  // The latest copy of `a` comes to back no assertion, so only the planned
  // citation keeps the conversion evidence below off a reused record.
  const bare = ungrouped("bare", ["a", "b"], window);
  await ledger.commit({ ...bare, transactions: bare.transactions.slice(1), withdrawalPolicy: "never-infer" });
  await ledger.holds("bare", { stored: 1, reused: 1 });
  // The fact of `a` gains conversion evidence its revision lacks, which cites its record.
  await ledger.commit(ungrouped("sync-2", ["a", "b"], window, { conversion: true }));
  await ledger.holds("sync-2", { stored: 1, reused: 1 });
  await ledger.commit(ungrouped("sync-3", ["a", "b"], window, { conversion: true }));
  await ledger.holds("sync-3", { stored: 0, reused: 2 });
  const evidence = await ledger.store.query<{ count: number }>("SELECT count(*)::int AS count FROM transaction_conversion_evidence");
  assert.equal(evidence.rows[0]!.count, 1);
});

// Each stored column outside the payload and the group decides reuse on its own.
for (const column of ["contentHash", "sequenceLexeme", "collisionKey", "description"] as const) {
  equivalent(`a changed ${column}`, async (ledger) => {
    const rows = [row("a", 5), row("b", 6), row("c", 7)];
    const changed = rows.map((entry) => entry.id === "b" ? { ...entry, record: { [column]: token(`changed-${column}`) } } : entry);
    await ledger.commit(grouped("deposit", "sync-1", rows));
    await ledger.commit(grouped("deposit", "sync-2", changed));
    await ledger.holds("sync-2", { stored: 1, reused: 2 });
    await ledger.commit(grouped("deposit", "sync-3", changed));
    await ledger.holds("sync-3", { stored: 0, reused: 3 });
  });
}

equivalent("counterparty evidence on a reused record", async (ledger) => {
  const rows = [row("a", 5), row("b", 6)];
  // Without a revision of its own, a stored copy leads to its transaction
  // only through a fact keyed by its occurrence, which is how deposits key them.
  const owner = grouped("deposit", "owner", rows, { sequenceByOccurrence: true });
  await ledger.commit(owner);
  await ledger.commit(grouped("deposit", "reuser", rows, { sequenceByOccurrence: true }));
  await ledger.holds("reuser", { stored: 0, reused: 2 });
  await resolvePGliteCanonicalLoanRepaymentRelations(ledger.store, {
    sourceConnectionKey: owner.capture.sourceConnectionKey,
    observedAt: owner.capture.observedAt,
    counterpartyEvidence: [{
      captureId: "reuser",
      sourceRecordKey: owner.capture.records[1]!.occurrenceKey,
      sourceConnectionKey: owner.capture.sourceConnectionKey,
      identityEpochKey: owner.capture.identityEpoch,
      accountKey: "checking-account",
      accountValue: "123456789012",
      role: "beneficiary",
      purpose: "loan_repayment",
      evidenceKind: "transaction-counterparty-account",
      contractVersion: "loan/canonical/v2.fubon",
    }],
  }, { clock: ledger.clock });
  const evidence = await ledger.store.query<{ source_sequence: string | null; capture_key: string }>(
    `SELECT financial.source_sequence, capture.capture_key
       FROM transaction_counterparty_account_evidence evidence
       JOIN source_captures capture ON capture.capture_id = evidence.capture_id
       LEFT JOIN financial_transactions financial ON financial.transaction_id = evidence.transaction_id`,
  );
  assert.deepEqual(evidence.rows, [{ source_sequence: owner.capture.records[1]!.occurrenceKey, capture_key: "reuser" }]);
});

equivalent("a Canonical Reset", async (ledger) => {
  const rows = [row("a", 5), row("b", 6)];
  await ledger.commit(grouped("deposit", "sync-1", rows));
  await ledger.commit(grouped("deposit", "sync-2", rows));
  await resetPGliteCanonicalStore(ledger.store);
  const kept = await ledger.store.query<{ count: number }>(
    `SELECT (SELECT count(*) FROM source_records)::int + (SELECT count(*) FROM capture_source_record_manifests)::int AS count`,
  );
  assert.equal(kept.rows[0]!.count, 0, "a reset leaves no record and no manifest");
  // Nothing stored is left to reuse, so the first capture after a reset stores its records.
  await ledger.commit(grouped("deposit", "sync-3", rows));
  await ledger.holds("sync-3", { stored: 2, reused: 0 });
  await ledger.commit(grouped("deposit", "sync-4", rows));
  await ledger.holds("sync-4", { stored: 0, reused: 2 });
});

const CARD_ROUTE = "esun/credit-card/human-attested-v4";
const monthBucket = encodeCreditCardQueryBucket({ kind: "month", month: "2026/09" });

/** One billed purchase through the credit-card command, which writes its lifecycle row. */
function cardCommandCapture(captureId: string): PGliteCanonicalCreditCardCaptureRequest {
  const instrument = token("instrument-occurrence");
  const purchase = token("transaction-occurrence");
  const statement = token("statement-occurrence");
  const scopeKey = token("credit-card-occurrence-scope");
  const records = [
    { occurrenceKey: instrument, providerKey: token("instrument-provider"), contentHash: token("instrument-content"), compact: { kind: "instrument", instrumentKey: "opaque-primary" } },
    {
      occurrenceKey: purchase,
      occurrenceGroup: { scopeKey, fingerprint: token("credit-card-economic-fingerprint"), partitionDate: "2026-09-22", ordinal: 1 },
      occurrenceGroupBucketKey: monthBucket,
      providerKey: token("transaction-provider"),
      contentHash: token("transaction-content"),
      compact: { kind: "transaction", amount: "1000" },
      description: "Card purchase",
    },
    { occurrenceKey: statement, providerKey: token("statement-provider"), contentHash: token("statement-content"), compact: { kind: "statement", statementKey: "statement-1" }, description: "Statement" },
  ];
  return {
    capture: {
      captureId,
      integrationNamespace: "esun",
      sourceConnectionKey: token("card-connection"),
      identityEpoch: token("card-epoch"),
      stream: "credit-card",
      recordKind: "credit-card-capture",
      routeKey: CARD_ROUTE,
      contractVersion: CARD_ROUTE,
      subjectDigest: token("card-subject"),
      observedAt: "2026-09-22T01:00:00.000Z",
      scope: {
        startDate: "2026-09-22",
        endDate: "2026-09-22",
        dateFormat: "YYYY-MM-DD",
        kind: "bounded-range",
        completeness: "complete-range",
        ruleVersion: CARD_ROUTE,
        completenessBasis: "credit-card-check",
        sourceAccountKey: "credit-portfolio-1",
        absenceAuthority: "comparable-complete-range",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: records.length, terminal: true, metadata: { fixture: "source-record-reuse" } }],
      records,
      occurrenceGroupCoverage: [{ scopeKey, startDate: "2026-09-22", endDate: "2026-09-22", contractVersion: CARD_ROUTE, bucketKeys: [monthBucket] }],
    },
    account: { sourceAccountKey: "credit-portfolio-1", accountType: "credit", currency: "TWD" },
    identity: { accountNaturalKey: token("opaque-card-account"), identityMethod: "opaque-provider-account" },
    instruments: [{ instrumentKey: "opaque-primary", cardMask: "****4281", role: "primary", lifecycle: "active", evidenceSourceOccurrenceKey: instrument }],
    transactions: [{
      sourceOccurrenceKey: purchase,
      sourceSequence: "transaction-1",
      amount: { coefficient: "1000", scale: 0 },
      currency: "TWD",
      direction: "outflow",
      postingStatus: "posted",
      postingOrigin: "provider_booked_history",
      postingBasis: "statement-posted-history",
      postingRuleVersion: CARD_ROUTE,
      description: "Card purchase",
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: CARD_ROUTE,
      effectiveOn: "2026-09-22",
      transactionDateTimeLocal: "2026-09-22T10:00:00",
      timeZone: "Asia/Taipei",
      timePrecision: "minute",
      timeOrigin: "source_reported",
      effectiveTimeBasis: "source-reported",
      effectiveTimeRuleVersion: CARD_ROUTE,
      utcInstantUtcUs: Date.parse("2026-09-22T02:00:00Z") * 1000,
      instrumentKey: "opaque-primary",
      billingStatus: "billed",
      consumeDate: "2026-09-22",
      postingDate: "2026-09-22",
      effectiveDateBasis: "consume-date",
      statementKey: "statement-1",
    }],
    statements: [{
      statementKey: "statement-1",
      revisionKey: "statement-revision-1",
      cycleStart: "2026-09-01",
      cycleEnd: "2026-09-30",
      issueDate: "2026-10-01",
      dueDate: "2026-10-20",
      currency: "TWD",
      balance: { coefficient: "1000", scale: 0 },
      minimumPayment: { coefficient: "100", scale: 0 },
      transactionSourceOccurrenceKeys: [purchase],
      evidenceSourceOccurrenceKey: statement,
    }],
    relations: [],
  };
}

equivalent("card lifecycle read across a reusing capture", async (ledger) => {
  const command = cardCommandCapture("command-1");
  await ledger.commitCard(command);
  // The same records through the shared commit: a capture that writes no lifecycle row.
  await ledger.commit({
    capture: { ...command.capture, captureId: "shared-2" },
    account: command.account,
    transactions: command.transactions,
    withdrawalPolicy: "never-infer",
  });
  await ledger.holds("shared-2", { stored: 0, reused: 3 });
  // Billed Monotonicity reads the purchase's lifecycle by transaction, so it
  // still finds it billed and refuses to see it unbilled again (ADR 0062).
  const unbilled = cardCommandCapture("command-3");
  await ledger.rejectsCard({
    ...unbilled,
    transactions: unbilled.transactions.map(({ statementKey: _statementKey, ...fact }) => ({ ...fact, billingStatus: "unbilled" as const })),
    statements: [],
  }, /cannot reduce their billed member count/u);
  await ledger.commitCard(cardCommandCapture("command-4"));
});

const CARD_SCOPE_KEY = token("card-scope");
const SEPTEMBER_STATEMENT = encodeCreditCardQueryBucket({ kind: "statement", period: "2026/09" });
const UNBILLED = encodeCreditCardQueryBucket({ kind: "unbilled" });
const september = (day: number): string => `2026-09-${String(day).padStart(2, "0")}`;

/** One purchase on the card. Rows sharing an id and a day are members of one occurrence group. */
type CardPurchase = Readonly<{
  id: string;
  day: number;
  /** Billed purchases sit in the September statement bucket and on its statement; unbilled ones in the unbilled bucket. */
  billing?: "billed" | "unbilled";
  instrument?: string;
  /** Card details that change nothing in the record or the fact; a billed purchase posts on its day unless told otherwise. */
  postingDay?: number | null;
  /** A billed purchase the statement does not list yet. */
  onStatement?: false;
  consumeDay?: number;
  effectiveDateBasis?: "consume-date" | "posting-date-fallback";
  /** Text of the fact only; the record's payload does not carry it. */
  note?: string;
}>;

type CardSync = Readonly<{
  /** Each listed card and the listing record that evidences it. */
  instruments?: readonly Readonly<{ key: string; evidence: string }>[];
  /** The September statement, when any purchase is billed. */
  statement?: Readonly<{ revision: string; balance: string; evidence: string }>;
}>;

/** A complete September capture through the credit-card command. */
function cardSync(captureId: string, purchases: readonly CardPurchase[], options: CardSync = {}): PGliteCanonicalCreditCardCaptureRequest {
  const instruments = options.instruments ?? [{ key: "primary", evidence: "listing-1" }];
  const statement = options.statement ?? { revision: "revision-1", balance: "1000", evidence: "statement-1" };
  const slots = assignOccurrenceSlots({
    rows: purchases,
    complete: true,
    scopeKey: () => CARD_SCOPE_KEY,
    fingerprint: (purchase) => token(`purchase-${purchase.id}`),
    partitionDate: (purchase) => september(purchase.day),
  });
  const listed = slots.filter(({ row }) => (row.billing ?? "billed") === "billed" && row.onStatement !== false);
  const statementOccurrence = token(`statement:${statement.evidence}`);
  const records = [
    ...[...new Set(instruments.map((instrument) => instrument.evidence))].map((evidence) => ({
      occurrenceKey: token(`instrument:${evidence}`),
      providerKey: token(`instrument-provider:${evidence}`),
      contentHash: token(`instrument-content:${evidence}`),
      compact: { kind: "instrument", listing: evidence },
    })),
    ...slots.map(({ row, occurrenceKey, collisionKey, group }) => ({
      occurrenceKey,
      collisionKey,
      providerKey: token(`purchase-provider:${row.id}:${group.ordinal}`),
      contentHash: token(`purchase-content:${row.id}`),
      compact: { kind: "transaction", amount: "100" },
      occurrenceGroup: group,
      occurrenceGroupBucketKey: (row.billing ?? "billed") === "billed" ? SEPTEMBER_STATEMENT : UNBILLED,
    })),
    ...(listed.length === 0 ? [] : [{
      occurrenceKey: statementOccurrence,
      providerKey: token(`statement-provider:${statement.evidence}`),
      contentHash: token(`statement-content:${statement.evidence}`),
      compact: { kind: "statement", evidence: statement.evidence },
    }]),
  ];
  return {
    capture: {
      captureId,
      integrationNamespace: "esun",
      sourceConnectionKey: token("card-connection"),
      identityEpoch: token("card-epoch"),
      stream: "credit-card",
      recordKind: "credit-card-capture",
      routeKey: CARD_ROUTE,
      contractVersion: CARD_ROUTE,
      subjectDigest: token("card-subject"),
      observedAt: "2026-09-30T01:00:00.000Z",
      scope: {
        startDate: september(1),
        endDate: september(30),
        dateFormat: "YYYY-MM-DD",
        kind: "bounded-range",
        completeness: "complete-range",
        ruleVersion: CARD_ROUTE,
        completenessBasis: "credit-card-check",
        sourceAccountKey: "credit-portfolio-1",
        absenceAuthority: "comparable-complete-range",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: records.length, terminal: true, metadata: { fixture: "source-record-reuse" } }],
      records,
      occurrenceGroupCoverage: [{
        scopeKey: CARD_SCOPE_KEY,
        startDate: september(1),
        endDate: september(30),
        contractVersion: CARD_ROUTE,
        bucketKeys: [SEPTEMBER_STATEMENT, UNBILLED],
      }],
    },
    account: { sourceAccountKey: "credit-portfolio-1", accountType: "credit", currency: "TWD" },
    identity: { accountNaturalKey: token("opaque-card-account"), identityMethod: "opaque-provider-account" },
    instruments: instruments.map((instrument, index) => ({
      instrumentKey: instrument.key,
      cardMask: `****${4281 + index}`,
      role: index === 0 ? "primary" : "supplementary",
      lifecycle: "active",
      evidenceSourceOccurrenceKey: token(`instrument:${instrument.evidence}`),
    })),
    transactions: slots.map(({ row, occurrenceKey, group }) => {
      const isBilled = (row.billing ?? "billed") === "billed";
      return {
        sourceOccurrenceKey: occurrenceKey,
        sourceSequence: `purchase-${row.id}-${group.ordinal}`,
        amount: { coefficient: "100", scale: 0 },
        currency: "TWD",
        direction: "outflow" as const,
        postingStatus: "posted" as const,
        postingOrigin: "provider_booked_history",
        postingBasis: "statement-posted-history",
        postingRuleVersion: CARD_ROUTE,
        description: `purchase ${row.id} ${row.note ?? ""}`,
        economicStatus: "normal" as const,
        administrativeState: "active" as const,
        semanticRuleVersion: CARD_ROUTE,
        effectiveOn: september(row.day),
        transactionDateTimeLocal: `${september(row.day)}T10:00:00`,
        timeZone: "Asia/Taipei" as const,
        timePrecision: "minute" as const,
        timeOrigin: "source_reported" as const,
        effectiveTimeBasis: "source-reported",
        effectiveTimeRuleVersion: CARD_ROUTE,
        utcInstantUtcUs: Date.parse(`${september(row.day)}T02:00:00Z`) * 1000,
        instrumentKey: row.instrument ?? "primary",
        billingStatus: isBilled ? "billed" as const : "unbilled" as const,
        consumeDate: september(row.consumeDay ?? row.day),
        postingDate: isBilled && row.postingDay !== null ? september(row.postingDay ?? row.day) : null,
        effectiveDateBasis: row.effectiveDateBasis ?? "consume-date",
        statementKey: isBilled && row.onStatement !== false ? "statement-2026-09" : null,
      };
    }),
    statements: listed.length === 0 ? [] : [{
      statementKey: "statement-2026-09",
      revisionKey: statement.revision,
      cycleStart: september(1),
      cycleEnd: september(30),
      issueDate: "2026-10-01",
      dueDate: "2026-10-20",
      currency: "TWD",
      balance: { coefficient: statement.balance, scale: 0 },
      minimumPayment: { coefficient: "100", scale: 0 },
      transactionSourceOccurrenceKeys: listed.map((slot) => slot.occurrenceKey),
      evidenceSourceOccurrenceKey: statementOccurrence,
    }],
    relations: [],
  };
}

/** A current used-credit reading of the card account, measured at `effectiveAt`. */
function usedCredit(captureId: string, effectiveAt: string): PGliteCanonicalCreditCardBalanceCaptureRequest {
  const history = cardSync(captureId, []);
  const usedCreditRoute = "esun/credit-card/current-used-credit-v1";
  const occurrenceKey = token(`used-credit:${effectiveAt}`);
  return {
    capture: {
      ...history.capture,
      recordKind: "credit-card-current-used-credit",
      routeKey: usedCreditRoute,
      contractVersion: usedCreditRoute,
      scope: { ...history.capture.scope, kind: "point-in-time", completeness: "single-page", ruleVersion: usedCreditRoute, absenceAuthority: undefined },
      occurrenceGroupCoverage: undefined,
      records: [{ occurrenceKey, providerKey: token(`used-credit-provider:${effectiveAt}`), contentHash: token(`used-credit-content:${effectiveAt}`), compact: { kind: "balance", effectiveAt } }],
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: 1, terminal: true, metadata: {} }],
    },
    account: history.account,
    identity: history.identity,
    balance: {
      observation: {
        observationKey: "issuer-aggregate",
        balanceKind: "credit_used",
        balance: { coefficient: "500", scale: 0 },
        currency: "TWD",
        effectiveAt,
        effectiveTimeBasis: "provider-http-date",
        effectiveTimeRuleVersion: usedCreditRoute,
        evidenceSourceRecordKey: occurrenceKey,
        evidenceSourceField: "usedCredit",
        evidenceSourceValue: "500",
        evidenceContractVersion: usedCreditRoute,
        sourceOccurrenceKey: occurrenceKey,
        evidenceEndpoint: "https://issuer.example/current-used-credit",
        evidenceResponseStatus: 200,
        evidenceCachePolicy: "no-store",
      },
      estimate: { kind: "estimate", basis: "provider-used-credit", formula: "provider-used-credit" },
    },
  };
}

/** Rows in each table the credit-card command writes only on change. */
async function cardRowCounts(store: PGliteStore): Promise<Record<string, number>> {
  const { rows: [row] } = await store.query<Record<string, number>>(
    `SELECT (SELECT count(*) FROM canonical_credit_card_instrument_evidence)::int AS instrument_evidence,
            (SELECT count(*) FROM canonical_credit_card_transaction_details)::int AS details,
            (SELECT count(*) FROM canonical_credit_card_transaction_lifecycle)::int AS lifecycle,
            (SELECT count(*) FROM canonical_credit_card_statement_summary_evidence)::int AS statement_summary`,
  );
  return { ...row! };
}

/**
 * The latest stored card rows, by highest commit sequence, say what the last
 * commit's request says: each instrument's evidence, each transaction's
 * details and lifecycle on its current revision, and the statement's summary.
 * A commit that skips a row it should have written leaves an older value
 * here, which the comparison between arms cannot see, since both skip it.
 */
async function assertLatestCardRows(store: PGliteStore, request: PGliteCanonicalCreditCardCaptureRequest): Promise<void> {
  const latest = (table: string, where: string) => `
    SELECT entry.* FROM ${table} entry
      JOIN source_captures entry_capture ON entry_capture.capture_id = entry.capture_id
      JOIN canonical_commits entry_commit ON entry_commit.commit_id = entry_capture.commit_id
     WHERE ${where}
     ORDER BY entry_commit.commit_sequence DESC LIMIT 1`;
  for (const instrument of request.instruments) {
    const { rows } = await store.query<{ occurrence_key: string }>(
      `SELECT record.occurrence_key
         FROM canonical_credit_card_instruments instrument
         JOIN LATERAL (${latest("canonical_credit_card_instrument_evidence", "entry.instrument_id = instrument.instrument_id")}) evidence ON TRUE
         JOIN source_records record ON record.source_record_id = evidence.source_record_id
        WHERE instrument.instrument_key = $1`,
      [instrument.instrumentKey],
    );
    assert.deepEqual(rows, [{ occurrence_key: instrument.evidenceSourceOccurrenceKey }], `latest evidence of ${instrument.instrumentKey}`);
  }
  for (const fact of request.transactions) {
    const current = await store.query<Record<string, unknown>>(
      `SELECT instrument.instrument_key, details.billing_status, details.consume_date, details.posting_date,
              details.effective_date_basis, details.statement_key,
              details.revision_id = current_revision.revision_id AS details_on_current_revision,
              lifecycle_instrument.instrument_key AS lifecycle_instrument_key,
              lifecycle.billing_status AS lifecycle_billing_status, lifecycle.statement_key AS lifecycle_statement_key,
              lifecycle.revision_id = current_revision.revision_id AS lifecycle_on_current_revision
         FROM financial_transactions financial
         JOIN LATERAL (SELECT revision_id FROM transaction_revisions revision
                        WHERE revision.transaction_id = financial.transaction_id
                        ORDER BY revision_number DESC LIMIT 1) current_revision ON TRUE
         JOIN LATERAL (${latest("canonical_credit_card_transaction_details", "entry.transaction_id = financial.transaction_id")}) details ON TRUE
         JOIN canonical_credit_card_instruments instrument ON instrument.instrument_id = details.instrument_id
         JOIN LATERAL (${latest("canonical_credit_card_transaction_lifecycle", "entry.transaction_id = financial.transaction_id")}) lifecycle ON TRUE
         JOIN canonical_credit_card_instruments lifecycle_instrument ON lifecycle_instrument.instrument_id = lifecycle.instrument_id
        WHERE financial.source_sequence = $1`,
      [fact.sourceSequence],
    );
    assert.deepEqual(current.rows, [{
      instrument_key: fact.instrumentKey,
      billing_status: fact.billingStatus,
      consume_date: fact.consumeDate ?? null,
      posting_date: fact.postingDate ?? null,
      effective_date_basis: fact.effectiveDateBasis ?? null,
      statement_key: fact.statementKey ?? null,
      details_on_current_revision: true,
      lifecycle_instrument_key: fact.instrumentKey,
      lifecycle_billing_status: fact.billingStatus,
      lifecycle_statement_key: fact.statementKey ?? null,
      lifecycle_on_current_revision: true,
    }], `latest card rows of ${fact.sourceSequence}`);
  }
  for (const statement of request.statements) {
    const { rows } = await store.query<{ revision_key: string; evidence_key: string }>(
      `SELECT revision.revision_key, summary.evidence_key
         FROM canonical_credit_card_statements statement
         JOIN LATERAL (${latest(
           "canonical_credit_card_statement_summary_evidence",
           `entry.statement_revision_id IN (SELECT statement_revision_id FROM canonical_credit_card_statement_revisions
                                            WHERE statement_id = statement.statement_id)`,
         )}) summary ON TRUE
         JOIN canonical_credit_card_statement_revisions revision ON revision.statement_revision_id = summary.statement_revision_id
        WHERE statement.statement_key = $1`,
      [statement.statementKey],
    );
    assert.deepEqual(rows, [{ revision_key: statement.revisionKey, evidence_key: statement.evidenceSourceOccurrenceKey }], `latest summary of ${statement.statementKey}`);
  }
}

/** Commit through the card command and require the latest card rows to match the request. */
async function cardCommit(ledger: Ledger, request: PGliteCanonicalCreditCardCaptureRequest): Promise<PGliteCanonicalCreditCardCommitResult> {
  const result = await ledger.commitCard(request);
  await assertLatestCardRows(ledger.store, request);
  return result;
}

// Rows `b` form one occurrence group of two members; `hold` is not billed yet.
const CARD_PURCHASES: readonly CardPurchase[] = [
  { id: "a", day: 5 },
  { id: "b", day: 6 },
  { id: "b", day: 6 },
  { id: "hold", day: 20, billing: "unbilled" },
];

equivalent("an unchanged card re-sync", async (ledger) => {
  await cardCommit(ledger, cardSync("sync-1", CARD_PURCHASES));
  await ledger.holds("sync-1", { stored: 6, reused: 0 });
  const written = await cardRowCounts(ledger.store);
  assert.deepEqual(written, { instrument_evidence: 1, details: 4, lifecycle: 4, statement_summary: 1 });
  for (const sync of ["sync-2", "sync-3"]) {
    await cardCommit(ledger, cardSync(sync, CARD_PURCHASES));
    await ledger.holds(sync, { stored: 0, reused: 6 });
  }
  assert.deepEqual(await cardRowCounts(ledger.store), written, "an unchanged re-sync writes no card row");
});

equivalent("an unbilled purchase billed under a new occurrence (ADR 0040)", async (ledger) => {
  await cardCommit(ledger, cardSync("sync-1", CARD_PURCHASES));
  // The issuer rewrote the merchant text at posting, so the billed row is a
  // new occurrence on the same card, day and direction, and supersedes the hold.
  const posted = [...CARD_PURCHASES.slice(0, 3), { id: "hold-posted", day: 20 }];
  const statement = { revision: "revision-2", balance: "1100", evidence: "statement-1" };
  await cardCommit(ledger, cardSync("sync-2", posted, { statement }));
  // The successor is new, and the statement's new revision cites its unchanged record again.
  await ledger.holds("sync-2", { stored: 2, reused: 4 });
  const relations = await ledger.store.query<{ relation_kind: string; capture_key: string }>(
    `SELECT relation.relation_kind, capture.capture_key FROM canonical_credit_card_relations relation
       JOIN source_captures capture ON capture.capture_id = relation.capture_id`,
  );
  assert.deepEqual(relations.rows, [{ relation_kind: "unbilled_to_billed", capture_key: "sync-2" }]);
  await cardCommit(ledger, cardSync("sync-3", posted, { statement }));
  await ledger.holds("sync-3", { stored: 0, reused: 6 });
  // The replaced hold cannot be listed again.
  await ledger.rejectsCard(cardSync("sync-relisted", [...posted, CARD_PURCHASES[3]!], { statement }), /replaced by its billed successor/u);
});

equivalent("an unbilled purchase billed under its own occurrence", async (ledger) => {
  await cardCommit(ledger, cardSync("sync-1", CARD_PURCHASES));
  const hold = (change: Partial<CardPurchase>) =>
    CARD_PURCHASES.map((purchase) => (purchase.id === "hold" ? { ...purchase, ...change } : purchase));
  // Billed before it posts or reaches a statement: the record moves bucket,
  // and only the billing status of its details and lifecycle changes.
  await cardCommit(ledger, cardSync("sync-2", hold({ billing: "billed", postingDay: null, onStatement: false })));
  await ledger.holds("sync-2", { stored: 1, reused: 5 });
  assert.deepEqual(await cardRowCounts(ledger.store), { instrument_evidence: 1, details: 5, lifecycle: 5, statement_summary: 1 });
  // It posts: its details change, its record does not, and the new details row cites it.
  await cardCommit(ledger, cardSync("sync-3", hold({ billing: "billed", postingDay: 21, onStatement: false })));
  await ledger.holds("sync-3", { stored: 1, reused: 5 });
  assert.deepEqual(await cardRowCounts(ledger.store), { instrument_evidence: 1, details: 6, lifecycle: 5, statement_summary: 1 });
  // The statement lists it: a new statement revision, and a statement key on both rows.
  const billed = hold({ billing: "billed", postingDay: 21 });
  const statement = { revision: "revision-2", balance: "1100", evidence: "statement-1" };
  await cardCommit(ledger, cardSync("sync-4", billed, { statement }));
  await ledger.holds("sync-4", { stored: 2, reused: 4 });
  assert.deepEqual(await cardRowCounts(ledger.store), { instrument_evidence: 1, details: 7, lifecycle: 6, statement_summary: 2 });
  await cardCommit(ledger, cardSync("sync-5", billed, { statement }));
  await ledger.holds("sync-5", { stored: 0, reused: 6 });
  // Billed, it may not revert (ADR 0062).
  await ledger.rejectsCard(cardSync("sync-reverted", CARD_PURCHASES, { statement }), /cannot reduce their billed member count/u);
});

equivalent("a billed card purchase that vanishes", async (ledger) => {
  await cardCommit(ledger, cardSync("sync-1", CARD_PURCHASES));
  await ledger.commitCard(cardSync("sync-2", CARD_PURCHASES));
  await ledger.rejectsCard(cardSync("sync-lost", CARD_PURCHASES.filter((purchase) => purchase.id !== "a")), /cannot lose members/u);
  await cardCommit(ledger, cardSync("sync-3", CARD_PURCHASES));
  await ledger.holds("sync-3", { stored: 0, reused: 6 });
});

equivalent("an unbilled card purchase that vanishes and returns", async (ledger) => {
  await cardCommit(ledger, cardSync("sync-1", CARD_PURCHASES));
  const withoutHold = CARD_PURCHASES.filter((purchase) => purchase.id !== "hold");
  const cancelled = await cardCommit(ledger, cardSync("sync-2", withoutHold));
  assert.equal(cancelled.withdrawnTransactionCount, 1, "the vanished hold is withdrawn");
  await ledger.holds("sync-2", { stored: 0, reused: 5 });
  await cardCommit(ledger, cardSync("sync-3", CARD_PURCHASES));
  await cardCommit(ledger, cardSync("sync-4", CARD_PURCHASES));
  await ledger.holds("sync-4", { stored: 0, reused: 6 });
  const events = await ledger.store.query<{ event_kind: string }>(
    `SELECT transition.event_kind FROM assertion_transitions transition
       JOIN canonical_commits commit_row ON commit_row.commit_id = transition.commit_id
       JOIN financial_transactions financial ON financial.transaction_id = transition.transaction_id
      WHERE financial.source_sequence = 'purchase-hold-1' AND transition.field_name = 'transaction_revision'
      ORDER BY commit_row.commit_sequence`,
  );
  assert.deepEqual(events.rows.map((event) => event.event_kind), ["observed", "withdrawn", "restored"]);
});

equivalent("a card instrument change", async (ledger) => {
  await cardCommit(ledger, cardSync("sync-1", CARD_PURCHASES));
  // The unchanged listing now also shows a supplementary card, which carries `a`:
  // the new card's evidence cites the listing record, so it is stored again.
  const added = [{ key: "primary", evidence: "listing-1" }, { key: "supplementary", evidence: "listing-1" }];
  const moved = CARD_PURCHASES.map((purchase) => (purchase.id === "a" ? { ...purchase, instrument: "supplementary" } : purchase));
  await cardCommit(ledger, cardSync("sync-2", moved, { instruments: added }));
  await ledger.holds("sync-2", { stored: 2, reused: 4 });
  assert.deepEqual(await cardRowCounts(ledger.store), { instrument_evidence: 2, details: 5, lifecycle: 5, statement_summary: 1 });
  await cardCommit(ledger, cardSync("sync-3", moved, { instruments: added }));
  await ledger.holds("sync-3", { stored: 0, reused: 6 });
  // A new listing evidences both cards.
  const relisted = [{ key: "primary", evidence: "listing-2" }, { key: "supplementary", evidence: "listing-2" }];
  await cardCommit(ledger, cardSync("sync-4", moved, { instruments: relisted }));
  await ledger.holds("sync-4", { stored: 1, reused: 5 });
  assert.equal((await cardRowCounts(ledger.store)).instrument_evidence, 4);
  await cardCommit(ledger, cardSync("sync-5", moved, { instruments: relisted }));
  await ledger.holds("sync-5", { stored: 0, reused: 6 });
});

equivalent("a card statement summary change", async (ledger) => {
  await cardCommit(ledger, cardSync("sync-1", CARD_PURCHASES));
  // The issuer revises the statement balance; its record is unchanged, but the new revision's summary cites it.
  const statement = { revision: "revision-2", balance: "1200", evidence: "statement-1" };
  await cardCommit(ledger, cardSync("sync-2", CARD_PURCHASES, { statement }));
  await ledger.holds("sync-2", { stored: 1, reused: 5 });
  await cardCommit(ledger, cardSync("sync-3", CARD_PURCHASES, { statement }));
  await ledger.holds("sync-3", { stored: 0, reused: 6 });
  // A summary served from a new record of the same revision is new evidence too.
  const reissued = { ...statement, evidence: "statement-2" };
  await ledger.rejectsCard(cardSync("sync-reissued", CARD_PURCHASES, { statement: reissued }), /reused with changed evidence/u);
  await cardCommit(ledger, cardSync("sync-4", CARD_PURCHASES, { statement: { ...reissued, revision: "revision-3" } }));
  await ledger.holds("sync-4", { stored: 1, reused: 5 });
  assert.equal((await cardRowCounts(ledger.store)).statement_summary, 3);
});

equivalent("a card details-only change", async (ledger) => {
  await cardCommit(ledger, cardSync("sync-1", CARD_PURCHASES));
  // Each step changes one details column of `a` alone; neither its record nor its fact changes.
  const steps: readonly Partial<CardPurchase>[] = [
    { postingDay: 7 },
    { postingDay: 7, consumeDay: 4 },
    { postingDay: 7, consumeDay: 4, effectiveDateBasis: "posting-date-fallback" },
  ];
  for (const [index, change] of steps.entries()) {
    const changed = CARD_PURCHASES.map((purchase) => (purchase.id === "a" ? { ...purchase, ...change } : purchase));
    await cardCommit(ledger, cardSync(`sync-${index + 2}`, changed));
    await ledger.holds(`sync-${index + 2}`, { stored: 1, reused: 5 });
    assert.deepEqual(await cardRowCounts(ledger.store), { instrument_evidence: 1, details: 5 + index, lifecycle: 4, statement_summary: 1 });
  }
  // A changed fact opens a new revision, which both rows and a new statement revision follow.
  const noted = CARD_PURCHASES.map((purchase) => (purchase.id === "a" ? { ...purchase, ...steps[2], note: "revised" } : purchase));
  const statement = { revision: "revision-2", balance: "1000", evidence: "statement-1" };
  await cardCommit(ledger, cardSync("sync-revised", noted, { statement }));
  await ledger.holds("sync-revised", { stored: 2, reused: 4 });
  assert.deepEqual(await cardRowCounts(ledger.store), { instrument_evidence: 1, details: 8, lifecycle: 5, statement_summary: 2 });
  await cardCommit(ledger, cardSync("sync-again", noted, { statement }));
  await ledger.holds("sync-again", { stored: 0, reused: 6 });
});

// A value that changes and then changes back must be written again: each
// card row is compared with the latest stored row, never with any stored one.
equivalent("card rows that change and change back", async (ledger) => {
  const purchases = (change: Readonly<{ holdListed?: boolean; postingDay?: number }>) =>
    CARD_PURCHASES.map((purchase) => {
      if (purchase.id === "hold")
        return { ...purchase, billing: "billed" as const, postingDay: 21, ...(change.holdListed ? {} : { onStatement: false as const }) };
      if (purchase.id === "a" && change.postingDay !== undefined) return { ...purchase, postingDay: change.postingDay };
      return purchase;
    });
  const first = { revision: "revision-1", balance: "1000", evidence: "statement-1" };
  const listed = { revision: "revision-2", balance: "1100", evidence: "statement-1" };
  await cardCommit(ledger, cardSync("sync-1", purchases({}), { statement: first }));
  // The statement lists the hold, and then no longer does: its lifecycle and
  // details statement key and the statement's summary return to what they were.
  await cardCommit(ledger, cardSync("sync-2", purchases({ holdListed: true }), { statement: listed }));
  await cardCommit(ledger, cardSync("sync-3", purchases({}), { statement: first }));
  await ledger.holds("sync-3", { stored: 2, reused: 4 });
  assert.deepEqual(await cardRowCounts(ledger.store), { instrument_evidence: 1, details: 6, lifecycle: 6, statement_summary: 3 });
  // A posting date that changes and changes back.
  await cardCommit(ledger, cardSync("sync-4", purchases({ postingDay: 7 }), { statement: first }));
  await cardCommit(ledger, cardSync("sync-5", purchases({}), { statement: first }));
  await ledger.holds("sync-5", { stored: 1, reused: 5 });
  assert.deepEqual(await cardRowCounts(ledger.store), { instrument_evidence: 1, details: 8, lifecycle: 6, statement_summary: 3 });
  // Instrument evidence that moves to a new listing and back.
  await cardCommit(ledger, cardSync("sync-6", purchases({}), { statement: first, instruments: [{ key: "primary", evidence: "listing-2" }] }));
  await cardCommit(ledger, cardSync("sync-7", purchases({}), { statement: first }));
  await ledger.holds("sync-7", { stored: 1, reused: 5 });
  assert.equal((await cardRowCounts(ledger.store)).instrument_evidence, 3);
  await cardCommit(ledger, cardSync("sync-8", purchases({}), { statement: first }));
  await ledger.holds("sync-8", { stored: 0, reused: 6 });
});

equivalent("a current used-credit reading beside an unchanged card re-sync", async (ledger) => {
  await cardCommit(ledger, cardSync("sync-1", CARD_PURCHASES));
  await ledger.commitCardBalance(usedCredit("used-credit-1", "2026-09-30T00:00:00.000Z"));
  await cardCommit(ledger, cardSync("sync-2", CARD_PURCHASES));
  await ledger.holds("sync-2", { stored: 0, reused: 6 });
  // The same reading again is reused; a new measurement cites its record.
  await ledger.commitCardBalance(usedCredit("used-credit-2", "2026-09-30T00:00:00.000Z"));
  await ledger.holds("used-credit-2", { stored: 0, reused: 1 });
  await ledger.commitCardBalance(usedCredit("used-credit-3", "2026-10-01T00:00:00.000Z"));
  await ledger.holds("used-credit-3", { stored: 1, reused: 0 });
  const revisions = await ledger.store.query<{ count: number }>("SELECT count(*)::int AS count FROM credit_card_balance_estimate_details");
  assert.equal(revisions.rows[0]!.count, 2);
  await cardCommit(ledger, cardSync("sync-3", CARD_PURCHASES));
  await ledger.holds("sync-3", { stored: 0, reused: 6 });
});

const EINVOICE_MONEY = (coefficient: string) =>
  ({ coefficient, scale: 0, currency: "TWD" as const, currencyAuthority: PGLITE_EINVOICE_CURRENCY_AUTHORITY });

/** Revision `revision` of invoice `key`; each revision has its own total. */
function einvoice(key: string, revision = 1): CanonicalEInvoiceInput {
  const total = String(100 * revision + key.charCodeAt(0));
  return {
    stableInvoiceKey: `AB-${key}`,
    sourceRevisionKey: `${key}-revision-${revision}`,
    revisionNumber: revision,
    revisionKind: revision === 1 ? "issued" : "revised",
    sourceIdentifiers: { invoiceNumber: `AB-${key}`, randomNumber: "2468" },
    seller: { taxId: "12345678", name: "SYNTHETIC SELLER" },
    total: EINVOICE_MONEY(total),
    occurrence: { value: "2026-09-01", precision: "date", timeZone: "Asia/Taipei", origin: "source-reported" },
    items: [{
      sequence: 1,
      completeness: "complete",
      name: `ITEM ${key}`,
      quantity: { coefficient: "1", scale: 0 },
      unitPrice: EINVOICE_MONEY(total),
      amount: EINVOICE_MONEY(total),
    }],
    authority: { routeKey: PGLITE_EINVOICE_ROUTE, contractVersion: PGLITE_EINVOICE_CONTRACT_VERSION },
    provenance: { kind: "provider-record", reference: `provider/invoice/${key}/${revision}`, sourceField: "invoiceList" },
    revocationReason: null,
  };
}

function einvoiceSync(captureId: string, invoices: readonly CanonicalEInvoiceInput[]): CanonicalEInvoiceCaptureInput {
  return {
    captureId,
    sourceConnectionKey: token("einvoice-connection"),
    identityEpoch: token("einvoice-epoch"),
    subjectDigest: token("einvoice-subject"),
    observedAt: "2026-09-30T00:00:00Z",
    scope: {
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      kind: "bounded-range",
      completeness: "complete-range",
      invoiceCompleteness: "complete",
      itemCompleteness: "complete",
      absenceAuthority: "comparable-complete-range",
    },
    pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: invoices.length, terminal: true, metadata: { fixture: "reuse" } }],
    invoices,
  };
}

async function einvoiceRowCounts(store: PGliteStore): Promise<Record<string, number>> {
  const { rows: [row] } = await store.query<Record<string, number>>(
    `SELECT (SELECT count(*) FROM einvoice_invoice_revisions)::int AS revisions,
            (SELECT count(*) FROM einvoice_revision_observations)::int AS observations,
            (SELECT count(*) FROM einvoice_revision_events)::int AS events`,
  );
  return { ...row! };
}

/**
 * Each invoice's latest observing commit observed exactly the revisions the
 * last capture listed for it. A commit that skips an observation it should
 * have written leaves an older set here, which both arms would share.
 */
async function assertLatestObservations(store: PGliteStore, input: CanonicalEInvoiceCaptureInput): Promise<void> {
  const { rows } = await store.query<{ stable_invoice_key: string; revisions: string[] }>(
    `WITH observed AS (
       SELECT invoice.stable_invoice_key, revision.source_revision_key, commit_row.commit_sequence,
              MAX(commit_row.commit_sequence) OVER (PARTITION BY invoice.invoice_id) AS latest_sequence
         FROM einvoice_invoices invoice
         JOIN einvoice_invoice_revisions revision ON revision.invoice_id = invoice.invoice_id
         JOIN einvoice_revision_observations observation ON observation.revision_id = revision.revision_id
         JOIN canonical_commits commit_row ON commit_row.commit_id = observation.commit_id
     )
     SELECT stable_invoice_key, array_agg(DISTINCT source_revision_key ORDER BY source_revision_key) AS revisions
       FROM observed WHERE commit_sequence = latest_sequence GROUP BY stable_invoice_key`,
  );
  const latest = new Map(rows.map((row) => [row.stable_invoice_key, row.revisions]));
  const listed = new Map<string, string[]>();
  for (const invoice of input.invoices)
    listed.set(invoice.stableInvoiceKey, [...(listed.get(invoice.stableInvoiceKey) ?? []), invoice.sourceRevisionKey].sort());
  for (const [key, revisions] of listed)
    assert.deepEqual(latest.get(key), revisions, `the latest observations of ${key} are what ${input.captureId} listed`);
}

async function einvoiceCommit(ledger: Ledger, input: CanonicalEInvoiceCaptureInput): Promise<void> {
  await ledger.commitEInvoice(input);
  await assertLatestObservations(ledger.store, input);
}

equivalent("an unchanged e-invoice re-sync", async (ledger) => {
  const invoices = [einvoice("x"), einvoice("y")];
  await einvoiceCommit(ledger, einvoiceSync("sync-1", invoices));
  await ledger.holds("sync-1", { stored: 2, reused: 0 });
  const written = await einvoiceRowCounts(ledger.store);
  assert.deepEqual(written, { revisions: 2, observations: 2, events: 2 });
  for (const sync of ["sync-2", "sync-3"]) {
    await einvoiceCommit(ledger, einvoiceSync(sync, invoices));
    await ledger.holds(sync, { stored: 0, reused: 2 });
  }
  assert.deepEqual(await einvoiceRowCounts(ledger.store), written, "an unchanged re-sync writes no observation");
});

equivalent("an e-invoice revised, then seen at its earlier revision again", async (ledger) => {
  await einvoiceCommit(ledger, einvoiceSync("sync-1", [einvoice("x"), einvoice("y")]));
  // A new revision is a new record, a revision row, its observation and a superseded event.
  await einvoiceCommit(ledger, einvoiceSync("sync-2", [einvoice("x", 2), einvoice("y")]));
  await ledger.holds("sync-2", { stored: 1, reused: 1 });
  assert.deepEqual(await einvoiceRowCounts(ledger.store), { revisions: 3, observations: 3, events: 4 });
  await einvoiceCommit(ledger, einvoiceSync("sync-3", [einvoice("x", 2), einvoice("y")]));
  await ledger.holds("sync-3", { stored: 0, reused: 2 });
  // The source lists the earlier revision again: its unchanged record is observed, so stored again.
  await einvoiceCommit(ledger, einvoiceSync("sync-4", [einvoice("x"), einvoice("y")]));
  await ledger.holds("sync-4", { stored: 1, reused: 1 });
  assert.deepEqual(await einvoiceRowCounts(ledger.store), { revisions: 3, observations: 4, events: 5 });
  await einvoiceCommit(ledger, einvoiceSync("sync-5", [einvoice("x"), einvoice("y")]));
  await ledger.holds("sync-5", { stored: 0, reused: 2 });
  // And the later one again.
  await einvoiceCommit(ledger, einvoiceSync("sync-6", [einvoice("x", 2), einvoice("y")]));
  await ledger.holds("sync-6", { stored: 1, reused: 1 });
  assert.deepEqual(await einvoiceRowCounts(ledger.store), { revisions: 3, observations: 5, events: 6 });
});

equivalent("an e-invoice listed at two revisions at once", async (ledger) => {
  await einvoiceCommit(ledger, einvoiceSync("sync-1", [einvoice("x")]));
  // Both revisions in one capture: the set of observed revisions changed, so both are observed.
  const both = [einvoice("x"), einvoice("x", 2)];
  await einvoiceCommit(ledger, einvoiceSync("sync-2", both));
  await ledger.holds("sync-2", { stored: 2, reused: 0 });
  await einvoiceCommit(ledger, einvoiceSync("sync-3", both));
  await ledger.holds("sync-3", { stored: 0, reused: 2 });
  // Listing only one of them is a different set again.
  await einvoiceCommit(ledger, einvoiceSync("sync-4", [einvoice("x", 2)]));
  await ledger.holds("sync-4", { stored: 1, reused: 0 });
  await einvoiceCommit(ledger, einvoiceSync("sync-5", [einvoice("x", 2)]));
  await ledger.holds("sync-5", { stored: 0, reused: 1 });
});

equivalent("an e-invoice that vanishes and returns", async (ledger) => {
  await einvoiceCommit(ledger, einvoiceSync("sync-1", [einvoice("x"), einvoice("y")]));
  // E-invoices have no withdrawal by omission: a capture without `y` writes nothing for it.
  await einvoiceCommit(ledger, einvoiceSync("sync-2", [einvoice("x")]));
  await ledger.holds("sync-2", { stored: 0, reused: 1 });
  // Seen again, `y` is what its latest observation holds, so its record is reused.
  await einvoiceCommit(ledger, einvoiceSync("sync-3", [einvoice("x"), einvoice("y")]));
  await ledger.holds("sync-3", { stored: 0, reused: 2 });
  assert.deepEqual(await einvoiceRowCounts(ledger.store), { revisions: 2, observations: 2, events: 2 });
});
const LOAN_CONTRACT = "loan/canonical/v2.fubon";
const LOAN_ACCOUNT = token("loan-account");
const LOAN_COUNTERPART_CONTRACT = "loan/counterpart/v1.fubon";

type LoanSync = Readonly<{
  /** Payment ids, each on its own day of September. */
  payments: readonly string[];
  /** The payment repaid from the deposit account, linked by a relation. */
  repaid?: string;
  /** Which record evidences the relation. */
  evidence?: "deposit" | "loan";
  /** Description of each payment by id, a field the source may revise (ADR 0117). */
  descriptions?: Readonly<Record<string, string>>;
  /** Rows ahead of these payments in the response, which shift each payment's source sequence index. */
  rowsAhead?: number;
}>;

/** A Fubon loan capture of September, with at most one repayment deposit in its own counterpart capture. */
function loanSync(captureId: string, sync: LoanSync): PGliteCanonicalLoanCommitRequest {
  const scopeKey = canonicalLoanOccurrenceScopeKey("fubon", LOAN_ACCOUNT);
  const records = sync.payments.map((id, index) => {
    const occurrenceGroup = { scopeKey, fingerprint: token(`loan-${id}`), partitionDate: september(index + 1), ordinal: 1 };
    const sourceRecordKey = canonicalOccurrenceGroupKey(occurrenceGroup);
    return {
      sourceRecordKey,
      occurrenceIndex: 1,
      sourceSequenceIndex: (sync.rowsAhead ?? 0) + index + 1,
      occurrenceGroup,
      occurrenceCollisionKey: token(`loan-collision-${id}`),
      effectiveOn: september(index + 1),
      sourceTime: { localTime: "12:00:00", precision: "second" as const, timeOrigin: "source_reported" as const },
      postingStatus: "posted" as const,
      eventKind: "payment" as const,
      eventEvidence: { kind: "source-coded-loan-event" as const, sourceRecordKey, sourceCode: "LOAN-PAYMENT", contractVersion: LOAN_CONTRACT },
      direction: "inflow" as const,
      amount: { coefficient: "1000", scale: 0 },
      currency: "TWD" as const,
      sourceDescription: sync.descriptions?.[id] ?? `PAYMENT ${id}`,
    };
  });
  const repaid = records.find((_, index) => sync.payments[index] === sync.repaid);
  const depositKey = token(`loan-deposit-${sync.repaid}`);
  const relationId = token(`loan-relation-${sync.repaid}`);
  const counterpartAccountKey = token("loan-repayment-account");
  const counterpartTransactions = repaid ? [{
    captureId: `${captureId}-deposit`,
    sourceRecordKey: depositKey,
    occurrenceIndex: 1,
    sourceConnectionKey: token("loan-connection"),
    identityEpochKey: token("loan-epoch"),
    accountKey: counterpartAccountKey,
    subjectDigest: token("loan-counterpart-subject"),
    accountNo: token("loan-counterpart-number"),
    accountType: "depository" as const,
    stream: "domestic-deposit" as const,
    recordKind: "fubon-loan-counterpart-deposit",
    authorityRoute: "fubon/loan/counterpart-deposit-v1",
    contractVersion: LOAN_COUNTERPART_CONTRACT,
    effectiveOn: repaid.effectiveOn,
    sourceTime: repaid.sourceTime,
    postingStatus: "posted" as const,
    direction: "outflow" as const,
    amount: repaid.amount,
    currency: "TWD" as const,
    description: "REPAYMENT",
    sourceEvidence: { kind: "source-linked-counterpart" as const, sourceRecordKey: depositKey, relationId, contractVersion: LOAN_COUNTERPART_CONTRACT },
  }] : [];
  return {
    capture: {
      captureId,
      sourceId: "fubon",
      authorityRoute: "fubon/loan/canonical-v2",
      contractVersion: LOAN_CONTRACT,
      identity: {
        sourceConnectionKey: token("loan-connection"),
        identityEpochKey: token("loan-epoch"),
        accountKey: LOAN_ACCOUNT,
        subjectDigest: token("loan-subject"),
        accountType: "loan",
        accountNo: token("loan-display-identity"),
        stream: "loan",
        recordKind: "fubon-loan-transaction",
        currency: "TWD",
      },
      observedAt: "2026-09-30T00:00:00.000Z",
      scope: {
        startDate: september(1),
        endDate: september(30),
        completeness: "complete-range",
        completenessBasis: "source-declared-terminal-range",
        completenessRuleVersion: LOAN_CONTRACT,
        pageCount: 1,
        terminal: true,
      },
      semantics: { status: "posted", effectiveTimeBasis: "source-reported", effectiveTimeRuleVersion: LOAN_CONTRACT, timeZone: "Asia/Taipei" },
      pages: [{ pageOrdinal: 0, responseCode: "200", terminal: true, rowCount: records.length, proofKind: "source-declared-terminal-range" }],
      occurrenceGroupCoverage: [{ scopeKey, startDate: september(1), endDate: september(30), contractVersion: LOAN_CONTRACT }],
      records,
      counterpartTransactions,
      balanceObservations: [],
      relations: repaid ? [{
        kind: "transfer_counterpart" as const,
        fromSourceRecordKey: repaid.sourceRecordKey,
        toSourceRecordKey: depositKey,
        fromAccountKey: LOAN_ACCOUNT,
        toAccountKey: counterpartAccountKey,
        fromDirection: "inflow" as const,
        toDirection: "outflow" as const,
        evidence: {
          kind: "explicit-source-linkage" as const,
          sourceRecordKey: sync.evidence === "loan" ? repaid.sourceRecordKey : depositKey,
          relationId,
          contractVersion: LOAN_CONTRACT,
        },
      }] : [],
      relationCoverage: repaid ? "source-linked-complete" : "not-asserted",
    },
  };
}

async function loanRowCounts(store: PGliteStore): Promise<Record<string, number>> {
  const { rows: [row] } = await store.query<Record<string, number>>(
    `SELECT (SELECT count(*) FROM loan_transaction_facts)::int AS facts,
            (SELECT count(*) FROM transaction_relations)::int AS relations,
            (SELECT count(*) FROM transaction_relation_provenance)::int AS provenance`,
  );
  return { ...row! };
}

/**
 * The latest provenance row of each relation, by highest commit sequence,
 * names the evidence the last request gave it, and every payment's current
 * revision has typed facts.
 */
async function assertLatestLoanRows(store: PGliteStore, request: PGliteCanonicalLoanCommitRequest): Promise<void> {
  for (const relation of request.capture.relations) {
    const { rows } = await store.query<{ evidence_source_record_key: string; evidence_relation_id: string }>(
      `SELECT provenance.evidence_source_record_key, provenance.evidence_relation_id
         FROM transaction_relations relation
         JOIN LATERAL (
           SELECT entry.* FROM transaction_relation_provenance entry
             JOIN canonical_commits commit_row ON commit_row.commit_id = entry.commit_id
            WHERE entry.relation_id = relation.relation_id
            ORDER BY commit_row.commit_sequence DESC LIMIT 1
         ) provenance ON TRUE
        WHERE relation.from_source_record_key = $1 AND relation.to_source_record_key = $2`,
      [relation.fromSourceRecordKey, relation.toSourceRecordKey],
    );
    assert.deepEqual(rows, [{ evidence_source_record_key: relation.evidence.sourceRecordKey, evidence_relation_id: relation.evidence.relationId }],
      `the latest provenance of the relation from ${relation.fromSourceRecordKey}`);
  }
  const { rows: [missing] } = await store.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM financial_transactions financial
       JOIN LATERAL (SELECT revision_id FROM transaction_revisions revision
                      WHERE revision.transaction_id = financial.transaction_id
                      ORDER BY revision_number DESC LIMIT 1) latest ON TRUE
      WHERE financial.source_sequence IN (SELECT jsonb_array_elements_text($1::jsonb))
        AND NOT EXISTS (SELECT 1 FROM loan_transaction_facts fact WHERE fact.revision_id = latest.revision_id)`,
    [JSON.stringify(request.capture.records.map((record) => record.sourceRecordKey))],
  );
  assert.equal(missing!.count, 0, "every payment's current revision has typed facts");
}

async function loanCommit(ledger: Ledger, request: PGliteCanonicalLoanCommitRequest): Promise<void> {
  await ledger.commitLoan(request);
  await assertLatestLoanRows(ledger.store, request);
}

equivalent("an unchanged loan re-sync", async (ledger) => {
  const sync = { payments: ["p1", "p2"], repaid: "p2" };
  await loanCommit(ledger, loanSync("sync-1", sync));
  await ledger.holds("sync-1", { stored: 2, reused: 0 });
  await ledger.holds("sync-1-deposit", { stored: 1, reused: 0 });
  const written = await loanRowCounts(ledger.store);
  assert.deepEqual(written, { facts: 2, relations: 1, provenance: 1 });
  for (const captureId of ["sync-2", "sync-3"]) {
    await loanCommit(ledger, loanSync(captureId, sync));
    await ledger.holds(captureId, { stored: 0, reused: 2 });
    await ledger.holds(`${captureId}-deposit`, { stored: 0, reused: 1 });
  }
  assert.deepEqual(await loanRowCounts(ledger.store), written, "an unchanged re-sync writes no loan row");
});

equivalent("a loan re-sync whose rows the response renumbers", async (ledger) => {
  // An older row ahead of both payments ages out, so the adapters number each
  // payment one lower. The position is not identity, so the records are reused.
  await loanCommit(ledger, loanSync("sync-1", { payments: ["p1", "p2"], rowsAhead: 1 }));
  await ledger.holds("sync-1", { stored: 2, reused: 0 });
  await loanCommit(ledger, loanSync("sync-2", { payments: ["p1", "p2"] }));
  await ledger.holds("sync-2", { stored: 0, reused: 2 });
});

equivalent("a new loan payment", async (ledger) => {
  await loanCommit(ledger, loanSync("sync-1", { payments: ["p1"] }));
  // The new payment's revision gets typed facts, which cite its new record.
  await loanCommit(ledger, loanSync("sync-2", { payments: ["p1", "p2"] }));
  await ledger.holds("sync-2", { stored: 1, reused: 1 });
  assert.deepEqual(await loanRowCounts(ledger.store), { facts: 2, relations: 0, provenance: 0 });
  await loanCommit(ledger, loanSync("sync-3", { payments: ["p1", "p2"] }));
  await ledger.holds("sync-3", { stored: 0, reused: 2 });
});

equivalent("a loan payment whose revision has no typed facts", async (ledger) => {
  await loanCommit(ledger, loanSync("sync-1", { payments: ["p1", "p2"] }));
  // A revision without typed facts, as one admitted before the command wrote them.
  const [p1] = loanSync("sync-1", { payments: ["p1"] }).capture.records;
  await ledger.store.query(
    `DELETE FROM loan_transaction_facts
      WHERE transaction_id = (SELECT transaction_id FROM financial_transactions WHERE source_sequence = $1)`,
    [p1!.sourceRecordKey],
  );
  // The unchanged revision gets its facts, which cite the record, so it is stored again.
  await loanCommit(ledger, loanSync("sync-2", { payments: ["p1", "p2"] }));
  await ledger.holds("sync-2", { stored: 1, reused: 1 });
  await loanCommit(ledger, loanSync("sync-3", { payments: ["p1", "p2"] }));
  await ledger.holds("sync-3", { stored: 0, reused: 2 });
});

equivalent("a revised loan payment", async (ledger) => {
  const sync = (description?: string) => ({ payments: ["p1", "p2"], ...(description ? { descriptions: { p1: description } } : {}) });
  await loanCommit(ledger, loanSync("sync-1", sync()));
  // A revised description opens a new revision, whose typed facts cite the new record.
  await loanCommit(ledger, loanSync("sync-2", sync("PAYMENT p1 REVISED")));
  await ledger.holds("sync-2", { stored: 1, reused: 1 });
  assert.deepEqual(await loanRowCounts(ledger.store), { facts: 3, relations: 0, provenance: 0 });
  await loanCommit(ledger, loanSync("sync-3", sync("PAYMENT p1 REVISED")));
  await ledger.holds("sync-3", { stored: 0, reused: 2 });
  // Only the current revision's facts count: without them, the next sync writes them again.
  const [p1] = loanSync("sync-1", sync()).capture.records;
  await ledger.store.query(
    `DELETE FROM loan_transaction_facts
      WHERE revision_id = (SELECT revision.revision_id FROM transaction_revisions revision
                             JOIN financial_transactions financial ON financial.transaction_id = revision.transaction_id
                            WHERE financial.source_sequence = $1 ORDER BY revision.revision_number DESC LIMIT 1)`,
    [p1!.sourceRecordKey],
  );
  await loanCommit(ledger, loanSync("sync-4", sync("PAYMENT p1 REVISED")));
  await ledger.holds("sync-4", { stored: 1, reused: 1 });
  // And back to the first description: another revision.
  await loanCommit(ledger, loanSync("sync-5", sync()));
  await ledger.holds("sync-5", { stored: 1, reused: 1 });
  assert.deepEqual(await loanRowCounts(ledger.store), { facts: 4, relations: 0, provenance: 0 });
});

equivalent("loan relation evidence that changes and changes back", async (ledger) => {
  const sync = (evidence: "deposit" | "loan") => ({ payments: ["p1", "p2"], repaid: "p2", evidence });
  await loanCommit(ledger, loanSync("sync-1", sync("deposit")));
  // The loan payment now evidences the relation: its unchanged record is cited, so stored again.
  await loanCommit(ledger, loanSync("sync-2", sync("loan")));
  await ledger.holds("sync-2", { stored: 1, reused: 1 });
  await ledger.holds("sync-2-deposit", { stored: 0, reused: 1 });
  assert.deepEqual(await loanRowCounts(ledger.store), { facts: 2, relations: 1, provenance: 2 });
  await loanCommit(ledger, loanSync("sync-3", sync("loan")));
  await ledger.holds("sync-3", { stored: 0, reused: 2 });
  // And back to the deposit: the latest provenance names the loan record, so this differs.
  await loanCommit(ledger, loanSync("sync-4", sync("deposit")));
  await ledger.holds("sync-4", { stored: 0, reused: 2 });
  await ledger.holds("sync-4-deposit", { stored: 1, reused: 0 });
  assert.deepEqual(await loanRowCounts(ledger.store), { facts: 2, relations: 1, provenance: 3 });
  await loanCommit(ledger, loanSync("sync-5", sync("deposit")));
  await ledger.holds("sync-5-deposit", { stored: 0, reused: 1 });
});

equivalent("a loan relation that vanishes and returns", async (ledger) => {
  const linked = { payments: ["p1", "p2"], repaid: "p2" };
  await loanCommit(ledger, loanSync("sync-1", linked));
  // Loans infer no withdrawal: a capture without the deposit writes nothing for the relation.
  await loanCommit(ledger, loanSync("sync-2", { payments: ["p1", "p2"] }));
  await ledger.holds("sync-2", { stored: 0, reused: 2 });
  // Back again, its latest provenance names the same evidence, so nothing is written.
  await loanCommit(ledger, loanSync("sync-3", linked));
  await ledger.holds("sync-3", { stored: 0, reused: 2 });
  await ledger.holds("sync-3-deposit", { stored: 0, reused: 1 });
  assert.deepEqual(await loanRowCounts(ledger.store), { facts: 2, relations: 1, provenance: 1 });
});

equivalent("a loan repayment resolved beside an unchanged loan re-sync", async (ledger) => {
  // The repayment resolver writes relation provenance of its own, which the
  // loan command's comparison must neither suppress nor be confused by.
  const linked = { payments: ["p1", "p2"], repaid: "p2" };
  await loanCommit(ledger, loanSync("sync-1", linked));
  await loanCommit(ledger, loanSync("sync-2", linked));
  const resolve = (fromCaptureId: string, toCaptureId: string) => resolvePGliteCanonicalLoanRepaymentRelations(ledger.store, {
    sourceConnectionKey: token("loan-connection"),
    explicitLinks: [{
      fromCaptureId,
      fromSourceRecordKey: token("loan-deposit-p2"),
      toCaptureId,
      toSourceRecordKey: loanSync(toCaptureId, linked).capture.relations[0]!.fromSourceRecordKey,
      relationId: token("loan-relation-p2"),
      contractVersion: LOAN_CONTRACT,
    }],
    observedAt: "2026-09-30T00:00:00.000Z",
  }, { clock: ledger.clock });
  // An explicit link names the captures that created the endpoints' revisions.
  assert.equal((await resolve("sync-1-deposit", "sync-1")).outcome, "changed");
  await loanCommit(ledger, loanSync("sync-3", linked));
  await ledger.holds("sync-3", { stored: 0, reused: 2 });
  await ledger.holds("sync-3-deposit", { stored: 0, reused: 1 });
  assert.equal((await resolve("sync-1-deposit", "sync-1")).outcome, "unchanged");
});
const INVESTMENT_SCOPE_KEY = token("investment-scope");

type InvestmentSync = Readonly<{
  /** Transaction ids; the first letter names the Security, `a` or `b`, and the digit the day. */
  transactions: readonly string[];
  /** Each Security's reported name, by letter. */
  names?: Readonly<Partial<Record<"a" | "b", string>>>;
  /**
   * A holding of `a` measured on this day of September, in its own record.
   * Its measurement key is the record's unless `measurement` names one, as
   * the Yuanta and TDCC adapters derive one from each capture.
   */
  holding?: Readonly<{ day: number; valuation?: string; measurement?: string }>;
  /** The day of a declared complete holding snapshot (ADR 0042); with no holding, an empty one. */
  snapshot?: number;
  /** The balance of an independent margin loan account, committed as its own capture. */
  independentMargin?: string;
  /**
   * An embedded margin balance, under its own record key. Its financial fact
   * has no occurrence group, so the capture comes from MaiCoin, whose route
   * does not require one.
   */
  margin?: Readonly<{ key: string; amount: string }>;
}>;

/** An investment capture of September whose Securities are named by their first transaction. */
function investmentSync(captureId: string, sync: InvestmentSync): PGliteCanonicalInvestmentCommitRequest {
  const sourceId = sync.margin ? "maicoin" : "yuanta-fund";
  const contractVersion = `${sourceId}/investment/canonical-v1`;
  const grouped = sourceId === "yuanta-fund";
  const securityKey = (letter: string) => `${sourceId}:FUND-${letter.toUpperCase()}`;
  const transactions = sync.transactions.map((id) => {
    const occurrenceGroup = { scopeKey: INVESTMENT_SCOPE_KEY, fingerprint: token(`investment-${id}`), partitionDate: september(Number(id.slice(1))), ordinal: 1 };
    const sourceRecordKey = grouped ? canonicalOccurrenceGroupKey(occurrenceGroup) : token(`investment-${id}`);
    return {
      sourceRecordKey,
      ...(grouped ? { occurrenceGroup } : {}),
      transactionKey: token(`investment-transaction-${id}`),
      securityKey: securityKey(id[0]!),
      action: "buy" as const,
      quantity: { coefficient: "5", scale: 0 },
      cashEffect: { coefficient: "1000", scale: 0, currency: "TWD" },
      effectiveOn: occurrenceGroup.partitionDate,
      description: `BUY ${id}`,
      fundingEvidence: { kind: "unresolved" as const, sourceRecordKey },
    };
  });
  const effectiveOn = september(sync.holding?.day ?? sync.snapshot ?? 30);
  const holdingKey = token(`investment-holding-${effectiveOn}`);
  const holdings = sync.holding ? [{
    measurementKey: sync.holding.measurement ? token(sync.holding.measurement) : holdingKey,
    measurementSubjectKey: token(`investment-holding-subject-${effectiveOn}`),
    sourceRecordKey: holdingKey,
    securityKey: securityKey("a"),
    quantity: { coefficient: "5", scale: 0 },
    valuation: { coefficient: sync.holding.valuation ?? "1200", scale: 0, currency: "TWD" },
    effectiveOn,
    observedAt: "2026-09-30T01:00:00.000Z",
    effectiveTimeEvidence: { kind: "source-reported-as-of" as const, sourceRecordKey: holdingKey, sourceField: "asOfDate", value: effectiveOn, contractVersion },
    lineage: { page: 1, row: 1, contractVersion },
  }] : [];
  const securities = (["a", "b"] as const)
    .filter((letter) => transactions.some((row) => row.securityKey === securityKey(letter)))
    .map((letter) => ({
      securityKey: securityKey(letter),
      producerSecurityId: `FUND-${letter.toUpperCase()}`,
      name: sync.names?.[letter] ?? `Fund ${letter.toUpperCase()}`,
      currency: "TWD",
      securityType: "mutual_fund" as const,
      identityEvidence: { kind: "producer-security-id" as const, contractVersion },
      // Only the Yuanta name contract reports names (ADR 0004).
      ...(grouped ? {
        nameEvidence: {
          contractVersion: `${sourceId}/security-name/source-reported-v1`,
          sourceRecordKey: transactions.find((row) => row.securityKey === securityKey(letter))!.sourceRecordKey,
        },
      } : {}),
    }));
  return {
    capture: {
      captureId,
      sourceId,
      authorityRoute: contractVersion,
      contractVersion,
      observedAt: "2026-09-30T01:00:00.000Z",
      identity: {
        sourceConnectionKey: token("investment-connection"),
        identityEpochKey: token("investment-epoch"),
        accountKey: token("investment-account"),
        accountType: "investment",
        reportingCurrency: "TWD",
      },
      scope: {
        effectiveOn,
        complete: true,
        transactionHistory: { startDate: september(1), endDate: september(30), complete: true },
        ...(sync.snapshot ? { holdingSnapshot: { sourceField: "asOfDate", value: effectiveOn, contractVersion } } : {}),
      },
      ...(grouped ? { occurrenceGroupCoverage: [{ scopeKey: INVESTMENT_SCOPE_KEY, startDate: september(1), endDate: september(30), contractVersion }] } : {}),
      securities,
      holdings,
      transactions,
      ...(sync.independentMargin ? {
        margin: {
          kind: "independent-account" as const,
          accountKey: token("investment-margin-account"),
          accountType: "loan" as const,
          amount: { coefficient: sync.independentMargin, scale: 0, currency: "TWD" },
          effectiveOn: september(30),
          sourceRecordKey: token(`investment-margin-balance-${sync.independentMargin}`),
          identityEvidence: { kind: "producer-margin-account-id" as const, producerAccountId: "MARGIN-LOAN-001", contractVersion: `${sourceId}/investment/margin-credit-canonical-v1` },
          sourceEventCode: "LOAN-DISBURSEMENT",
        },
      } : {}),
      ...(sync.margin ? {
        margin: {
          kind: "embedded" as const,
          amount: { coefficient: sync.margin.amount, scale: 0, currency: "TWD" },
          effectiveOn: september(30),
          sourceRecordKey: token(`investment-margin-${sync.margin.key}`),
        },
      } : {}),
    },
  };
}

async function investmentRowCounts(store: PGliteStore): Promise<Record<string, number>> {
  const { rows: [row] } = await store.query<Record<string, number>>(
    `SELECT (SELECT count(*) FROM investment_security_name_observations)::int AS names,
            (SELECT count(*) FROM investment_holding_observations)::int AS holdings,
            (SELECT count(*) FROM investment_transactions)::int AS transactions,
            (SELECT count(*) FROM investment_passbook_movements)::int AS movements,
            (SELECT count(*) FROM investment_margin_balance_observations)::int AS margins`,
  );
  return { ...row! };
}

/**
 * Each named Security's latest name observation, by highest commit sequence
 * as the overview reads it, carries the name the last request gave it.
 */
async function assertLatestNames(store: PGliteStore, request: PGliteCanonicalInvestmentCommitRequest): Promise<void> {
  for (const security of request.capture.securities) {
    if (!security.nameEvidence) continue;
    const { rows } = await store.query<{ name: string }>(
      `SELECT observation.name
         FROM investment_security_name_observations observation
         JOIN investment_securities security ON security.security_id = observation.security_id
         JOIN canonical_commits commit_row ON commit_row.commit_id = observation.commit_id
        WHERE security.security_key = $1
        ORDER BY commit_row.commit_sequence DESC, observation.capture_id DESC LIMIT 1`,
      [security.securityKey],
    );
    assert.deepEqual(rows, [{ name: security.name }], `the latest name of ${security.securityKey}`);
  }
}

async function investmentCommit(ledger: Ledger, request: PGliteCanonicalInvestmentCommitRequest): Promise<void> {
  await ledger.commitInvestment(request);
  await assertLatestNames(ledger.store, request);
}

const INVESTMENT_TRANSACTIONS = ["a1", "b2"];

equivalent("an unchanged investment re-sync", async (ledger) => {
  const sync = { transactions: INVESTMENT_TRANSACTIONS, margin: { key: "m1", amount: "500" } };
  await investmentCommit(ledger, investmentSync("sync-1", sync));
  await ledger.holds("sync-1", { stored: 3, reused: 0 });
  const written = await investmentRowCounts(ledger.store);
  assert.deepEqual(written, { names: 0, holdings: 0, transactions: 2, movements: 0, margins: 1 });
  for (const captureId of ["sync-2", "sync-3"]) {
    await investmentCommit(ledger, investmentSync(captureId, sync));
    await ledger.holds(captureId, { stored: 0, reused: 3 });
  }
  assert.deepEqual(await investmentRowCounts(ledger.store), written, "an unchanged re-sync writes no investment row");
});

equivalent("investment rows that are new", async (ledger) => {
  const margin = { key: "m1", amount: "500" };
  await investmentCommit(ledger, investmentSync("sync-1", { transactions: ["a1"], margin }));
  // A new transaction of a new Security: its transaction row and name both cite its record.
  await investmentCommit(ledger, investmentSync("sync-2", { transactions: INVESTMENT_TRANSACTIONS, margin }));
  await ledger.holds("sync-2", { stored: 1, reused: 2 });
  // A new margin balance is a new record under its own key.
  await investmentCommit(ledger, investmentSync("sync-3", { transactions: INVESTMENT_TRANSACTIONS, margin: { key: "m2", amount: "700" } }));
  await ledger.holds("sync-3", { stored: 1, reused: 2 });
  assert.deepEqual(await investmentRowCounts(ledger.store), { names: 0, holdings: 0, transactions: 2, movements: 0, margins: 2 });
});

equivalent("an unchanged investment re-sync with an independent margin account", async (ledger) => {
  const sync = { transactions: INVESTMENT_TRANSACTIONS, independentMargin: "300" };
  await investmentCommit(ledger, investmentSync("sync-1", sync));
  for (const captureId of ["sync-2", "sync-3"]) {
    await investmentCommit(ledger, investmentSync(captureId, sync));
    await ledger.holds(captureId, { stored: 0, reused: 2 });
    // No row of the command cites the margin account's record, so it is reused too.
    await ledger.holds(`${captureId}:margin-credit`, { stored: 0, reused: 1 });
  }
});

equivalent("investment rows missing beside stored facts", async (ledger) => {
  const sync = { transactions: INVESTMENT_TRANSACTIONS, margin: { key: "m1", amount: "500" } };
  await investmentCommit(ledger, investmentSync("sync-1", sync));
  // Unchanged facts whose investment rows are gone, as before the command wrote them:
  // the rows are written again and cite their records, which are stored again.
  await ledger.store.exec(`
    DELETE FROM investment_transactions;
    DELETE FROM investment_margin_balance_observations;`);
  await investmentCommit(ledger, investmentSync("sync-2", sync));
  await ledger.holds("sync-2", { stored: 3, reused: 0 });
  await investmentCommit(ledger, investmentSync("sync-3", sync));
  await ledger.holds("sync-3", { stored: 0, reused: 3 });
  assert.deepEqual(await investmentRowCounts(ledger.store), { names: 0, holdings: 0, transactions: 2, movements: 0, margins: 1 });
});

equivalent("a Security renamed and renamed back", async (ledger) => {
  const sync = (name?: string) => ({ transactions: INVESTMENT_TRANSACTIONS, ...(name ? { names: { a: name } } : {}) });
  await investmentCommit(ledger, investmentSync("sync-1", sync()));
  // The name's evidence record is unchanged, but the new name observation cites it.
  await investmentCommit(ledger, investmentSync("sync-2", sync("Fund A Renamed")));
  await ledger.holds("sync-2", { stored: 1, reused: 1 });
  assert.equal((await investmentRowCounts(ledger.store)).names, 3);
  await investmentCommit(ledger, investmentSync("sync-3", sync("Fund A Renamed")));
  await ledger.holds("sync-3", { stored: 0, reused: 2 });
  // Back to the first name: the latest observation holds the other one, so this differs.
  await investmentCommit(ledger, investmentSync("sync-4", sync()));
  await ledger.holds("sync-4", { stored: 1, reused: 1 });
  assert.equal((await investmentRowCounts(ledger.store)).names, 4);
  await investmentCommit(ledger, investmentSync("sync-5", sync()));
  await ledger.holds("sync-5", { stored: 0, reused: 2 });
});

equivalent("investment holdings measured each sync (ADR 0008)", async (ledger) => {
  await investmentCommit(ledger, investmentSync("sync-1", { transactions: INVESTMENT_TRANSACTIONS, holding: { day: 28 } }));
  // The same measurement again writes nothing and reuses its record.
  await investmentCommit(ledger, investmentSync("sync-2", { transactions: INVESTMENT_TRANSACTIONS, holding: { day: 28 } }));
  await ledger.holds("sync-2", { stored: 0, reused: 3 });
  // A measurement on a new day is a new observation, even of the same value.
  await investmentCommit(ledger, investmentSync("sync-3", { transactions: INVESTMENT_TRANSACTIONS, holding: { day: 29 } }));
  await ledger.holds("sync-3", { stored: 1, reused: 2 });
  await investmentCommit(ledger, investmentSync("sync-4", { transactions: INVESTMENT_TRANSACTIONS, holding: { day: 30, valuation: "1300" } }));
  await ledger.holds("sync-4", { stored: 1, reused: 2 });
  // The same day and value, measured by a later capture, is a new observation
  // (ADR 0008): it cites the unchanged record, which is stored again.
  await investmentCommit(ledger, investmentSync("sync-again", { transactions: INVESTMENT_TRANSACTIONS, holding: { day: 30, valuation: "1300", measurement: "sync-again" } }));
  await ledger.holds("sync-again", { stored: 1, reused: 2 });
  // No holding: transactions alone are reused.
  await investmentCommit(ledger, investmentSync("sync-5", { transactions: INVESTMENT_TRANSACTIONS }));
  await ledger.holds("sync-5", { stored: 0, reused: 2 });
  assert.equal((await investmentRowCounts(ledger.store)).holdings, 4);
});

equivalent("an investment holding sold and bought back", async (ledger) => {
  const sync = (day: number, held: boolean) => ({ transactions: INVESTMENT_TRANSACTIONS, snapshot: day, ...(held ? { holding: { day } } : {}) });
  await investmentCommit(ledger, investmentSync("sync-1", sync(27, true)));
  // An empty snapshot says the holding was sold; the transactions are reused beside it.
  await investmentCommit(ledger, investmentSync("sync-2", sync(28, false)));
  await ledger.holds("sync-2", { stored: 0, reused: 2 });
  await investmentCommit(ledger, investmentSync("sync-3", sync(29, true)));
  await ledger.holds("sync-3", { stored: 1, reused: 2 });
  const { rows } = await ledger.store.query<{ snapshots: number; holdings: number }>(
    `SELECT (SELECT count(*) FROM investment_holding_snapshots)::int AS snapshots,
            (SELECT count(*) FROM investment_holding_observations)::int AS holdings`,
  );
  assert.deepEqual(rows, [{ snapshots: 3, holdings: 2 }]);
});

// TDCC fixtures, shaped like the redacted TR001 and TR002 inventories.
const TDCC_CONNECTION = { sourceConnectionKey: token("tdcc-connection"), identityEpochKey: token("tdcc-epoch") };
const TDCC_BROKER_ACCOUNT = ["98", "76543"].join("");
const tdccAccountRow = (items: readonly unknown[] = []) => ({
  accountEmail: "", accountName: "", accountStatus: "0", applyTime: "112/01/09", brokerAccount: TDCC_BROKER_ACCOUNT,
  brokerName: "", brokerNo: "1020", isTisa: "N", items, mergeByNewAcct: "", mergeDate: "", phoneNumber: "",
});
const tdccPositions = (items: readonly unknown[], lastServerTime: string) =>
  readTdccPositions({ accounts: [tdccAccountRow(items)], currCHNames: { TWD: "新台幣　" }, exchangeRates: { TWD: "1" }, lastServerTime });
const tdccHolding = (quantity: string) => {
  const row = Array.from({ length: 22 }, () => "");
  Object.assign(row, { 0: "2330  ", 1: "台積電", 6: "00", 7: quantity, 17: "585.5", 19: "TWD" });
  return row;
};
const tdccMovement = (overrides: Readonly<Record<number, string>> = {}) => {
  const row = [
    "01150805", "00012", "2330  ", "台積電", "0", "0", "0", "0", "00", "01150801",
    "113", "買　　進          ", "1000.000000000000000000", "0E-18", "1", "0", "", "", "1", "01150801",
    "TWD", "中", "",
  ];
  for (const [slot, value] of Object.entries(overrides)) row[Number(slot)] = value;
  return row;
};
const TDCC_MOVEMENTS = [
  tdccMovement(),
  tdccMovement({ 0: "01150912", 1: "00031", 9: "01150910", 10: "123", 11: "賣　　出          ", 12: "400.000000000000000000" }),
];
function tdccMovementSync(captureId: string, movements: readonly string[][]): PGliteCanonicalInvestmentCommitRequest {
  const positions = tdccPositions([], "20261009103000");
  return {
    capture: tdccPassbookMovementCapture({
      captureId,
      observedAt: "2026-10-09T02:31:00.000Z",
      connection: TDCC_CONNECTION,
      account: positions.accounts[0]!,
      pages: [{ brokerAccount: TDCC_BROKER_ACCOUNT, brokerNo: "1020", exchangeRates: { TWD: "1" }, items: movements, lastServerTime: "20261009103000" }],
    }),
  };
}
function tdccHoldingSync(captureId: string, quantity: string, lastServerTime: string): PGliteCanonicalInvestmentCommitRequest {
  const positions = tdccPositions([tdccHolding(quantity)], lastServerTime);
  const at = `${lastServerTime.slice(0, 4)}-${lastServerTime.slice(4, 6)}-${lastServerTime.slice(6, 8)}T02:31:00.000Z`;
  return { capture: tdccSecuritiesHoldingCapture({ captureId, observedAt: at, connection: TDCC_CONNECTION, positions, account: positions.accounts[0]! }) };
}

equivalent("TDCC passbook movements recollected", async (ledger) => {
  // A stored movement whose row is gone is written again.
  await investmentCommit(ledger, tdccMovementSync("sync-0", TDCC_MOVEMENTS.slice(0, 1)));
  await ledger.store.exec("DELETE FROM investment_passbook_movements");
  await investmentCommit(ledger, tdccMovementSync("sync-1", TDCC_MOVEMENTS.slice(0, 1)));
  await ledger.holds("sync-1", { stored: 1, reused: 0 });
  // A new movement is written once and cites its record.
  await investmentCommit(ledger, tdccMovementSync("sync-2", TDCC_MOVEMENTS));
  await ledger.holds("sync-2", { stored: 1, reused: 1 });
  await investmentCommit(ledger, tdccMovementSync("sync-3", TDCC_MOVEMENTS));
  await ledger.holds("sync-3", { stored: 0, reused: 2 });
  assert.equal((await investmentRowCounts(ledger.store)).movements, 2);
});

equivalent("TDCC holdings, a new measurement every sync (ADR 0008)", async (ledger) => {
  // Each TR001 response is a measurement at its server time: its record and
  // observation are new even when the quantity is not, and the capture's
  // empty-or-not snapshot needs its own holding rows (ADR 0042).
  await investmentCommit(ledger, tdccHoldingSync("sync-1", "1000", "20261009103000"));
  await investmentCommit(ledger, tdccHoldingSync("sync-2", "1000", "20261010103000"));
  await ledger.holds("sync-2", { stored: 1, reused: 0 });
  await investmentCommit(ledger, tdccHoldingSync("sync-3", "1200", "20261011103000"));
  await investmentCommit(ledger, tdccHoldingSync("sync-4", "1000", "20261012103000"));
  await ledger.holds("sync-4", { stored: 1, reused: 0 });
  assert.equal((await investmentRowCounts(ledger.store)).holdings, 4);
});

test("the commit that reuses records is the one the app's deposit command runs", async () => {
  // The second arm above stands in for the store before ADR 0152; this pins
  // that it really stores every record, so the comparison has two sides.
  const store = new PGliteStore(await createTestPGlite("full"));
  try {
    const ledger = openLedger(store, "any");
    const rows = [row("a", 5), row("b", 6)];
    await ledger.commit(grouped("deposit", "sync-1", rows));
    await ledger.commit(grouped("deposit", "sync-2", rows));
    const { rows: [counts] } = await store.query<{ records: number; scopes: number; provenance: number; manifests: number }>(
      `SELECT (SELECT count(*) FROM source_records)::int AS records,
              (SELECT count(*) FROM source_record_scopes)::int AS scopes,
              (SELECT count(*) FROM assertion_provenance WHERE source_record_id IS NOT NULL)::int AS provenance,
              (SELECT count(*) FROM capture_source_record_manifests)::int AS manifests`,
    );
    assert.deepEqual(counts, { records: 4, scopes: 4, provenance: 4, manifests: 0 });
  } finally {
    await store.close();
  }
});
