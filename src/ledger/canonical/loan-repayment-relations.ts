import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  withCanonicalSnapshot,
  withCanonicalWriterQueue,
} from "./canonical-runtime.ts";
import { assertValidatedCanonicalDatabase } from "./canonical-schema-lifecycle.ts";

/** Resolver rules are versioned because provider note/date contracts may
 * change without changing the meaning of already admitted relations. */
export const LOAN_REPAYMENT_RELATION_RESOLVER_VERSION =
  "loan-repayment-relation/v1" as const;
export const LOAN_REPAYMENT_RELATION_RESOLUTION_AUTHORITY =
  "canonical/loan-repayment-relation-resolution-v1" as const;
export const COUNTERPARTY_ACCOUNT_EVIDENCE_VERSION =
  "counterparty-account/v1" as const;
/**
 * Live Yuanta domestic-deposit CSV observations show a complete loan account
 * in 備註 as `00` followed by the 14-digit account exposed by the loan
 * statement selector.  The contract is deliberately exact: it is not a
 * general leading-zero trimming rule.
 */
export const YUANTA_LOAN_ACCOUNT_NOTE_NORMALIZATION_CONTRACT_VERSION =
  "yuanta/transaction-note-loan-account-leading-00/v1" as const;
/**
 * A provider-specific fixed note/code contract is deliberately explicit and
 * versioned.  Callers must establish this contract from live Institution
 * behaviour before they can persist note evidence; the resolver never
 * searches arbitrary descriptions or user-authored notes.
 */
export const INSTITUTION_REPAYMENT_NOTE_EVIDENCE_VERSION =
  "institution-repayment-note/v1" as const;

/**
 * The date relationship used by a fixed Institution note is part of the
 * evidence contract.  An empty or implicit offset is deliberately invalid:
 * each provider integration has to state which signed calendar-day offsets
 * its live behaviour permits (for example, `[0]` for same-day settlement).
 */
export type InstitutionRepaymentDateContract = Readonly<{
  version: string;
  comparison: "signed-calendar-day-offset";
  allowedSignedDayOffsets: readonly number[];
}>;

export type CounterpartyAccountRole = "originator" | "beneficiary";
export type CounterpartyAccountPurpose = "loan_repayment" | string;
export type CounterpartyAccountScope =
  | "loan_contract"
  | "shared_collection"
  | null;

/**
 * Evidence is intentionally generic.  A deposit, foreign-currency, loan or
 * future provider integration can attach the same shape to a transaction or
 * to an account-level repayment mandate.
 */
export type TransactionCounterpartyAccountEvidenceInput = Readonly<{
  captureId: string;
  sourceRecordKey: string;
  sourceConnectionKey: string;
  identityEpochKey: string;
  accountValue: string;
  normalizedAccountValue?: string;
  accountDigest?: string;
  role: CounterpartyAccountRole;
  purpose: CounterpartyAccountPurpose;
  scope?: CounterpartyAccountScope;
  evidenceKind?: "transaction-counterparty-account" | "repayment-mandate";
  sourceField?: string;
  contractVersion: string;
  effectiveStartDate?: string | null;
  effectiveEndDate?: string | null;
  /** Required when the source record has no transaction revision (for
   * example, a repayment-setting page). */
  accountKey?: string;
}>;

export type AdmittedCounterpartyAccountEvidence =
  TransactionCounterpartyAccountEvidenceInput & Readonly<{
    sourceValue: string;
    normalizedAccountValue: string;
    accountDigest: `sha256:${string}`;
    evidenceKind:
      | "transaction-counterparty-account"
      | "repayment-mandate";
    sourceField: string;
  }>;

export type PersistedCounterpartyAccountEvidence = Readonly<{
  evidenceId: string;
  transactionId: string | null;
  accountId: string | null;
  sourceRecordId: string;
  captureId: string;
  sourceConnectionKey: string;
  identityEpochKey: string;
  sourceValue: string;
  normalizedValue: string;
  valueDigest: string;
  role: CounterpartyAccountRole;
  purpose: string;
  scope: CounterpartyAccountScope;
  evidenceKind:
    | "transaction-counterparty-account"
    | "repayment-mandate";
  sourceField: string;
  contractVersion: string;
  effectiveStartDate: string | null;
  effectiveEndDate: string | null;
}>;

export type InstitutionGeneratedRepaymentNoteContract = Readonly<{
  evidenceVersion: typeof INSTITUTION_REPAYMENT_NOTE_EVIDENCE_VERSION;
  /** Provider namespace whose live page established this fixed contract. */
  integrationNamespace: string;
  /** Stable provider contract identifier for this exact note/code. */
  contractVersion: string;
  /** Provider-versioned fixed note/code pattern identifier. */
  patternId: string;
  /** Exact Institution-generated note/code admitted by this contract. */
  fixedValue: string;
  /** The value is asserted by the Institution page, never authored by the user. */
  generatedBy: "institution";
  /** The fixed value was verified against live provider behaviour. */
  liveVerified: true;
  /** Provider-specific date semantics used by the relation fallback. */
  dateContractVersion: string;
  dateField: "transaction-date";
  /** Explicit provider date contract; no universal offset is assumed. */
  dateContract: InstitutionRepaymentDateContract;
}>;

export type InstitutionGeneratedRepaymentNoteEvidenceInput = Readonly<{
  captureId: string;
  sourceRecordKey: string;
  sourceConnectionKey: string;
  identityEpochKey: string;
  /** Exact note/code as observed in the Institution source record. */
  noteValue: string;
  contract: InstitutionGeneratedRepaymentNoteContract;
  sourceField?: string;
}>;

export type AdmittedInstitutionGeneratedRepaymentNoteEvidence =
  InstitutionGeneratedRepaymentNoteEvidenceInput & Readonly<{
    sourceValue: string;
    normalizedValue: string;
    fixedValue: string;
    sourceField: string;
  }>;

export type PersistedInstitutionGeneratedRepaymentNoteEvidence = Readonly<{
  noteEvidenceId: string;
  transactionId: string;
  sourceRecordId: string;
  captureId: string;
  integrationNamespace: string;
  sourceConnectionKey: string;
  identityEpochKey: string;
  sourceValue: string;
  normalizedValue: string;
  fixedValue: string;
  evidenceVersion: string;
  patternId: string;
  contractVersion: string;
  dateContractVersion: string;
  dateContract: InstitutionRepaymentDateContract | null;
  dateField: "transaction-date";
  generatedBy: "institution";
  liveVerified: true;
}>;

export type ExplicitLoanTransactionLink = Readonly<{
  fromCaptureId: string;
  fromSourceRecordKey: string;
  toCaptureId: string;
  toSourceRecordKey: string;
  relationId: string;
  contractVersion: string;
  evidenceSourceRecordKey?: string;
}>;

export type LoanRepaymentRelationResolutionRequest = Readonly<{
  sourceConnectionKey: string;
  integrationNamespace?: string;
  observedAt?: string;
  /** A failed/partial capture cannot withdraw or replace existing support. */
  requiredCoverage?: { complete: boolean };
  explicitLinks?: readonly ExplicitLoanTransactionLink[];
}>;

export type LoanRepaymentRelationResolutionResult = Readonly<{
  status: "canonical-live";
  outcome: "changed" | "unchanged" | "no-admission";
  resolutionId: string | null;
  exactRelationIds: readonly string[];
  settlementGroupIds: readonly string[];
  reason?: string;
}>;

export type LoanRepaymentRelationView = Readonly<{
  relationId: string;
  relationKind: "transfer_counterpart";
  fromTransactionId: string;
  toTransactionId: string;
  fromAccountId: string;
  toAccountId: string;
  fromSourceRecordKey: string;
  toSourceRecordKey: string;
  fromDirection: "inflow" | "outflow";
  toDirection: "inflow" | "outflow";
  sourceConnectionKey: string;
  fromIdentityEpochKey: string;
  toIdentityEpochKey: string;
  evidenceSourceRecordKey: string;
  evidenceRelationId: string;
  evidenceContractVersion: string;
}>;

export type LoanRepaymentSettlementGroupView = Readonly<{
  settlementGroupId: string;
  groupKey: string;
  sourceConnectionKey: string;
  members: readonly Readonly<{
    transactionId: string;
    memberKind: "deposit_outflow" | "loan_payment";
    sourceRecordKey: string;
  }>[];
}>;

/** Relation resolution is a canonical production write/read seam. The
 * structural adapter remains source-compatible with loan/investment facades,
 * while its database capability is checked at runtime before any SQL runs. */
type RelationStore = Readonly<{
  db: DatabaseSync;
  databasePath?: string;
  commitClock?: () => number;
}>;

function requireValidatedRelationStore(store: RelationStore): void {
  assertValidatedCanonicalDatabase(store.db);
}

type BlobId = Uint8Array;

type CaptureContext = {
  captureId: BlobId;
  captureKey: string;
  sourceConnectionId: BlobId;
  identityEpochId: BlobId;
  sourceConnectionKey: string;
  identityEpochKey: string;
  integrationNamespace: string;
  commitId: BlobId;
  scopeAccountId: BlobId | null;
  /** Source observation time; used to bound current-only mandates. */
  observedAt: string;
};

type TransactionContext = CaptureContext & {
  transactionId: BlobId;
  accountId: BlobId;
  sourceRecordId: BlobId;
  sourceRecordKey: string;
  accountType: string;
  stream: string;
  accountNo: string;
  effectiveOn: string;
  amountCoefficient: string;
  amountScale: number;
  currency: string;
  direction: "inflow" | "outflow";
  eventKind: string | null;
};

type Plan =
  | Readonly<{
      kind: "exact";
      from: TransactionContext;
      to: TransactionContext;
      supportKind:
        | "explicit-source-linkage"
        | "verified-repayment-destination"
        | "fixed-institution-note";
      supportKey: string;
      evidenceSourceRecordKey: string;
      evidenceRelationId: string;
      evidenceContractVersion: string;
      evidenceJson: Record<string, unknown>;
    }>
  | Readonly<{
      kind: "group";
      members: readonly TransactionContext[];
      supportKind:
        | "verified-repayment-destination"
        | "fixed-institution-note";
      supportKey: string;
      evidenceSourceRecordKey: string;
      evidenceRelationId: string;
      evidenceContractVersion: string;
      evidenceJson: Record<string, unknown>;
    }>;

function createCanonicalOpaqueId(): BlobId {
  return randomBytes(16);
}

function digest(...parts: string[]): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("base64url")}`;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required.`);
  return value;
}

function opaqueId(value: unknown, label: string): string {
  const result = text(value, label).trim();
  if (!/^sha256:[A-Za-z0-9_-]+$/u.test(result))
    throw new Error(`${label} must be an opaque sha256 token.`);
  return result;
}

function validDate(value: string | null | undefined, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value))
    throw new Error(`${label} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new Error(`${label} must be a valid calendar date.`);
  return value;
}

function observedCalendarDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const match = /^(\d{4}-\d{2}-\d{2})/u.exec(value.trim());
  if (!match) return null;
  try {
    return validDate(match[1], "Source observation date");
  } catch {
    return null;
  }
}

/** Normalize a complete account value. Masked values are a deliberate stop. */
export function normalizeCounterpartyAccountValue(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/[\s-]+/gu, "");
  if (!normalized) throw new Error("Counterparty account value is required.");
  if (/[*#•xX]/u.test(normalized))
    throw new Error(
      "Masked counterparty account values cannot be admitted as exact evidence.",
    );
  return normalized;
}

export function counterpartyAccountDigest(
  integrationNamespace: string,
  normalizedValue: string,
): `sha256:${string}` {
  return digest(
    COUNTERPARTY_ACCOUNT_EVIDENCE_VERSION,
    text(integrationNamespace, "Integration namespace").trim().toLowerCase(),
    normalizedValue,
  );
}

/**
 * Note matching is intentionally less permissive than account
 * normalisation: it folds Unicode and surrounding/duplicate whitespace, but
 * does not strip punctuation, digits, or arbitrary words.  The resulting
 * value is compared to the fixed value from a provider contract.
 */
export function normalizeInstitutionGeneratedRepaymentNote(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ");
  if (!normalized)
    throw new Error("Institution-generated repayment note value is required.");
  return normalized;
}

function normalizeInstitutionRepaymentDateContract(
  value: InstitutionRepaymentDateContract,
  dateContractVersion: string,
): InstitutionRepaymentDateContract {
  if (value === null || typeof value !== "object")
    throw new Error("Institution repayment date contract is required.");
  const version = text(value.version, "Institution repayment date contract version").trim();
  const expectedVersion = text(
    dateContractVersion,
    "Institution repayment note date contract version",
  ).trim();
  if (version !== expectedVersion)
    throw new Error(
      "Institution repayment date contract version does not match its evidence.",
    );
  if (value.comparison !== "signed-calendar-day-offset")
    throw new Error("Institution repayment date comparison is unsupported.");
  if (
    !Array.isArray(value.allowedSignedDayOffsets) ||
    value.allowedSignedDayOffsets.length === 0
  )
    throw new Error(
      "Institution repayment date contract must list allowed signed day offsets.",
    );
  const offsets = value.allowedSignedDayOffsets.map((offset) => {
    if (!Number.isSafeInteger(offset))
      throw new Error(
        "Institution repayment date contract offsets must be safe integers.",
      );
    return offset;
  });
  if (new Set(offsets).size !== offsets.length)
    throw new Error(
      "Institution repayment date contract offsets must be unique.",
    );
  offsets.sort((left, right) => left - right);
  return Object.freeze({
    version,
    comparison: value.comparison,
    allowedSignedDayOffsets: Object.freeze(offsets),
  });
}

function serializeInstitutionRepaymentDateContract(
  contract: InstitutionRepaymentDateContract,
): string {
  return JSON.stringify({
    version: contract.version,
    comparison: contract.comparison,
    allowedSignedDayOffsets: [...contract.allowedSignedDayOffsets],
  });
}

function parsePersistedInstitutionRepaymentDateContract(
  value: unknown,
  dateContractVersion: string,
): InstitutionRepaymentDateContract | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    return normalizeInstitutionRepaymentDateContract(
      parsed as InstitutionRepaymentDateContract,
      dateContractVersion,
    );
  } catch {
    // Older v10 note rows predate the explicit payload.  They remain
    // queryable as provenance but cannot be used for fallback admission.
    return null;
  }
}

export function admitInstitutionGeneratedRepaymentNoteEvidence(
  input: InstitutionGeneratedRepaymentNoteEvidenceInput,
  integrationNamespace: string,
): AdmittedInstitutionGeneratedRepaymentNoteEvidence {
  const sourceValue = text(input.noteValue, "Institution-generated repayment note source value");
  const contract = input.contract;
  if (contract.evidenceVersion !== INSTITUTION_REPAYMENT_NOTE_EVIDENCE_VERSION)
    throw new Error("Institution repayment note evidence version is unsupported.");
  if (contract.generatedBy !== "institution" || contract.liveVerified !== true)
    throw new Error("Institution repayment note must be live-verified Institution evidence.");
  if (contract.dateField !== "transaction-date")
    throw new Error("Institution repayment note date field is unsupported.");
  text(contract.contractVersion, "Institution repayment note contract version");
  text(contract.patternId, "Institution repayment note pattern ID");
  const dateContractVersion = text(
    contract.dateContractVersion,
    "Institution repayment note date contract version",
  ).trim();
  const dateContract = normalizeInstitutionRepaymentDateContract(
    contract.dateContract,
    dateContractVersion,
  );
  const contractNamespace = text(
    contract.integrationNamespace,
    "Institution repayment note integration namespace",
  ).trim().toLowerCase();
  if (
    contractNamespace !==
    text(integrationNamespace, "Integration namespace").trim().toLowerCase()
  )
    throw new Error(
      "Institution repayment note contract namespace does not match its capture.",
    );
  const normalizedValue = normalizeInstitutionGeneratedRepaymentNote(sourceValue);
  const fixedValue = normalizeInstitutionGeneratedRepaymentNote(contract.fixedValue);
  if (normalizedValue !== fixedValue)
    throw new Error(
      "Institution repayment note does not match the fixed provider contract value.",
    );
  return Object.freeze({
    ...input,
    noteValue: sourceValue,
    sourceValue,
    normalizedValue,
    contract: {
      ...contract,
      integrationNamespace: contractNamespace,
      contractVersion: contract.contractVersion.trim(),
      patternId: contract.patternId.trim(),
      fixedValue,
      dateContractVersion,
      dateContract,
    },
    sourceField: text(
      input.sourceField ?? "transaction-note",
      "Institution-generated repayment note source field",
    ).trim(),
    fixedValue,
  });
}

export function admitCounterpartyAccountEvidence(
  input: TransactionCounterpartyAccountEvidenceInput,
  integrationNamespace: string,
): AdmittedCounterpartyAccountEvidence {
  const sourceValue = text(input.accountValue, "Counterparty account source value");
  const defaultNormalizedAccountValue =
    normalizeCounterpartyAccountValue(sourceValue);
  const requestedNormalizedAccountValue = input.normalizedAccountValue;
  const namespace = text(
    integrationNamespace,
    "Counterparty account integration namespace",
  )
    .trim()
    .toLowerCase();
  const isYuantaLoanAccountNoteAlias =
    namespace === "yuanta" &&
    input.contractVersion ===
      YUANTA_LOAN_ACCOUNT_NOTE_NORMALIZATION_CONTRACT_VERSION &&
    input.evidenceKind === "transaction-counterparty-account" &&
    input.role === "beneficiary" &&
    input.purpose === "loan_repayment" &&
    input.sourceField === "備註" &&
    /^00\d{14}$/u.test(defaultNormalizedAccountValue) &&
    requestedNormalizedAccountValue ===
      defaultNormalizedAccountValue.slice(2);
  if (
    requestedNormalizedAccountValue !== undefined &&
    requestedNormalizedAccountValue !== defaultNormalizedAccountValue &&
    !isYuantaLoanAccountNoteAlias
  )
    throw new Error("Counterparty account normalization does not match the source value.");
  const normalizedAccountValue =
    requestedNormalizedAccountValue ?? defaultNormalizedAccountValue;
  const accountDigest = counterpartyAccountDigest(
    namespace,
    normalizedAccountValue,
  );
  if (input.accountDigest !== undefined && input.accountDigest !== accountDigest)
    throw new Error("Counterparty account digest does not match the normalized value.");
  if (input.role !== "originator" && input.role !== "beneficiary")
    throw new Error("Counterparty account role is unsupported.");
  const purpose = text(input.purpose, "Counterparty account purpose").trim();
  const scope = input.scope ?? null;
  if (
    scope !== null &&
    scope !== "loan_contract" &&
    scope !== "shared_collection"
  )
    throw new Error("Counterparty account scope is unsupported.");
  const effectiveStartDate = validDate(
    input.effectiveStartDate,
    "Counterparty account effective start date",
  );
  const effectiveEndDate = validDate(
    input.effectiveEndDate,
    "Counterparty account effective end date",
  );
  if (
    effectiveStartDate !== null &&
    effectiveEndDate !== null &&
    effectiveStartDate > effectiveEndDate
  )
    throw new Error("Counterparty account effective dates are inverted.");
  return Object.freeze({
    ...input,
    captureId: text(input.captureId, "Counterparty account capture ID").trim(),
    sourceRecordKey: text(
      input.sourceRecordKey,
      "Counterparty account source record key",
    ).trim(),
    sourceConnectionKey: text(
      input.sourceConnectionKey,
      "Counterparty account source connection key",
    ).trim(),
    identityEpochKey: text(
      input.identityEpochKey,
      "Counterparty account identity epoch key",
    ).trim(),
      sourceValue,
    normalizedAccountValue,
    accountDigest,
    purpose,
    scope,
    evidenceKind: input.evidenceKind ?? "transaction-counterparty-account",
    sourceField: text(input.sourceField ?? "counterparty-account", "Counterparty account source field").trim(),
    effectiveStartDate,
    effectiveEndDate,
  });
}

function asPath(store: RelationStore): string {
  return store.databasePath ?? ":memory:";
}

function blob(value: unknown, label: string): BlobId {
  if (!(value instanceof Uint8Array) || value.byteLength !== 16)
    throw new Error(`${label} is missing or malformed.`);
  return value;
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function idString(value: unknown, label: string): string {
  const binary = blob(value, label);
  const valueHex = hex(binary);
  return `${valueHex.slice(0, 8)}-${valueHex.slice(8, 12)}-${valueHex.slice(12, 16)}-${valueHex.slice(16, 20)}-${valueHex.slice(20)}`;
}

function accountFromScope(
  db: DatabaseSync,
  captureId: BlobId,
  accountKey: string | undefined,
  sourceConnectionId: BlobId,
  identityEpochId: BlobId,
): BlobId | null {
  const scoped = db
    .prepare(
      `SELECT account_id FROM capture_scopes
       WHERE capture_id = ? AND account_id IS NOT NULL
         AND source_connection_id = ? AND identity_epoch_id = ?
         AND (? IS NULL OR account_no = ?)
       ORDER BY scope_id LIMIT 1`,
    )
    .get(captureId, sourceConnectionId, identityEpochId, accountKey ?? null, accountKey ?? null) as
    | { account_id?: unknown }
    | undefined;
  if (scoped?.account_id instanceof Uint8Array) return scoped.account_id;
  if (!accountKey) return null;
  const account = db
    .prepare(
      `SELECT account_id FROM financial_accounts
       WHERE source_connection_id = ? AND identity_epoch_id = ? AND account_no = ?`,
    )
    .get(sourceConnectionId, identityEpochId, accountKey) as
    | { account_id?: unknown }
    | undefined;
  return account?.account_id instanceof Uint8Array ? account.account_id : null;
}

function captureContext(
  db: DatabaseSync,
  captureKey: string,
  sourceRecordKey: string,
  accountKey?: string,
): { capture: CaptureContext; transaction: TransactionContext | null } {
  const captureRow = db
    .prepare(
      `SELECT capture.capture_id, capture.capture_key,
              capture.source_connection_id, capture.identity_epoch_id,
              capture.commit_id, capture.observed_at,
              connection.source_connection_key, connection.integration_namespace,
              epoch.epoch_key
       FROM source_captures capture
       JOIN source_connections connection
         ON connection.source_connection_id = capture.source_connection_id
       JOIN identity_epochs epoch ON epoch.identity_epoch_id = capture.identity_epoch_id
       WHERE capture.capture_key = ? LIMIT 1`,
    )
    .get(captureKey) as Record<string, unknown> | undefined;
  if (!captureRow)
    throw new Error(`Canonical source capture ${captureKey} was not found.`);
  const captureId = blob(captureRow.capture_id, "Source capture ID");
  const sourceConnectionId = blob(
    captureRow.source_connection_id,
    "Source connection ID",
  );
  const identityEpochId = blob(captureRow.identity_epoch_id, "Identity epoch ID");
  const sourceRecord = db
    .prepare(
      `SELECT record.source_record_id, record.occurrence_key,
              revision.transaction_id, account.account_id, account.account_type,
              account.stream, account.account_no,
              revision.effective_on, revision.amount_coefficient,
              revision.amount_scale, revision.currency, revision.direction,
              loan_fact.event_kind
       FROM source_records record
       LEFT JOIN transaction_revisions revision
         ON revision.source_record_id = record.source_record_id
        AND revision.capture_id = record.capture_id
        AND revision.revision_number = (
          SELECT MAX(newer.revision_number)
          FROM transaction_revisions newer
          WHERE newer.transaction_id = revision.transaction_id
        )
       LEFT JOIN financial_transactions transaction_row
         ON transaction_row.transaction_id = revision.transaction_id
       LEFT JOIN financial_accounts account
         ON account.account_id = transaction_row.account_id
       LEFT JOIN loan_transaction_facts loan_fact
         ON loan_fact.revision_id = revision.revision_id
       WHERE record.capture_id = ? AND record.occurrence_key = ?
       ORDER BY revision.revision_number DESC LIMIT 1`,
    )
    .get(captureId, sourceRecordKey) as Record<string, unknown> | undefined;
  const scopeAccountId = accountFromScope(
    db,
    captureId,
    accountKey,
    sourceConnectionId,
    identityEpochId,
  );
  const capture: CaptureContext = {
    captureId,
    captureKey: String(captureRow.capture_key),
    sourceConnectionId,
    identityEpochId,
    sourceConnectionKey: String(captureRow.source_connection_key),
    identityEpochKey: String(captureRow.epoch_key),
    integrationNamespace: String(captureRow.integration_namespace),
    commitId: blob(captureRow.commit_id, "Capture commit ID"),
    scopeAccountId,
    observedAt: text(captureRow.observed_at, "Capture observed-at timestamp"),
  };
  let transactionRecord = sourceRecord;
  // Replaying an unchanged capture appends a new source observation without
  // inventing another transaction revision. In that case the new source
  // record still names the same account-scoped occurrence. Resolve that
  // occurrence back to its existing canonical transaction so new evidence is
  // transaction-scoped instead of being silently widened to the account.
  if (
    sourceRecord &&
    !(sourceRecord.transaction_id instanceof Uint8Array) &&
    scopeAccountId
  ) {
    const replayedTransaction = db
      .prepare(
        `SELECT transaction_row.transaction_id, account.account_id,
                account.account_type, account.stream, account.account_no,
                revision.effective_on, revision.amount_coefficient,
                revision.amount_scale, revision.currency, revision.direction,
                loan_fact.event_kind
         FROM financial_transactions transaction_row
         JOIN financial_accounts account
           ON account.account_id = transaction_row.account_id
         JOIN transaction_revisions revision
           ON revision.transaction_id = transaction_row.transaction_id
          AND revision.revision_number = (
            SELECT MAX(newer.revision_number)
            FROM transaction_revisions newer
            WHERE newer.transaction_id = transaction_row.transaction_id
          )
         LEFT JOIN loan_transaction_facts loan_fact
           ON loan_fact.revision_id = revision.revision_id
         WHERE transaction_row.account_id = ?
           AND transaction_row.source_sequence = ?
         LIMIT 1`,
      )
      .get(scopeAccountId, String(sourceRecord.occurrence_key)) as
      | Record<string, unknown>
      | undefined;
    if (replayedTransaction) {
      transactionRecord = {
        ...replayedTransaction,
        source_record_id: sourceRecord.source_record_id,
        occurrence_key: sourceRecord.occurrence_key,
      };
    }
  }
  if (
    !transactionRecord ||
    !(transactionRecord.transaction_id instanceof Uint8Array)
  )
    return { capture, transaction: null };
  return {
    capture,
    transaction: {
      ...capture,
      transactionId: blob(transactionRecord.transaction_id, "Transaction ID"),
      accountId: blob(transactionRecord.account_id, "Transaction account ID"),
      sourceRecordId: blob(transactionRecord.source_record_id, "Source record ID"),
      sourceRecordKey: String(transactionRecord.occurrence_key),
      accountType: String(transactionRecord.account_type),
      stream: String(transactionRecord.stream),
      accountNo: String(transactionRecord.account_no),
      effectiveOn: String(transactionRecord.effective_on),
      amountCoefficient: String(transactionRecord.amount_coefficient),
      amountScale: Number(transactionRecord.amount_scale),
      currency: String(transactionRecord.currency),
      direction: String(transactionRecord.direction) as "inflow" | "outflow",
      eventKind:
        transactionRecord.event_kind === null ||
        transactionRecord.event_kind === undefined
          ? null
          : String(transactionRecord.event_kind),
    },
  };
}

function validateEvidenceIdentity(
  evidence: AdmittedCounterpartyAccountEvidence,
  context: CaptureContext,
): void {
  if (
    evidence.sourceConnectionKey !== context.sourceConnectionKey ||
    evidence.identityEpochKey !== context.identityEpochKey
  )
    throw new Error(
      "Counterparty account evidence source scope does not match its capture.",
    );
}

function ensureEvidenceSchema(db: DatabaseSync): void {
  for (const table of [
    "transaction_counterparty_account_evidence",
    "institution_repayment_note_evidence",
  ]) {
    const row = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!row)
      throw new Error(`Canonical schema v10 evidence table ${table} is missing.`);
  }
}

function evidenceId(
  context: CaptureContext,
  transactionId: BlobId | null,
  accountId: BlobId | null,
  evidence: AdmittedCounterpartyAccountEvidence,
): BlobId {
  return createHash("sha256")
    .update(
      [
        "counterparty-account-evidence-id/v1",
        hex(context.captureId),
        transactionId ? hex(transactionId) : "",
        accountId ? hex(accountId) : "",
        evidence.sourceRecordKey,
        evidence.accountDigest,
        evidence.role,
        evidence.purpose,
        evidence.scope ?? "",
        evidence.evidenceKind,
        evidence.contractVersion,
      ].join("\u0000"),
    )
    .digest()
    .subarray(0, 16);
}

function readPersistedEvidence(
  db: DatabaseSync,
  row: Record<string, unknown>,
): PersistedCounterpartyAccountEvidence {
  return {
    evidenceId: idString(row.evidence_id, "Counterparty evidence ID"),
    transactionId:
      row.transaction_id instanceof Uint8Array
        ? idString(row.transaction_id, "Counterparty evidence transaction ID")
        : null,
    accountId:
      row.account_id instanceof Uint8Array
        ? idString(row.account_id, "Counterparty evidence account ID")
        : null,
    sourceRecordId: idString(row.source_record_id, "Counterparty evidence source record ID"),
    captureId: String(
      (
        db
          .prepare("SELECT capture_key FROM source_captures WHERE capture_id = ?")
          .get(row.capture_id as Uint8Array) as { capture_key?: unknown } | undefined
      )?.capture_key ?? "",
    ),
    sourceConnectionKey: String(
      (
        db
          .prepare(
            "SELECT source_connection_key FROM source_connections WHERE source_connection_id = ?",
          )
          .get(row.source_connection_id as Uint8Array) as
          | { source_connection_key?: unknown }
          | undefined
      )?.source_connection_key ?? "",
    ),
    identityEpochKey: String(
      (
        db
          .prepare("SELECT epoch_key FROM identity_epochs WHERE identity_epoch_id = ?")
          .get(row.identity_epoch_id as Uint8Array) as
          | { epoch_key?: unknown }
          | undefined
      )?.epoch_key ?? "",
    ),
    sourceValue: String(row.source_value),
    normalizedValue: String(row.normalized_value),
    valueDigest: String(row.value_digest),
    role: String(row.role) as CounterpartyAccountRole,
    purpose: String(row.purpose),
    scope: row.scope === null ? null : (String(row.scope) as CounterpartyAccountScope),
    evidenceKind: String(row.evidence_kind) as PersistedCounterpartyAccountEvidence["evidenceKind"],
    sourceField: String(row.source_field),
    contractVersion: String(row.contract_version),
    effectiveStartDate:
      row.effective_start_date === null ? null : String(row.effective_start_date),
    effectiveEndDate:
      row.effective_end_date === null ? null : String(row.effective_end_date),
  };
}

function persistEvidenceOnce(
  store: RelationStore,
  input: TransactionCounterpartyAccountEvidenceInput,
): PersistedCounterpartyAccountEvidence {
  ensureEvidenceSchema(store.db);
  const preliminary = captureContext(
    store.db,
    text(input.captureId, "Counterparty account capture ID").trim(),
    text(input.sourceRecordKey, "Counterparty account source record key").trim(),
    input.accountKey,
  );
  const evidence = admitCounterpartyAccountEvidence(
    input,
    preliminary.capture.integrationNamespace,
  );
  validateEvidenceIdentity(evidence, preliminary.capture);
  // A repayment mandate describes the captured loan account, even when its
  // provenance happens to be a transaction-bearing source record.  Keeping
  // it account-scoped lets one provider-declared repayment destination apply
  // to every eligible installment in that account's bounded history.
  const accountScopedMandate =
    evidence.evidenceKind === "repayment-mandate" && Boolean(input.accountKey);
  const transactionId = accountScopedMandate
    ? null
    : preliminary.transaction?.transactionId ?? null;
  const accountId = transactionId ? null : preliminary.capture.scopeAccountId;
  if (!transactionId && !accountId)
    throw new Error(
      "Counterparty account evidence must identify a transaction or a captured account.",
    );
  if (
    evidence.evidenceKind === "repayment-mandate" &&
    accountId === null &&
    preliminary.transaction === null
  )
    throw new Error("Repayment mandate evidence must identify its account scope.");
  const evidenceIdValue = evidenceId(
    preliminary.capture,
    transactionId,
    accountId,
    evidence,
  );
  const existing = store.db
    .prepare(
      `SELECT * FROM transaction_counterparty_account_evidence
       WHERE evidence_id = ? LIMIT 1`,
    )
    .get(evidenceIdValue) as Record<string, unknown> | undefined;
  if (existing) {
    if (
      String(existing.source_value) !== evidence.sourceValue ||
      String(existing.normalized_value) !== evidence.normalizedAccountValue ||
      String(existing.value_digest) !== evidence.accountDigest
    )
      throw new Error("Counterparty account evidence overwrite is forbidden.");
    store.db
      .prepare(
        `INSERT OR IGNORE INTO counterparty_account_evidence_support(
          evidence_id, source_record_id, capture_id, commit_id
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        evidenceIdValue,
        preliminary.transaction?.sourceRecordId ??
          captureSourceRecordId(store.db, preliminary.capture, input.sourceRecordKey),
        preliminary.capture.captureId,
        preliminary.capture.commitId,
      );
    return readPersistedEvidence(store.db, existing);
  }
  const sourceRecordId = preliminary.transaction?.sourceRecordId ??
    captureSourceRecordId(store.db, preliminary.capture, input.sourceRecordKey);
  store.db
    .prepare(
      `INSERT INTO transaction_counterparty_account_evidence(
        evidence_id, transaction_id, account_id, source_record_id, capture_id,
        source_connection_id, identity_epoch_id, source_value, normalized_value,
        value_digest, role, purpose, scope, evidence_kind, source_field,
        contract_version, effective_start_date, effective_end_date, created_commit_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      evidenceIdValue,
      transactionId,
      accountId,
      sourceRecordId,
      preliminary.capture.captureId,
      preliminary.capture.sourceConnectionId,
      preliminary.capture.identityEpochId,
      evidence.sourceValue,
      evidence.normalizedAccountValue,
      evidence.accountDigest,
      evidence.role,
      evidence.purpose,
      evidence.scope ?? null,
      evidence.evidenceKind,
      evidence.sourceField,
      evidence.contractVersion,
      evidence.effectiveStartDate ?? null,
      evidence.effectiveEndDate ?? null,
      preliminary.capture.commitId,
    );
  store.db
    .prepare(
      `INSERT INTO counterparty_account_evidence_support(
        evidence_id, source_record_id, capture_id, commit_id
      ) VALUES (?, ?, ?, ?)`,
    )
    .run(
      evidenceIdValue,
      sourceRecordId,
      preliminary.capture.captureId,
      preliminary.capture.commitId,
    );
  const persisted = store.db
    .prepare(
      "SELECT * FROM transaction_counterparty_account_evidence WHERE evidence_id = ?",
    )
    .get(evidenceIdValue) as Record<string, unknown>;
  return readPersistedEvidence(store.db, persisted);
}

function captureSourceRecordId(
  db: DatabaseSync,
  capture: CaptureContext,
  sourceRecordKey: string,
): BlobId {
  return blob(
    (
      db
        .prepare(
          "SELECT source_record_id FROM source_records WHERE capture_id = ? AND occurrence_key = ? LIMIT 1",
        )
        .get(capture.captureId, sourceRecordKey) as
        | { source_record_id?: unknown }
        | undefined
    )?.source_record_id,
    "Counterparty evidence source record ID",
  );
}

/** Persist exact source account evidence after a canonical Capture commits. */
export async function persistCounterpartyAccountEvidence(
  store: RelationStore,
  input: TransactionCounterpartyAccountEvidenceInput,
): Promise<PersistedCounterpartyAccountEvidence> {
  requireValidatedRelationStore(store);
  return withCanonicalWriterQueue(asPath(store), () => {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const value = persistEvidenceOnce(store, input);
      store.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        store.db.exec("ROLLBACK");
      } catch {
        /* Preserve the original admission/storage error. */
      }
      throw error;
    }
  });
}

export function queryCounterpartyAccountEvidence(
  store: RelationStore,
  options: { transactionId?: string; accountId?: string } = {},
): PersistedCounterpartyAccountEvidence[] {
  requireValidatedRelationStore(store);
  ensureEvidenceSchema(store.db);
  const rows = store.db
    .prepare(
      `SELECT evidence.*
       FROM transaction_counterparty_account_evidence evidence
       WHERE (? IS NULL OR hex(evidence.transaction_id) = REPLACE(?, '-', ''))
         AND (? IS NULL OR hex(evidence.account_id) = REPLACE(?, '-', ''))
       ORDER BY evidence.created_commit_id, evidence.evidence_id`,
    )
    .all(
      options.transactionId ?? null,
      options.transactionId ?? null,
      options.accountId ?? null,
      options.accountId ?? null,
    ) as Array<Record<string, unknown>>;
  return rows.map((row) => readPersistedEvidence(store.db, row));
}

function noteEvidenceId(
  context: CaptureContext,
  transaction: TransactionContext,
  evidence: AdmittedInstitutionGeneratedRepaymentNoteEvidence,
): BlobId {
  return createHash("sha256")
    .update(
      [
        "institution-repayment-note-evidence-id/v1",
        hex(context.captureId),
        hex(transaction.transactionId),
        evidence.sourceRecordKey,
        evidence.normalizedValue,
        evidence.contract.evidenceVersion,
        evidence.contract.patternId,
        evidence.contract.contractVersion,
        evidence.contract.dateContractVersion,
        serializeInstitutionRepaymentDateContract(evidence.contract.dateContract),
      ].join("\u0000"),
    )
    .digest()
    .subarray(0, 16);
}

function validateNoteEvidenceIdentity(
  evidence: AdmittedInstitutionGeneratedRepaymentNoteEvidence,
  context: CaptureContext,
): void {
  if (
    evidence.sourceConnectionKey !== context.sourceConnectionKey ||
    evidence.identityEpochKey !== context.identityEpochKey
  )
    throw new Error(
      "Institution repayment note evidence source scope does not match its capture.",
    );
}

function readPersistedNoteEvidence(
  db: DatabaseSync,
  row: Record<string, unknown>,
): PersistedInstitutionGeneratedRepaymentNoteEvidence {
  const capture = db
    .prepare("SELECT capture_key FROM source_captures WHERE capture_id = ?")
    .get(row.capture_id as Uint8Array) as { capture_key?: unknown } | undefined;
  const connection = db
    .prepare(
      "SELECT source_connection_key FROM source_connections WHERE source_connection_id = ?",
    )
    .get(row.source_connection_id as Uint8Array) as
    | { source_connection_key?: unknown }
    | undefined;
  const epoch = db
    .prepare("SELECT epoch_key FROM identity_epochs WHERE identity_epoch_id = ?")
    .get(row.identity_epoch_id as Uint8Array) as { epoch_key?: unknown } | undefined;
  if (Number(row.live_verified) !== 1)
    throw new Error("Persisted Institution repayment note is not live-verified.");
  return {
    noteEvidenceId: idString(row.note_evidence_id, "Institution note evidence ID"),
    transactionId: idString(row.transaction_id, "Institution note transaction ID"),
    sourceRecordId: idString(row.source_record_id, "Institution note source record ID"),
    captureId: String(capture?.capture_key ?? ""),
    integrationNamespace: String(
      (
        db
          .prepare(
            "SELECT integration_namespace FROM source_connections WHERE source_connection_id = ?",
          )
          .get(row.source_connection_id as Uint8Array) as
          | { integration_namespace?: unknown }
          | undefined
      )?.integration_namespace ?? "",
    ),
    sourceConnectionKey: String(connection?.source_connection_key ?? ""),
    identityEpochKey: String(epoch?.epoch_key ?? ""),
    sourceValue: String(row.source_value),
    normalizedValue: String(row.normalized_value),
    fixedValue: String(row.fixed_value),
    evidenceVersion: String(row.evidence_version),
    patternId: String(row.pattern_id),
    contractVersion: String(row.contract_version),
    dateContractVersion: String(row.date_contract_version),
    dateContract: parsePersistedInstitutionRepaymentDateContract(
      row.date_contract_json,
      String(row.date_contract_version),
    ),
    dateField: String(row.date_field) as "transaction-date",
    generatedBy: String(row.generated_by) as "institution",
    liveVerified: true,
  };
}

function persistInstitutionGeneratedRepaymentNoteEvidenceOnce(
  store: RelationStore,
  input: InstitutionGeneratedRepaymentNoteEvidenceInput,
): PersistedInstitutionGeneratedRepaymentNoteEvidence {
  ensureEvidenceSchema(store.db);
  const preliminary = captureContext(
    store.db,
    text(input.captureId, "Institution repayment note capture ID").trim(),
    text(input.sourceRecordKey, "Institution repayment note source record key").trim(),
  );
  if (!preliminary.transaction)
    throw new Error(
      "Institution repayment note evidence must identify a financial transaction.",
    );
  const evidence = admitInstitutionGeneratedRepaymentNoteEvidence(
    input,
    preliminary.capture.integrationNamespace,
  );
  validateNoteEvidenceIdentity(evidence, preliminary.capture);
  const noteId = noteEvidenceId(preliminary.capture, preliminary.transaction, evidence);
  const existing = store.db
    .prepare(
      "SELECT * FROM institution_repayment_note_evidence WHERE note_evidence_id = ? LIMIT 1",
    )
    .get(noteId) as Record<string, unknown> | undefined;
  const sourceRecordId = preliminary.transaction.sourceRecordId;
  if (existing) {
    if (
      String(existing.source_value) !== evidence.sourceValue ||
      String(existing.normalized_value) !== evidence.normalizedValue ||
      String(existing.fixed_value) !== evidence.fixedValue ||
      String(existing.pattern_id) !== evidence.contract.patternId ||
      String(existing.contract_version) !== evidence.contract.contractVersion ||
      String(existing.date_contract_version) !== evidence.contract.dateContractVersion ||
      String(existing.date_contract_json) !==
        serializeInstitutionRepaymentDateContract(evidence.contract.dateContract)
    )
      throw new Error("Institution repayment note evidence overwrite is forbidden.");
    store.db
      .prepare(
        `INSERT OR IGNORE INTO institution_repayment_note_evidence_support(
          note_evidence_id, source_record_id, capture_id, commit_id
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(noteId, sourceRecordId, preliminary.capture.captureId, preliminary.capture.commitId);
    return readPersistedNoteEvidence(store.db, existing);
  }
  store.db
    .prepare(
      `INSERT INTO institution_repayment_note_evidence(
        note_evidence_id, transaction_id, source_record_id, capture_id,
        source_connection_id, identity_epoch_id, source_value, normalized_value,
        fixed_value, evidence_version, pattern_id, contract_version,
        date_contract_version, date_contract_json, date_field, generated_by, live_verified,
        created_commit_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      noteId,
      preliminary.transaction.transactionId,
      sourceRecordId,
      preliminary.capture.captureId,
      preliminary.capture.sourceConnectionId,
      preliminary.capture.identityEpochId,
      evidence.sourceValue,
      evidence.normalizedValue,
      evidence.fixedValue,
      evidence.contract.evidenceVersion,
      evidence.contract.patternId,
      evidence.contract.contractVersion,
      evidence.contract.dateContractVersion,
      serializeInstitutionRepaymentDateContract(evidence.contract.dateContract),
      evidence.contract.dateField,
      evidence.contract.generatedBy,
      evidence.contract.liveVerified ? 1 : 0,
      preliminary.capture.commitId,
    );
  store.db
    .prepare(
      `INSERT INTO institution_repayment_note_evidence_support(
        note_evidence_id, source_record_id, capture_id, commit_id
      ) VALUES (?, ?, ?, ?)`,
    )
    .run(noteId, sourceRecordId, preliminary.capture.captureId, preliminary.capture.commitId);
  const persisted = store.db
    .prepare("SELECT * FROM institution_repayment_note_evidence WHERE note_evidence_id = ?")
    .get(noteId) as Record<string, unknown>;
  return readPersistedNoteEvidence(store.db, persisted);
}

/** Persist a fixed, live-verified Institution note/code after its Capture commits. */
export async function persistInstitutionGeneratedRepaymentNoteEvidence(
  store: RelationStore,
  input: InstitutionGeneratedRepaymentNoteEvidenceInput,
): Promise<PersistedInstitutionGeneratedRepaymentNoteEvidence> {
  requireValidatedRelationStore(store);
  return withCanonicalWriterQueue(asPath(store), () => {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const value = persistInstitutionGeneratedRepaymentNoteEvidenceOnce(store, input);
      store.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        store.db.exec("ROLLBACK");
      } catch {
        /* Preserve the original admission/storage error. */
      }
      throw error;
    }
  });
}

export function queryInstitutionGeneratedRepaymentNoteEvidence(
  store: RelationStore,
  options: { transactionId?: string; sourceConnectionKey?: string } = {},
): PersistedInstitutionGeneratedRepaymentNoteEvidence[] {
  requireValidatedRelationStore(store);
  ensureEvidenceSchema(store.db);
  const rows = store.db
    .prepare(
      `SELECT evidence.*
       FROM institution_repayment_note_evidence evidence
       JOIN source_connections connection
         ON connection.source_connection_id = evidence.source_connection_id
       WHERE (? IS NULL OR lower(hex(evidence.transaction_id)) = replace(lower(?), '-', ''))
         AND (? IS NULL OR connection.source_connection_key = ?)
       ORDER BY evidence.created_commit_id, evidence.note_evidence_id`,
    )
    .all(
      options.transactionId ?? null,
      options.transactionId ?? null,
      options.sourceConnectionKey ?? null,
      options.sourceConnectionKey ?? null,
    ) as Array<Record<string, unknown>>;
  return rows.map((row) => readPersistedNoteEvidence(store.db, row));
}

function transactionRows(
  db: DatabaseSync,
  sourceConnectionId: BlobId,
): { loans: TransactionContext[]; deposits: TransactionContext[] } {
  const rows = db
    .prepare(
      `SELECT capture.capture_id, capture.capture_key,
              capture.source_connection_id, capture.identity_epoch_id,
              capture.commit_id, capture.observed_at, connection.source_connection_key,
              connection.integration_namespace, epoch.epoch_key,
              record.source_record_id, record.occurrence_key,
              transaction_row.transaction_id, transaction_row.account_id,
              account.account_type, account.stream, account.account_no,
              revision.effective_on, revision.amount_coefficient,
              revision.amount_scale, revision.currency, revision.direction,
              loan_fact.event_kind
       FROM financial_transactions transaction_row
       JOIN financial_accounts account ON account.account_id = transaction_row.account_id
       JOIN source_connections connection
         ON connection.source_connection_id = account.source_connection_id
       JOIN identity_epochs epoch ON epoch.identity_epoch_id = account.identity_epoch_id
       JOIN transaction_revisions revision
         ON revision.transaction_id = transaction_row.transaction_id
        AND NOT EXISTS (
          SELECT 1 FROM transaction_revisions newer
          JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.commit_id
          JOIN canonical_commits current_commit ON current_commit.commit_id = revision.commit_id
          WHERE newer.transaction_id = revision.transaction_id
            AND newer_commit.commit_sequence > current_commit.commit_sequence
        )
       JOIN source_records record ON record.source_record_id = revision.source_record_id
       JOIN source_captures capture ON capture.capture_id = record.capture_id
       LEFT JOIN loan_transaction_facts loan_fact ON loan_fact.revision_id = revision.revision_id
       WHERE account.source_connection_id = ?
       ORDER BY revision.effective_on, record.occurrence_key`,
    )
    .all(sourceConnectionId) as Array<Record<string, unknown>>;
  const mapped = rows.map((row) => ({
    captureId: blob(row.capture_id, "Transaction capture ID"),
    captureKey: String(row.capture_key),
    sourceConnectionId: blob(row.source_connection_id, "Transaction source connection ID"),
    identityEpochId: blob(row.identity_epoch_id, "Transaction identity epoch ID"),
    sourceConnectionKey: String(row.source_connection_key),
    identityEpochKey: String(row.epoch_key),
    integrationNamespace: String(row.integration_namespace),
    commitId: blob(row.commit_id, "Transaction commit ID"),
    scopeAccountId: blob(row.account_id, "Transaction account ID"),
    observedAt: text(row.observed_at, "Transaction capture observed-at timestamp"),
    transactionId: blob(row.transaction_id, "Transaction ID"),
    accountId: blob(row.account_id, "Transaction account ID"),
    sourceRecordId: blob(row.source_record_id, "Transaction source record ID"),
    sourceRecordKey: String(row.occurrence_key),
    accountType: String(row.account_type),
    stream: String(row.stream),
    accountNo: String(row.account_no),
    effectiveOn: String(row.effective_on),
    amountCoefficient: String(row.amount_coefficient),
    amountScale: Number(row.amount_scale),
    currency: String(row.currency),
    direction: String(row.direction) as "inflow" | "outflow",
    eventKind:
      row.event_kind === null || row.event_kind === undefined
        ? null
        : String(row.event_kind),
  } satisfies TransactionContext));
  return {
    loans: mapped.filter(
      (row) =>
        row.accountType === "loan" &&
        (row.eventKind === "payment" || row.eventKind === "interest") &&
        row.direction === "inflow",
    ),
    deposits: mapped.filter(
      (row) => row.accountType === "depository" && row.direction === "outflow",
    ),
  };
}

function captureIsComplete(db: DatabaseSync, captureId: BlobId): boolean {
  const row = db
    .prepare(
      `SELECT capture.completeness AS capture_completeness,
              COUNT(scope.scope_id) AS scope_count,
              SUM(CASE WHEN scope.completeness = 'complete-range'
                          AND scope.terminal = 1
                          AND scope.page_count > 0
                          AND (SELECT COUNT(*)
                               FROM capture_scope_pages page_count
                               WHERE page_count.scope_id = scope.scope_id) = scope.page_count
                          AND (SELECT COUNT(*)
                               FROM capture_scope_pages terminal_page
                               WHERE terminal_page.scope_id = scope.scope_id
                                 AND terminal_page.terminal = 1) = 1
                          AND (SELECT MAX(page_ordinal)
                               FROM capture_scope_pages max_page
                               WHERE max_page.scope_id = scope.scope_id) = scope.page_count - 1
       THEN 1 ELSE 0 END) AS complete_scope_count
       FROM source_captures capture
       LEFT JOIN capture_scopes scope ON scope.capture_id = capture.capture_id
       WHERE capture.capture_id = ?
       GROUP BY capture.capture_id`,
    )
    .get(captureId) as Record<string, unknown> | undefined;
  return (
    row !== undefined &&
    row.capture_completeness === "complete-range" &&
    Number(row.scope_count) > 0 &&
    Number(row.scope_count) === Number(row.complete_scope_count)
  );
}

function evidenceRowsForTransactions(
  db: DatabaseSync,
  transactionIds: readonly BlobId[],
  accountIds: readonly BlobId[],
): Array<Record<string, unknown>> {
  if (transactionIds.length === 0 && accountIds.length === 0) return [];
  const placeholders = [...transactionIds, ...accountIds].map(() => "?").join(",");
  return db
    .prepare(
      `SELECT evidence.*, capture.observed_at AS evidence_observed_at
       FROM transaction_counterparty_account_evidence evidence
       JOIN source_captures capture ON capture.capture_id = evidence.capture_id
       WHERE evidence.purpose = 'loan_repayment'
         AND (evidence.transaction_id IN (${placeholders})
              OR evidence.account_id IN (${placeholders}))`,
    )
    .all(...transactionIds, ...accountIds, ...transactionIds, ...accountIds) as Array<Record<string, unknown>>;
}

function noteRowsForTransactions(
  db: DatabaseSync,
  transactionIds: readonly BlobId[],
): Array<Record<string, unknown>> {
  if (transactionIds.length === 0) return [];
  const placeholders = transactionIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT evidence.*
       FROM institution_repayment_note_evidence evidence
       WHERE evidence.transaction_id IN (${placeholders})
         AND evidence.live_verified = 1`,
    )
    .all(...transactionIds) as Array<Record<string, unknown>>;
}

function mandateEvidenceAppliesToTransaction(
  evidence: Record<string, unknown>,
  transaction: TransactionContext,
): boolean {
  if (evidence.evidence_kind !== "repayment-mandate") return true;
  const start = evidence.effective_start_date === null
    ? null
    : String(evidence.effective_start_date ?? "");
  const end = evidence.effective_end_date === null
    ? null
    : String(evidence.effective_end_date ?? "");
  if (start && transaction.effectiveOn < start) return false;
  if (end && transaction.effectiveOn > end) return false;
  // A current-only mandate carries no historical effective interval.  It
  // proves only what the Institution reported at observation time; treating
  // it as an account-wide historical fact would admit old repayments that
  // were never covered by the source assertion.
  if (!start && !end)
    return observedCalendarDate(evidence.evidence_observed_at) === transaction.effectiveOn;
  return true;
}

/**
 * Canonicalize a decimal coefficient/scale pair without floating point. Both
 * date-scoped and date-independent amount keys must use this exact helper so
 * equivalent values (for example 12500:2 and 125000:3) compare identically.
 */
function canonicalDecimalValueKey(coefficient: string, scale: number): string {
  let normalizedCoefficient = coefficient;
  let normalizedScale = scale;
  // Canonical writers preserve source decimal scale.  Compare exact decimal
  // values rather than their textual coefficient/scale spelling so 12500.00
  // and 12500.0000 remain the same amount without using floating point.
  try {
    let integer = BigInt(normalizedCoefficient);
    while (normalizedScale > 0 && integer % 10n === 0n) {
      integer /= 10n;
      normalizedScale -= 1;
    }
    normalizedCoefficient = integer.toString();
  } catch {
    // Canonical admission already rejects malformed amounts. Keep a stable
    // diagnostic key if a legacy row violates that invariant.
  }
  return `${normalizedCoefficient}:${normalizedScale}`;
}

function amountKey(row: TransactionContext): string {
  return `${row.effectiveOn}\u0000${row.currency}\u0000${canonicalDecimalValueKey(
    row.amountCoefficient,
    row.amountScale,
  )}`;
}

function amountValueKey(row: TransactionContext): string {
  return `${row.currency}\u0000${canonicalDecimalValueKey(
    row.amountCoefficient,
    row.amountScale,
  )}`;
}

function decimalSumEquals(
  parts: readonly TransactionContext[],
  total: TransactionContext,
): boolean {
  if (parts.length === 0 || parts.some((part) => part.currency !== total.currency))
    return false;
  const scale = Math.max(total.amountScale, ...parts.map((part) => part.amountScale));
  try {
    const scaled = (row: TransactionContext) =>
      BigInt(row.amountCoefficient) * 10n ** BigInt(scale - row.amountScale);
    return parts.reduce((sum, part) => sum + scaled(part), 0n) === scaled(total);
  } catch {
    return false;
  }
}

function signedCalendarDayOffset(
  depositDate: string,
  loanDate: string,
): number | null {
  const deposit = Date.parse(`${depositDate}T00:00:00Z`);
  const loan = Date.parse(`${loanDate}T00:00:00Z`);
  if (!Number.isFinite(deposit) || !Number.isFinite(loan)) return null;
  return Math.round((loan - deposit) / 86_400_000);
}

function noteDateContract(row: Record<string, unknown>): InstitutionRepaymentDateContract | null {
  return parsePersistedInstitutionRepaymentDateContract(
    row.date_contract_json,
    String(row.date_contract_version ?? ""),
  );
}

function noteAllowsDatePair(
  note: Record<string, unknown>,
  deposit: TransactionContext,
  loan: TransactionContext,
): boolean {
  const contract = noteDateContract(note);
  if (!contract || deposit.currency !== loan.currency) return false;
  const offset = signedCalendarDayOffset(deposit.effectiveOn, loan.effectiveOn);
  return offset !== null && contract.allowedSignedDayOffsets.includes(offset);
}

function relationPlanKey(plan: Plan): string {
  if (plan.kind === "exact")
    return [
      "exact",
      hex(plan.from.transactionId),
      hex(plan.to.transactionId),
      plan.supportKey,
    ].join("\u0000");
  return [
    "group",
    ...plan.members.map((member) => hex(member.transactionId)).sort(),
    plan.supportKey,
  ].join("\u0000");
}

function assertTransactionPair(
  left: TransactionContext,
  right: TransactionContext,
): { loan: TransactionContext; deposit: TransactionContext } {
  const loan = left.accountType === "loan" ? left : right;
  const deposit = left.accountType === "depository" ? left : right;
  if (
    loan.accountType !== "loan" ||
    loan.eventKind !== "payment" ||
    loan.direction !== "inflow" ||
    deposit.accountType !== "depository" ||
    deposit.direction !== "outflow"
  )
    throw new Error("Loan repayment relations require one loan payment and one deposit outflow.");
  if (!Buffer.from(loan.sourceConnectionId).equals(Buffer.from(deposit.sourceConnectionId)))
    throw new Error("Loan repayment relation endpoints must share one source connection.");
  return { loan, deposit };
}

function explicitPlans(
  db: DatabaseSync,
  links: readonly ExplicitLoanTransactionLink[],
): Plan[] {
  return links.map((link) => {
    const from = captureContext(db, link.fromCaptureId, link.fromSourceRecordKey).transaction;
    const to = captureContext(db, link.toCaptureId, link.toSourceRecordKey).transaction;
    if (!from || !to) throw new Error("Explicit loan relation endpoint is not a financial transaction.");
    assertTransactionPair(from, to);
    const evidenceSourceRecordKey = link.evidenceSourceRecordKey ?? link.fromSourceRecordKey;
    if (evidenceSourceRecordKey !== from.sourceRecordKey && evidenceSourceRecordKey !== to.sourceRecordKey)
      throw new Error("Explicit relation evidence must cite one endpoint source record.");
    text(link.relationId, "Explicit relation ID");
    text(link.contractVersion, "Explicit relation contract version");
    const supportKey = digest(
      "explicit-relation-support/v1",
      link.relationId,
      from.sourceRecordKey,
      to.sourceRecordKey,
    );
    return {
      kind: "exact",
      from,
      to,
      supportKind: "explicit-source-linkage",
      supportKey,
      evidenceSourceRecordKey,
      evidenceRelationId: link.relationId,
      evidenceContractVersion: link.contractVersion,
      evidenceJson: {
        kind: "explicit-source-linkage",
        evidenceVersion: link.contractVersion,
        relationId: link.relationId,
        fromSourceRecordKey: from.sourceRecordKey,
        toSourceRecordKey: to.sourceRecordKey,
      },
    } satisfies Plan;
  });
}

type NoteFallbackCandidate = {
  deposits: TransactionContext[];
  loans: TransactionContext[];
  notes: Record<string, unknown>[];
};

function noteContractKey(row: Record<string, unknown>): string {
  return [
    row.evidence_version,
    row.pattern_id,
    row.contract_version,
    row.date_contract_version,
    row.fixed_value,
  ].map((value) => String(value)).join("\u0000");
}

function fixedInstitutionNoteFallbackPlans(
  rows: { loans: TransactionContext[]; deposits: TransactionContext[] },
  noteEvidence: readonly Record<string, unknown>[],
): Plan[] {
  const notesByDeposit = new Map<string, Record<string, unknown>[]>();
  for (const note of noteEvidence) {
    if (!(note.transaction_id instanceof Uint8Array)) continue;
    const deposit = rows.deposits.find((candidate) =>
      Buffer.from(candidate.transactionId).equals(Buffer.from(note.transaction_id as Uint8Array)),
    );
    if (!deposit) continue;
    const key = hex(deposit.transactionId);
    notesByDeposit.set(key, [...(notesByDeposit.get(key) ?? []), note]);
  }
  if (notesByDeposit.size === 0) return [];

  const candidates = new Map<string, NoteFallbackCandidate>();
  for (const deposit of rows.deposits) {
    const notes = notesByDeposit.get(hex(deposit.transactionId));
    if (!notes || notes.length === 0) continue;
    for (const loan of rows.loans) {
      // The fallback requires exact same-currency amount, but its date
      // relationship is provider-defined.  A note contract may explicitly
      // allow a signed posting lag; same-day is not an implicit default.
      if (deposit.currency !== loan.currency || amountValueKey(deposit) !== amountValueKey(loan))
        continue;
      for (const note of notes) {
        if (!noteAllowsDatePair(note, deposit, loan)) continue;
        const key = `${noteContractKey(note)}\u0000${amountValueKey(deposit)}`;
        const prior = candidates.get(key) ?? { deposits: [], loans: [], notes: [] };
        if (!prior.deposits.some((candidate) =>
          Buffer.from(candidate.transactionId).equals(Buffer.from(deposit.transactionId)),
        )) prior.deposits.push(deposit);
        if (!prior.loans.some((candidate) =>
          Buffer.from(candidate.transactionId).equals(Buffer.from(loan.transactionId)),
        )) prior.loans.push(loan);
        if (!prior.notes.some((candidate) =>
          Buffer.from(candidate.note_evidence_id as Uint8Array).equals(
            Buffer.from(note.note_evidence_id as Uint8Array),
          ),
        )) prior.notes.push(note);
        candidates.set(key, prior);
      }
    }
  }

  const plans: Plan[] = [];
  for (const candidate of candidates.values()) {
    const { deposits, loans, notes } = candidate;
    if (
      deposits.length === 1 &&
      loans.length === 1 &&
      notes.length > 0 &&
      new Set(notes.map(noteContractKey)).size === 1
    ) {
      const deposit = deposits[0]!;
      const loan = loans[0]!;
      const note = notes[0]!;
      plans.push({
        kind: "exact",
        from: deposit,
        to: loan,
        supportKind: "fixed-institution-note",
        supportKey: digest(
          "fixed-institution-note-support/v1",
          String(note.note_evidence_id),
          hex(deposit.transactionId),
          hex(loan.transactionId),
        ),
        evidenceSourceRecordKey: deposit.sourceRecordKey,
        evidenceRelationId: idString(note.note_evidence_id, "Institution note evidence ID"),
        evidenceContractVersion: String(note.contract_version),
        evidenceJson: {
          kind: "fixed-institution-note",
          evidenceVersion: String(note.evidence_version),
          patternId: String(note.pattern_id),
          dateContractVersion: String(note.date_contract_version),
          noteEvidenceId: idString(note.note_evidence_id, "Institution note evidence ID"),
          amountValueKey: amountValueKey(deposit),
          signedCalendarDayOffset: signedCalendarDayOffset(
            deposit.effectiveOn,
            loan.effectiveOn,
          ),
        },
      });
      continue;
    }
    // A group is safe only when every side has multiple matching transactions
    // and every note comes from one fixed provider contract.  A one-to-many or
    // many-to-one match remains unresolved rather than inventing allocations.
    if (
      deposits.length < 2 ||
      loans.length < 2 ||
      deposits.length !== loans.length ||
      notes.length < deposits.length
    )
      continue;
    if (new Set(notes.map(noteContractKey)).size !== 1) continue;
    const members = [...deposits, ...loans];
    const firstNote = notes[0]!;
    plans.push({
      kind: "group",
      members,
      supportKind: "fixed-institution-note",
      supportKey: digest(
        "fixed-institution-note-settlement-group/v1",
        ...notes.map((note) => String(note.note_evidence_id)).sort(),
        ...members.map((member) => hex(member.transactionId)).sort(),
      ),
      evidenceSourceRecordKey: deposits[0]!.sourceRecordKey,
      evidenceRelationId: idString(firstNote.note_evidence_id, "Institution note evidence ID"),
      evidenceContractVersion: String(firstNote.contract_version),
      evidenceJson: {
        kind: "fixed-institution-note",
        evidenceVersion: String(firstNote.evidence_version),
        patternId: String(firstNote.pattern_id),
        dateContractVersion: String(firstNote.date_contract_version),
        noteEvidenceIds: notes.map((note) => idString(note.note_evidence_id, "Institution note evidence ID")),
        amountValueKey: amountValueKey(deposits[0]!),
        collectiveMembership: true,
      },
    });
  }
  return plans;
}

function inferredPlans(
  db: DatabaseSync,
  rows: { loans: TransactionContext[]; deposits: TransactionContext[] },
): Plan[] {
  const loanIds = rows.loans.map((row) => row.transactionId);
  const loanAccountIds = [...new Map(rows.loans.map((row) => [hex(row.accountId), row.accountId])).values()];
  const depositIds = rows.deposits.map((row) => row.transactionId);
  const depositAccountIds = [
    ...new Map(rows.deposits.map((row) => [hex(row.accountId), row.accountId])).values(),
  ];
  const evidence = evidenceRowsForTransactions(
    db,
    [...depositIds, ...loanIds],
    [...loanAccountIds, ...depositAccountIds],
  );
  const depositEvidence = evidence.filter(
    (row) =>
      row.transaction_id instanceof Uint8Array &&
      rows.deposits.some((transaction) => Buffer.from(transaction.transactionId).equals(Buffer.from(row.transaction_id as Uint8Array))) &&
      row.evidence_kind === "transaction-counterparty-account" &&
      row.role === "beneficiary",
  );
  const loanEvidence = evidence.filter(
    (row) =>
      (row.account_id instanceof Uint8Array || row.transaction_id instanceof Uint8Array) &&
      (row.evidence_kind === "repayment-mandate" || row.evidence_kind === "transaction-counterparty-account"),
  );
  const applicableLoanEvidence = loanEvidence.filter((row) =>
    rows.loans.some((candidate) =>
      (row.account_id instanceof Uint8Array
        ? Buffer.from(candidate.accountId).equals(Buffer.from(row.account_id as Uint8Array))
        : row.transaction_id instanceof Uint8Array &&
          Buffer.from(candidate.transactionId).equals(Buffer.from(row.transaction_id as Uint8Array))) &&
      mandateEvidenceAppliesToTransaction(row, candidate),
    ),
  );
  const depositsByDigest = new Map<string, TransactionContext[]>();
  const loansByDigest = new Map<string, TransactionContext[]>();
  for (const row of depositEvidence) {
    const transaction = rows.deposits.find((candidate) =>
      Buffer.from(candidate.transactionId).equals(Buffer.from(row.transaction_id as Uint8Array)),
    );
    if (transaction)
      depositsByDigest.set(row.value_digest as string, [
        ...(depositsByDigest.get(row.value_digest as string) ?? []),
        transaction,
      ]);
  }
  for (const row of applicableLoanEvidence) {
    const transactions = rows.loans.filter((candidate) =>
      row.account_id instanceof Uint8Array
        ? Buffer.from(candidate.accountId).equals(Buffer.from(row.account_id as Uint8Array))
        : Buffer.from(candidate.transactionId).equals(Buffer.from(row.transaction_id as Uint8Array)),
    ).filter((candidate) => mandateEvidenceAppliesToTransaction(row, candidate));
    for (const transaction of transactions)
      loansByDigest.set(row.value_digest as string, [
        ...(loansByDigest.get(row.value_digest as string) ?? []),
        transaction,
      ]);
  }
  const plans: Plan[] = [];
  for (const [valueDigest, deposits] of depositsByDigest) {
    const loans = loansByDigest.get(valueDigest) ?? [];
    const uniqueDeposits = [...new Map(deposits.map((row) => [hex(row.transactionId), row])).values()];
    const uniqueLoans = [...new Map(loans.map((row) => [hex(row.transactionId), row])).values()];
    if (uniqueDeposits.length === 0 || uniqueLoans.length === 0) continue;
    const matchingPairs = uniqueDeposits.flatMap((deposit) =>
      uniqueLoans.map((loan) => ({ deposit, loan })),
    );
    // A mandate is account-level evidence only.  The deposit side must carry
    // a transaction-scoped beneficiary account assertion before a one-to-one
    // exact plan can be emitted; otherwise this digest may be present only
    // because a mandate happens to scope the loan account.
    const exactEvidence = depositEvidence.find((row) => row.value_digest === valueDigest);
    const matchingKey = (pair: { deposit: TransactionContext; loan: TransactionContext }) =>
      `${amountKey(pair.deposit)}\u0000${amountKey(pair.loan)}`;
    if (uniqueDeposits.length === 1 && uniqueLoans.length === 1 && exactEvidence) {
      const pair = matchingPairs[0]!;
      plans.push({
        kind: "exact",
        from: pair.deposit,
        to: pair.loan,
        supportKind: "verified-repayment-destination",
        supportKey: digest(
          "verified-repayment-destination/v1",
          valueDigest,
          pair.deposit.sourceRecordKey,
          pair.loan.sourceRecordKey,
        ),
        evidenceSourceRecordKey: pair.deposit.sourceRecordKey,
        evidenceRelationId: valueDigest,
        evidenceContractVersion: String(exactEvidence.contract_version),
        evidenceJson: {
          kind: "verified-repayment-destination",
          accountDigest: valueDigest,
          evidenceVersion: COUNTERPARTY_ACCOUNT_EVIDENCE_VERSION,
          amountDateComparison: matchingKey(pair),
        },
      });
      continue;
    }
    // A verified account is the admission authority; date and amount do not
    // create the relation. They may, however, make the allocation within that
    // verified history uniquely explainable. When exactly one deposit outflow
    // on a date equals the sum of every loan payment component on that date,
    // preserve that installment as its own settlement group. Anything not
    // uniquely partitioned here remains in the account-wide group below.
    const allocatedDepositIds = new Set<string>();
    const allocatedLoanIds = new Set<string>();
    for (const effectiveOn of [
      ...new Set(uniqueDeposits.map((deposit) => deposit.effectiveOn)),
    ].sort()) {
      const dateDeposits = uniqueDeposits.filter(
        (deposit) => deposit.effectiveOn === effectiveOn,
      );
      const dateLoans = uniqueLoans.filter((loan) => loan.effectiveOn === effectiveOn);
      if (
        dateDeposits.length !== 1 ||
        dateLoans.length === 0 ||
        !decimalSumEquals(dateLoans, dateDeposits[0]!)
      )
        continue;
      const deposit = dateDeposits[0]!;
      const members = [deposit, ...dateLoans];
      plans.push({
        kind: "group",
        members,
        supportKind: "verified-repayment-destination",
        supportKey: digest(
          "verified-repayment-date-total-group/v1",
          valueDigest,
          effectiveOn,
          ...members.map((member) => hex(member.transactionId)).sort(),
        ),
        evidenceSourceRecordKey: deposit.sourceRecordKey,
        evidenceRelationId: valueDigest,
        evidenceContractVersion: String(exactEvidence?.contract_version ?? ""),
        evidenceJson: {
          kind: "verified-repayment-destination",
          accountDigest: valueDigest,
          evidenceVersion: COUNTERPARTY_ACCOUNT_EVIDENCE_VERSION,
          ambiguous: dateLoans.length > 1,
          collectiveMembership: true,
          allocationBasis: "same-date-complete-component-sum",
          effectiveOn,
          amountDateComparison: dateLoans
            .map((loan) => matchingKey({ deposit, loan }))
            .sort(),
        },
      });
      allocatedDepositIds.add(hex(deposit.transactionId));
      dateLoans.forEach((loan) => allocatedLoanIds.add(hex(loan.transactionId)));
    }
    const remainingDeposits = uniqueDeposits.filter(
      (deposit) => !allocatedDepositIds.has(hex(deposit.transactionId)),
    );
    const remainingLoans = uniqueLoans.filter(
      (loan) => !allocatedLoanIds.has(hex(loan.transactionId)),
    );
    // A verified repayment destination establishes collective membership.  It
    // does not require dates or amounts to agree, and it does not authorize an
    // invented allocation between individual endpoints.  Keep every eligible
    // endpoint in one settlement group, including one-to-many/many-to-one
    // cases, so amount/date differences remain explicitly unexplained.
    if (
      matchingPairs.length > 0 &&
      remainingDeposits.length > 0 &&
      remainingLoans.length > 0 &&
      exactEvidence
    ) {
      const members = [...remainingDeposits, ...remainingLoans];
      plans.push({
        kind: "group",
        members,
        supportKind: "verified-repayment-destination",
        supportKey: digest(
          "verified-repayment-settlement-group/v1",
          valueDigest,
          ...members.map((member) => hex(member.transactionId)).sort(),
        ),
        evidenceSourceRecordKey: remainingDeposits[0]!.sourceRecordKey,
        evidenceRelationId: valueDigest,
        evidenceContractVersion: String(exactEvidence.contract_version),
        evidenceJson: {
          kind: "verified-repayment-destination",
          accountDigest: valueDigest,
          evidenceVersion: COUNTERPARTY_ACCOUNT_EVIDENCE_VERSION,
          ambiguous: true,
          collectiveMembership: true,
          amountDateComparison: matchingPairs.map(matchingKey).sort(),
        },
      });
    }
  }
  // Account evidence is the stronger, explicitly account-scoped path.  Even
  // when its candidates are ambiguous or temporally invalid, the presence of
  // obtainable account evidence must not silently downgrade the resolution to
  // a note/amount heuristic.
  // The fallback is permitted only when no repayment-purpose account or
  // mandate evidence exists at all.  An expired or current-only mandate is
  // still source evidence for this scope; it must fail closed instead of
  // being treated as if the account path were unavailable and silently
  // downgraded to note/date/amount coincidence.
  if (evidence.length > 0) return plans;

  return fixedInstitutionNoteFallbackPlans(
    rows,
    noteRowsForTransactions(db, [...rows.deposits, ...rows.loans].map((row) => row.transactionId)),
  );
}

function endpointSet(plan: Plan): Set<string> {
  if (plan.kind === "exact") return new Set([hex(plan.from.transactionId), hex(plan.to.transactionId)]);
  return new Set(plan.members.map((member) => hex(member.transactionId)));
}

function currentGeneration(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT generation.generation_id
       FROM active_projection_generation active
       JOIN projection_generations generation ON generation.generation_id = active.generation_id
       WHERE active.singleton_id = 1 AND generation.status = 'active'`,
    )
    .get() as { generation_id?: unknown } | undefined;
  if (!row || !Number.isSafeInteger(Number(row.generation_id)))
    throw new Error("Canonical active projection generation is missing.");
  return Number(row.generation_id);
}

function ensureLoanAccountIdentity(db: DatabaseSync, transaction: TransactionContext, commitId: BlobId): void {
  // The v9 compatibility table intentionally only models loan and domestic
  // deposit identities. Generic repayment relations may involve another
  // depository stream (for example foreign currency), so do not force those
  // accounts through its narrower legacy CHECK constraint.
  if (
    transaction.accountType !== "loan" &&
    transaction.stream !== "loan" &&
    transaction.stream !== "domestic-deposit"
  )
    return;
  if (transaction.accountType === "loan" && transaction.stream !== "loan")
    return;
  if (
    transaction.accountType === "depository" &&
    transaction.stream !== "domestic-deposit"
  )
    return;
  const existing = db
    .prepare(
      "SELECT account_key, account_no, account_type, stream, source_connection_id, identity_epoch_id FROM loan_account_identities WHERE account_id = ?",
    )
    .get(transaction.accountId) as Record<string, unknown> | undefined;
  const expected = {
    account_key: transaction.accountNo,
    account_no: transaction.accountNo,
    account_type: transaction.accountType,
    stream: transaction.stream,
  };
  if (existing) {
    for (const [key, value] of Object.entries({
      account_key: expected.account_key,
      account_type: expected.account_type,
      stream: expected.stream,
    }))
      if (existing[key] !== value)
        throw new Error("Loan relation endpoint account identity overwrite is forbidden.");
    if (
      !(existing.source_connection_id instanceof Uint8Array) ||
      !Buffer.from(existing.source_connection_id).equals(
        Buffer.from(transaction.sourceConnectionId),
      ) ||
      !(existing.identity_epoch_id instanceof Uint8Array) ||
      !Buffer.from(existing.identity_epoch_id).equals(
        Buffer.from(transaction.identityEpochId),
      )
    )
      throw new Error("Loan relation endpoint source identity overwrite is forbidden.");
    return;
  }
  db.prepare(
    `INSERT INTO loan_account_identities(
      account_id, source_connection_id, identity_epoch_id, created_commit_id,
      account_key, account_no, account_type, stream
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    transaction.accountId,
    transaction.sourceConnectionId,
    transaction.identityEpochId,
    commitId,
    expected.account_key,
    expected.account_no,
    expected.account_type,
    expected.stream,
  );
}

function canonicalEndpoints(from: TransactionContext, to: TransactionContext): [TransactionContext, TransactionContext] {
  const fromKey = Buffer.concat([from.accountId, from.transactionId]);
  const toKey = Buffer.concat([to.accountId, to.transactionId]);
  return Buffer.compare(fromKey, toKey) <= 0 ? [from, to] : [to, from];
}

function persistExact(
  db: DatabaseSync,
  plan: Extract<Plan, { kind: "exact" }>,
  resolutionId: BlobId,
  commitId: BlobId,
  generationId: number,
): { relationId: BlobId; inserted: boolean } {
  const [from, to] = canonicalEndpoints(plan.from, plan.to);
  ensureLoanAccountIdentity(db, from, commitId);
  ensureLoanAccountIdentity(db, to, commitId);
  const loan = from.accountType === "loan" ? from : to;
  const relationKey = [
    "loan-relation-v10",
    hex(from.sourceConnectionId),
    hex(from.identityEpochId),
    hex(to.identityEpochId),
    hex(from.accountId),
    hex(from.transactionId),
    hex(to.accountId),
    hex(to.transactionId),
  ].join(":");
  const existing = db
    .prepare(
      `SELECT relation_id FROM transaction_relations
       WHERE (from_transaction_id = ? AND to_transaction_id = ?)
          OR (from_transaction_id = ? AND to_transaction_id = ?)
       ORDER BY commit_id LIMIT 1`,
    )
    .get(from.transactionId, to.transactionId, to.transactionId, from.transactionId) as
    | { relation_id?: unknown }
    | undefined;
  let relationId: BlobId;
  let inserted = false;
  if (existing?.relation_id instanceof Uint8Array) {
    relationId = existing.relation_id;
  } else {
    relationId = createCanonicalOpaqueId();
    inserted = true;
    db.prepare(
      `INSERT INTO transaction_relations(
        relation_id, account_id, source_connection_id, identity_epoch_id,
        commit_id, relation_key, relation_kind,
        from_account_id, to_account_id, from_source_record_key, to_source_record_key,
        from_transaction_id, to_transaction_id, from_direction, to_direction,
        evidence_source_record_key, evidence_relation_id, evidence_contract_version,
        from_identity_epoch_id, to_identity_epoch_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'transfer_counterpart', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
    ).run(
      relationId,
      loan.accountId,
      from.sourceConnectionId,
      loan.identityEpochId,
      commitId,
      relationKey,
      from.accountId,
      to.accountId,
      from.sourceRecordKey,
      to.sourceRecordKey,
      from.transactionId,
      to.transactionId,
      from.direction,
      to.direction,
      plan.evidenceSourceRecordKey,
      plan.evidenceRelationId,
      plan.evidenceContractVersion,
      from.identityEpochId,
      to.identityEpochId,
    );
  }
  const evidenceRecord =
    plan.evidenceSourceRecordKey === from.sourceRecordKey
      ? from
      : plan.evidenceSourceRecordKey === to.sourceRecordKey
        ? to
        : null;
  if (!evidenceRecord)
    throw new Error("Loan relation evidence source record is not an endpoint.");
  db.prepare(
    `INSERT OR IGNORE INTO transaction_relation_provenance(
      relation_id, source_record_id, capture_id, commit_id,
      evidence_source_record_key, evidence_relation_id, evidence_contract_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    relationId,
    evidenceRecord.sourceRecordId,
    evidenceRecord.captureId,
    commitId,
    plan.evidenceSourceRecordKey,
    plan.evidenceRelationId,
    plan.evidenceContractVersion,
  );
  db.prepare(
    `INSERT INTO current_loan_relations(
      generation_id, relation_id, projection_commit_id, relation_commit_id
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(generation_id, relation_id) DO UPDATE SET projection_commit_id = excluded.projection_commit_id`,
  ).run(generationId, relationId, commitId, commitId);
  return { relationId, inserted };
}

function persistGroup(
  db: DatabaseSync,
  plan: Extract<Plan, { kind: "group" }>,
  resolutionId: BlobId,
  commitId: BlobId,
  generationId: number,
): { groupId: BlobId; inserted: boolean } {
  const sorted = [...plan.members].sort((left, right) =>
    hex(left.transactionId).localeCompare(hex(right.transactionId)),
  );
  const groupKey = [
    "loan-settlement-group-v10",
    hex(sorted[0]!.sourceConnectionId),
    ...sorted.map((member) => hex(member.transactionId)),
    plan.supportKey,
  ].join(":");
  const existing = db
    .prepare("SELECT settlement_group_id FROM loan_repayment_settlement_groups WHERE group_key = ?")
    .get(groupKey) as { settlement_group_id?: unknown } | undefined;
  const groupId = existing?.settlement_group_id instanceof Uint8Array
    ? existing.settlement_group_id
    : createCanonicalOpaqueId();
  const inserted = !(existing?.settlement_group_id instanceof Uint8Array);
  if (inserted)
    db.prepare(
      `INSERT INTO loan_repayment_settlement_groups(
        settlement_group_id, source_connection_id, group_key,
        resolver_version, created_commit_id
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(groupId, sorted[0]!.sourceConnectionId, groupKey, LOAN_REPAYMENT_RELATION_RESOLVER_VERSION, commitId);
  for (const member of sorted) {
    ensureLoanAccountIdentity(db, member, commitId);
    db.prepare(
      `INSERT OR IGNORE INTO loan_repayment_settlement_group_members(
        settlement_group_id, transaction_id, member_kind,
        source_record_id, capture_id, commit_id
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      groupId,
      member.transactionId,
      member.accountType === "loan" ? "loan_payment" : "deposit_outflow",
      member.sourceRecordId,
      member.captureId,
      commitId,
    );
  }
  db.prepare(
    `INSERT INTO current_loan_repayment_settlement_groups(
      generation_id, settlement_group_id, projection_commit_id
    ) VALUES (?, ?, ?)
    ON CONFLICT(generation_id, settlement_group_id) DO UPDATE SET projection_commit_id = excluded.projection_commit_id`,
  ).run(generationId, groupId, commitId);
  return { groupId, inserted };
}

function supersedeOverlappingCurrent(
  db: DatabaseSync,
  plan: Plan,
  resolutionId: BlobId,
  commitId: BlobId,
  replacementRelationId: BlobId | null,
  replacementGroupId: BlobId | null,
): number {
  const members = endpointSet(plan);
  let count = 0;
  const generationId = currentGeneration(db);

  // A relation is an assertion about one ordered pair of endpoints.  Only an
  // assertion about that same pair can replace it; sharing one endpoint is
  // not a conflict (for example, one deposit may have two independently
  // source-backed counterparts).  The normal writer reuses the existing
  // relation ID for the same pair, so this branch is mostly a guard for
  // legacy rows whose relation ID was not reused.
  if (plan.kind === "exact") {
    const currentRelations = db
      .prepare(
        `SELECT current.relation_id, relation.from_transaction_id, relation.to_transaction_id
         FROM current_loan_relations current
         JOIN transaction_relations relation ON relation.relation_id = current.relation_id
         WHERE current.generation_id = ?`,
      )
      .all(generationId) as Array<Record<string, unknown>>;
    for (const current of currentRelations) {
      const from = current.from_transaction_id instanceof Uint8Array ? hex(current.from_transaction_id) : "";
      const to = current.to_transaction_id instanceof Uint8Array ? hex(current.to_transaction_id) : "";
      if (!members.has(from) || !members.has(to)) continue;
      const currentRelationId = blob(current.relation_id, "Current relation ID");
      if (replacementRelationId && Buffer.from(currentRelationId).equals(Buffer.from(replacementRelationId))) continue;
      db.prepare("DELETE FROM current_loan_relations WHERE generation_id = ? AND relation_id = ?").run(generationId, currentRelationId);
      db.prepare(
        `INSERT OR IGNORE INTO loan_repayment_relation_events(
          event_id, resolution_id, relation_id, settlement_group_id, event_kind,
          support_kind, support_key, supersedes_relation_id, supersedes_group_id,
          evidence_json, commit_id
        ) VALUES (?, ?, ?, NULL, 'superseded', ?, ?, ?, ?, ?, ?)`,
      ).run(createCanonicalOpaqueId(), resolutionId, currentRelationId, plan.supportKind, plan.supportKey, replacementRelationId, replacementGroupId, JSON.stringify({ superseded: "current-relation" }), commitId);
      count += 1;
    }
  }

  // A settlement group records collective membership.  A relation for one
  // pair inside a multi-member group does not contradict that membership, so
  // it must remain current.  The only safe group replacement here is an
  // exact plan whose two endpoints are the complete group membership (a
  // legacy/synthetic two-member group); larger groups stay current.
  const currentGroups = db
    .prepare(
      `SELECT current.settlement_group_id
       FROM current_loan_repayment_settlement_groups current
       WHERE current.generation_id = ?`,
    )
    .all(generationId) as Array<Record<string, unknown>>;
  for (const current of currentGroups) {
    const groupId = current.settlement_group_id as Uint8Array;
    if (plan.kind !== "exact") continue;
    if (replacementGroupId && Buffer.from(groupId).equals(Buffer.from(replacementGroupId))) continue;
    const currentMembers = db
      .prepare("SELECT transaction_id FROM loan_repayment_settlement_group_members WHERE settlement_group_id = ?")
      .all(groupId) as Array<Record<string, unknown>>;
    const currentMemberKeys = new Set(
      currentMembers
        .filter((member) => member.transaction_id instanceof Uint8Array)
        .map((member) => hex(member.transaction_id as Uint8Array)),
    );
    if (
      currentMemberKeys.size !== members.size ||
      [...currentMemberKeys].some((member) => !members.has(member))
    )
      continue;
    db.prepare("DELETE FROM current_loan_repayment_settlement_groups WHERE generation_id = ? AND settlement_group_id = ?").run(generationId, groupId);
    db.prepare(
      `INSERT OR IGNORE INTO loan_repayment_relation_events(
        event_id, resolution_id, relation_id, settlement_group_id, event_kind,
        support_kind, support_key, supersedes_relation_id, supersedes_group_id,
        evidence_json, commit_id
      ) VALUES (?, ?, NULL, ?, 'superseded', ?, ?, ?, ?, ?, ?)`,
    ).run(createCanonicalOpaqueId(), resolutionId, groupId, plan.supportKind, plan.supportKey, replacementRelationId, replacementGroupId, JSON.stringify({ superseded: "current-settlement-group" }), commitId);
    count += 1;
  }
  return count;
}

function withdrawStaleVerifiedAccountGroups(
  db: DatabaseSync,
  sourceConnectionId: BlobId,
  plans: readonly Plan[],
  desiredGroupIds: readonly BlobId[],
  resolutionId: BlobId,
  commitId: BlobId,
): number {
  const planByDigest = new Map<string, Plan>();
  for (const plan of plans) {
    if (plan.supportKind !== "verified-repayment-destination") continue;
    const accountDigest = plan.evidenceJson.accountDigest;
    if (typeof accountDigest === "string")
      planByDigest.set(accountDigest, plan);
  }
  if (planByDigest.size === 0) return 0;
  const desired = new Set(desiredGroupIds.map(hex));
  const generationId = currentGeneration(db);
  const current = db
    .prepare(
      `SELECT current.settlement_group_id, event.evidence_json
       FROM current_loan_repayment_settlement_groups current
       JOIN loan_repayment_settlement_groups group_row
         ON group_row.settlement_group_id = current.settlement_group_id
       JOIN loan_repayment_relation_events event
         ON event.settlement_group_id = current.settlement_group_id
        AND event.event_kind = 'observed'
       JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
       WHERE current.generation_id = ?
         AND group_row.source_connection_id = ?
         AND event.support_kind = 'verified-repayment-destination'
         AND NOT EXISTS (
           SELECT 1 FROM loan_repayment_relation_events newer
           JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.commit_id
           WHERE newer.settlement_group_id = event.settlement_group_id
             AND newer.event_kind = 'observed'
             AND newer_commit.commit_sequence > event_commit.commit_sequence
         )`,
    )
    .all(generationId, sourceConnectionId) as Array<Record<string, unknown>>;
  let withdrawn = 0;
  for (const row of current) {
    const groupId = blob(row.settlement_group_id, "Current settlement group ID");
    if (desired.has(hex(groupId))) continue;
    let accountDigest: string | undefined;
    try {
      const evidence = JSON.parse(String(row.evidence_json)) as {
        accountDigest?: unknown;
      };
      if (typeof evidence.accountDigest === "string")
        accountDigest = evidence.accountDigest;
    } catch {
      continue;
    }
    if (!accountDigest) continue;
    const replacementPlan = planByDigest.get(accountDigest);
    if (!replacementPlan) continue;
    db.prepare(
      `DELETE FROM current_loan_repayment_settlement_groups
       WHERE generation_id = ? AND settlement_group_id = ?`,
    ).run(generationId, groupId);
    db.prepare(
      `INSERT OR IGNORE INTO loan_repayment_relation_events(
        event_id, resolution_id, relation_id, settlement_group_id, event_kind,
        support_kind, support_key, supersedes_relation_id, supersedes_group_id,
        evidence_json, commit_id
      ) VALUES (?, ?, NULL, ?, 'withdrawn', ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      createCanonicalOpaqueId(),
      resolutionId,
      groupId,
      replacementPlan.supportKind,
      replacementPlan.supportKey,
      JSON.stringify({
        withdrawn: "stale-verified-account-allocation",
        accountDigest,
      }),
      commitId,
    );
    withdrawn += 1;
  }
  return withdrawn;
}

function resolutionSourceConnection(
  db: DatabaseSync,
  request: LoanRepaymentRelationResolutionRequest,
): { id: BlobId; namespace: string } {
  const row = db
    .prepare(
      `SELECT source_connection_id, integration_namespace
       FROM source_connections
       WHERE source_connection_key = ?
         AND (? IS NULL OR integration_namespace = ?)
       ORDER BY integration_namespace LIMIT 1`,
    )
    .get(request.sourceConnectionKey, request.integrationNamespace ?? null, request.integrationNamespace ?? null) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Loan repayment source connection was not found.");
  return { id: blob(row.source_connection_id, "Source connection ID"), namespace: String(row.integration_namespace) };
}

function resolutionInputCommitId(db: DatabaseSync): BlobId {
  return blob(
    (
      db
        .prepare(
          "SELECT commit_id FROM canonical_commits WHERE commit_kind <> 'relation_resolution' ORDER BY commit_sequence DESC LIMIT 1",
        )
        .get() as { commit_id?: unknown } | undefined
    )?.commit_id,
    "Loan repayment resolution input commit ID",
  );
}

function createResolutionCommit(store: RelationStore): BlobId {
  const latest = store.db
    .prepare(
      `SELECT COALESCE(MAX(commit_sequence), 0) AS commit_sequence,
              COALESCE(MAX(recorded_at_utc_us), -1) AS recorded_at_utc_us
         FROM canonical_commits`,
    )
    .get() as {
    commit_sequence?: number;
    recorded_at_utc_us?: number;
  };
  const candidate = (store.commitClock ?? (() => Date.now() * 1_000))();
  if (!Number.isSafeInteger(candidate) || candidate < 0)
    throw new Error(
      "Loan repayment relation resolution clock returned invalid UTC micros.",
    );
  const commitId = createCanonicalOpaqueId();
  store.db
    .prepare(
      `INSERT INTO canonical_commits(
         commit_id, commit_sequence, recorded_at_utc_us, authority_route,
         commit_kind
       ) VALUES (?, ?, ?, ?, 'relation_resolution')`,
    )
    .run(
      commitId,
      Number(latest.commit_sequence ?? 0) + 1,
      Math.max(candidate, Number(latest.recorded_at_utc_us ?? -1) + 1),
      LOAN_REPAYMENT_RELATION_RESOLUTION_AUTHORITY,
    );
  return commitId;
}

type NoAdmissionCoverageState = "complete" | "incomplete";

function noAdmissionInvocationKey(
  request: LoanRepaymentRelationResolutionRequest,
  plans: readonly Plan[],
): string {
  const mode = request.explicitLinks ? "explicit" : "inferred";
  const planKeys = plans.map(relationPlanKey).sort();
  return [mode, ...planKeys].join("\u0000");
}

function persistNoAdmissionRun(
  store: RelationStore,
  connection: { id: BlobId; namespace: string },
  coverageState: NoAdmissionCoverageState,
  reason: string,
  observedAt: string,
  inputCommitId: BlobId,
  invocationKey: string,
): { resolutionId: string; inserted: boolean } {
  const resolutionKey = digest(
    "loan-repayment-no-admission-resolution/v1",
    hex(connection.id),
    connection.namespace,
    LOAN_REPAYMENT_RELATION_RESOLVER_VERSION,
    coverageState,
    reason,
    observedAt,
    hex(inputCommitId),
    invocationKey,
  );
  const existing = store.db
    .prepare(
      "SELECT resolution_id, outcome FROM loan_repayment_resolution_runs WHERE resolution_key = ?",
    )
    .get(resolutionKey) as
    | { resolution_id?: unknown; outcome?: unknown }
    | undefined;
  if (existing?.resolution_id instanceof Uint8Array) {
    if (existing.outcome !== "no-admission")
      throw new Error("Loan repayment no-admission resolution key was reused.");
    return {
      resolutionId: idString(existing.resolution_id, "Resolution ID"),
      inserted: false,
    };
  }
  const resolutionId = createCanonicalOpaqueId();
  const commitId = createResolutionCommit(store);
  store.db.prepare(
    `INSERT INTO loan_repayment_resolution_runs(
      resolution_id, resolution_key, source_connection_id, resolver_version,
      coverage_state, outcome, reason, observed_at, commit_id
    ) VALUES (?, ?, ?, ?, ?, 'no-admission', ?, ?, ?)`,
  ).run(
    resolutionId,
    resolutionKey,
    connection.id,
    LOAN_REPAYMENT_RELATION_RESOLVER_VERSION,
    coverageState,
    reason,
    observedAt,
    commitId,
  );
  return {
    resolutionId: idString(resolutionId, "Resolution ID"),
    inserted: true,
  };
}

function noAdmissionResult(
  store: RelationStore,
  connection: { id: BlobId; namespace: string },
  request: LoanRepaymentRelationResolutionRequest,
  coverageState: NoAdmissionCoverageState,
  reason: string,
  inputCommitId: BlobId,
  plans: readonly Plan[],
  observedAt: string,
): LoanRepaymentRelationResolutionResult {
  const persisted = persistNoAdmissionRun(
    store,
    connection,
    coverageState,
    reason,
    observedAt,
    inputCommitId,
    noAdmissionInvocationKey(request, plans),
  );
  return {
    status: "canonical-live",
    outcome: persisted.inserted ? "no-admission" : "unchanged",
    resolutionId: persisted.resolutionId,
    exactRelationIds: [],
    settlementGroupIds: [],
    reason,
  };
}

function resolveOnce(
  store: RelationStore,
  request: LoanRepaymentRelationResolutionRequest,
): LoanRepaymentRelationResolutionResult {
  ensureEvidenceSchema(store.db);
  const connection = resolutionSourceConnection(store.db, request);
  const observedAt = request.observedAt ?? new Date().toISOString();
  const inputCommitId = resolutionInputCommitId(store.db);
  const rows = transactionRows(store.db, connection.id);
  const plans = request.explicitLinks
    ? explicitPlans(store.db, request.explicitLinks)
    : inferredPlans(store.db, rows);
  if (
    request.explicitLinks &&
    plans.some(
      (plan) =>
        plan.kind === "exact" &&
        (!Buffer.from(plan.from.sourceConnectionId).equals(Buffer.from(connection.id)) ||
          !Buffer.from(plan.to.sourceConnectionId).equals(Buffer.from(connection.id))),
    )
  )
    throw new Error(
      "Explicit loan repayment relation endpoints must belong to the requested source connection.",
    );
  if (request.requiredCoverage?.complete === false)
    return noAdmissionResult(
      store,
      connection,
      request,
      "incomplete",
      "required-capture-coverage-is-incomplete",
      inputCommitId,
      plans,
      observedAt,
    );
  const relevantTransactions = plans.flatMap((plan) =>
    plan.kind === "exact" ? [plan.from, plan.to] : [...plan.members],
  );
  if (!request.explicitLinks && relevantTransactions.some((transaction) => !captureIsComplete(store.db, transaction.captureId)))
    return noAdmissionResult(
      store,
      connection,
      request,
      "incomplete",
      "required-capture-coverage-is-incomplete",
      inputCommitId,
      plans,
      observedAt,
    );
  if (plans.length === 0)
    return noAdmissionResult(
      store,
      connection,
      request,
      "complete",
      "no-evidence-backed-admission",
      inputCommitId,
      plans,
      observedAt,
    );
  const resolutionKey = digest(
    "loan-repayment-resolution/v1",
    hex(connection.id),
    ...plans.map(relationPlanKey).sort(),
  );
  const existingRun = store.db
    .prepare("SELECT resolution_id, outcome FROM loan_repayment_resolution_runs WHERE resolution_key = ?")
    .get(resolutionKey) as { resolution_id?: unknown; outcome?: unknown } | undefined;
  if (existingRun?.resolution_id instanceof Uint8Array) {
    const observed = store.db
      .prepare(
        `SELECT relation_id, settlement_group_id
         FROM loan_repayment_relation_events
         WHERE resolution_id = ? AND event_kind = 'observed'
         ORDER BY event_id`,
      )
      .all(existingRun.resolution_id) as Array<Record<string, unknown>>;
    return {
      status: "canonical-live",
      outcome: "unchanged",
      resolutionId: idString(existingRun.resolution_id, "Resolution ID"),
      exactRelationIds: observed
        .filter((row) => row.relation_id instanceof Uint8Array)
        .map((row) => idString(row.relation_id, "Relation ID")),
      settlementGroupIds: observed
        .filter((row) => row.settlement_group_id instanceof Uint8Array)
        .map((row) => idString(row.settlement_group_id, "Settlement group ID")),
    };
  }
  const commitId = createResolutionCommit(store);
  const resolutionId = createCanonicalOpaqueId();
  store.db
    .prepare(
      `INSERT INTO loan_repayment_resolution_runs(
        resolution_id, resolution_key, source_connection_id, resolver_version,
        coverage_state, outcome, reason, observed_at, commit_id
      ) VALUES (?, ?, ?, ?, 'complete', 'changed', NULL, ?, ?)`,
    )
    .run(resolutionId, resolutionKey, connection.id, LOAN_REPAYMENT_RELATION_RESOLVER_VERSION, observedAt, commitId);
  const generationId = currentGeneration(store.db);
  const exactRelationIds: BlobId[] = [];
  const settlementGroupIds: BlobId[] = [];
  let changed = false;
  for (const plan of plans) {
    if (plan.kind === "exact") {
      const persisted = persistExact(store.db, plan, resolutionId, commitId, generationId);
      exactRelationIds.push(persisted.relationId);
      changed ||= persisted.inserted;
      store.db.prepare(
        `INSERT OR IGNORE INTO loan_repayment_relation_events(
          event_id, resolution_id, relation_id, settlement_group_id, event_kind,
          support_kind, support_key, supersedes_relation_id, supersedes_group_id,
          evidence_json, commit_id
        ) VALUES (?, ?, ?, NULL, 'observed', ?, ?, NULL, NULL, ?, ?)`,
      ).run(createCanonicalOpaqueId(), resolutionId, persisted.relationId, plan.supportKind, plan.supportKey, JSON.stringify(plan.evidenceJson), commitId);
      const superseded = supersedeOverlappingCurrent(
        store.db,
        plan,
        resolutionId,
        commitId,
        persisted.relationId,
        null,
      );
      changed ||= superseded > 0;
    } else {
      const persisted = persistGroup(store.db, plan, resolutionId, commitId, generationId);
      settlementGroupIds.push(persisted.groupId);
      changed ||= persisted.inserted;
      store.db.prepare(
        `INSERT OR IGNORE INTO loan_repayment_relation_events(
          event_id, resolution_id, relation_id, settlement_group_id, event_kind,
          support_kind, support_key, supersedes_relation_id, supersedes_group_id,
          evidence_json, commit_id
        ) VALUES (?, ?, NULL, ?, 'observed', ?, ?, NULL, NULL, ?, ?)`,
      ).run(createCanonicalOpaqueId(), resolutionId, persisted.groupId, plan.supportKind, plan.supportKey, JSON.stringify(plan.evidenceJson), commitId);
      const superseded = supersedeOverlappingCurrent(
        store.db,
        plan,
        resolutionId,
        commitId,
        null,
        persisted.groupId,
      );
      changed ||= superseded > 0;
    }
  }
  if (!request.explicitLinks) {
    const withdrawn = withdrawStaleVerifiedAccountGroups(
      store.db,
      connection.id,
      plans,
      settlementGroupIds,
      resolutionId,
      commitId,
    );
    changed ||= withdrawn > 0;
  }
  if (!changed)
    store.db.prepare("UPDATE loan_repayment_resolution_runs SET outcome = 'unchanged' WHERE resolution_id = ?").run(resolutionId);
  return {
    status: "canonical-live",
    outcome: changed ? "changed" : "unchanged",
    resolutionId: idString(resolutionId, "Resolution ID"),
    exactRelationIds: exactRelationIds.map((value) => idString(value, "Relation ID")),
    settlementGroupIds: settlementGroupIds.map((value) => idString(value, "Settlement group ID")),
  };
}

/** Resolve independently captured deposit and loan transactions. */
export async function resolveLoanRepaymentRelations(
  store: RelationStore,
  request: LoanRepaymentRelationResolutionRequest,
): Promise<LoanRepaymentRelationResolutionResult> {
  requireValidatedRelationStore(store);
  return withCanonicalWriterQueue(asPath(store), () => {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const value = resolveOnce(store, request);
      store.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        store.db.exec("ROLLBACK");
      } catch {
        /* Preserve the original resolver error. */
      }
      throw error;
    }
  });
}

export function queryCurrentLoanRepaymentRelations(
  store: RelationStore,
  options: { sourceConnectionKey?: string; integrationNamespace?: string } = {},
): LoanRepaymentRelationView[] {
  requireValidatedRelationStore(store);
  ensureEvidenceSchema(store.db);
  return withCanonicalSnapshot(store.db, () => {
    const rows = store.db
      .prepare(
        `SELECT relation.relation_id, relation.relation_kind,
                relation.from_transaction_id, relation.to_transaction_id,
                relation.from_account_id, relation.to_account_id,
                relation.from_source_record_key, relation.to_source_record_key,
                relation.from_direction, relation.to_direction,
                relation.evidence_source_record_key, relation.evidence_relation_id,
                relation.evidence_contract_version,
                connection.source_connection_key,
                from_epoch.epoch_key AS from_epoch_key,
                to_epoch.epoch_key AS to_epoch_key
         FROM current_loan_relations current
         JOIN active_projection_generation active ON active.singleton_id = 1
         JOIN transaction_relations relation
           ON relation.relation_id = current.relation_id
         JOIN source_connections connection
           ON connection.source_connection_id = relation.source_connection_id
         LEFT JOIN identity_epochs from_epoch
           ON from_epoch.identity_epoch_id = relation.from_identity_epoch_id
         LEFT JOIN identity_epochs to_epoch
           ON to_epoch.identity_epoch_id = relation.to_identity_epoch_id
         WHERE current.generation_id = active.generation_id
           AND (? IS NULL OR connection.source_connection_key = ?)
           AND (? IS NULL OR connection.integration_namespace = ?)
         ORDER BY relation.relation_key`,
      )
      .all(
        options.sourceConnectionKey ?? null,
        options.sourceConnectionKey ?? null,
        options.integrationNamespace ?? null,
        options.integrationNamespace ?? null,
      ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      relationId: idString(row.relation_id, "Relation ID"),
      relationKind: "transfer_counterpart",
      fromTransactionId: idString(row.from_transaction_id, "From transaction ID"),
      toTransactionId: idString(row.to_transaction_id, "To transaction ID"),
      fromAccountId: idString(row.from_account_id, "From account ID"),
      toAccountId: idString(row.to_account_id, "To account ID"),
      fromSourceRecordKey: String(row.from_source_record_key),
      toSourceRecordKey: String(row.to_source_record_key),
      fromDirection: String(row.from_direction) as "inflow" | "outflow",
      toDirection: String(row.to_direction) as "inflow" | "outflow",
      sourceConnectionKey: String(row.source_connection_key),
      fromIdentityEpochKey: String(row.from_epoch_key ?? ""),
      toIdentityEpochKey: String(row.to_epoch_key ?? ""),
      evidenceSourceRecordKey: String(row.evidence_source_record_key),
      evidenceRelationId: String(row.evidence_relation_id),
      evidenceContractVersion: String(row.evidence_contract_version),
    }));
  });
}

export function queryCurrentLoanRepaymentSettlementGroups(
  store: RelationStore,
  options: { sourceConnectionKey?: string; integrationNamespace?: string } = {},
): LoanRepaymentSettlementGroupView[] {
  requireValidatedRelationStore(store);
  ensureEvidenceSchema(store.db);
  return withCanonicalSnapshot(store.db, () => {
    const rows = store.db
      .prepare(
        `SELECT group_row.settlement_group_id, group_row.group_key,
                connection.source_connection_key,
                member.transaction_id, member.member_kind, record.occurrence_key
         FROM current_loan_repayment_settlement_groups current
         JOIN active_projection_generation active ON active.singleton_id = 1
         JOIN loan_repayment_settlement_groups group_row
           ON group_row.settlement_group_id = current.settlement_group_id
         JOIN source_connections connection
           ON connection.source_connection_id = group_row.source_connection_id
         JOIN loan_repayment_settlement_group_members member
           ON member.settlement_group_id = group_row.settlement_group_id
         JOIN source_records record ON record.source_record_id = member.source_record_id
         WHERE current.generation_id = active.generation_id
           AND (? IS NULL OR connection.source_connection_key = ?)
           AND (? IS NULL OR connection.integration_namespace = ?)
         ORDER BY group_row.group_key, member.transaction_id`,
      )
      .all(
        options.sourceConnectionKey ?? null,
        options.sourceConnectionKey ?? null,
        options.integrationNamespace ?? null,
        options.integrationNamespace ?? null,
      ) as Array<Record<string, unknown>>;
    const groups = new Map<string, LoanRepaymentSettlementGroupView>();
    for (const row of rows) {
      const groupId = idString(row.settlement_group_id, "Settlement group ID");
      const prior = groups.get(groupId);
      const member = {
        transactionId: idString(row.transaction_id, "Settlement member transaction ID"),
        memberKind: String(row.member_kind) as "deposit_outflow" | "loan_payment",
        sourceRecordKey: String(row.occurrence_key),
      } as const;
      if (prior)
        groups.set(groupId, { ...prior, members: [...prior.members, member] });
      else
        groups.set(groupId, {
          settlementGroupId: groupId,
          groupKey: String(row.group_key),
          sourceConnectionKey: String(row.source_connection_key),
          members: [member],
        });
    }
    return [...groups.values()];
  });
}
