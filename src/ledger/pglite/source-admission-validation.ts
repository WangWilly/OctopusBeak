import {
  requireCanonicalSourceText,
  requireCanonicalSourceToken,
  stableCanonicalSourceJson,
  validateCanonicalSourceAccountNumber,
  type CanonicalSourceEvidence,
  type CanonicalSourceRecord,
} from "../canonical/canonical-source-evidence.ts";
import { canonicalSourceRouteRegistration } from "../canonical/canonical-source-route-registry.ts";

export { validateCanonicalSourceAccountNumber };

/**
 * The PGlite worker has its own source-admission boundary.  It deliberately
 * stays independent of the retired synchronous admission runtime.
 */
export type PGliteCanonicalSourceRecord = CanonicalSourceRecord;
export type PGliteCanonicalSourceEvidence = CanonicalSourceEvidence;

export type PGliteCanonicalAdmissionFailureReason =
  | "invalid-evidence"
  | "capture-overwrite"
  | "occurrence-conflict"
  | "authority-route-unregistered"
  | "authority-route-drift"
  | "invalid-origin"
  | "invalid-financial-fact"
  | "cancelled"
  | "empty-batch"
  | "infrastructure";

/** Stable errors crossing the worker/domain boundary. */
export class PGliteCanonicalSourceAdmissionError extends Error {
  readonly reason: PGliteCanonicalAdmissionFailureReason;
  readonly code: PGliteCanonicalAdmissionFailureReason;

  constructor(
    reason: PGliteCanonicalAdmissionFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PGliteCanonicalSourceAdmissionError";
    this.reason = reason;
    this.code = reason;
  }
}

const SOURCE_DATE = /^\d{8}$/u;
const FORBIDDEN_SOURCE_KEY_PARTS = new Set([
  "raw",
  "header",
  "headers",
  "cookie",
  "cookies",
  "password",
  "secret",
  "credential",
  "credentials",
  "token",
  "tokens",
]);

function isForbiddenSourceKey(key: string): boolean {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .some((part) => FORBIDDEN_SOURCE_KEY_PARTS.has(part));
}

function requireSourceDate(
  value: unknown,
  label: string,
  format: "YYYYMMDD" | "YYYY-MM-DD" = "YYYYMMDD",
): string {
  const text = requireCanonicalSourceText(value, label);
  const normalized = format === "YYYY-MM-DD" ? text.replaceAll("-", "") : text;
  if (
    (format === "YYYYMMDD" && !SOURCE_DATE.test(text)) ||
    (format === "YYYY-MM-DD" &&
      (!/^\d{4}-\d{2}-\d{2}$/u.test(text) || !SOURCE_DATE.test(normalized)))
  )
    throw new Error(`${label} must be ${format}.`);
  const date = new Date(
    Date.UTC(
      Number(normalized.slice(0, 4)),
      Number(normalized.slice(4, 6)) - 1,
      Number(normalized.slice(6, 8)),
    ),
  );
  if (
    date.getUTCFullYear() !== Number(normalized.slice(0, 4)) ||
    date.getUTCMonth() !== Number(normalized.slice(4, 6)) - 1 ||
    date.getUTCDate() !== Number(normalized.slice(6, 8))
  )
    throw new Error(`${label} must be a calendar date.`);
  return text;
}

function assertCompactSourceValue(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error(`${path} contains a non-exact number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertCompactSourceValue(entry, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isForbiddenSourceKey(key))
        throw new Error(`${path}.${key} is not compact source evidence.`);
      assertCompactSourceValue(entry, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} contains an unsupported value.`);
}

function routeError(request: PGliteCanonicalSourceEvidence): void {
  const registration = canonicalSourceRouteRegistration(request.routeKey);
  if (!registration)
    throw new PGliteCanonicalSourceAdmissionError(
      "authority-route-unregistered",
      `Authority route ${request.routeKey} is not registered.`,
    );
  if (
    registration.integrationNamespace !== request.integrationNamespace ||
    registration.stream !== request.stream
  )
    throw new PGliteCanonicalSourceAdmissionError(
      "authority-route-drift",
      `Authority route ${request.routeKey} expected ${registration.integrationNamespace}/${registration.stream} but received ${request.integrationNamespace}/${request.stream}.`,
    );
  if (!registration.contractVersions.includes(request.contractVersion))
    throw new PGliteCanonicalSourceAdmissionError(
      "authority-route-drift",
      `Authority route ${request.routeKey} does not register contract version ${request.contractVersion}.`,
    );
}

/** Validate the closed provider-neutral source evidence contract. */
export function validatePGliteCanonicalSourceEvidence(
  evidence: PGliteCanonicalSourceEvidence,
): void {
  // Route admission is checked first so an unregistered authority cannot be
  // smuggled through a malformed request and receive a generic SQL failure.
  routeError(evidence);
  requireCanonicalSourceText(evidence.captureId, "Capture ID");
  requireCanonicalSourceText(
    evidence.integrationNamespace,
    "Integration namespace",
  );
  requireCanonicalSourceToken(
    evidence.sourceConnectionKey,
    "Source connection key",
  );
  requireCanonicalSourceToken(evidence.identityEpoch, "Identity epoch");
  requireCanonicalSourceText(evidence.stream, "Stream");
  requireCanonicalSourceText(evidence.recordKind, "Record kind");
  requireCanonicalSourceText(evidence.routeKey, "Authority route");
  requireCanonicalSourceText(evidence.contractVersion, "Contract version");
  requireCanonicalSourceToken(evidence.subjectDigest, "Subject digest");
  if (!Number.isFinite(Date.parse(evidence.observedAt)))
    throw new Error("Observed at must be RFC3339.");
  const sourceAccountKey =
    evidence.scope.sourceAccountKey ?? evidence.scope.accountNo;
  if (
    evidence.scope.sourceAccountKey !== undefined &&
    evidence.scope.sourceAccountKey !== null &&
    evidence.scope.accountNo !== undefined &&
    evidence.scope.accountNo !== null &&
    evidence.scope.sourceAccountKey !== evidence.scope.accountNo
  )
    throw new Error("Source account key and compatibility accountNo disagree.");
  if (sourceAccountKey !== undefined && sourceAccountKey !== null)
    requireCanonicalSourceText(sourceAccountKey, "Source account key");
  validateCanonicalSourceAccountNumber(evidence.accountNumber);
  const dateFormat = evidence.scope.dateFormat ?? "YYYYMMDD";
  if (dateFormat !== "YYYYMMDD" && dateFormat !== "YYYY-MM-DD")
    throw new Error("Source scope date format is unsupported.");
  const start = requireSourceDate(evidence.scope.startDate, "Scope start", dateFormat);
  const end = requireSourceDate(evidence.scope.endDate, "Scope end", dateFormat);
  if (start > end) throw new Error("Scope start must not be after scope end.");
  if (
    evidence.scope.kind !== "bounded-range" &&
    evidence.scope.kind !== "point-in-time"
  )
    throw new Error("Source scope kind is unsupported.");
  if (
    evidence.scope.completeness !== "complete-range" &&
    evidence.scope.completeness !== "single-page"
  )
    throw new Error("Source scope completeness is unsupported.");
  if (
    evidence.scope.absenceAuthority !== undefined &&
    evidence.scope.absenceAuthority !== "comparable-complete-range" &&
    evidence.scope.absenceAuthority !== "provider-explicit-no-data"
  )
    throw new Error("Source absence authority is unsupported.");
  requireCanonicalSourceText(evidence.scope.ruleVersion, "Completeness rule version");
  if (evidence.scope.completenessBasis !== undefined)
    requireCanonicalSourceText(evidence.scope.completenessBasis, "Completeness basis");
  if (evidence.scope.contractFingerprint !== undefined)
    requireCanonicalSourceToken(evidence.scope.contractFingerprint, "Contract fingerprint");
  if (evidence.scope.preflightFingerprint !== undefined)
    requireCanonicalSourceToken(evidence.scope.preflightFingerprint, "Preflight fingerprint");
  const pageTerminalPolicy = evidence.scope.pageTerminalPolicy ?? "last";
  if (pageTerminalPolicy !== "last" && pageTerminalPolicy !== "each")
    throw new Error("Source page terminal policy is unsupported.");
  if (!Array.isArray(evidence.pages) || evidence.pages.length === 0)
    throw new Error("At least one source page is required.");
  let rowCount = 0;
  evidence.pages.forEach((page, index) => {
    if (
      page.pageOrdinal !== index ||
      (page.responseCode !== "200" && page.responseCode !== "204") ||
      page.terminal !==
        (pageTerminalPolicy === "each" || index === evidence.pages.length - 1)
    )
      throw new Error("Source page sequence/status/terminal marker is inconsistent.");
    if (!Number.isSafeInteger(page.rowCount) || page.rowCount < 0)
      throw new Error("Source page row count is invalid.");
    if (page.responseCode === "204" && page.rowCount !== 0)
      throw new Error("Source page with HTTP 204 must not claim rows.");
    assertCompactSourceValue(page.metadata, `page[${index}].metadata`);
    rowCount += page.rowCount;
  });
  if (!Array.isArray(evidence.records) || rowCount !== evidence.records.length)
    throw new Error("Source page counts do not match compact records.");
  const occurrences = new Set<string>();
  evidence.records.forEach((record, index) => {
    requireCanonicalSourceToken(record.occurrenceKey, `Record ${index} occurrence key`);
    if (record.collisionKey !== undefined)
      requireCanonicalSourceToken(record.collisionKey, `Record ${index} collision key`);
    if (record.providerKey !== "human-attested:no-provider-key")
      requireCanonicalSourceToken(record.providerKey, `Record ${index} provider key`);
    requireCanonicalSourceToken(record.contentHash, `Record ${index} content hash`);
    if (occurrences.has(record.occurrenceKey))
      throw new PGliteCanonicalSourceAdmissionError(
        "occurrence-conflict",
        "Duplicate occurrence in one capture.",
      );
    occurrences.add(record.occurrenceKey);
    if (!record.compact || typeof record.compact !== "object" || Array.isArray(record.compact))
      throw new Error(`Record ${index} compact payload must be an object.`);
    assertCompactSourceValue(record.compact, `record[${index}].compact`);
    if (record.compactJson !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(record.compactJson);
      } catch (error) {
        throw new Error(`Record ${index} compact JSON is invalid.`, { cause: error });
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        stableCanonicalSourceJson(parsed as Record<string, unknown>) !== stableCanonicalSourceJson(record.compact))
        throw new Error(`Record ${index} compact JSON disagrees with compact evidence.`);
      assertCompactSourceValue(parsed, `record[${index}].compactJson`);
    }
  });
}

/** Validate the typed financial facts before any transaction starts. */
export function validatePGliteCanonicalFinancialFact(
  fact: PGliteCanonicalFinancialFactInput,
  sourceRoute: PGliteCanonicalSourceEvidence["routeKey"],
): void {
  if (!fact.amount || typeof fact.amount !== "object")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Financial amount is required.");
  requireCanonicalSourceToken(fact.sourceOccurrenceKey, "Financial source occurrence key");
  requireCanonicalSourceText(fact.sourceSequence, "Financial source sequence");
  if (!/^-?(?:0|[1-9]\d*)$/u.test(fact.amount.coefficient))
    throw new PGliteCanonicalSourceAdmissionError(
      "invalid-financial-fact",
      "Financial amount coefficient must be an exact integer.",
    );
  if (!Number.isSafeInteger(fact.amount.scale) || fact.amount.scale < 0)
    throw new PGliteCanonicalSourceAdmissionError(
      "invalid-financial-fact",
      "Financial amount scale must be a non-negative safe integer.",
    );
  if (fact.balanceAfter !== undefined && fact.balanceAfter !== null)
    validateFinancialAmount(fact.balanceAfter, "Financial balance amount");
  if (fact.direction !== "inflow" && fact.direction !== "outflow")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Financial direction is unsupported.");
  if (fact.postingStatus !== "pending" && fact.postingStatus !== "posted")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Financial posting status is unsupported.");
  if (!isAllowedPostingOrigin(fact.postingOrigin))
    throw new PGliteCanonicalSourceAdmissionError("invalid-origin", "Financial posting origin is not an admitted source origin.");
  if (!isAllowedPostingBasis(fact.postingBasis))
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Financial posting basis is unsupported.");
  if (!isAllowedRuleVersion(fact.postingRuleVersion) || !isAllowedRuleVersion(fact.semanticRuleVersion) || !isAllowedRuleVersion(fact.effectiveTimeRuleVersion))
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Financial rule version is unsupported.");
  // A validated source route owns its controlled non-ISO denomination scheme.
  const route = canonicalSourceRouteRegistration(sourceRoute);
  if (!/^[A-Z]{3}$/u.test(fact.currency) &&
      !(route?.nonIsoFinancialDenominations?.includes(fact.currency) &&
        route.contractVersions.includes(fact.postingRuleVersion)))
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Financial currency is not admitted for this source route.");
  requireCanonicalSourceText(fact.effectiveOn, "Financial effective date");
  requireCanonicalSourceText(fact.transactionDateTimeLocal, "Financial local transaction date");
  if (fact.timeZone !== "Asia/Taipei")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Financial time zone is unsupported by the canonical baseline.");
  if (fact.timePrecision !== "date" && fact.timePrecision !== "minute" && fact.timePrecision !== "second")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Financial time precision is unsupported.");
  if (fact.timeOrigin !== "source_reported" && fact.timeOrigin !== "defaulted_local_midnight")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Financial time origin is unsupported.");
  if (fact.effectiveTimeBasis !== "accounting" && fact.effectiveTimeBasis !== "transaction-time" && fact.effectiveTimeBasis !== "source-reported")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Financial effective time basis is unsupported.");
  if (!Number.isSafeInteger(fact.utcInstantUtcUs))
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Financial UTC instant is invalid.");
  if (fact.description !== undefined && fact.description !== null && typeof fact.description !== "string")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Financial description must be text or null.");
  if (fact.economicStatus !== "normal" && fact.economicStatus !== "canceled" && fact.economicStatus !== "refund" && fact.economicStatus !== "reversal")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Financial economic status is unsupported.");
  if (fact.administrativeState !== "active" && fact.administrativeState !== "deleted" && fact.administrativeState !== "purged")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Financial administrative state is unsupported.");
  if (fact.conversionEvidence !== undefined && fact.conversionEvidence !== null)
    validateConversionEvidence(fact.conversionEvidence, fact.amount, fact.currency);
}

function validateFinancialAmount(
  value: Readonly<{ coefficient: string; scale: number }> | null | undefined,
  label: string,
): void {
  if (!value || typeof value !== "object" || typeof value.coefficient !== "string" ||
    !/^-?(?:0|[1-9]\d*)$/u.test(value.coefficient))
    throw new PGliteCanonicalSourceAdmissionError(
      "invalid-financial-fact",
      `${label} coefficient must be an exact integer.`,
    );
  if (!Number.isSafeInteger(value.scale) || value.scale < 0)
    throw new PGliteCanonicalSourceAdmissionError(
      "invalid-financial-fact",
      `${label} scale must be a non-negative safe integer.`,
    );
}

function validateConversionEvidence(
  conversion: PGliteCanonicalConversionEvidenceInput,
  transactionAmount: Readonly<{ coefficient: string; scale: number }>,
  transactionCurrency: string,
): void {
  if (!conversion || typeof conversion !== "object")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Conversion evidence must be an object.");
  if (conversion.originalAmount === undefined || conversion.originalCurrency === undefined ||
    conversion.sourceReportedRate === undefined || conversion.impliedRate === undefined)
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Conversion evidence has missing required fields.");
  validateFinancialAmount(conversion.bookedAmount, "Conversion booked amount");
  if (!/^[A-Z]{3}$/u.test(conversion.bookedCurrency))
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Conversion booked currency is invalid.");
  if (conversion.originalAmount !== null)
    validateFinancialAmount(conversion.originalAmount, "Conversion original amount");
  if (conversion.originalCurrency !== null && !/^[A-Z]{3}$/u.test(conversion.originalCurrency))
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Conversion original currency is invalid.");
  if ((conversion.originalAmount === null) !== (conversion.originalCurrency === null))
    throw new PGliteCanonicalSourceAdmissionError(
      "invalid-financial-fact",
      "Conversion original amount and currency must be present together.",
    );
  if (conversion.feeAmount !== undefined && conversion.feeAmount !== null)
    validateFinancialAmount(conversion.feeAmount, "Conversion fee amount");
  if (conversion.feeCurrency !== undefined && conversion.feeCurrency !== null && !/^[A-Z]{3}$/u.test(conversion.feeCurrency))
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Conversion fee currency is invalid.");
  if ((conversion.feeAmount == null) !== (conversion.feeCurrency == null))
    throw new PGliteCanonicalSourceAdmissionError(
      "invalid-financial-fact",
      "Conversion fee amount and currency must be present together.",
    );
  for (const [label, rate] of [
    ["source-reported", conversion.sourceReportedRate],
    ["implied", conversion.impliedRate],
  ] as const) {
    if (!rate) continue;
    validateFinancialAmount(rate.amount, `${label} conversion rate`);
    if (!/^[A-Z]{3}$/u.test(rate.baseCurrency) || !/^[A-Z]{3}$/u.test(rate.quoteCurrency))
      throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", `${label} conversion currencies are invalid.`);
    if (rate.observedOn !== undefined && rate.observedOn !== null &&
      !/^\d{4}-\d{2}-\d{2}$/u.test(rate.observedOn))
      throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", `${label} conversion date is invalid.`);
  }
  if (conversion.comparison !== "consistent" && conversion.comparison !== "conflicted" && conversion.comparison !== "not-comparable")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Conversion comparison is invalid.");
  if (conversion.bookedAmount.coefficient !== transactionAmount.coefficient ||
    conversion.bookedAmount.scale !== transactionAmount.scale ||
    conversion.bookedCurrency !== transactionCurrency)
    throw new PGliteCanonicalSourceAdmissionError(
      "invalid-financial-fact",
      "Conversion booked amount must match the canonical transaction.",
    );
  if (typeof conversion.evidenceOrigin !== "string" || conversion.evidenceOrigin.trim() === "")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Conversion evidence origin is required.");
}

export type PGliteCanonicalConversionRateInput = Readonly<{
  amount: Readonly<{ coefficient: string; scale: number }>;
  baseCurrency: string;
  quoteCurrency: string;
  observedOn?: string | null;
}>;

export type PGliteCanonicalConversionEvidenceInput = Readonly<{
  originalAmount: Readonly<{ coefficient: string; scale: number }> | null;
  originalCurrency: string | null;
  bookedAmount: Readonly<{ coefficient: string; scale: number }>;
  bookedCurrency: string;
  sourceReportedRate: PGliteCanonicalConversionRateInput | null;
  impliedRate: PGliteCanonicalConversionRateInput | null;
  comparison: "consistent" | "conflicted" | "not-comparable";
  feeAmount?: Readonly<{ coefficient: string; scale: number }> | null;
  feeCurrency?: string | null;
  evidenceOrigin: string;
}>;

export type PGliteCanonicalFinancialFactInput = Readonly<{
  sourceOccurrenceKey: string;
  sourceSequence: string;
  amount: Readonly<{ coefficient: string; scale: number }>;
  /** Source-reported running balance retained with the transaction evidence. */
  balanceAfter?: Readonly<{ coefficient: string; scale: number }> | null;
  currency: string;
  direction: "inflow" | "outflow";
  postingStatus: "pending" | "posted";
  postingOrigin: string;
  postingBasis: string;
  postingRuleVersion: string;
  description?: string | null;
  economicStatus: "normal" | "canceled" | "refund" | "reversal";
  administrativeState: "active" | "deleted" | "purged";
  semanticRuleVersion: string;
  effectiveOn: string;
  transactionDateTimeLocal: string;
  timeZone: "Asia/Taipei";
  timePrecision: "date" | "minute" | "second";
  timeOrigin: "source_reported" | "defaulted_local_midnight";
  effectiveTimeBasis: "accounting" | "transaction-time" | "source-reported";
  effectiveTimeRuleVersion: string;
  utcInstantUtcUs: number;
  /** Foreign-currency conversion evidence from the same provider row. */
  conversionEvidence?: PGliteCanonicalConversionEvidenceInput | null;
}>;

/**
 * Optional provider-reported balance evidence carried by a typed deposit
 * command.  It lives beside the generic source-admission types so the
 * worker can persist the observation in the same transaction as the source
 * capture and financial facts.
 */
export type PGliteCanonicalBalanceObservationInput = Readonly<{
  observationKey: string;
  balanceKind:
    | "loan_outstanding"
    | "outstanding_principal"
    | "outstanding_total"
    | "ledger"
    | "available"
    | "credit_used";
  balance: Readonly<{ coefficient: string; scale: number }>;
  currency: string;
  effectiveAt: string;
  effectiveTimeBasis:
    | "source-reported"
    | "provider-http-date"
    | "provider-system-time"
    | "provider-query-time";
  effectiveTimeRuleVersion: string;
  evidenceSourceRecordKey: string;
  evidenceSourceField: string;
  evidenceSourceValue: string;
  evidenceContractVersion: string;
  /** The source occurrence that contains the provider balance field. */
  sourceOccurrenceKey: string;
  evidenceEndpoint?: string;
  evidenceResponseStatus?: 200;
  evidenceCachePolicy?: string;
}>;

export type PGliteCanonicalAccountIdentifierInput = Readonly<{
  value: string;
  kind:
    | "depository-account"
    | "loan-account"
    | "brokerage-account"
    | "credit-portfolio-account"
    | "platform-account";
  evidenceVersion: string;
  sourceField: string;
}>;

export function validatePGliteCanonicalBalanceObservation(
  observation: PGliteCanonicalBalanceObservationInput,
): void {
  requireCanonicalSourceText(observation.observationKey, "Balance observation key");
  requireCanonicalSourceToken(observation.sourceOccurrenceKey, "Balance source occurrence key");
  if (!observation.balance || typeof observation.balance !== "object")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Balance amount is required.");
  if (!/^-?(?:0|[1-9]\d*)$/u.test(observation.balance.coefficient))
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Balance coefficient must be an exact integer.");
  if (!Number.isSafeInteger(observation.balance.scale) || observation.balance.scale < 0)
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Balance scale is invalid.");
  if (!/^[A-Z]{3}$/u.test(observation.currency))
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Balance currency must be an ISO-like uppercase code.");
  if (!Number.isFinite(Date.parse(observation.effectiveAt)))
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Balance effective time must be RFC3339.");
  if (!requireCanonicalSourceText(observation.effectiveTimeRuleVersion, "Balance effective-time rule version"))
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Balance effective-time rule version is required.");
  requireCanonicalSourceText(observation.evidenceSourceRecordKey, "Balance evidence source record key");
  requireCanonicalSourceText(observation.evidenceSourceField, "Balance evidence source field");
  requireCanonicalSourceText(observation.evidenceSourceValue, "Balance evidence source value");
  requireCanonicalSourceText(observation.evidenceContractVersion, "Balance evidence contract version");
  if (observation.evidenceEndpoint !== undefined)
    requireCanonicalSourceText(observation.evidenceEndpoint, "Balance evidence endpoint");
  if (observation.evidenceCachePolicy !== undefined)
    requireCanonicalSourceText(observation.evidenceCachePolicy, "Balance evidence cache policy");
  if (observation.evidenceResponseStatus !== undefined && observation.evidenceResponseStatus !== 200)
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Balance evidence response status must be 200.");
}

function isAllowedPostingOrigin(value: string): boolean {
  return value === "provider_booked_history" || value === "human_attested_history" || value === "human-attested" || /^synthetic_/u.test(value);
}

function isAllowedPostingBasis(value: string): boolean {
  return value === "query-status-success-with-accounting-date" || value === "human-attested-formally-posted" || value === "statement-posted-history" || /^synthetic_/u.test(value);
}

function isAllowedRuleVersion(value: string): boolean {
  return value.length > 0 && (
    /^synthetic-/u.test(value) ||
    /^foreign-currency\//u.test(value) ||
    /^fubon\/(credit-card|loan)\//u.test(value) ||
    /^yuanta\/(loan)\//u.test(value) ||
    /^esun\/credit-card\//u.test(value) ||
    /\/investment\//u.test(value) ||
    /^(cathay|linebank|fubon|yuanta|hncb|ctbc|sinopac|post)\//u.test(value)
  );
}

export type PGliteCanonicalFinancialAccountInput = Readonly<{
  sourceAccountKey: string;
  accountNo?: string | null;
  accountType: "depository" | "credit" | "loan" | "investment" | "other";
  currency: string | null;
}>;

export function validatePGliteCanonicalFinancialAccount(
  account: PGliteCanonicalFinancialAccountInput,
  evidence: PGliteCanonicalSourceEvidence,
): void {
  if (![
    "depository",
    "credit",
    "loan",
    "investment",
    "other",
  ].includes(account.accountType))
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Financial account type is unsupported.");
  requireCanonicalSourceText(account.sourceAccountKey, "Financial source account key");
  const evidenceKey = evidence.scope.sourceAccountKey ?? evidence.scope.accountNo;
  if (evidenceKey !== account.sourceAccountKey)
    throw new PGliteCanonicalSourceAdmissionError(
      "invalid-financial-fact",
      "Financial source account key must match the explicitly admitted source account key.",
    );
  if (account.accountNo !== undefined && account.accountNo !== null)
    requireCanonicalSourceText(account.accountNo, "Financial account number");
  if (account.accountNo !== undefined && account.accountNo !== null &&
    (!evidence.accountNumber || evidence.accountNumber.value !== account.accountNo))
    throw new PGliteCanonicalSourceAdmissionError(
      "invalid-financial-fact",
      "Financial account number must match provider-supported account-number evidence.",
    );
  if (account.currency !== null && !/^[A-Z]{3}$/u.test(account.currency))
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Financial account currency is invalid.");
}

/** Canonicalize a persisted record payload for recurrence comparison. */
export function canonicalSourceRecordJson(record: CanonicalSourceRecord): string {
  // Preserve the adapter's exact compact JSON when supplied. Recurrence
  // comparison canonicalizes parsed JSON separately, so evidence storage does
  // not rewrite provider bytes after validation.
  return record.compactJson ?? stableCanonicalSourceJson(record.compact);
}

export function classifyPGliteCanonicalAdmissionError(error: unknown): PGliteCanonicalSourceAdmissionError {
  if (error instanceof PGliteCanonicalSourceAdmissionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/capture overwrite|capture key|duplicate key.*capture/iu.test(message))
    return new PGliteCanonicalSourceAdmissionError("capture-overwrite", message, { cause: error });
  if (/collision|occurrence|content overwrite|identity.*conflict|route.*bound/iu.test(message))
    return new PGliteCanonicalSourceAdmissionError("occurrence-conflict", message, { cause: error });
  if (/authority route|contract drift|not registered/iu.test(message))
    return new PGliteCanonicalSourceAdmissionError("authority-route-drift", message, { cause: error });
  if (/cancel/iu.test(message))
    return new PGliteCanonicalSourceAdmissionError("cancelled", message, { cause: error });
  if (/financial|posting|origin|currency|amount|direction|time zone|rule version|account/iu.test(message))
    return new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", message, { cause: error });
  if (/source|scope|page|opaque token|RFC3339|compact|account key/iu.test(message))
    return new PGliteCanonicalSourceAdmissionError("invalid-evidence", message, { cause: error });
  return new PGliteCanonicalSourceAdmissionError("infrastructure", "Canonical PGlite admission failed.", { cause: error });
}

export function assertPGliteCanonicalRoute(evidence: PGliteCanonicalSourceEvidence): void {
  routeError(evidence);
}
