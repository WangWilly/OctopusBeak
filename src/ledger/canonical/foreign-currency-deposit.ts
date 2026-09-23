import type { SQLInputValue } from "node:sqlite";
import type { ValidatedCanonicalDatabase as DatabaseSync } from "./canonical-database.ts";
import {
  commitCanonicalFinancialDepositCaptureBatch,
  commitCanonicalFinancialDepositCaptureInTransaction,
  type CanonicalFinancialDepositCommitResult,
  type CanonicalFinancialDepositWriterStore,
  type FinancialDepositAmount,
} from "./canonical-financial-deposit-writer.ts";
import {
  withCanonicalSourceCaptureAdmissionTransaction,
  type CanonicalSourceCaptureAdmissionTransactionCapability,
} from "./canonical-source-capture-admission.ts";
import type { CanonicalSourceStore } from "./canonical-source-store.ts";
import { commitCanonicalBankTransactionKindEnrichmentForCapturesInTransaction } from "./bank-transaction-kind-enrichment.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import { withCanonicalSnapshot } from "./canonical-runtime.ts";
import {
  admitForeignCurrencyDepositCapture,
  createForeignCurrencyDepositCapture,
  currency,
  date,
  FOREIGN_CURRENCY_DEPOSIT_STREAM,
  type ForeignCurrencyConversionQuery,
  type ForeignCurrencyDepositAdmittedCapture,
  type ForeignCurrencyDepositCaptureInput,
  type ForeignCurrencyDepositCommitStore,
  type ForeignCurrencyLifecycleEvent,
  type ForeignCurrencyQueryResult,
  type ForeignCurrencyTransaction,
} from "./foreign-currency-deposit-admission.ts";

export {
  FOREIGN_CURRENCY_DEPOSIT_STREAM,
  FOREIGN_CURRENCY_DEPOSIT_TIME_ZONE,
  FOREIGN_CURRENCY_DEPOSIT_ACCOUNT_CURRENCY,
  FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS,
  FOREIGN_CURRENCY_DEPOSIT_CONTRACTS,
  FOREIGN_CURRENCY_DEPOSIT_CONTRACT_FIXTURES,
  createForeignCurrencyDepositCapture,
  admitForeignCurrencyDepositCapture,
  type ForeignCurrencyDepositSourceId,
  type ForeignCurrencyCurrencyEvidence,
  type ForeignCurrencySourceTimeInput,
  type ForeignCurrencyRateInput,
  type ForeignCurrencyOriginalAmountInput,
  type ForeignCurrencyDepositRecordInput,
  type ForeignCurrencyDepositCaptureInput,
  type ForeignCurrencyDepositAdmittedCapture,
  type ForeignCurrencyDepositCommitStore,
  type ForeignCurrencyConversionQuery,
  type ForeignCurrencyTransaction,
  type ForeignCurrencyAssertionLineage,
  type ForeignCurrencyScopeProof,
  type ForeignCurrencySourceRecord,
  type ForeignCurrencyLifecycleEvent,
  type ForeignCurrencyProvenance,
  type ForeignCurrencyQueryResult,
} from "./foreign-currency-deposit-admission.ts";
export function commitForeignCurrencyDepositCaptureInTransaction(
  store: ForeignCurrencyDepositCommitStore,
  capture: ForeignCurrencyDepositCaptureInput | ForeignCurrencyDepositAdmittedCapture,
  capability: CanonicalSourceCaptureAdmissionTransactionCapability,
): CanonicalFinancialDepositCommitResult {
  const admitted =
    "source" in capture
      ? admitForeignCurrencyDepositCapture(capture as ForeignCurrencyDepositCaptureInput)
      : (capture as ForeignCurrencyDepositAdmittedCapture);
  const result = commitCanonicalFinancialDepositCaptureInTransaction(
    store,
    admitted,
    capability,
    (db, results) =>
      commitCanonicalBankTransactionKindEnrichmentForCapturesInTransaction(
        db,
        results.map((entry) => entry.captureId),
      ),
  );
  return result;
}

export async function commitForeignCurrencyDepositCapture(
  store: ForeignCurrencyDepositCommitStore,
  capture: ForeignCurrencyDepositCaptureInput | ForeignCurrencyDepositAdmittedCapture,
): Promise<CanonicalFinancialDepositCommitResult> {
  return withCanonicalSourceCaptureAdmissionTransaction(store as unknown as CanonicalSourceStore, (capability) =>
    commitForeignCurrencyDepositCaptureInTransaction(store, capture, capability),
  );
}

export async function commitForeignCurrencyDepositCaptureBatch(
  store: ForeignCurrencyDepositCommitStore,
  captures: readonly (ForeignCurrencyDepositCaptureInput | ForeignCurrencyDepositAdmittedCapture)[],
): Promise<CanonicalFinancialDepositCommitResult[]> {
  const admitted = captures.map((capture) =>
    "source" in capture
      ? admitForeignCurrencyDepositCapture(capture as ForeignCurrencyDepositCaptureInput)
      : (capture as ForeignCurrencyDepositAdmittedCapture),
  );
  return commitCanonicalFinancialDepositCaptureBatch(
    store,
    admitted,
    (db, results) =>
      commitCanonicalBankTransactionKindEnrichmentForCapturesInTransaction(
        db,
        results.map((result) => result.captureId),
      ),
  );
}

function hex(value: unknown): string {
  if (value instanceof Uint8Array)
    return Buffer.from(value).toString("hex");
  return String(value ?? "").toLowerCase();
}

function amount(coefficient: unknown, scale: unknown): FinancialDepositAmount {
  return { coefficient: String(coefficient), scale: Number(scale) };
}

function conversion(row: Record<string, unknown>): ForeignCurrencyConversionQuery | null {
  if (row.booked_amount_coefficient == null) return null;
  const sourceReportedRate =
    row.source_reported_rate_coefficient == null
      ? null
      : {
          amount: amount(row.source_reported_rate_coefficient, row.source_reported_rate_scale),
          baseCurrency: String(row.source_reported_rate_base_currency),
          quoteCurrency: String(row.source_reported_rate_quote_currency),
          observedOn: row.source_reported_rate_date == null ? null : String(row.source_reported_rate_date),
        };
  const impliedRate =
    row.implied_rate_coefficient == null
      ? null
      : {
          amount: amount(row.implied_rate_coefficient, row.implied_rate_scale),
          baseCurrency: String(row.implied_rate_base_currency),
          quoteCurrency: String(row.implied_rate_quote_currency),
          observedOn: row.implied_rate_date == null ? null : String(row.implied_rate_date),
        };
  return {
    originalAmount:
      row.original_amount_coefficient == null
        ? null
        : amount(row.original_amount_coefficient, row.original_amount_scale),
    originalCurrency: row.original_currency == null ? null : String(row.original_currency),
    bookedAmount: amount(row.booked_amount_coefficient, row.booked_amount_scale),
    bookedCurrency: String(row.booked_currency),
    sourceReportedRate,
    impliedRate,
    comparison: row.comparison as ForeignCurrencyConversionQuery["comparison"],
    feeAmount:
      row.fee_amount_coefficient == null
        ? null
        : amount(row.fee_amount_coefficient, row.fee_amount_scale),
    feeCurrency: row.fee_currency == null ? null : String(row.fee_currency),
    evidenceOrigin: String(row.evidence_origin),
  };
}

function mapTransaction(row: Record<string, unknown>): ForeignCurrencyTransaction {
  const mappedConversion = conversion(row);
  return {
    id: hex(row.transaction_id),
    accountId: hex(row.account_id),
    accountNo: row.account_no == null ? null : String(row.account_no),
    sourceSequence: String(row.source_sequence),
    amount: amount(row.amount_coefficient, row.amount_scale),
    bookedAmount: amount(row.amount_coefficient, row.amount_scale),
    currency: String(row.currency),
    direction: row.direction as "inflow" | "outflow",
    originalAmount: mappedConversion?.originalAmount ?? null,
    originalCurrency: mappedConversion?.originalCurrency ?? null,
    conversion: mappedConversion,
    effectiveOn: String(row.effective_on),
    transactionDateTimeLocal: String(row.transaction_date_time_local),
    timeZone: String(row.time_zone),
    timePrecision: row.time_precision as "date" | "minute" | "second",
    timeOrigin: row.time_origin as "source_reported" | "defaulted_local_midnight",
    utcInstantUtcUs: Number(row.utc_instant_utc_us),
    description: row.description == null ? null : String(row.description),
    authorityRoute: String(row.authority_route),
    captureId: hex(row.capture_id),
    sourceRecordId: hex(row.source_record_id),
    revisionId: hex(row.revision_id),
    commitSequence: Number(row.commit_sequence),
    supportState:
      row.support_state === "withdrawn" ? "withdrawn" : "supported",
  };
}

function enrichTransaction(
  db: DatabaseSync,
  row: Record<string, unknown>,
  transaction: ForeignCurrencyTransaction,
  knowledgeAt?: number,
): ForeignCurrencyTransaction {
  const assertionRow = db
    .prepare(
      `SELECT assertion.assertion_id, assertion.revision_id, assertion.origin,
          assertion.producer_id, assertion.rule_lineage, commit_row.commit_sequence
       FROM assertions assertion
       JOIN canonical_commits commit_row ON commit_row.commit_id = assertion.created_commit_id
       WHERE assertion.revision_id = ? AND assertion.origin = 'source'
       ORDER BY commit_row.commit_sequence, assertion.assertion_id LIMIT 1`,
    )
    .get(row.revision_id as Uint8Array) as Record<string, unknown> | undefined;
  const assertion = assertionRow
    ? {
        id: hex(assertionRow.assertion_id),
        revisionId: hex(assertionRow.revision_id),
        origin: "source" as const,
        producerId: String(assertionRow.producer_id),
        ruleLineage: String(assertionRow.rule_lineage),
        commitSequence: Number(assertionRow.commit_sequence),
      }
    : null;
  const lifecycleRows = assertionRow
    ? (db
        .prepare(
          `SELECT event.event_id, event.event_kind, commit_row.commit_sequence,
              scope.scope_id, scope.completeness, scope.contract_fingerprint,
              scope.preflight_fingerprint
           FROM assertion_transitions event
           JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
           LEFT JOIN capture_scopes scope ON scope.scope_id = event.scope_id
           WHERE event.assertion_id = ? ${knowledgeAt === undefined ? "" : "AND commit_row.commit_sequence <= ?"}
           ORDER BY commit_row.commit_sequence, event.event_id`,
        )
        .all(
          assertionRow.assertion_id as Uint8Array,
          ...(knowledgeAt === undefined ? [] : [knowledgeAt]),
        ) as Array<Record<string, unknown>>)
    : [];
  const lifecycleEvents = lifecycleRows.map((event) => ({
    id: hex(event.event_id),
    kind: event.event_kind as ForeignCurrencyLifecycleEvent["kind"],
    commitSequence: Number(event.commit_sequence),
    scopeProof:
      event.scope_id == null
        ? null
        : {
            id: hex(event.scope_id),
            completeness: String(event.completeness),
            contractFingerprint: String(event.contract_fingerprint),
            preflightFingerprint: String(event.preflight_fingerprint),
          },
  }));
  const sourceRecordRow = db
    .prepare(
      `SELECT source_record.source_record_id, source_record.capture_id,
          source_record.sequence_lexeme, source_record.description,
          source_record.payload_json, scope.scope_id, scope.account_id,
          scope.source_account_key AS account_no, scope.stream, scope.scope_start, scope.scope_end,
          scope.completeness, scope.contract_fingerprint, scope.preflight_fingerprint
       FROM source_records source_record
       LEFT JOIN source_record_scopes record_scope
         ON record_scope.source_record_id = source_record.source_record_id
       LEFT JOIN capture_scopes scope ON scope.scope_id = record_scope.scope_id
       WHERE source_record.source_record_id = ?
       ORDER BY scope.scope_id LIMIT 1`,
    )
    .get(row.source_record_id as Uint8Array) as Record<string, unknown> | undefined;
  const sourceRecord = sourceRecordRow
    ? {
        id: hex(sourceRecordRow.source_record_id),
        captureId: hex(sourceRecordRow.capture_id),
        sequence: String(sourceRecordRow.sequence_lexeme),
        description:
          sourceRecordRow.description == null
            ? null
            : String(sourceRecordRow.description),
        payloadJson: String(sourceRecordRow.payload_json),
        payload: String(sourceRecordRow.payload_json),
        scopeProof:
          sourceRecordRow.scope_id == null
            ? null
            : {
                id: hex(sourceRecordRow.scope_id),
                accountId: hex(sourceRecordRow.account_id),
                accountNo:
                  sourceRecordRow.account_no == null
                    ? ""
                    : String(sourceRecordRow.account_no),
                stream: String(sourceRecordRow.stream),
                scopeStart: String(sourceRecordRow.scope_start),
                scopeEnd: String(sourceRecordRow.scope_end),
                completeness: String(sourceRecordRow.completeness),
                contractFingerprint: String(sourceRecordRow.contract_fingerprint),
                preflightFingerprint: String(sourceRecordRow.preflight_fingerprint),
              },
      }
    : null;
  const provenanceRows = assertionRow
    ? (db
        .prepare(
          `SELECT provenance.source_record_id, source_record.capture_id,
              commit_row.commit_sequence
           FROM assertion_provenance provenance
           LEFT JOIN source_records source_record
             ON source_record.source_record_id = provenance.source_record_id
           JOIN canonical_commits commit_row ON commit_row.commit_id = provenance.commit_id
           WHERE provenance.assertion_id = ? ${knowledgeAt === undefined ? "" : "AND commit_row.commit_sequence <= ?"}
           ORDER BY commit_row.commit_sequence, provenance.source_record_id`,
        )
        .all(
          assertionRow.assertion_id as Uint8Array,
          ...(knowledgeAt === undefined ? [] : [knowledgeAt]),
        ) as Array<Record<string, unknown>>)
    : [];
  const provenance = provenanceRows.map((item) => ({
    sourceRecordId: hex(item.source_record_id),
    captureId: item.capture_id == null ? null : hex(item.capture_id),
    commitSequence: Number(item.commit_sequence),
  }));
  const latestLifecycle = lifecycleEvents.at(-1);
  return {
    ...transaction,
    supportState: latestLifecycle?.kind === "withdrawn" ? "withdrawn" : "supported",
    assertion,
    sourceRecord,
    lifecycleEvents,
    provenance,
  };
}

function queryRows(
  db: DatabaseSync,
  where: string,
  params: SQLInputValue[],
  options: {
    includeCurrent: boolean;
    knowledgeAt?: number;
    orderBy?: "financial" | "lineage";
  },
): ForeignCurrencyTransaction[] {
  const rows = db
    .prepare(
      `SELECT
         transaction_row.transaction_id,
         account_row.account_id,
         ${options.knowledgeAt === undefined ? "account_row.account_no" : `(SELECT observation.identifier_value
          FROM financial_account_identifier_observations observation
          JOIN canonical_commits observation_commit
            ON observation_commit.commit_id = observation.commit_id
         WHERE observation.account_id = account_row.account_id
           AND observation_commit.commit_sequence <= ?
         ORDER BY observation_commit.commit_sequence DESC,
                  observation.observed_at DESC,
                  observation.observation_id DESC
         LIMIT 1)`} AS account_no,
         transaction_row.source_sequence,
         revision.amount_coefficient,
         revision.amount_scale,
         revision.currency,
         revision.direction,
         revision.effective_on,
         revision.transaction_date_time_local,
         revision.time_zone,
         revision.time_precision,
         revision.time_origin,
         revision.utc_instant_utc_us,
         revision.description,
         revision.revision_id,
         revision.capture_id,
         source_record.source_record_id,
         source_capture.authority_route,
         commit_row.commit_sequence,
         revision.revision_number,
         source_assertion.assertion_id,
         conversion.original_amount_coefficient,
         conversion.original_amount_scale,
         conversion.original_currency,
         conversion.booked_amount_coefficient,
         conversion.booked_amount_scale,
         conversion.booked_currency,
         conversion.source_reported_rate_coefficient,
         conversion.source_reported_rate_scale,
         conversion.source_reported_rate_base_currency,
         conversion.source_reported_rate_quote_currency,
         conversion.source_reported_rate_date,
         conversion.implied_rate_coefficient,
         conversion.implied_rate_scale,
         conversion.implied_rate_base_currency,
         conversion.implied_rate_quote_currency,
         conversion.implied_rate_date,
         conversion.comparison,
         conversion.fee_amount_coefficient,
         conversion.fee_amount_scale,
         conversion.fee_currency,
         conversion.evidence_origin,
         COALESCE((SELECT CASE WHEN lifecycle.event_kind = 'withdrawn' THEN 'withdrawn' ELSE 'supported' END
           FROM assertion_transitions lifecycle
           JOIN canonical_commits lifecycle_commit ON lifecycle_commit.commit_id = lifecycle.commit_id
           JOIN assertions lifecycle_assertion ON lifecycle_assertion.assertion_id = lifecycle.assertion_id
           WHERE lifecycle_assertion.revision_id = revision.revision_id
             ${options.knowledgeAt === undefined ? "" : "AND lifecycle_commit.commit_sequence <= ?"}
           ORDER BY lifecycle_commit.commit_sequence DESC, lifecycle.event_id DESC LIMIT 1), 'supported') AS support_state
       FROM financial_transactions transaction_row
       JOIN financial_accounts account_row ON account_row.account_id = transaction_row.account_id
       JOIN transaction_revisions revision ON revision.transaction_id = transaction_row.transaction_id
       JOIN source_records source_record ON source_record.source_record_id = revision.source_record_id
       JOIN source_captures source_capture ON source_capture.capture_id = revision.capture_id
       JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
       LEFT JOIN assertions source_assertion ON source_assertion.revision_id = revision.revision_id
         AND source_assertion.origin = 'source'
       LEFT JOIN transaction_conversion_evidence conversion ON conversion.revision_id = revision.revision_id
       WHERE account_row.stream = ? AND ${where}
       ORDER BY ${options.orderBy === "lineage" ? "commit_row.commit_sequence, revision.revision_number" : "revision.effective_on, revision.utc_instant_utc_us, transaction_row.source_sequence"}`,
    )
    .all(
      ...(options.knowledgeAt === undefined ? [] : [options.knowledgeAt]),
      ...(options.knowledgeAt === undefined ? [] : [options.knowledgeAt]),
      FOREIGN_CURRENCY_DEPOSIT_STREAM,
      ...params,
    ) as Array<Record<string, unknown>>;
  const accountIds = [
    ...new Set(
      rows
        .filter((row) => row.account_id instanceof Uint8Array)
        .map((row) => Buffer.from(row.account_id as Uint8Array).toString("hex")),
    ),
  ];
  const currentIds = options.includeCurrent
    ? accountIds.length === 0
      ? new Set<string>()
      : new Set(
          createCanonicalProjectionRuntime(db)
            .read({
              kind: "current",
              families: ["transactions"],
              scope: { accountIds },
            })
            .families.transactions.map(
              (row) => `${row.transactionId}:${row.revisionId}`,
            ),
        )
    : null;
  return rows
    .filter(
      (row) =>
        currentIds === null ||
        currentIds.has(
          `${Buffer.from(row.transaction_id as Uint8Array).toString("hex")}:${Buffer.from(row.revision_id as Uint8Array).toString("hex")}`,
        ),
    )
    .map((row) =>
      enrichTransaction(db, row, mapTransaction(row), options.knowledgeAt),
    );
}

export function queryForeignCurrencyDepositCurrent(
  store: ForeignCurrencyDepositCommitStore,
  options: { accountNo?: string; currency?: string } = {},
): ForeignCurrencyQueryResult {
  const predicates = ["1 = 1"];
  const params: SQLInputValue[] = [];
  if (options.accountNo !== undefined) {
    predicates.push("account_row.source_account_key = ?");
    params.push(options.accountNo);
  }
  if (options.currency !== undefined) {
    predicates.push("revision.currency = ?");
    params.push(currency(options.currency, "Query currency"));
  }
  const transactions = withCanonicalSnapshot(store.db, () =>
    queryRows(store.db, predicates.join(" AND "), params, {
      includeCurrent: true,
    }),
  );
  return {
    status: "canonical-live",
    transactions,
    records: transactions,
    provenanceCount: transactions.reduce(
      (count, transaction) => count + (transaction.provenance?.length ?? 0),
      0,
    ),
  };
}

export function queryForeignCurrencyDepositHistorical(
  store: ForeignCurrencyDepositCommitStore,
  request: { knowledgeAt: number; accountNo?: string; effectiveAt?: string },
): ForeignCurrencyQueryResult {
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt < 0)
    throw new Error("Historical query requires a non-negative knowledge point.");
  const predicates = [
    `revision.commit_id IN (
       SELECT revision_at.commit_id FROM transaction_revisions revision_at
       JOIN canonical_commits commit_at ON commit_at.commit_id = revision_at.commit_id
       WHERE revision_at.transaction_id = transaction_row.transaction_id
         AND commit_at.commit_sequence <= ?
         ${request.effectiveAt === undefined ? "" : "AND revision_at.effective_on <= ?"}
       ORDER BY commit_at.commit_sequence DESC LIMIT 1
     )`,
  ];
  const params: SQLInputValue[] = [request.knowledgeAt];
  if (request.effectiveAt !== undefined) {
    const effectiveAt = date(request.effectiveAt, "Historical effective date");
    params.push(effectiveAt);
  }
  if (request.accountNo !== undefined) {
    predicates.push("account_row.source_account_key = ?");
    params.push(request.accountNo);
  }
  const transactions = queryRows(store.db, predicates.join(" AND "), params, {
    includeCurrent: false,
    knowledgeAt: request.knowledgeAt,
  });
  return {
    status: "canonical-live",
    transactions,
    records: transactions,
    provenanceCount: transactions.reduce(
      (count, transaction) => count + (transaction.provenance?.length ?? 0),
      0,
    ),
  };
}

export function queryForeignCurrencyDepositLineage(
  store: ForeignCurrencyDepositCommitStore,
  request: { occurrenceKey: string; accountNo?: string },
): ForeignCurrencyQueryResult {
  const predicates = [
    "source_record.occurrence_key = ?",
  ];
  const params: SQLInputValue[] = [request.occurrenceKey];
  if (request.accountNo !== undefined) {
    predicates.push("account_row.source_account_key = ?");
    params.push(request.accountNo);
  }
  const transactions = queryRows(
    store.db,
    predicates.join(" AND "),
    params,
    { includeCurrent: false, orderBy: "lineage" },
  );
  return {
    status: "canonical-live",
    transactions,
    records: transactions,
    provenanceCount: transactions.reduce(
      (count, transaction) => count + (transaction.provenance?.length ?? 0),
      0,
    ),
  };
}

// Short aliases make the public current/historical/lineage boundary discoverable
// without exposing SQL or writer internals.
export const queryForeignCurrencyCurrent = queryForeignCurrencyDepositCurrent;
export const queryForeignCurrencyHistorical = queryForeignCurrencyDepositHistorical;
export const queryForeignCurrencyLineage = queryForeignCurrencyDepositLineage;
