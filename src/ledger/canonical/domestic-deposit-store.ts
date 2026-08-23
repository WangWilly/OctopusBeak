import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
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
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositValidatedCapture,
} from "./canonical-financial-deposit-writer.ts";

export {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCapture,
} from "./canonical-financial-deposit-writer.ts";
export type {
  CanonicalFinancialDepositCapture,
  CanonicalFinancialDepositCommitResult,
  CanonicalFinancialDepositPage,
  CanonicalFinancialDepositRecord,
  CanonicalFinancialDepositValidatedCapture,
  CanonicalFinancialDepositWriterStore,
} from "./canonical-financial-deposit-writer.ts";

/**
 * Durable Source Capture/Record storage shared by domestic-deposit adapters;
 * the financial admission seam delegates to the provider-neutral writer.
 *
 * Source-record admission remains deliberately blocked. Financial captures
 * cross the separate normalized seam below and use the shared transaction
 * writer; no response body, headers, DOM, or credentials are retained.
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
  currency: string;
  direction: "inflow" | "outflow";
  postingStatus: "pending" | "posted";
  effectiveOn: string;
  transactionDateTimeLocal: string;
  effectiveTimeBasis: "accounting" | "transaction-time";
  timeZone: string;
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
  /** Optional source subject digest when accountKey is a provider account number. */
  subjectDigest?: string;
  integrationNamespace?: string;
  sourceConnectionKey?: string;
  identityEpochKey?: string;
  recordKind?: string;
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

function financialCutoffDate(value: string): string {
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

/**
 * Adapter boundary for the financial writer.  All provider-specific
 * vocabulary is resolved here; the writer only receives normalized identity,
 * completeness, time, posting and occurrence semantics.
 */
function normalizeLineBankFinancialCapture(
  capture: LineBankHumanAttestedV13ValidatedCapture,
): CanonicalFinancialDepositValidatedCapture {
  if (!hasLineBankFinancialValidatedBrand(capture))
    throw new DomesticDepositConflictError(
      "LINE Bank financial capture did not cross the runtime-validated v13 seam.",
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
  return admitCanonicalFinancialDepositCapture({
    captureId: capture.captureId,
    authorityRoute: LINEBANK_V13_AUTHORITY,
    // The financial admission contract is distinct from the source
    // preflight-v4 envelope carried by the adapter input.
    contractVersion: "human-attested-v13",
    identity: {
      integrationNamespace: "linebank",
      sourceConnectionKey: v13ConnectionKey(capture),
      identityEpochKey: v13EpochKey(capture),
      stream: capture.stream,
      recordKind: LINEBANK_V13_RECORD_KIND,
      subjectDigest: capture.accountKey,
      accountNo: capture.accountKey,
      accountType: "depository",
      currency: "TWD",
    },
    observedAt: capture.observedAt,
    scope: {
      startDate: v13CanonicalDate(capture.scope.startDate),
      endDate: v13CanonicalDate(capture.scope.endDate),
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis:
        "human-attested-requested-scope-all-pages-stable-totals",
      completenessRuleVersion: "linebank/domestic-deposit/human-attested-v13",
      absenceAuthority: "comparable-complete-range",
      contractFingerprint,
      preflightFingerprint,
      pageCount: capture.pageCount,
    },
    semantics: {
      postingStatus: capture.postingStatus,
      postingOrigin: "human_attested_history",
      postingBasis: "human-attested-formally-posted",
      postingRuleVersion: "linebank/domestic-deposit/human-attested-v13",
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: "linebank/domestic-deposit/human-attested-v13",
      effectiveTimeBasis: capture.effectiveTimeBasis,
      effectiveTimeRuleVersion: "linebank/domestic-deposit/human-attested-v13",
      timeZone: capture.timeZone,
      timePrecision: "second",
      timeOrigin: "source_reported",
      requireBalance: true,
    },
    pages: capture.pages.map((page) => ({
      pageOrdinal: page.pageNbr - 1,
      responseCode: "200",
      terminal: page.pageNbr === capture.pageCount,
      rowCount: page.txCnt,
      responseDigest: opaqueToken(
        "linebank-v13-page",
        capture.captureId,
        String(page.pageNbr),
        String(page.txCnt),
      ),
      proofKind: "human-attested-requested-scope-all-pages-stable-totals",
      contractFingerprint,
      preflightFingerprint,
      metadataJson: JSON.stringify({
        pageNbr: page.pageNbr,
        pageCapacity: page.pageCnt,
        totalCount: page.totTxCnt,
        rowCount: page.txCnt,
      }),
    })),
    records: capture.records.map((record) => ({
      occurrenceKey: record.sourceOccurrenceKey,
      collisionKey: record.baseOccurrenceKey,
      providerKey: record.sourceOccurrenceKey,
      contentHash: record.sourceChangeFingerprint,
      sequenceLexeme: record.sourceOccurrenceKey,
      compactJson: v13CompactRecord(capture, record),
      amount: record.amount,
      balanceAfter: record.balanceAfter,
      currency: record.currency,
      direction: record.direction,
      sourceTime: {
        localDate: record.sourceTime.localDate,
        localTime: record.sourceTime.localTime,
        timeZone: record.sourceTime.timeZone,
        epochMilliseconds: record.sourceTime.epochMilliseconds,
      },
      effectiveOn: v13CanonicalDate(record.sourceTime.localDate),
      transactionDateTimeLocal: v13CanonicalDateTime(record.sourceTime),
    })),
  });
}

export async function commitCanonicalLineBankFinancialCapture(
  store: DomesticDepositStore,
  capture: LineBankHumanAttestedV13ValidatedCapture,
): Promise<LineBankFinancialCommitResult> {
  ensureOpen(store);
  return commitCanonicalFinancialDepositCapture(
    {
      db: store.db,
      databasePath: store.databasePath,
      commitClock: () => store.sourceStore.commitClock(),
    },
    normalizeLineBankFinancialCapture(capture),
  );
}

function hasFinancialEvidence(
  store: DomesticDepositStore,
  integrationNamespace = "linebank",
): boolean {
  return Boolean(
    store.db
      .prepare(
        `SELECT 1 FROM source_captures capture
         JOIN source_connections connection
           ON connection.source_connection_id = capture.source_connection_id
         WHERE connection.integration_namespace = ?
           AND capture.record_kind NOT LIKE '%source-record%' LIMIT 1`,
      )
      .get(integrationNamespace),
  );
}

function canonicalFinancialRows(
  store: DomesticDepositStore,
  request: {
    knowledgeAt?: number;
    financialAt?: string;
    occurrenceKey?: string;
    accountKey?: string;
    sourceConnectionKey?: string;
    integrationNamespace?: string;
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
  const clauses = ["revision_commit.commit_sequence <= ?"];
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
    parameters.push(financialCutoffDate(request.financialAt));
  }
  if (request.occurrenceKey !== undefined) {
    clauses.push("transaction_row.source_sequence = ?");
    parameters.push(request.occurrenceKey);
  }
  if (request.accountKey !== undefined) {
    clauses.push("account.account_no = ?");
    parameters.push(request.accountKey);
  }
  if (request.integrationNamespace !== undefined) {
    clauses.push("connection.integration_namespace = ?");
    parameters.push(request.integrationNamespace);
  }
  if (request.sourceConnectionKey !== undefined) {
    clauses.push("connection.source_connection_key = ?");
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
    currency: String(row.currency),
    direction: String(row.direction) as "inflow" | "outflow",
    postingStatus: String(row.posting_status) as "pending" | "posted",
    effectiveOn: String(row.effective_on),
    transactionDateTimeLocal: String(row.transaction_date_time_local),
    effectiveTimeBasis: String(row.effective_time_basis) as
      "accounting" | "transaction-time",
    timeZone: String(row.time_zone),
    knowledgeCommitSequence: Number(row.commit_sequence),
  }));
}

export function queryCurrent(
  store: DomesticDepositStore,
  request: { integrationNamespace?: string } = {},
): DomesticDepositCurrentQueryResult {
  ensureOpen(store);
  const base = domesticQueryResult(
    queryCanonicalSourceCurrent(store.sourceStore),
  );
  const integrationNamespace = request.integrationNamespace ?? "linebank";
  const financial = hasFinancialEvidence(store, integrationNamespace);
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
    transactions: canonicalFinancialRows(store, { integrationNamespace }),
  };
}

export function queryHistorical(
  store: DomesticDepositStore,
  request: {
    knowledgeAt?: number;
    financialAt?: string;
    integrationNamespace?: string;
  } = {},
):
  | DomesticDepositHistoricalQueryResult
  | DomesticDepositBlockedHistoricalQueryResult {
  ensureOpen(store);
  const integrationNamespace = request.integrationNamespace ?? "linebank";
  if (
    request.financialAt !== undefined &&
    !hasFinancialEvidence(store, integrationNamespace)
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
  const financial = hasFinancialEvidence(store, integrationNamespace);
  const financialAt =
    request.financialAt === undefined
      ? undefined
      : financialCutoffDate(request.financialAt);
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
    transactions: canonicalFinancialRows(store, {
      ...request,
      integrationNamespace,
    }),
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
  const integrationNamespace = request.integrationNamespace ?? "linebank";
  const sourceConnectionKey =
    request.sourceConnectionKey ??
    opaqueToken(`${integrationNamespace}-connection`, request.sourceConnection);
  const identityEpochKey =
    request.identityEpochKey ??
    opaqueToken(
      `${integrationNamespace}-epoch`,
      request.sourceConnection,
      String(request.identityEpoch),
    );
  const transactions = canonicalFinancialRows(store, {
    occurrenceKey: request.sourceOccurrenceKey,
    accountKey: request.accountKey,
    sourceConnectionKey,
    integrationNamespace,
    identityEpochKey,
    includeWithdrawn: true,
  });
  const result = queryCanonicalSourceLineage(store.sourceStore, {
    integrationNamespace,
    sourceConnectionKey,
    identityEpoch: identityEpochKey,
    stream: request.stream,
    recordKind:
      request.recordKind ??
      (transactions.length > 0
        ? LINEBANK_V13_RECORD_KIND
        : "linebank-domestic-deposit-source-record"),
    subjectDigest: request.subjectDigest ?? request.accountKey,
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
