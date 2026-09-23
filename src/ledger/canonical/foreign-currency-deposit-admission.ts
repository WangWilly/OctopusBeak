import { createHash } from "node:crypto";
import {
  admitCanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositConversionEvidence,
  type CanonicalFinancialDepositRate,
  type CanonicalFinancialDepositRecord,
  type CanonicalFinancialDepositValidatedCapture,
  type FinancialDepositAmount,
  type FinancialDepositSourceTime,
} from "./canonical-financial-deposit-admission.ts";
import type { CanonicalFinancialDepositWriterStore } from "./canonical-financial-deposit-writer.ts";
import { FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_METADATA } from "./foreign-currency-deposit-authorities.ts";
import {
  validateCanonicalSourceAccountNumber,
  type CanonicalSourceAccountNumber,
} from "./canonical-source-evidence.ts";
export const FOREIGN_CURRENCY_DEPOSIT_STREAM = "foreign-currency-deposit" as const;
export const FOREIGN_CURRENCY_DEPOSIT_TIME_ZONE = "Asia/Taipei" as const;
/** A foreign-currency account has no single denomination.  Its currency is
 * therefore intentionally nullable; each admitted transaction still carries
 * a required source-proven currency. */
export const FOREIGN_CURRENCY_DEPOSIT_ACCOUNT_CURRENCY = null;

/** Sources currently advertised for canonical foreign-currency Financial
 * Transactions. SinoPac uses an explicitly human-attested composite identity;
 * it is never represented as a provider-guaranteed transaction identifier. */
export const FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS = [
  "yuanta",
  "cathay",
  "linebank",
  "sinopac",
] as const;
export type ForeignCurrencyDepositSourceId =
  (typeof FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS)[number];

type ForeignCurrencyContract = {
  sourceId: ForeignCurrencyDepositSourceId;
  authorityRoute: string;
  contractVersion: string;
  recordKind: string;
  postingOrigin: string;
  workflow: string;
};

export const FOREIGN_CURRENCY_DEPOSIT_CONTRACTS: Readonly<
  Record<ForeignCurrencyDepositSourceId, ForeignCurrencyContract>
> = {
  yuanta: {
    ...FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_METADATA.yuanta,
    sourceId: "yuanta",
    workflow: "yuantaForeignCurrencyStatements",
  },
  cathay: {
    ...FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_METADATA.cathay,
    sourceId: "cathay",
    workflow: "cathayForeignStatements",
  },
  linebank: {
    ...FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_METADATA.linebank,
    sourceId: "linebank",
    workflow: "linebankStatements",
  },
  sinopac: {
    ...FOREIGN_CURRENCY_DEPOSIT_AUTHORITY_METADATA.sinopac,
    sourceId: "sinopac",
    workflow: "sinopacStatements",
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
  /** Explicit provider account-number evidence; accountNo remains the source key. */
  accountNumber?: CanonicalSourceAccountNumber | null;
  sourceConnectionKey: string;
  identityEpochKey: string;
  observedAt: string;
  startDate: string;
  endDate: string;
  /** A source terminal response is required; absence is not inferred. */
  completeness: "complete-range";
  /** Typed denomination boundary for this provider request. */
  captureCurrencyScope:
    | { kind: "currency"; currency: string }
    | { kind: "multi-currency" };
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
  /** Provider account number when explicitly evidenced; otherwise null. */
  accountNo: string | null;
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

export function currency(value: string, label: string): string {
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

export function date(value: string, label: string): string {
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
  return normalizeExactParts(coefficient.toString(), scale);
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
    direction: input.direction,
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
  validateCanonicalSourceAccountNumber(input.accountNumber);
  if (
    input.accountNumber &&
    (input.accountNumber.kind !== "depository-account" ||
      !/^\d{6,24}$/u.test(input.accountNumber.value))
  )
    throw new Error(
      "Foreign-currency account number evidence must be a complete provider depository number.",
    );
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
  const captureCurrencyScope =
    input.captureCurrencyScope.kind === "currency"
      ? {
          kind: "currency" as const,
          currency: currency(
            input.captureCurrencyScope.currency,
            "Capture scope currency",
          ),
        }
      : { kind: "multi-currency" as const };
  if (
    captureCurrencyScope.kind === "currency" &&
    records.some((record) => record.currency !== captureCurrencyScope.currency)
  )
    throw new Error("Foreign source row currency falls outside its typed capture scope.");
  if (
    records.some(
      (record) => record.effectiveOn < startDate || record.effectiveOn > endDate,
    )
  )
    throw new Error("Foreign source row falls outside the complete capture scope.");
  const scopeFingerprint = token(
    `${contract.contractVersion}:${accountNo}:${startDate}:${endDate}:${canonicalJson(captureCurrencyScope)}`,
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
      `${input.sourceConnectionKey}:${input.identityEpochKey}:${input.captureOccurrenceId.trim()}:${accountNo}:${startDate}:${endDate}:${canonicalJson(captureCurrencyScope)}`,
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
      sourceAccountKey: accountNo,
      accountNumber: input.accountNumber ?? null,
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
      postingOrigin: contract.postingOrigin,
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
          captureCurrencyScope,
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
