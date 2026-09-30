import type { CanonicalSourceAccountNumber } from "./canonical-source-evidence.ts";

export const DOMESTIC_DEPOSIT_SOURCE_RECORD_STAGE = "source-record-only" as const;
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
  /** Source-provided description and note, with no synthetic fallback text. */
  description?: string | null;
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
  /** Optional explicit provider account-number evidence. */
  accountNumber?: CanonicalSourceAccountNumber | null;
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

export type DomesticDepositValidatedCapture = DomesticDepositCapture & {
  readonly __runtimeValidatedCapture: "domestic-deposit-source-record";
};

export class DomesticDepositConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomesticDepositConflictError";
  }
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

