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

export type DomesticDepositQueryRecord = DomesticDepositSourceRecord & {
  firstCommitSequence: number;
};

export type DomesticDepositSourceObservation = DomesticDepositQueryRecord & {
  recordId: number;
  captureId: string;
  commitSequence: number;
};

type BaseQueryResult = {
  status: typeof DOMESTIC_DEPOSIT_SOURCE_RECORD_STAGE;
  canonicalAdmission: typeof DOMESTIC_DEPOSIT_CANONICAL_ADMISSION;
  records: DomesticDepositQueryRecord[];
  observations: DomesticDepositSourceObservation[];
  provenanceCount: number;
  financialAdmissionBlockers: readonly DomesticDepositFinancialAdmissionBlocker[];
};

export type DomesticDepositCurrentQueryResult = BaseQueryResult & {
  kind: "current";
};
export type DomesticDepositHistoricalQueryResult = BaseQueryResult & {
  kind: "historical";
  knowledgeAt: number;
  financialCutoffApplied: false;
};
export type DomesticDepositBlockedHistoricalQueryResult = {
  status: "blocked";
  kind: "historical";
  canonicalAdmission: typeof DOMESTIC_DEPOSIT_CANONICAL_ADMISSION;
  reason: "effective-time-semantics-unproven";
  records: [];
  observations: [];
  provenanceCount: 0;
  financialAdmissionBlockers: readonly DomesticDepositFinancialAdmissionBlocker[];
};
export type DomesticDepositLineageQueryResult = BaseQueryResult & {
  kind: "lineage";
  sourceOccurrenceKey: string;
  provenance: Array<{ captureId: string; commitSequence: number }>;
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

export function queryCurrent(
  store: DomesticDepositStore,
): DomesticDepositCurrentQueryResult {
  ensureOpen(store);
  return {
    kind: "current",
    ...domesticQueryResult(queryCanonicalSourceCurrent(store.sourceStore)),
  };
}

export function queryHistorical(
  store: DomesticDepositStore,
  request: { knowledgeAt?: number; financialAt?: string } = {},
):
  | DomesticDepositHistoricalQueryResult
  | DomesticDepositBlockedHistoricalQueryResult {
  ensureOpen(store);
  if (request.financialAt !== undefined) {
    return {
      status: "blocked",
      kind: "historical",
      canonicalAdmission: DOMESTIC_DEPOSIT_CANONICAL_ADMISSION,
      reason: "effective-time-semantics-unproven",
      records: [],
      observations: [],
      provenanceCount: 0,
      financialAdmissionBlockers: DOMESTIC_DEPOSIT_FINANCIAL_ADMISSION_BLOCKERS,
    };
  }
  const result = queryCanonicalSourceHistorical(store.sourceStore, {
    knowledgeAt: request.knowledgeAt,
  });
  return {
    kind: "historical",
    knowledgeAt: result.knowledgeAt,
    financialCutoffApplied: false,
    ...domesticQueryResult(result),
  };
}

export function queryLineage(
  store: DomesticDepositStore,
  request: DomesticDepositLineageRequest,
): DomesticDepositLineageQueryResult {
  ensureOpen(store);
  const result = queryCanonicalSourceLineage(store.sourceStore, {
    integrationNamespace: "linebank",
    sourceConnectionKey: opaqueToken(
      "linebank-connection",
      request.sourceConnection,
    ),
    identityEpoch: opaqueToken(
      "linebank-epoch",
      request.sourceConnection,
      String(request.identityEpoch),
    ),
    stream: request.stream,
    recordKind: "linebank-domestic-deposit-source-record",
    subjectDigest: request.accountKey,
    occurrenceKey: request.sourceOccurrenceKey,
  });
  const base = domesticQueryResult(result);
  return {
    kind: "lineage",
    sourceOccurrenceKey: request.sourceOccurrenceKey,
    ...base,
    provenance: result.provenance,
  };
}
