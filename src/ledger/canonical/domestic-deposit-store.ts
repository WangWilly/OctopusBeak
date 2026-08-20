import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { withCanonicalWriterQueue } from "./canonical-runtime.ts";
import {
  admitCanonicalSourceEvidence,
  commitCanonicalSourceEvidence,
  createCanonicalSourceStore,
  queryCanonicalSourceCurrent,
  queryCanonicalSourceHistorical,
  queryCanonicalSourceLineage,
  type CanonicalSourceEvidence,
  type CanonicalSourceObservation,
} from "./canonical-source-store.ts";
import { syncCanonicalProjectionFromCompatibility } from "./canonical-source-store.ts";
import type { LineBankHumanAttestedV13Capture } from "./linebank-domestic-deposit.ts";

/**
 * Durable Source Capture/Record storage shared by domestic-deposit adapters.
 *
 * This is deliberately not a Financial Transaction table. It preserves the
 * compact, typed evidence needed for a later contract review while every
 * result remains `canonicalAdmission: blocked`. The database is SQLite with a
 * single BEGIN IMMEDIATE writer boundary; no response body, headers, DOM, or
 * credentials are retained.
 */
export const DOMESTIC_DEPOSIT_SOURCE_RECORD_STAGE =
  "source-record-only" as const;
export const DOMESTIC_DEPOSIT_CANONICAL_ADMISSION = "blocked" as const;

export const DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS = [
  "provider-identity-guarantee-unproven",
  "posting-semantics-unproven",
  "effective-time-semantics-unproven",
  "cancellation-semantics-unproven",
  "completeness-semantics-unproven",
  "authority-semantics-unproven",
  "revision-semantics-unproven",
  "canonical-financial-writer-unavailable",
] as const;

export type DomesticDepositFinancialAdmissionBlocker =
  (typeof DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS)[number];

export type DomesticDepositExactAmount = { coefficient: string; scale: number };

export type DomesticDepositSourceTime = {
  localDate: string;
  localTime: string;
  timeZone: "Asia/Taipei";
  epochMilliseconds: number;
  basis: "source_observed";
};

export type DomesticDepositSourceRecord = {
  /** Opaque source-occurrence digest; no raw account or row values. */
  sourceOccurrenceKey: string;
  /** Base identity digest excludes txDtm and detects time collisions. */
  baseOccurrenceKey: string;
  /** Comparison-only fingerprint; never used as identity. */
  sourceChangeFingerprint: string;
  accountKey: string;
  sourceConnection: string;
  stream: string;
  contractVersion: string;
  identityEpoch: number;
  /** Compact source fields retained for future audit/revalidation. */
  sourceSequence: string;
  occurrenceCounter: number;
  sourceSequenceKey: string;
  sourceTime: DomesticDepositSourceTime;
  direction: "inflow" | "outflow";
  sourceDirectionCode: "1" | "2";
  amount: DomesticDepositExactAmount;
  balanceAfter: DomesticDepositExactAmount;
  currency: "TWD";
  cancellation: "N";
  cancellationFlags: { cncdTxYn: "N"; cnclTxYn: "N" };
  provenance: { captureId: string; matchingRuleVersion: string };
};

export type DomesticDepositCapture = {
  captureId: string;
  sourceConnection: string;
  stream: string;
  contractVersion: string;
  identityEpoch: number;
  accountKey: string;
  scope: {
    startDate: string;
    endDate: string;
    completeness: "transport-exact-single-page";
    evidenceVersion: string;
  };
  transport: {
    responseCode: "200";
    pageNbr: 1;
    pageCapacity: number;
    reportedRowCount: number;
    collectedRowCount: number;
    terminal: true;
  };
  ruleVersions: {
    contract: string;
    matching: string;
    direction: string;
    time: string;
  };
  observedAt: string;
  canonicalAdmission: typeof DOMESTIC_DEPOSIT_CANONICAL_ADMISSION;
  financialAdmissionBlockers: readonly DomesticDepositFinancialAdmissionBlocker[];
  records: readonly DomesticDepositSourceRecord[];
};

const DOMESTIC_DEPOSIT_VALIDATED_CAPTURE = Symbol(
  "domestic-deposit-runtime-validated-capture",
);
const LINEBANK_FINANCIAL_VALIDATED_CAPTURE = Symbol(
  "linebank-human-attested-v13-runtime-validated-capture",
);

export type LineBankHumanAttestedV13ValidatedCapture =
  LineBankHumanAttestedV13Capture & {
    readonly __runtimeValidatedLineBankFinancialCapture: "human-attested-v13";
  };

/** The validator calls this once all v13 invariants have passed. */
export function admitLineBankHumanAttestedV13Capture(
  capture: LineBankHumanAttestedV13Capture,
): LineBankHumanAttestedV13ValidatedCapture {
  Object.defineProperty(capture, LINEBANK_FINANCIAL_VALIDATED_CAPTURE, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  for (const page of capture.pages) Object.freeze(page);
  for (const record of capture.records) {
    Object.freeze(record.sourceTime);
    Object.freeze(record.amount);
    if (record.balanceAfter) Object.freeze(record.balanceAfter);
    Object.freeze(record.cancellationFlags);
    Object.freeze(record);
  }
  Object.freeze(capture.pages);
  Object.freeze(capture.records);
  Object.freeze(capture.scope);
  Object.freeze(capture.authority);
  Object.freeze(capture.humanAttestation.directionCodes);
  Object.freeze(capture.humanAttestation);
  Object.freeze(capture.sourceScopeEvidence);
  Object.freeze(capture.financialAdmissionBlockers);
  Object.freeze(capture);
  return capture as LineBankHumanAttestedV13ValidatedCapture;
}

function hasLineBankFinancialValidatedBrand(
  capture: unknown,
): capture is LineBankHumanAttestedV13ValidatedCapture {
  return (
    capture !== null &&
    typeof capture === "object" &&
    (
      capture as LineBankHumanAttestedV13Capture & {
        [LINEBANK_FINANCIAL_VALIDATED_CAPTURE]?: true;
      }
    )[LINEBANK_FINANCIAL_VALIDATED_CAPTURE] === true
  );
}

/** A runtime-branded capture accepted by the source-record writer. */
export type DomesticDepositValidatedCapture = DomesticDepositCapture & {
  readonly __runtimeValidatedCapture: "domestic-deposit-source-record";
};

export type DomesticDepositStore = {
  readonly db: DatabaseSync;
  readonly databasePath: string;
  readonly sourceStore: ReturnType<typeof createCanonicalSourceStore>;
  close(): void;
};

export type DomesticDepositCommitResult = {
  status: typeof DOMESTIC_DEPOSIT_SOURCE_RECORD_STAGE;
  canonicalAdmission: typeof DOMESTIC_DEPOSIT_CANONICAL_ADMISSION;
  captureId: string;
  commitSequence: number;
  addedRecordCount: number;
  repeatRecordCount: number;
  provenanceCount: number;
  financialAdmissionBlockers: readonly DomesticDepositFinancialAdmissionBlocker[];
};

export type LineBankFinancialCommitResult = {
  status: "canonical-live";
  canonicalAdmission: "admitted";
  captureId: string;
  commitSequence: number;
  transactionCount: number;
  provenanceCount: number;
};

export type DomesticDepositFinancialTransaction = {
  id: string;
  accountId: string;
  accountNo: string;
  sourceOccurrenceKey: string;
  amount: DomesticDepositExactAmount;
  currency: "TWD";
  direction: "inflow" | "outflow";
  postingStatus: "posted";
  effectiveOn: string;
  transactionDateTimeLocal: string;
  effectiveTimeBasis: "transaction-time";
  timeZone: "Asia/Taipei";
  knowledgeCommitSequence: number;
};

export type DomesticDepositQueryRecord = DomesticDepositSourceRecord & {
  firstCommitSequence: number;
};

export type DomesticDepositSourceObservation = DomesticDepositQueryRecord & {
  recordId: number;
  captureId: string;
  commitSequence: number;
};

type BaseQueryResult = {
  status: typeof DOMESTIC_DEPOSIT_SOURCE_RECORD_STAGE | "canonical-live";
  canonicalAdmission: typeof DOMESTIC_DEPOSIT_CANONICAL_ADMISSION | "admitted";
  records: DomesticDepositQueryRecord[];
  observations: DomesticDepositSourceObservation[];
  provenanceCount: number;
  financialAdmissionBlockers:
    readonly DomesticDepositFinancialAdmissionBlocker[] | readonly [];
  transactions: DomesticDepositFinancialTransaction[];
};

export type DomesticDepositCurrentQueryResult = BaseQueryResult & {
  kind: "current";
};
export type DomesticDepositHistoricalQueryResult = BaseQueryResult &
  (
    | {
        kind: "historical";
        knowledgeAt: number;
        financialCutoffApplied: false;
        cutoff: { kind: "knowledge"; knowledgeAt: number };
      }
    | {
        kind: "historical";
        knowledgeAt: number;
        financialCutoffApplied: true;
        cutoff: {
          kind: "both";
          knowledgeAt: number;
          financialAt: string;
        };
      }
  );
export type DomesticDepositBlockedHistoricalQueryResult = {
  status: "blocked";
  kind: "historical";
  canonicalAdmission: typeof DOMESTIC_DEPOSIT_CANONICAL_ADMISSION;
  reason: "effective-time-semantics-unproven";
  records: [];
  observations: [];
  provenanceCount: 0;
  financialAdmissionBlockers: readonly DomesticDepositFinancialAdmissionBlocker[];
  transactions: [];
};
export type DomesticDepositLineageQueryResult = BaseQueryResult & {
  kind: "lineage";
  sourceOccurrenceKey: string;
  provenance: Array<{ captureId: string; commitSequence: number }>;
  expectedObservationCount: number;
  provenanceComplete: boolean;
};
export type DomesticDepositLineageRequest = {
  sourceOccurrenceKey: string;
  sourceConnection: string;
  identityEpoch: number;
  stream: string;
  accountKey: string;
};

export class DomesticDepositConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomesticDepositConflictError";
  }
}

function opaqueToken(...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex");
  return `sha256:${digest}`;
}

function ensureOpen(store: DomesticDepositStore): void {
  // DatabaseSync throws a useful closed-handle error; this explicit guard keeps
  // the public failure deterministic before a transaction starts.
  if (!store.db) throw new Error("Domestic deposit store is closed.");
}

export function createDomesticDepositStore(
  databasePath: string,
): DomesticDepositStore {
  if (typeof databasePath !== "string" || databasePath.trim() === "") {
    throw new Error("A durable domestic-deposit SQLite path is required.");
  }
  const path = databasePath.trim();
  const sourceStore = createCanonicalSourceStore(path);
  let closed = false;
  return {
    db: sourceStore.db,
    databasePath: path,
    sourceStore,
    close() {
      if (!closed) {
        sourceStore.close();
        closed = true;
      }
    },
  };
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required.`);
  return value.trim();
}

function requireOpaqueToken(value: unknown, label: string): string {
  const token = requireNonEmpty(value, label);
  if (!/^sha256:[A-Za-z0-9_-]+$/.test(token))
    throw new Error(`${label} must be an opaque sha256 token.`);
  return token;
}

function hasRuntimeValidatedBrand(
  capture: DomesticDepositCapture,
): capture is DomesticDepositValidatedCapture {
  return (
    (
      capture as DomesticDepositCapture & {
        [DOMESTIC_DEPOSIT_VALIDATED_CAPTURE]?: true;
      }
    )[DOMESTIC_DEPOSIT_VALIDATED_CAPTURE] === true
  );
}

/**
 * Validate and attach the non-enumerable runtime brand used by the writer.
 * The public seam is intentionally source-record-only and never admits a
 * Financial Transaction.
 */
export function admitDomesticDepositCapture(
  capture: DomesticDepositCapture,
): DomesticDepositValidatedCapture {
  validateCapture(capture);
  Object.defineProperty(capture, DOMESTIC_DEPOSIT_VALIDATED_CAPTURE, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return capture as DomesticDepositValidatedCapture;
}

function requireDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{8}$/.test(value))
    throw new Error(`${label} must be YYYYMMDD.`);
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new Error(`${label} must be a calendar date.`);
  return value;
}

function requireSafeInteger(
  value: unknown,
  label: string,
  minimum = 0,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new Error(`${label} must be a safe integer.`);
  return value;
}

function requireExactAmount(
  value: DomesticDepositExactAmount,
  label: string,
): void {
  if (
    !value ||
    typeof value.coefficient !== "string" ||
    !/^\d+$/.test(value.coefficient) ||
    !Number.isSafeInteger(value.scale) ||
    value.scale < 0
  )
    throw new Error(`${label} must be an exact non-negative decimal.`);
}

function epochFromTaipei(localDate: string, localTime: string): number {
  const date = requireDate(localDate, "Source local date");
  if (!/^\d{6}$/.test(localTime))
    throw new Error("Source local time must be HHMMSS.");
  const hour = Number(localTime.slice(0, 2));
  const minute = Number(localTime.slice(2, 4));
  const second = Number(localTime.slice(4, 6));
  if (hour > 23 || minute > 59 || second > 59)
    throw new Error("Source local time is invalid.");
  const value = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    hour - 8,
    minute,
    second,
  );
  if (!Number.isSafeInteger(value))
    throw new Error("Source epoch milliseconds are invalid.");
  return value;
}

function validateCapture(capture: DomesticDepositCapture): void {
  requireNonEmpty(capture.captureId, "Capture ID");
  requireNonEmpty(capture.sourceConnection, "Source Connection");
  requireNonEmpty(capture.stream, "Stream");
  requireNonEmpty(capture.contractVersion, "Contract version");
  requireSafeInteger(capture.identityEpoch, "Identity Epoch");
  requireOpaqueToken(capture.accountKey, "Account key");
  if (capture.sourceConnection !== "accessibility.linebank.com.tw")
    throw new Error("Source connection is unsupported.");
  const start = requireDate(
    capture.scope.startDate,
    "Capture scope start date",
  );
  const end = requireDate(capture.scope.endDate, "Capture scope end date");
  if (start > end)
    throw new Error("Capture scope start date must be on or before end date.");
  if (
    capture.scope.completeness !== "transport-exact-single-page" ||
    !requireNonEmpty(capture.scope.evidenceVersion, "Scope evidence version")
  )
    throw new Error("Capture completeness/scope evidence is unsupported.");
  if (
    capture.transport.responseCode !== "200" ||
    capture.transport.pageNbr !== 1 ||
    capture.transport.terminal !== true
  )
    throw new Error("Capture transport status/page is not terminal HTTP 200.");
  requireSafeInteger(capture.transport.pageCapacity, "Page capacity", 1);
  requireSafeInteger(capture.transport.reportedRowCount, "Reported row count");
  requireSafeInteger(
    capture.transport.collectedRowCount,
    "Collected row count",
  );
  if (
    capture.transport.reportedRowCount !==
      capture.transport.collectedRowCount ||
    capture.records.length !== capture.transport.collectedRowCount
  )
    throw new Error("Capture count metadata does not match compact records.");
  if (
    capture.ruleVersions.contract !== capture.contractVersion ||
    !requireNonEmpty(capture.ruleVersions.matching, "Matching rule version") ||
    !requireNonEmpty(
      capture.ruleVersions.direction,
      "Direction rule version",
    ) ||
    !requireNonEmpty(capture.ruleVersions.time, "Time rule version")
  )
    throw new Error("Capture rule versions are incomplete.");
  if (
    !/^\d{4}-\d{2}-\d{2}T/.test(capture.observedAt) ||
    !Number.isFinite(Date.parse(capture.observedAt))
  )
    throw new Error("Capture observedAt must be RFC3339.");
  if (capture.canonicalAdmission !== DOMESTIC_DEPOSIT_CANONICAL_ADMISSION)
    throw new Error(
      "Source records cannot authorize canonical financial admission.",
    );
  for (const blocker of DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS)
    if (!capture.financialAdmissionBlockers.includes(blocker))
      throw new Error("Capture cannot weaken financial admission blockers.");
  const occurrenceKeys = new Set<string>();
  const baseKeys = new Set<string>();
  for (const record of capture.records) {
    requireOpaqueToken(record.sourceOccurrenceKey, "Source occurrence key");
    requireOpaqueToken(record.baseOccurrenceKey, "Base occurrence key");
    requireOpaqueToken(
      record.sourceChangeFingerprint,
      "Source change fingerprint",
    );
    requireOpaqueToken(record.accountKey, "Source record account key");
    if (
      record.accountKey !== capture.accountKey ||
      record.sourceConnection !== capture.sourceConnection ||
      record.stream !== capture.stream ||
      record.contractVersion !== capture.contractVersion ||
      record.identityEpoch !== capture.identityEpoch
    )
      throw new Error("Source record context does not match capture.");
    if (occurrenceKeys.has(record.sourceOccurrenceKey))
      throw new DomesticDepositConflictError(
        "Duplicate source occurrence in one capture.",
      );
    if (baseKeys.has(record.baseOccurrenceKey))
      throw new DomesticDepositConflictError(
        "Duplicate source base identity in one capture.",
      );
    occurrenceKeys.add(record.sourceOccurrenceKey);
    baseKeys.add(record.baseOccurrenceKey);
    const sourceSequence = requireNonEmpty(
      record.sourceSequence,
      "Source sequence",
    );
    if (!/^\d+$/.test(sourceSequence) || BigInt(sourceSequence) <= 0n)
      throw new Error("Source sequence is invalid.");
    requireSafeInteger(record.occurrenceCounter, "Occurrence counter", 1);
    requireOpaqueToken(record.sourceSequenceKey, "Source sequence key");
    if (
      record.sourceTime.timeZone !== "Asia/Taipei" ||
      record.sourceTime.basis !== "source_observed"
    )
      throw new Error("Source time basis is unsupported.");
    requireSafeInteger(
      record.sourceTime.epochMilliseconds,
      "Source epoch milliseconds",
    );
    if (
      epochFromTaipei(
        record.sourceTime.localDate,
        record.sourceTime.localTime,
      ) !== record.sourceTime.epochMilliseconds
    )
      throw new Error("Source time reconstruction mismatch.");
    if (record.direction !== "inflow" && record.direction !== "outflow")
      throw new Error("Source direction is unsupported.");
    if (
      record.sourceDirectionCode !== "1" &&
      record.sourceDirectionCode !== "2"
    )
      throw new Error("Source direction code is unsupported.");
    if (
      (record.sourceDirectionCode === "1" ? "inflow" : "outflow") !==
      record.direction
    )
      throw new Error("Source direction/code mismatch.");
    requireExactAmount(record.amount, "Source amount");
    requireExactAmount(record.balanceAfter, "Source balance");
    if (
      record.currency !== "TWD" ||
      record.cancellation !== "N" ||
      record.cancellationFlags.cncdTxYn !== "N" ||
      record.cancellationFlags.cnclTxYn !== "N"
    )
      throw new Error("Source currency/cancellation evidence is unsupported.");
    if (
      record.provenance.captureId !== capture.captureId ||
      !requireNonEmpty(
        record.provenance.matchingRuleVersion,
        "Matching rule version",
      )
    )
      throw new Error("Source provenance is incomplete.");
  }
}

function cloneRecord(
  record: DomesticDepositSourceRecord,
): DomesticDepositSourceRecord {
  return {
    ...record,
    sourceTime: { ...record.sourceTime },
    amount: { ...record.amount },
    balanceAfter: { ...record.balanceAfter },
    cancellationFlags: { ...record.cancellationFlags },
    provenance: { ...record.provenance },
  };
}

function stableRecordFingerprint(record: DomesticDepositSourceRecord): string {
  return JSON.stringify({
    sourceOccurrenceKey: record.sourceOccurrenceKey,
    baseOccurrenceKey: record.baseOccurrenceKey,
    sourceChangeFingerprint: record.sourceChangeFingerprint,
    accountKey: record.accountKey,
    sourceConnection: record.sourceConnection,
    stream: record.stream,
    contractVersion: record.contractVersion,
    identityEpoch: record.identityEpoch,
    sourceSequence: record.sourceSequence,
    occurrenceCounter: record.occurrenceCounter,
    sourceSequenceKey: record.sourceSequenceKey,
    sourceTime: {
      localDate: record.sourceTime.localDate,
      localTime: record.sourceTime.localTime,
      timeZone: record.sourceTime.timeZone,
      epochMilliseconds: record.sourceTime.epochMilliseconds,
      basis: record.sourceTime.basis,
    },
    direction: record.direction,
    sourceDirectionCode: record.sourceDirectionCode,
    amount: record.amount,
    balanceAfter: record.balanceAfter,
    currency: record.currency,
    cancellation: record.cancellation,
    cancellationFlags: record.cancellationFlags,
  });
}

function rowToRecord(row: Record<string, unknown>): DomesticDepositQueryRecord {
  return {
    sourceOccurrenceKey: String(row.source_occurrence_key),
    baseOccurrenceKey: String(row.base_occurrence_key),
    sourceChangeFingerprint: String(row.source_change_fingerprint),
    accountKey: String(row.account_key),
    sourceConnection: String(row.source_connection),
    stream: String(row.stream),
    contractVersion: String(row.contract_version),
    identityEpoch: Number(row.identity_epoch),
    sourceSequence: String(row.source_sequence),
    occurrenceCounter: Number(row.occurrence_counter),
    sourceSequenceKey: String(row.source_sequence_key),
    sourceTime: {
      localDate: String(row.local_date),
      localTime: String(row.local_time),
      timeZone: "Asia/Taipei",
      epochMilliseconds: Number(row.epoch_milliseconds),
      basis: "source_observed",
    },
    direction: String(row.direction) as "inflow" | "outflow",
    sourceDirectionCode: String(row.source_direction_code) as "1" | "2",
    amount: {
      coefficient: String(row.amount_coefficient),
      scale: Number(row.amount_scale),
    },
    balanceAfter: {
      coefficient: String(row.balance_coefficient),
      scale: Number(row.balance_scale),
    },
    currency: "TWD",
    cancellation: "N",
    cancellationFlags: { cncdTxYn: "N", cnclTxYn: "N" },
    provenance: {
      captureId: String(row.first_capture_id),
      matchingRuleVersion: String(row.matching_rule_version),
    },
    firstCommitSequence: Number(row.first_commit_sequence),
  };
}

function domesticRecordCompact(
  record: DomesticDepositSourceRecord,
): Record<string, unknown> {
  return JSON.parse(stableRecordFingerprint(record)) as Record<string, unknown>;
}

function domesticCaptureEvidence(
  capture: DomesticDepositValidatedCapture,
): CanonicalSourceEvidence {
  return {
    captureId: capture.captureId,
    integrationNamespace: "linebank",
    sourceConnectionKey: opaqueToken(
      "linebank-connection",
      capture.sourceConnection,
    ),
    identityEpoch: opaqueToken(
      "linebank-epoch",
      capture.sourceConnection,
      String(capture.identityEpoch),
    ),
    stream: capture.stream,
    recordKind: "linebank-domestic-deposit-source-record",
    routeKey: `linebank/${capture.stream}/${capture.contractVersion}`,
    contractVersion: capture.contractVersion,
    subjectDigest: capture.accountKey,
    observedAt: capture.observedAt,
    scope: {
      startDate: capture.scope.startDate,
      endDate: capture.scope.endDate,
      kind: "bounded-range",
      completeness: "single-page",
      ruleVersion: capture.scope.evidenceVersion,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: capture.transport.collectedRowCount,
        terminal: true,
        metadata: {
          pageNbr: capture.transport.pageNbr,
          pageCapacity: capture.transport.pageCapacity,
          reportedRowCount: capture.transport.reportedRowCount,
          collectedRowCount: capture.transport.collectedRowCount,
        },
      },
    ],
    records: capture.records.map((record) => ({
      occurrenceKey: record.sourceOccurrenceKey,
      collisionKey: record.baseOccurrenceKey,
      providerKey: record.sourceSequenceKey,
      contentHash: record.sourceChangeFingerprint,
      compact: domesticRecordCompact(record),
    })),
  };
}

function domesticRecordFromObservation(
  observation: CanonicalSourceObservation,
  firstCommitSequence: number,
): DomesticDepositSourceObservation {
  const compact = observation.compact as unknown as DomesticDepositSourceRecord;
  return {
    ...cloneRecord(compact),
    recordId: observation.recordId,
    captureId: observation.captureId,
    commitSequence: observation.commitSequence,
    firstCommitSequence,
  };
}

function domesticQueryResult(result: {
  records: CanonicalSourceObservation[];
  observations: CanonicalSourceObservation[];
  provenanceCount: number;
}): BaseQueryResult {
  const firstByOccurrence = new Map<string, number>();
  for (const observation of result.observations) {
    const occurrence = domesticObservationIdentity(observation);
    const existing = firstByOccurrence.get(occurrence);
    if (existing === undefined || observation.commitSequence < existing)
      firstByOccurrence.set(occurrence, observation.commitSequence);
  }
  const observations = result.observations.map((observation) =>
    domesticRecordFromObservation(
      observation,
      firstByOccurrence.get(domesticObservationIdentity(observation)) ??
        observation.commitSequence,
    ),
  );
  const latest = new Map<string, DomesticDepositQueryRecord>();
  for (const observation of observations)
    latest.set(domesticRecordIdentity(observation), observation);
  return {
    status: DOMESTIC_DEPOSIT_SOURCE_RECORD_STAGE,
    canonicalAdmission: DOMESTIC_DEPOSIT_CANONICAL_ADMISSION,
    records: [...latest.values()],
    observations,
    provenanceCount: result.provenanceCount,
    financialAdmissionBlockers: DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS,
    transactions: [],
  };
}

function domesticRecordIdentity(record: DomesticDepositSourceRecord): string {
  return [
    record.sourceConnection,
    String(record.identityEpoch),
    record.stream,
    record.accountKey,
    record.sourceOccurrenceKey,
  ].join("\u0000");
}

function domesticObservationIdentity(
  observation: CanonicalSourceObservation,
): string {
  return [
    observation.identity.integrationNamespace,
    observation.identity.sourceConnectionKey,
    observation.identity.identityEpoch,
    observation.identity.stream,
    observation.identity.recordKind,
    observation.identity.subjectDigest,
    observation.occurrenceKey,
  ].join("\u0000");
}

export async function commitCanonicalDomesticDeposit(
  store: DomesticDepositStore,
  capture: DomesticDepositValidatedCapture,
): Promise<DomesticDepositCommitResult> {
  ensureOpen(store);
  if (!hasRuntimeValidatedBrand(capture))
    throw new DomesticDepositConflictError(
      "Capture did not cross the runtime-validated admission seam.",
    );
  validateCapture(capture);
  const before = new Set(
    queryCanonicalSourceCurrent(store.sourceStore).records.map((record) =>
      domesticRecordIdentity(
        record.compact as unknown as DomesticDepositSourceRecord,
      ),
    ),
  );
  const committed = await commitCanonicalSourceEvidence(
    store.sourceStore,
    admitCanonicalSourceEvidence(domesticCaptureEvidence(capture)),
  );
  const repeatRecordCount = capture.records.filter((record) =>
    before.has(domesticRecordIdentity(record)),
  ).length;
  return {
    status: DOMESTIC_DEPOSIT_SOURCE_RECORD_STAGE,
    canonicalAdmission: DOMESTIC_DEPOSIT_CANONICAL_ADMISSION,
    captureId: capture.captureId,
    commitSequence: committed.commitSequence,
    addedRecordCount: capture.records.length - repeatRecordCount,
    repeatRecordCount,
    provenanceCount: committed.provenanceCount,
    financialAdmissionBlockers: DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS,
  };
}

const LINEBANK_V13_AUTHORITY = "linebank/domestic-deposit/human-attested-v13";
const LINEBANK_V13_RECORD_KIND = "linebank-domestic-deposit-financial-v13";

function canonicalId(): Uint8Array {
  return randomBytes(16);
}

function idText(value: unknown): string {
  return Buffer.from(value as Uint8Array).toString("hex");
}

function v13ConnectionKey(capture: LineBankHumanAttestedV13Capture): string {
  return opaqueToken("linebank-connection", capture.sourceConnection);
}

function v13EpochKey(capture: LineBankHumanAttestedV13Capture): string {
  return opaqueToken(
    "linebank-epoch",
    capture.sourceConnection,
    String(capture.identityEpoch),
  );
}

function v13CanonicalDate(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function v13FinancialCutoff(value: string): string {
  const normalized = /^\d{8}$/.test(value) ? v13CanonicalDate(value) : value;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) throw new Error("Financial cutoff must be a calendar date.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new Error("Financial cutoff must be a calendar date.");
  return normalized;
}

function v13CanonicalDateTime(value: DomesticDepositSourceTime): string {
  return `${v13CanonicalDate(value.localDate)}T${value.localTime.slice(0, 2)}:${value.localTime.slice(2, 4)}:${value.localTime.slice(4, 6)}`;
}

function v13CompactRecord(
  capture: LineBankHumanAttestedV13Capture,
  record: LineBankHumanAttestedV13Capture["records"][number],
): string {
  return JSON.stringify({
    sourceOccurrenceKey: record.sourceOccurrenceKey,
    baseOccurrenceKey: record.baseOccurrenceKey,
    sourceChangeFingerprint: record.sourceChangeFingerprint,
    accountKey: capture.accountKey,
    sourceConnection: capture.sourceConnection,
    stream: capture.stream,
    contractVersion: capture.contractVersion,
    identityEpoch: capture.identityEpoch,
    sourceSequence: record.sourceSequence,
    occurrenceCounter: record.occurrenceCounter,
    sourceSequenceKey: record.sourceOccurrenceKey,
    sourceTime: record.sourceTime,
    direction: record.direction,
    sourceDirectionCode: record.sourceDirectionCode,
    amount: record.amount,
    balanceAfter: record.balanceAfter,
    currency: record.currency,
    cancellation: "N",
    cancellationFlags: record.cancellationFlags,
    provenance: {
      captureId: capture.captureId,
      matchingRuleVersion: "occurrence-v1",
    },
  });
}

function latestLineBankLifecycle(
  db: DatabaseSync,
  assertionId: Uint8Array,
): string | null {
  const row = db
    .prepare(
      `SELECT transition.event_kind FROM assertion_transitions transition
       JOIN canonical_commits commit_row ON commit_row.commit_id = transition.commit_id
       WHERE transition.assertion_id = ?
       ORDER BY commit_row.commit_sequence DESC, transition.event_id DESC LIMIT 1`,
    )
    .get(assertionId) as { event_kind?: string } | undefined;
  return row?.event_kind ?? null;
}

function insertLineBankLifecycle(
  db: DatabaseSync,
  values: {
    assertionId: Uint8Array;
    transactionId: Uint8Array;
    captureId: Uint8Array;
    scopeId: Uint8Array;
    commitId: Uint8Array;
    kind: "observed" | "withdrawn" | "restored";
  },
): void {
  db.prepare(
    `INSERT INTO assertion_transitions(
      event_id, assertion_id, transaction_id, field_name, capture_id, scope_id,
      run_id, coordinate_id, user_id, commit_id, event_kind
    ) VALUES (?, ?, ?, 'transaction_revision', ?, ?, NULL, NULL, NULL, ?, ?)`,
  ).run(
    canonicalId(),
    values.assertionId,
    values.transactionId,
    values.captureId,
    values.scopeId,
    values.commitId,
    values.kind,
  );
}

function commitCanonicalLineBankFinancialCaptureOnce(
  store: DomesticDepositStore,
  capture: LineBankHumanAttestedV13ValidatedCapture,
): LineBankFinancialCommitResult {
  if (!hasLineBankFinancialValidatedBrand(capture))
    throw new DomesticDepositConflictError(
      "LINE Bank financial capture did not cross the runtime-validated v13 seam.",
    );
  const db = store.db;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (
      db
        .prepare("SELECT 1 FROM source_captures WHERE capture_key = ?")
        .get(capture.captureId)
    )
      throw new DomesticDepositConflictError("Capture overwrite is forbidden.");

    const commitId = canonicalId();
    const commitSequence = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(commit_sequence), 0) + 1 AS value FROM canonical_commits",
          )
          .get() as { value?: number }
      ).value ?? 1,
    );
    const previousKnowledge = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(recorded_at_utc_us), -1) AS value FROM canonical_commits",
          )
          .get() as { value?: number }
      ).value ?? -1,
    );
    const clockValue = store.sourceStore.commitClock();
    if (!Number.isSafeInteger(clockValue) || clockValue < 0)
      throw new Error("Canonical admission clock returned invalid UTC micros.");
    db.prepare(
      `INSERT INTO canonical_commits(
        commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind
      ) VALUES (?, ?, ?, ?, 'source_capture')`,
    ).run(
      commitId,
      commitSequence,
      Math.max(clockValue, previousKnowledge + 1),
      LINEBANK_V13_AUTHORITY,
    );
    db.prepare(
      `INSERT INTO source_authority_routes(
        authority_route, integration_namespace, stream, contract_version, created_commit_id
      ) VALUES (?, 'linebank', ?, 'human-attested-v13', ?)
      ON CONFLICT(authority_route) DO NOTHING`,
    ).run(LINEBANK_V13_AUTHORITY, capture.stream, commitId);

    const connectionKey = v13ConnectionKey(capture);
    const existingConnection = db
      .prepare(
        "SELECT source_connection_id FROM source_connections WHERE integration_namespace = 'linebank' AND source_connection_key = ?",
      )
      .get(connectionKey) as { source_connection_id?: unknown } | undefined;
    const connectionId = existingConnection
      ? (existingConnection.source_connection_id as Uint8Array)
      : canonicalId();
    if (!existingConnection)
      db.prepare(
        "INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id) VALUES (?, 'linebank', ?, ?)",
      ).run(connectionId, connectionKey, commitId);

    const epochKey = v13EpochKey(capture);
    const existingEpoch = db
      .prepare(
        "SELECT identity_epoch_id FROM identity_epochs WHERE source_connection_id = ? AND epoch_key = ?",
      )
      .get(connectionId, epochKey) as
      { identity_epoch_id?: unknown } | undefined;
    const epochId = existingEpoch
      ? (existingEpoch.identity_epoch_id as Uint8Array)
      : canonicalId();
    if (!existingEpoch)
      db.prepare(
        "INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id) VALUES (?, ?, ?, ?)",
      ).run(epochId, connectionId, epochKey, commitId);
    db.prepare(
      "INSERT INTO source_route_bindings(authority_route, source_connection_id, created_commit_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    ).run(LINEBANK_V13_AUTHORITY, connectionId, commitId);

    const existingSubject = db
      .prepare(
        `SELECT source_subject_id FROM source_subjects
         WHERE source_connection_id = ? AND identity_epoch_id = ? AND stream = ?
           AND record_kind = ? AND subject_digest = ?`,
      )
      .get(
        connectionId,
        epochId,
        capture.stream,
        LINEBANK_V13_RECORD_KIND,
        capture.accountKey,
      ) as { source_subject_id?: unknown } | undefined;
    const subjectId = existingSubject
      ? (existingSubject.source_subject_id as Uint8Array)
      : canonicalId();
    if (!existingSubject)
      db.prepare(
        `INSERT INTO source_subjects(
          source_subject_id, source_connection_id, identity_epoch_id, stream,
          record_kind, subject_digest, created_commit_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        subjectId,
        connectionId,
        epochId,
        capture.stream,
        LINEBANK_V13_RECORD_KIND,
        capture.accountKey,
        commitId,
      );

    for (const record of capture.records) {
      const collisions = db
        .prepare(
          `SELECT occurrence_key FROM source_records
           WHERE source_subject_id = ? AND collision_key = ?`,
        )
        .all(subjectId, record.baseOccurrenceKey) as Array<{
        occurrence_key?: unknown;
      }>;
      if (
        collisions.some(
          (row) => String(row.occurrence_key) !== record.sourceOccurrenceKey,
        )
      )
        throw new DomesticDepositConflictError(
          "LINE Bank occurrence base collision is forbidden.",
        );
      const prior = db
        .prepare(
          `SELECT provider_key, content_hash FROM source_records
           WHERE source_subject_id = ? AND occurrence_key = ?`,
        )
        .all(subjectId, record.sourceOccurrenceKey) as Array<{
        provider_key?: unknown;
        content_hash?: unknown;
      }>;
      if (
        prior.some(
          (row) =>
            String(row.provider_key) !== record.sourceOccurrenceKey ||
            String(row.content_hash) !== record.sourceChangeFingerprint,
        )
      )
        throw new DomesticDepositConflictError(
          "LINE Bank occurrence content overwrite is forbidden.",
        );
    }

    const existingAccount = db
      .prepare(
        `SELECT account_id, currency, account_type FROM financial_accounts
         WHERE source_connection_id = ? AND identity_epoch_id = ? AND stream = ? AND account_no = ?`,
      )
      .get(connectionId, epochId, capture.stream, capture.accountKey) as
      | { account_id?: unknown; currency?: unknown; account_type?: unknown }
      | undefined;
    if (
      existingAccount &&
      (existingAccount.currency !== "TWD" ||
        existingAccount.account_type !== "depository")
    )
      throw new DomesticDepositConflictError(
        "LINE Bank account classification conflict is forbidden.",
      );
    const accountId = existingAccount
      ? (existingAccount.account_id as Uint8Array)
      : canonicalId();
    if (!existingAccount)
      db.prepare(
        `INSERT INTO financial_accounts(
          account_id, source_connection_id, identity_epoch_id, stream, account_no,
          account_type, currency, created_commit_id
        ) VALUES (?, ?, ?, ?, ?, 'depository', 'TWD', ?)`,
      ).run(
        accountId,
        connectionId,
        epochId,
        capture.stream,
        capture.accountKey,
        commitId,
      );

    const captureId = canonicalId();
    const scopeId = canonicalId();
    const scopeStart = v13CanonicalDate(capture.scope.startDate);
    const scopeEnd = v13CanonicalDate(capture.scope.endDate);
    db.prepare(
      `INSERT INTO source_captures(
        capture_id, capture_key, source_connection_id, identity_epoch_id,
        authority_route, source_subject_id, stream, record_kind, account_no,
        observed_at, scope_start, scope_end, completeness, completeness_basis,
        completeness_rule_version, commit_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete-range',
        'human-attested-requested-scope-all-pages-stable-totals',
        'linebank/domestic-deposit/human-attested-v13', ?)`,
    ).run(
      captureId,
      capture.captureId,
      connectionId,
      epochId,
      LINEBANK_V13_AUTHORITY,
      subjectId,
      capture.stream,
      LINEBANK_V13_RECORD_KIND,
      capture.accountKey,
      capture.observedAt,
      scopeStart,
      scopeEnd,
      commitId,
    );
    const contractFingerprint = opaqueToken(
      "linebank-v13-contract",
      capture.contractVersion,
      capture.humanAttestation.evidenceVersion,
    );
    const preflightFingerprint = opaqueToken(
      "linebank-v13-scope",
      capture.sourceScopeEvidence.evidenceVersion,
      capture.authority.kind,
      capture.authority.membershipEffectiveDate ?? "personal-main",
    );
    db.prepare(
      `INSERT INTO capture_scopes(
        scope_id, capture_id, source_connection_id, identity_epoch_id, account_id,
        source_subject_id, account_no, stream, scope_start, scope_end, scope_kind,
        completeness, completeness_basis, completeness_rule_version,
        absence_authority, contract_fingerprint, preflight_fingerprint,
        page_count, terminal, commit_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'bounded-range', 'complete-range',
        'human-attested-requested-scope-all-pages-stable-totals',
        'linebank/domestic-deposit/human-attested-v13',
        'comparable-complete-range', ?, ?, ?, 1, ?)`,
    ).run(
      scopeId,
      captureId,
      connectionId,
      epochId,
      accountId,
      subjectId,
      capture.accountKey,
      capture.stream,
      scopeStart,
      scopeEnd,
      contractFingerprint,
      preflightFingerprint,
      capture.pageCount,
      commitId,
    );
    for (const page of capture.pages)
      db.prepare(
        `INSERT INTO capture_scope_pages(
          scope_page_id, scope_id, page_ordinal, response_code, terminal,
          row_count, response_digest, proof_kind, contract_fingerprint,
          preflight_fingerprint, metadata_json, commit_id
        ) VALUES (?, ?, ?, '200', ?, ?, ?,
          'human-attested-requested-scope-all-pages-stable-totals', ?, ?, ?, ?)`,
      ).run(
        canonicalId(),
        scopeId,
        page.pageNbr - 1,
        page.pageNbr === capture.pageCount ? 1 : 0,
        page.txCnt,
        opaqueToken(
          "linebank-v13-page",
          capture.captureId,
          String(page.pageNbr),
          String(page.txCnt),
        ),
        contractFingerprint,
        preflightFingerprint,
        JSON.stringify({
          pageNbr: page.pageNbr,
          pageCapacity: page.pageCnt,
          totalCount: page.totTxCnt,
          rowCount: page.txCnt,
        }),
        commitId,
      );

    const seen = new Set<string>();
    for (const record of capture.records) {
      if (!record.balanceAfter)
        throw new DomesticDepositConflictError(
          "LINE Bank admitted financial record lacks an exact balance.",
        );
      seen.add(record.sourceOccurrenceKey);
      const sourceRecordId = canonicalId();
      db.prepare(
        `INSERT INTO source_records(
          source_record_id, capture_id, source_subject_id, commit_id, record_kind,
          sequence_lexeme, provider_key, content_hash, occurrence_key,
          collision_key, description, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        sourceRecordId,
        captureId,
        subjectId,
        commitId,
        LINEBANK_V13_RECORD_KIND,
        record.sourceOccurrenceKey,
        record.sourceOccurrenceKey,
        record.sourceChangeFingerprint,
        record.sourceOccurrenceKey,
        record.baseOccurrenceKey,
        v13CompactRecord(capture, record),
      );
      db.prepare(
        `INSERT INTO source_record_scopes(
          source_record_id, scope_id, capture_id, account_id, source_subject_id,
          sequence_lexeme, occurrence_key, commit_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sourceRecordId,
        scopeId,
        captureId,
        accountId,
        subjectId,
        record.sourceOccurrenceKey,
        record.sourceOccurrenceKey,
        commitId,
      );
      db.prepare(
        "INSERT INTO source_record_provenance(source_record_id, capture_id, commit_id) VALUES (?, ?, ?)",
      ).run(sourceRecordId, captureId, commitId);

      const existingTransaction = db
        .prepare(
          "SELECT transaction_id FROM financial_transactions WHERE account_id = ? AND source_sequence = ?",
        )
        .get(accountId, record.sourceOccurrenceKey) as
        { transaction_id?: unknown } | undefined;
      const transactionId = existingTransaction
        ? (existingTransaction.transaction_id as Uint8Array)
        : canonicalId();
      if (!existingTransaction)
        db.prepare(
          "INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id) VALUES (?, ?, ?, ?)",
        ).run(transactionId, accountId, record.sourceOccurrenceKey, commitId);
      const existingRevision = db
        .prepare(
          "SELECT revision_id, commit_id FROM transaction_revisions WHERE transaction_id = ? ORDER BY revision_number DESC LIMIT 1",
        )
        .get(transactionId) as
        { revision_id?: unknown; commit_id?: unknown } | undefined;
      let revisionId: Uint8Array;
      let assertionId: Uint8Array;
      if (!existingRevision) {
        revisionId = canonicalId();
        db.prepare(
          `INSERT INTO transaction_revisions(
            revision_id, transaction_id, source_record_id, capture_id, commit_id,
            revision_number, amount_coefficient, amount_scale, currency, direction,
            posting_status, posting_origin, posting_basis, posting_rule_version,
            description, economic_status, administrative_state,
            semantic_rule_version, effective_on, transaction_date_time_local,
            time_zone, time_precision, time_origin, effective_time_basis,
            effective_time_rule_version, utc_instant_utc_us
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'TWD', ?, 'posted',
            'human_attested_history', 'human-attested-formally-posted',
            'linebank/domestic-deposit/human-attested-v13', NULL, 'normal',
            'active', 'linebank/domestic-deposit/human-attested-v13', ?, ?,
            'Asia/Taipei', 'second', 'source_reported', 'transaction-time',
            'linebank/domestic-deposit/human-attested-v13', ?)`,
        ).run(
          revisionId,
          transactionId,
          sourceRecordId,
          captureId,
          commitId,
          record.amount.coefficient,
          record.amount.scale,
          record.direction,
          v13CanonicalDate(record.sourceTime.localDate),
          v13CanonicalDateTime(record.sourceTime),
          record.sourceTime.epochMilliseconds * 1_000,
        );
        db.prepare(
          `INSERT INTO transaction_time_observations(
            observation_id, transaction_id, revision_id, source_record_id,
            commit_id, role, local_value, time_zone, time_precision,
            time_origin, utc_instant_utc_us
          ) VALUES (?, ?, ?, ?, ?, 'occurred', ?, 'Asia/Taipei', 'second',
            'source_reported', ?)`,
        ).run(
          canonicalId(),
          transactionId,
          revisionId,
          sourceRecordId,
          commitId,
          v13CanonicalDateTime(record.sourceTime),
          record.sourceTime.epochMilliseconds * 1_000,
        );
        assertionId = canonicalId();
        db.prepare(
          `INSERT INTO assertions(
            assertion_id, transaction_id, field_name, target_kind, origin,
            producer_id, rule_lineage, revision_id, value_text, created_commit_id
          ) VALUES (?, ?, 'transaction_revision', 'transaction', 'source', ?, ?, ?, NULL, ?)`,
        ).run(
          assertionId,
          transactionId,
          LINEBANK_V13_AUTHORITY,
          LINEBANK_V13_AUTHORITY,
          revisionId,
          commitId,
        );
        insertLineBankLifecycle(db, {
          assertionId,
          transactionId,
          captureId,
          scopeId,
          commitId,
          kind: "observed",
        });
        db.prepare(
          `INSERT INTO current_transactions(
            transaction_id, revision_id, commit_id, projection_commit_id,
            revision_commit_id
          ) VALUES (?, ?, ?, ?, ?)`,
        ).run(transactionId, revisionId, commitId, commitId, commitId);
      } else {
        revisionId = existingRevision.revision_id as Uint8Array;
        const assertion = db
          .prepare(
            "SELECT assertion_id FROM assertions WHERE origin = 'source' AND revision_id = ?",
          )
          .get(revisionId) as { assertion_id?: unknown } | undefined;
        if (!assertion)
          throw new Error("LINE Bank canonical source assertion is missing.");
        assertionId = assertion.assertion_id as Uint8Array;
        if (latestLineBankLifecycle(db, assertionId) === "withdrawn") {
          insertLineBankLifecycle(db, {
            assertionId,
            transactionId,
            captureId,
            scopeId,
            commitId,
            kind: "restored",
          });
          db.prepare(
            `INSERT INTO current_transactions(
              transaction_id, revision_id, commit_id, projection_commit_id,
              revision_commit_id
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(transaction_id) DO UPDATE SET
              revision_id = excluded.revision_id,
              commit_id = excluded.commit_id,
              projection_commit_id = excluded.projection_commit_id,
              revision_commit_id = excluded.revision_commit_id`,
          ).run(
            transactionId,
            revisionId,
            commitId,
            commitId,
            existingRevision.commit_id as Uint8Array,
          );
        }
      }
      db.prepare(
        "INSERT INTO assertion_provenance(assertion_id, source_record_id, commit_id) VALUES (?, ?, ?)",
      ).run(assertionId, sourceRecordId, commitId);
    }

    const prior = db
      .prepare(
        `SELECT assertion.assertion_id, assertion.transaction_id,
          transaction_row.source_sequence, revision.revision_id
         FROM assertions assertion
         JOIN financial_transactions transaction_row
           ON transaction_row.transaction_id = assertion.transaction_id
         JOIN transaction_revisions revision ON revision.revision_id = assertion.revision_id
         JOIN current_transactions current_row
           ON current_row.transaction_id = transaction_row.transaction_id
          AND current_row.revision_id = revision.revision_id
         JOIN assertion_provenance provenance
           ON provenance.assertion_id = assertion.assertion_id
         JOIN source_record_scopes record_scope
           ON record_scope.source_record_id = provenance.source_record_id
         JOIN capture_scopes prior_scope ON prior_scope.scope_id = record_scope.scope_id
         JOIN source_captures prior_capture ON prior_capture.capture_id = prior_scope.capture_id
         WHERE assertion.origin = 'source' AND transaction_row.account_id = ?
           AND revision.effective_on BETWEEN ? AND ?
           AND prior_scope.source_connection_id = ?
           AND prior_scope.identity_epoch_id = ?
           AND prior_scope.account_id = ? AND prior_scope.stream = ?
           AND prior_scope.scope_start = ? AND prior_scope.scope_end = ?
           AND prior_scope.scope_kind = 'bounded-range'
           AND prior_scope.completeness = 'complete-range'
           AND prior_scope.completeness_rule_version = ?
           AND prior_scope.contract_fingerprint = ?
           AND prior_scope.preflight_fingerprint = ?
           AND prior_capture.authority_route = ?`,
      )
      .all(
        accountId,
        scopeStart,
        scopeEnd,
        connectionId,
        epochId,
        accountId,
        capture.stream,
        scopeStart,
        scopeEnd,
        LINEBANK_V13_AUTHORITY,
        contractFingerprint,
        preflightFingerprint,
        LINEBANK_V13_AUTHORITY,
      ) as Array<Record<string, unknown>>;
    for (const row of prior) {
      if (seen.has(String(row.source_sequence))) continue;
      const assertionId = row.assertion_id as Uint8Array;
      if (latestLineBankLifecycle(db, assertionId) === "withdrawn") continue;
      insertLineBankLifecycle(db, {
        assertionId,
        transactionId: row.transaction_id as Uint8Array,
        captureId,
        scopeId,
        commitId,
        kind: "withdrawn",
      });
      db.prepare(
        "DELETE FROM current_transactions WHERE transaction_id = ? AND revision_id = ?",
      ).run(row.transaction_id as Uint8Array, row.revision_id as Uint8Array);
    }

    db.prepare(
      `INSERT INTO source_sync_states(
        source_connection_id, account_id, stream, scope_start, scope_end,
        cursor, last_capture_id, commit_id
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(source_connection_id, account_id, stream) DO UPDATE SET
        scope_start = excluded.scope_start, scope_end = excluded.scope_end,
        cursor = excluded.cursor, last_capture_id = excluded.last_capture_id,
        commit_id = excluded.commit_id`,
    ).run(
      connectionId,
      accountId,
      capture.stream,
      scopeStart,
      scopeEnd,
      captureId,
      commitId,
    );
    syncCanonicalProjectionFromCompatibility(db, commitId);
    db.prepare(
      `INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?)
       ON CONFLICT(generation) DO UPDATE SET commit_id = excluded.commit_id`,
    ).run(commitId);
    db.exec("COMMIT");
    return {
      status: "canonical-live",
      canonicalAdmission: "admitted",
      captureId: capture.captureId,
      commitSequence,
      transactionCount: capture.records.length,
      provenanceCount: Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM source_captures WHERE record_kind = ?",
            )
            .get(LINEBANK_V13_RECORD_KIND) as { count?: number }
        ).count ?? 0,
      ),
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* preserve original failure */
    }
    throw error;
  }
}

export function commitCanonicalLineBankFinancialCapture(
  store: DomesticDepositStore,
  capture: LineBankHumanAttestedV13ValidatedCapture,
): Promise<LineBankFinancialCommitResult> {
  ensureOpen(store);
  return withCanonicalWriterQueue(store.databasePath, () =>
    commitCanonicalLineBankFinancialCaptureOnce(store, capture),
  );
}

function hasLineBankFinancialEvidence(store: DomesticDepositStore): boolean {
  return Boolean(
    store.db
      .prepare("SELECT 1 FROM source_captures WHERE record_kind = ? LIMIT 1")
      .get(LINEBANK_V13_RECORD_KIND),
  );
}

function lineBankFinancialRows(
  store: DomesticDepositStore,
  request: {
    knowledgeAt?: number;
    financialAt?: string;
    occurrenceKey?: string;
    accountKey?: string;
    sourceConnectionKey?: string;
    identityEpochKey?: string;
    includeWithdrawn?: boolean;
  } = {},
): DomesticDepositFinancialTransaction[] {
  const latestKnowledge = Number(
    (
      store.db
        .prepare(
          "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
        )
        .get() as { value?: number }
    ).value ?? 0,
  );
  const knowledgeAt = request.knowledgeAt ?? latestKnowledge;
  const clauses = [
    "revision.posting_rule_version = 'linebank/domestic-deposit/human-attested-v13'",
    "revision_commit.commit_sequence <= ?",
  ];
  if (!request.includeWithdrawn)
    clauses.push(`COALESCE((
      SELECT transition.event_kind FROM assertion_transitions transition
      JOIN canonical_commits transition_commit ON transition_commit.commit_id = transition.commit_id
      WHERE transition.assertion_id = assertion.assertion_id
        AND transition_commit.commit_sequence <= ?
      ORDER BY transition_commit.commit_sequence DESC, transition.event_id DESC LIMIT 1
    ), 'observed') <> 'withdrawn'`);
  const parameters: Array<number | string> = [knowledgeAt];
  if (!request.includeWithdrawn) parameters.push(knowledgeAt);
  if (request.financialAt !== undefined) {
    clauses.push("revision.effective_on <= ?");
    parameters.push(v13FinancialCutoff(request.financialAt));
  }
  if (request.occurrenceKey !== undefined) {
    clauses.push("transaction_row.source_sequence = ?");
    parameters.push(request.occurrenceKey);
  }
  if (request.accountKey !== undefined) {
    clauses.push("account.account_no = ?");
    parameters.push(request.accountKey);
  }
  if (request.sourceConnectionKey !== undefined) {
    clauses.push(
      "connection.integration_namespace = 'linebank'",
      "connection.source_connection_key = ?",
    );
    parameters.push(request.sourceConnectionKey);
  }
  if (request.identityEpochKey !== undefined) {
    clauses.push("epoch.epoch_key = ?");
    parameters.push(request.identityEpochKey);
  }
  const rows = store.db
    .prepare(
      `SELECT transaction_row.transaction_id, transaction_row.account_id,
        account.account_no, transaction_row.source_sequence,
        revision.amount_coefficient, revision.amount_scale, revision.currency,
        revision.direction, revision.posting_status, revision.effective_on,
        revision.transaction_date_time_local, revision.effective_time_basis,
        revision.time_zone, revision_commit.commit_sequence
       FROM financial_transactions transaction_row
       JOIN financial_accounts account ON account.account_id = transaction_row.account_id
       JOIN source_connections connection
         ON connection.source_connection_id = account.source_connection_id
       JOIN identity_epochs epoch
         ON epoch.identity_epoch_id = account.identity_epoch_id
       JOIN transaction_revisions revision ON revision.transaction_id = transaction_row.transaction_id
       JOIN canonical_commits revision_commit ON revision_commit.commit_id = revision.commit_id
       JOIN assertions assertion ON assertion.revision_id = revision.revision_id
         AND assertion.origin = 'source'
       WHERE ${clauses.join(" AND ")}
         AND NOT EXISTS (
           SELECT 1 FROM transaction_revisions newer
           JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.commit_id
           WHERE newer.transaction_id = revision.transaction_id
             AND newer_commit.commit_sequence <= ?
             AND newer_commit.commit_sequence > revision_commit.commit_sequence
         )
       ORDER BY account.account_no, revision.utc_instant_utc_us, transaction_row.source_sequence`,
    )
    .all(...parameters, knowledgeAt) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: idText(row.transaction_id),
    accountId: idText(row.account_id),
    accountNo: String(row.account_no),
    sourceOccurrenceKey: String(row.source_sequence),
    amount: {
      coefficient: String(row.amount_coefficient),
      scale: Number(row.amount_scale),
    },
    currency: "TWD",
    direction: String(row.direction) as "inflow" | "outflow",
    postingStatus: "posted",
    effectiveOn: String(row.effective_on),
    transactionDateTimeLocal: String(row.transaction_date_time_local),
    effectiveTimeBasis: "transaction-time",
    timeZone: "Asia/Taipei",
    knowledgeCommitSequence: Number(row.commit_sequence),
  }));
}

export function queryCurrent(
  store: DomesticDepositStore,
): DomesticDepositCurrentQueryResult {
  ensureOpen(store);
  const base = domesticQueryResult(
    queryCanonicalSourceCurrent(store.sourceStore),
  );
  const financial = hasLineBankFinancialEvidence(store);
  return {
    kind: "current",
    ...base,
    ...(financial
      ? {
          status: "canonical-live" as const,
          canonicalAdmission: "admitted" as const,
          financialAdmissionBlockers: [] as const,
        }
      : {}),
    transactions: lineBankFinancialRows(store),
  };
}

export function queryHistorical(
  store: DomesticDepositStore,
  request: { knowledgeAt?: number; financialAt?: string } = {},
):
  | DomesticDepositHistoricalQueryResult
  | DomesticDepositBlockedHistoricalQueryResult {
  ensureOpen(store);
  if (
    request.financialAt !== undefined &&
    !hasLineBankFinancialEvidence(store)
  ) {
    return {
      status: "blocked",
      kind: "historical",
      canonicalAdmission: DOMESTIC_DEPOSIT_CANONICAL_ADMISSION,
      reason: "effective-time-semantics-unproven",
      records: [],
      observations: [],
      provenanceCount: 0,
      financialAdmissionBlockers: DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS,
      transactions: [],
    };
  }
  const result = queryCanonicalSourceHistorical(store.sourceStore, {
    knowledgeAt: request.knowledgeAt,
  });
  const financial = hasLineBankFinancialEvidence(store);
  const financialAt =
    request.financialAt === undefined
      ? undefined
      : v13FinancialCutoff(request.financialAt);
  const common = {
    kind: "historical",
    knowledgeAt: result.knowledgeAt,
    ...domesticQueryResult(result),
    ...(financial
      ? {
          status: "canonical-live" as const,
          canonicalAdmission: "admitted" as const,
          financialAdmissionBlockers: [] as const,
        }
      : {}),
    transactions: lineBankFinancialRows(store, request),
  };
  if (financialAt === undefined)
    return {
      ...common,
      kind: "historical",
      financialCutoffApplied: false,
      cutoff: { kind: "knowledge", knowledgeAt: result.knowledgeAt },
    };
  return {
    ...common,
    kind: "historical",
    financialCutoffApplied: true,
    cutoff: {
      kind: "both",
      knowledgeAt: result.knowledgeAt,
      financialAt,
    },
  };
}

export function queryLineage(
  store: DomesticDepositStore,
  request: DomesticDepositLineageRequest,
): DomesticDepositLineageQueryResult {
  ensureOpen(store);
  const sourceConnectionKey = opaqueToken(
    "linebank-connection",
    request.sourceConnection,
  );
  const identityEpochKey = opaqueToken(
    "linebank-epoch",
    request.sourceConnection,
    String(request.identityEpoch),
  );
  const transactions = lineBankFinancialRows(store, {
    occurrenceKey: request.sourceOccurrenceKey,
    accountKey: request.accountKey,
    sourceConnectionKey,
    identityEpochKey,
    includeWithdrawn: true,
  });
  const result = queryCanonicalSourceLineage(store.sourceStore, {
    integrationNamespace: "linebank",
    sourceConnectionKey,
    identityEpoch: identityEpochKey,
    stream: request.stream,
    recordKind:
      transactions.length > 0
        ? LINEBANK_V13_RECORD_KIND
        : "linebank-domestic-deposit-source-record",
    subjectDigest: request.accountKey,
    occurrenceKey: request.sourceOccurrenceKey,
  });
  const base = domesticQueryResult(result);
  const completeLineage =
    result.provenanceComplete &&
    result.expectedObservationCount === result.observations.length &&
    result.records.length > 0 &&
    result.observations.length > 0 &&
    result.provenanceCount > 0 &&
    result.provenance.length === result.provenanceCount &&
    transactions.length > 0;
  return {
    kind: "lineage",
    sourceOccurrenceKey: request.sourceOccurrenceKey,
    ...base,
    ...(completeLineage
      ? {
          status: "canonical-live" as const,
          canonicalAdmission: "admitted" as const,
          financialAdmissionBlockers: [] as const,
        }
      : {}),
    transactions,
    provenance: result.provenance,
    expectedObservationCount: result.expectedObservationCount,
    provenanceComplete: result.provenanceComplete,
  };
}
