import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCaptureBatch,
  type CanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositCommitResult,
  type CanonicalFinancialDepositConversionEvidence,
  type CanonicalFinancialDepositRate,
  type CanonicalFinancialDepositRecord,
  type CanonicalFinancialDepositValidatedCapture,
  type FinancialDepositAmount,
  type FinancialDepositSourceTime,
  type CanonicalFinancialDepositWriterStore,
} from "./canonical-financial-deposit-writer.ts";

export const FOREIGN_CURRENCY_DEPOSIT_STREAM = "foreign-currency-deposit" as const;
export const FOREIGN_CURRENCY_DEPOSIT_TIME_ZONE = "Asia/Taipei" as const;
/** A foreign-currency account has no single denomination.  Its currency is
 * therefore intentionally nullable; each admitted transaction still carries
 * a required source-proven currency. */
export const FOREIGN_CURRENCY_DEPOSIT_ACCOUNT_CURRENCY = null;

export const FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS = [
  "yuanta",
  "cathay",
  "sinopac",
  "linebank",
] as const;
export type ForeignCurrencyDepositSourceId =
  (typeof FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS)[number];

type ForeignCurrencyContract = {
  sourceId: ForeignCurrencyDepositSourceId;
  authorityRoute: string;
  contractVersion: string;
  recordKind: string;
  workflow: string;
};

export const FOREIGN_CURRENCY_DEPOSIT_CONTRACTS: Readonly<
  Record<ForeignCurrencyDepositSourceId, ForeignCurrencyContract>
> = {
  yuanta: {
    sourceId: "yuanta",
    authorityRoute: "yuanta/foreign-currency/deposit/v1",
    contractVersion: "foreign-currency/yuanta/v1",
    recordKind: "yuanta-foreign-currency-deposit",
    workflow: "yuantaForeignCurrencyStatements",
  },
  cathay: {
    sourceId: "cathay",
    authorityRoute: "cathay/foreign-currency/deposit/v1",
    contractVersion: "foreign-currency/cathay/v1",
    recordKind: "cathay-foreign-currency-deposit",
    workflow: "cathayForeignStatements",
  },
  sinopac: {
    sourceId: "sinopac",
    authorityRoute: "sinopac/foreign-currency/deposit/v1",
    contractVersion: "foreign-currency/sinopac/v1",
    recordKind: "sinopac-foreign-currency-deposit",
    workflow: "sinopacStatements",
  },
  linebank: {
    sourceId: "linebank",
    authorityRoute: "linebank/foreign-currency/deposit/v1",
    contractVersion: "foreign-currency/linebank/v1",
    recordKind: "linebank-foreign-currency-deposit",
    workflow: "linebankStatements",
  },
};

/** Versioned contract fixtures deliberately prove the boundary fields that
 * readiness reports. They are source-shape metadata, not financial facts. */
export const FOREIGN_CURRENCY_DEPOSIT_CONTRACT_FIXTURES =
  FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS.map((sourceId) => ({
    ...FOREIGN_CURRENCY_DEPOSIT_CONTRACTS[sourceId],
    fixtureEvidence: "canonical-versioned-synthetic" as const,
    accountBoundary: "source-proven-account" as const,
    currencyScope: "row-or-typed-scope" as const,
    amountDirection: "source-proven-debit-credit" as const,
    timePrecision: "source-preserved-date-minute-second" as const,
    completeness: "terminal-complete-range" as const,
  }));

export type ForeignCurrencyCurrencyEvidence = {
  kind: "row" | "scope" | "contract";
  currency: string;
};

export type ForeignCurrencySourceTimeInput = {
  localDate: string;
  localTime?: string;
  timeZone?: string;
  precision?: "date" | "minute" | "second";
  timeOrigin?: "source_reported" | "defaulted_local_midnight";
};

export type ForeignCurrencyRateInput = {
  rate: string | FinancialDepositAmount;
  baseCurrency: string;
  quoteCurrency: string;
  observedOn?: string | null;
};

export type ForeignCurrencyOriginalAmountInput = {
  amount: string | FinancialDepositAmount;
  currency: string;
};

export type ForeignCurrencyDepositRecordInput = {
  /** Stable provider key; row ordinals alone are not accepted as identity. */
  sourceKey: string;
  sequence?: string;
  amount: string | FinancialDepositAmount;
  direction: "inflow" | "outflow";
  currencyEvidence: ForeignCurrencyCurrencyEvidence;
  balanceAfter: string | FinancialDepositAmount;
  sourceTime: ForeignCurrencySourceTimeInput;
  originalAmount?: ForeignCurrencyOriginalAmountInput | null;
  sourceReportedRate?: ForeignCurrencyRateInput | null;
  feeAmount?: { amount: string | FinancialDepositAmount; currency: string } | null;
  description?: string | null;
  sourcePayload?: Record<string, unknown>;
};

export type ForeignCurrencyDepositCaptureInput = {
  source: ForeignCurrencyDepositSourceId;
  accountNo: string;
  sourceConnectionKey: string;
  identityEpochKey: string;
  observedAt: string;
  startDate: string;
  endDate: string;
  /** A source terminal response is required; absence is not inferred. */
  completeness: "complete-range";
  records: readonly ForeignCurrencyDepositRecordInput[];
  /** Explicit run/observation identity. Content hashes are not Capture identity. */
  captureOccurrenceId: string;
  /** Empty results are admissible only when the terminal source response says no data. */
  zeroResultAuthority?: "provider-explicit-no-data";
  captureId?: string;
  accountType: string;
  /** Accepted for provenance only; it is never used to fill row currency. */
  accountDefaultCurrency?: string;
};

export type ForeignCurrencyDepositAdmittedCapture =
  CanonicalFinancialDepositValidatedCapture;

export type ForeignCurrencyDepositCommitStore = CanonicalFinancialDepositWriterStore;

export type ForeignCurrencyConversionQuery = {
  originalAmount: FinancialDepositAmount | null;
  originalCurrency: string | null;
  bookedAmount: FinancialDepositAmount;
  bookedCurrency: string;
  sourceReportedRate: CanonicalFinancialDepositRate | null;
  impliedRate: CanonicalFinancialDepositRate | null;
  comparison: "consistent" | "conflicted" | "not-comparable";
  feeAmount: FinancialDepositAmount | null;
  feeCurrency: string | null;
  evidenceOrigin: string;
};

export type ForeignCurrencyTransaction = {
  id: string;
  accountId: string;
  accountNo: string;
  sourceSequence: string;
  amount: FinancialDepositAmount;
  bookedAmount: FinancialDepositAmount;
  currency: string;
  direction: "inflow" | "outflow";
  originalAmount: FinancialDepositAmount | null;
  originalCurrency: string | null;
  conversion: ForeignCurrencyConversionQuery | null;
  effectiveOn: string;
  transactionDateTimeLocal: string;
  timeZone: string;
  timePrecision: "date" | "minute" | "second";
  timeOrigin: "source_reported" | "defaulted_local_midnight";
  utcInstantUtcUs: number;
  description: string | null;
  authorityRoute: string;
  captureId: string;
  sourceRecordId: string;
  revisionId: string;
  commitSequence: number;
  supportState: "supported" | "withdrawn";
  assertion?: ForeignCurrencyAssertionLineage | null;
  sourceRecord?: ForeignCurrencySourceRecord | null;
  lifecycleEvents?: ForeignCurrencyLifecycleEvent[];
  provenance?: ForeignCurrencyProvenance[];
};

export type ForeignCurrencyAssertionLineage = {
  id: string;
  revisionId: string;
  origin: "source";
  producerId: string;
  ruleLineage: string;
  commitSequence: number;
};

export type ForeignCurrencyScopeProof = {
  id: string;
  accountId: string;
  accountNo: string;
  stream: string;
  scopeStart: string;
  scopeEnd: string;
  completeness: string;
  contractFingerprint: string;
  preflightFingerprint: string;
};

export type ForeignCurrencySourceRecord = {
  id: string;
  captureId: string;
  sequence: string;
  description: string | null;
  payloadJson: string;
  /** Short alias used by the lineage contract; both fields carry the same
   * compact, non-replay payload. */
  payload: string;
  scopeProof: ForeignCurrencyScopeProof | null;
};

export type ForeignCurrencyLifecycleEvent = {
  id: string;
  kind: "observed" | "withdrawn" | "restored" | "superseded";
  commitSequence: number;
  scopeProof: Pick<
    ForeignCurrencyScopeProof,
    "id" | "completeness" | "contractFingerprint" | "preflightFingerprint"
  > | null;
};

export type ForeignCurrencyProvenance = {
  sourceRecordId: string;
  captureId: string | null;
  commitSequence: number;
};

export type ForeignCurrencyQueryResult = {
  status: "canonical-live";
  transactions: ForeignCurrencyTransaction[];
  /** Alias used by source-store query consumers. */
  records: ForeignCurrencyTransaction[];
  provenanceCount: number;
};

type Exact = FinancialDepositAmount & { value: bigint };

function normalizeExactParts(
  coefficient: string,
  scale: number,
): { coefficient: string; scale: number } {
  let normalizedCoefficient = coefficient.replace(/^0+(?=\d)/, "") || "0";
  let normalizedScale = scale;
  while (normalizedScale > 0 && normalizedCoefficient.endsWith("0")) {
    normalizedCoefficient = normalizedCoefficient.slice(0, -1) || "0";
    normalizedScale -= 1;
  }
  return { coefficient: normalizedCoefficient, scale: normalizedScale };
}

function exact(value: string | FinancialDepositAmount, label: string): Exact {
  if (typeof value === "number")
    throw new Error(`${label} must remain an exact decimal string.`);
  if (typeof value === "string") {
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
      throw new Error(`${label} must be a non-negative exact decimal.`);
    const [whole, fraction = ""] = value.split(".");
    const normalized = normalizeExactParts(`${whole}${fraction}`, fraction.length);
    return {
      ...normalized,
      value: BigInt(normalized.coefficient),
    };
  }
  if (
    !value ||
    typeof value.coefficient !== "string" ||
    !/^(?:0|[1-9]\d*)$/.test(value.coefficient) ||
    !Number.isSafeInteger(value.scale) ||
    value.scale < 0
  )
    throw new Error(`${label} must be an exact coefficient/scale amount.`);
  const normalized = normalizeExactParts(value.coefficient, value.scale);
  return { ...normalized, value: BigInt(normalized.coefficient) };
}

const ISO_4217_CURRENCY_CODES = new Set([
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BOV",
  "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF",
  "CHW", "CLF", "CLP", "CNY", "COP", "COU", "CRC", "CUC", "CUP", "CVE",
  "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD",
  "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD",
  "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD",
  "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD",
  "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA",
  "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV",
  "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB",
  "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB",
  "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SLL",
  "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT",
  "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "USN",
  "UYI", "UYU", "UYW", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAF",
  "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XCD", "XDR", "XOF", "XPD",
  "XPF", "XPT", "XSU", "XTS", "XUA", "XXX", "YER", "ZAR", "ZMW", "ZWL",
]);

function currency(value: string, label: string): string {
  if (!/^[A-Z]{3}$/.test(value) || !ISO_4217_CURRENCY_CODES.has(value))
    throw new Error(`${label} must be a valid ISO 4217 currency code.`);
  return value;
}

function token(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("base64url")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    typeof nested === "bigint" ? nested.toString() : nested,
  );
}

function date(value: string, label: string): string {
  const normalized = value.replaceAll("/", "-");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized))
    throw new Error(`${label} must be YYYY-MM-DD.`);
  const check = new Date(`${normalized}T00:00:00Z`);
  if (
    Number.isNaN(check.getTime()) ||
    check.toISOString().slice(0, 10) !== normalized
  )
    throw new Error(`${label} must be a valid calendar date.`);
  return normalized;
}

function localTime(value: string | undefined): {
  value: string;
  precision: "date" | "minute" | "second";
} {
  if (value === undefined || value === "")
    return { value: "00:00:00", precision: "date" };
  if (/^\d{2}:\d{2}$/.test(value)) {
    const [hour, minute] = value.split(":").map(Number);
    if (hour > 23 || minute > 59) throw new Error("Invalid minute time.");
    return { value: `${value}:00`, precision: "minute" };
  }
  if (!/^\d{2}:\d{2}:\d{2}$/.test(value))
    throw new Error("Source time must be HH:mm or HH:mm:ss.");
  const [hour, minute, second] = value.split(":").map(Number);
  if (hour > 23 || minute > 59 || second > 59)
    throw new Error("Invalid second time.");
  return { value, precision: "second" };
}

function normalizeSourceTime(input: ForeignCurrencySourceTimeInput): {
  sourceTime: FinancialDepositSourceTime;
  transactionDateTimeLocal: string;
} {
  const localDate = date(input.localDate, "Source date");
  const parsed = localTime(input.localTime);
  const precision = input.precision ?? parsed.precision;
  if (precision !== parsed.precision && !(precision === "date" && parsed.precision === "date"))
    throw new Error("Source time precision does not match the observed value.");
  const zone = input.timeZone ?? FOREIGN_CURRENCY_DEPOSIT_TIME_ZONE;
  if (zone !== FOREIGN_CURRENCY_DEPOSIT_TIME_ZONE)
    throw new Error("Foreign-currency source time must be Asia/Taipei.");
  const origin = input.timeOrigin ?? (precision === "date" ? "defaulted_local_midnight" : "source_reported");
  if (precision !== "date" && origin === "defaulted_local_midnight")
    throw new Error("Only date precision may default to local midnight.");
  const epochMilliseconds = Date.parse(`${localDate}T${parsed.value}+08:00`);
  if (!Number.isSafeInteger(epochMilliseconds))
    throw new Error("Source time is outside the supported instant range.");
  return {
    sourceTime: {
      localDate,
      localTime: parsed.value,
      timeZone: zone,
      epochMilliseconds,
      precision,
      timeOrigin: origin,
    },
    transactionDateTimeLocal: `${localDate}T${parsed.value}`,
  };
}

function gcd(a: bigint, b: bigint): bigint {
  let left = a < 0n ? -a : a;
  let right = b < 0n ? -b : b;
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}

function divideToTerminatingDecimal(numerator: Exact, denominator: Exact): FinancialDepositAmount | null {
  if (denominator.value === 0n) return null;
  let numeratorValue = numerator.value * 10n ** BigInt(denominator.scale);
  let denominatorValue = denominator.value * 10n ** BigInt(numerator.scale);
  const divisor = gcd(numeratorValue, denominatorValue);
  numeratorValue /= divisor;
  denominatorValue /= divisor;
  let twos = 0;
  let fives = 0;
  while (denominatorValue % 2n === 0n) {
    denominatorValue /= 2n;
    twos += 1;
  }
  while (denominatorValue % 5n === 0n) {
    denominatorValue /= 5n;
    fives += 1;
  }
  if (denominatorValue !== 1n) return null;
  const scale = Math.max(twos, fives);
  const coefficient = numeratorValue * 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives);
  const text = coefficient.toString().replace(/0+$/, "") || "0";
  return { coefficient: text, scale: Math.max(0, scale - (coefficient.toString().length - text.length)) };
}

function rate(value: ForeignCurrencyRateInput): CanonicalFinancialDepositRate {
  const parsed = exact(value.rate, "Source-reported rate");
  return {
    amount: { coefficient: parsed.coefficient, scale: parsed.scale },
    baseCurrency: currency(value.baseCurrency, "Rate base currency"),
    quoteCurrency: currency(value.quoteCurrency, "Rate quote currency"),
    observedOn: value.observedOn == null ? null : date(value.observedOn, "Rate date"),
  };
}

function sameRate(left: CanonicalFinancialDepositRate, right: CanonicalFinancialDepositRate): boolean {
  return (
    left.baseCurrency === right.baseCurrency &&
    left.quoteCurrency === right.quoteCurrency &&
    BigInt(left.amount.coefficient) * 10n ** BigInt(right.amount.scale) ===
      BigInt(right.amount.coefficient) * 10n ** BigInt(left.amount.scale)
  );
}

function buildConversionEvidence(
  input: ForeignCurrencyDepositRecordInput,
  booked: Exact,
  bookedCurrency: string,
): CanonicalFinancialDepositConversionEvidence {
  const original = input.originalAmount
    ? exact(input.originalAmount.amount, "Original amount")
    : null;
  const originalCurrency = input.originalAmount
    ? currency(input.originalAmount.currency, "Original currency")
    : null;
  const sourceReportedRate = input.sourceReportedRate
    ? rate(input.sourceReportedRate)
    : null;
  const impliedAmount =
    original && originalCurrency !== bookedCurrency
      ? divideToTerminatingDecimal(booked, original)
      : null;
  const impliedRate =
    impliedAmount && originalCurrency
      ? {
          amount: impliedAmount,
          baseCurrency: originalCurrency,
          quoteCurrency: bookedCurrency,
          observedOn: null,
        }
      : null;
  let comparison: CanonicalFinancialDepositConversionEvidence["comparison"] =
    "not-comparable";
  if (sourceReportedRate && impliedRate)
    comparison = sameRate(sourceReportedRate, impliedRate)
      ? "consistent"
      : "conflicted";
  const fee = input.feeAmount
    ? exact(input.feeAmount.amount, "Fee amount")
    : null;
  return {
    originalAmount: original
      ? { coefficient: original.coefficient, scale: original.scale }
      : null,
    originalCurrency,
    bookedAmount: { coefficient: booked.coefficient, scale: booked.scale },
    bookedCurrency,
    sourceReportedRate,
    impliedRate,
    comparison,
    feeAmount: fee
      ? { coefficient: fee.coefficient, scale: fee.scale }
      : null,
    feeCurrency: input.feeAmount
      ? currency(input.feeAmount.currency, "Fee currency")
      : null,
    evidenceOrigin: "source-row-conversion-evidence-v1",
  };
}

function buildRecord(
  input: ForeignCurrencyDepositRecordInput,
  contract: ForeignCurrencyContract,
): CanonicalFinancialDepositRecord {
  if (!input.sourceKey.trim()) throw new Error("Foreign source key is required.");
  if (
    input.currencyEvidence.kind !== "row" &&
    input.currencyEvidence.kind !== "scope" &&
    input.currencyEvidence.kind !== "contract"
  )
    throw new Error("Transaction currency evidence must be row, scope, or contract.");
  const booked = exact(input.amount, "Booked amount");
  const balance = exact(input.balanceAfter, "Balance amount");
  const rowCurrency = currency(input.currencyEvidence.currency, "Transaction currency");
  const sourceTime = normalizeSourceTime(input.sourceTime);
  const payload = {
    sourceKey: input.sourceKey,
    sequence: input.sequence ?? input.sourceKey,
    amount: { coefficient: booked.coefficient, scale: booked.scale },
    balanceAfter: { coefficient: balance.coefficient, scale: balance.scale },
    currency: rowCurrency,
    currencyEvidence: input.currencyEvidence,
    sourceTime,
    originalAmount: input.originalAmount ?? null,
    sourceReportedRate: input.sourceReportedRate ?? null,
    feeAmount: input.feeAmount ?? null,
    description: input.description ?? null,
    sourcePayload: input.sourcePayload ?? null,
  };
  const payloadJson = canonicalJson(payload);
  const occurrenceKey = token(`${contract.sourceId}:occurrence:${input.sourceKey}`);
  const collisionKey = token(`${contract.sourceId}:collision:${input.sourceKey}`);
  const providerKey = token(`${contract.sourceId}:provider:${input.sourceKey}`);
  const contentHash = token(payloadJson);
  return {
    occurrenceKey,
    collisionKey,
    providerKey,
    contentHash,
    sequenceLexeme: input.sequence ?? input.sourceKey,
    compactJson: payloadJson,
    amount: { coefficient: booked.coefficient, scale: booked.scale },
    balanceAfter: { coefficient: balance.coefficient, scale: balance.scale },
    currency: rowCurrency,
    direction: input.direction,
    sourceTime: sourceTime.sourceTime,
    effectiveOn: sourceTime.sourceTime.localDate,
    transactionDateTimeLocal: sourceTime.transactionDateTimeLocal,
    description: input.description ?? null,
    conversionEvidence: buildConversionEvidence(input, booked, rowCurrency),
  };
}

export function createForeignCurrencyDepositCapture(
  input: ForeignCurrencyDepositCaptureInput,
): CanonicalFinancialDepositCapture {
  const contract = FOREIGN_CURRENCY_DEPOSIT_CONTRACTS[input.source];
  if (!contract) throw new Error("Unsupported foreign-currency source.");
  const accountNo = input.accountNo.trim();
  if (!accountNo) throw new Error("Source-proven account number is required.");
  if (typeof input.identityEpochKey !== "string" || !input.identityEpochKey.trim())
    throw new Error("Source identity epoch key is required.");
  if (
    typeof input.captureOccurrenceId !== "string" ||
    !input.captureOccurrenceId.trim()
  )
    throw new Error("Foreign capture occurrence identity is required.");
  if (typeof input.accountType !== "string" || !input.accountType.trim())
    throw new Error("Source account type is required.");
  if (input.accountType !== "depository")
    throw new Error("Foreign-currency deposit account type must be depository.");
  if (input.completeness !== "complete-range")
    throw new Error("Foreign capture requires a terminal complete-range proof.");
  if (
    input.records.length === 0 &&
    input.zeroResultAuthority !== "provider-explicit-no-data"
  )
    throw new Error(
      "Empty foreign capture requires provider-explicit-no-data terminal evidence.",
    );
  const startDate = date(input.startDate, "Capture start date");
  const endDate = date(input.endDate, "Capture end date");
  if (startDate > endDate) throw new Error("Capture scope is inverted.");
  const records = input.records.map((record) => buildRecord(record, contract));
  if (
    records.some(
      (record) => record.effectiveOn < startDate || record.effectiveOn > endDate,
    )
  )
    throw new Error("Foreign source row falls outside the complete capture scope.");
  const scopeFingerprint = token(
    `${contract.contractVersion}:${accountNo}:${startDate}:${endDate}`,
  );
  const responseDigest = token(records.map((record) => record.contentHash).join("|"));
  const first = records[0]?.sourceTime ?? {
    localDate: startDate,
    localTime: "00:00:00",
    timeZone: FOREIGN_CURRENCY_DEPOSIT_TIME_ZONE,
    epochMilliseconds: Date.parse(`${startDate}T00:00:00+08:00`),
    precision: "date" as const,
    timeOrigin: "defaulted_local_midnight" as const,
  };
  const captureId =
    input.captureId ??
    `foreign-${contract.sourceId}-${token(
      `${input.sourceConnectionKey}:${input.identityEpochKey}:${input.captureOccurrenceId.trim()}:${accountNo}:${startDate}:${endDate}`,
    ).slice("sha256:".length)}`;
  return {
    captureId,
    authorityRoute: contract.authorityRoute,
    contractVersion: contract.contractVersion,
    identity: {
      integrationNamespace: contract.sourceId,
      sourceConnectionKey: token(input.sourceConnectionKey),
      identityEpochKey: token(input.identityEpochKey),
      stream: FOREIGN_CURRENCY_DEPOSIT_STREAM,
      recordKind: contract.recordKind,
      subjectDigest: token(`${accountNo}:${contract.recordKind}`),
      accountNo,
      accountType: input.accountType,
      // There is no account-level currency for this multi-currency stream.
      currency: FOREIGN_CURRENCY_DEPOSIT_ACCOUNT_CURRENCY,
    },
    observedAt: input.observedAt,
    scope: {
      startDate,
      endDate,
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "foreign-currency-terminal-complete-range",
      completenessRuleVersion: contract.contractVersion,
      absenceAuthority: "provider-explicit-no-data",
      contractFingerprint: scopeFingerprint,
      preflightFingerprint: token(`${scopeFingerprint}:preflight`),
      pageCount: 1,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "provider_booked_history",
      postingBasis: "statement-posted-history",
      postingRuleVersion: contract.contractVersion,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: contract.contractVersion,
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: contract.contractVersion,
      timeZone: FOREIGN_CURRENCY_DEPOSIT_TIME_ZONE,
      timePrecision: first.precision ?? "second",
      timeOrigin: first.timeOrigin ?? "source_reported",
      requireBalance: true,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: records.length,
        responseDigest,
        proofKind: "foreign-currency-terminal-statement",
        contractFingerprint: scopeFingerprint,
        preflightFingerprint: token(`${scopeFingerprint}:preflight`),
        metadataJson: canonicalJson({
          source: contract.sourceId,
          accountNo,
          startDate,
          endDate,
          currencyScope: "row-or-typed-scope",
          completeness: "complete-range",
        }),
      },
    ],
    records,
  };
}

export function admitForeignCurrencyDepositCapture(
  input: ForeignCurrencyDepositCaptureInput | CanonicalFinancialDepositCapture,
): ForeignCurrencyDepositAdmittedCapture {
  const capture =
    "source" in input && "records" in input &&
    input.source !== undefined
      ? createForeignCurrencyDepositCapture(input as ForeignCurrencyDepositCaptureInput)
      : (input as CanonicalFinancialDepositCapture);
  return admitCanonicalFinancialDepositCapture(capture);
}

export async function commitForeignCurrencyDepositCapture(
  store: ForeignCurrencyDepositCommitStore,
  capture: ForeignCurrencyDepositCaptureInput | ForeignCurrencyDepositAdmittedCapture,
): Promise<CanonicalFinancialDepositCommitResult> {
  const admitted =
    "source" in capture
      ? admitForeignCurrencyDepositCapture(capture as ForeignCurrencyDepositCaptureInput)
      : (capture as ForeignCurrencyDepositAdmittedCapture);
  return commitCanonicalFinancialDepositCapture(store, admitted);
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
  return commitCanonicalFinancialDepositCaptureBatch(store, admitted);
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
    accountNo: String(row.account_no),
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
          scope.account_no, scope.stream, scope.scope_start, scope.scope_end,
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
                accountNo: String(sourceRecordRow.account_no),
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
  const currentJoin = options.includeCurrent
    ? `JOIN current_transactions current_row ON current_row.transaction_id = transaction_row.transaction_id
         AND current_row.revision_id = revision.revision_id`
    : "";
  const rows = db
    .prepare(
      `SELECT
         transaction_row.transaction_id,
         account_row.account_id,
         account_row.account_no,
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
       ${currentJoin}
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
      FOREIGN_CURRENCY_DEPOSIT_STREAM,
      ...params,
    ) as Array<Record<string, unknown>>;
  return rows.map((row) =>
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
    predicates.push("account_row.account_no = ?");
    params.push(options.accountNo);
  }
  if (options.currency !== undefined) {
    predicates.push("revision.currency = ?");
    params.push(currency(options.currency, "Query currency"));
  }
  const transactions = queryRows(store.db, predicates.join(" AND "), params, {
    includeCurrent: true,
  });
  return {
    status: "canonical-live",
    transactions,
    records: transactions,
    provenanceCount: transactions.length,
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
    predicates.push("account_row.account_no = ?");
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
    provenanceCount: transactions.length,
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
    predicates.push("account_row.account_no = ?");
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
