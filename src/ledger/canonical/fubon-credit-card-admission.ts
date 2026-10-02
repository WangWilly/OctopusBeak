import { createHash } from "node:crypto";
import {
  admitCanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositValidatedCapture,
} from "./canonical-financial-deposit-admission.ts";
import {
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  isFubonCreditCardHumanAttestedAccountKey,
  isFubonCreditCardHumanAttestedV2Active,
} from "./fubon-credit-card-human-attestation-contract.ts";
import {
  fubonCreditCardPanFingerprint,
  type FubonCreditCardPanFingerprintKey,
  type FubonCreditCardPanIdentityMetadata,
} from "./fubon-credit-card-pan.ts";
import {
  assignOccurrenceSlots,
  canonicalOccurrenceGroupKey,
  findOccurrenceGroupCaptureAmbiguity,
  type CanonicalOccurrenceGroup,
} from "./occurrence-groups.ts";

export type FubonCreditCardExactAmount = {
  coefficient: string;
  scale: number;
};

export type FubonCreditCardInstrumentRole =
  | "primary"
  | "supplementary"
  | "virtual"
  | "replacement";

export type FubonCreditCardInstrumentEvidence = {
  kind: "explicit-instrument-role" | "explicit-card-lifecycle";
  sourceRecordKey: string;
  contractVersion: string;
};

export type FubonCreditCardInstrumentInput = {
  instrumentKey: string;
  cardMask?: string;
  productName?: string;
  role: FubonCreditCardInstrumentRole;
  lifecycle?: "active" | "suspended" | "closed" | "replaced";
  evidence?: FubonCreditCardInstrumentEvidence;
};

export type FubonCreditCardTransactionInput = {
  sourceRecordKey: string;
  occurrenceIndex: number;
  instrumentKey: string;
  consumeDate?: string | null;
  postingDate?: string | null;
  postingStatus?: "posted" | "pending";
  direction: "inflow" | "outflow";
  bookedAmount: string | FubonCreditCardExactAmount;
  bookedCurrency: string;
  /** Optional source signed lexeme. Its sign must agree with direction. */
  signedAmount?: string;
  foreignCurrency?: string | null;
  foreignAmount?: string | FubonCreditCardExactAmount | null;
  description: string;
  installmentKey?: string | null;
  billingStatus: "billed" | "unbilled";
  /** Opaque source scope used when billed evidence lacks a settled Statement. */
  sourceScopeKey?: string;
  /** Source grid that returned this row; provenance only, not transaction identity. */
  occurrenceGroupBucketKey?: string;
  statementKey?: string;
  paymentStatus?: string;
  correctionKey?: string;
  correctionEvidence?: {
    kind: "explicit-source-correction";
    sourceRecordKey: string;
    contractVersion: string;
  };
  sourceKey?: string;
};

type FubonCreditCardGridBase = {
  kind: "billed" | "unbilled";
  period: string;
  currentPage: number;
  pageSize: number;
  maximumPageSize: number;
  capturedRowCount: number;
  terminal: boolean;
  dueDateEvidence?: "explicit-date" | "provider-text-status";
};

/**
 * A terminal grid is either backed by a provider-declared total, or by a
 * short first page whose returned row count is strictly below the requested
 * maximum. The short-page variant deliberately carries no source-declared
 * count: observed rows are not promoted into provider evidence.
 */
export type FubonCreditCardGrid =
  | (FubonCreditCardGridBase & {
      terminalEvidence: "source-declared-total";
      sourceDeclaredRowCount: number;
      sourceDeclaredScopeRowCount: number;
    })
  | (FubonCreditCardGridBase & {
      terminalEvidence: "short-page";
      sourceDeclaredRowCount?: never;
      sourceDeclaredScopeRowCount?: never;
    });

export type FubonCreditCardCompleteness = {
  billedPeriods: readonly string[];
  unbilledIncluded: boolean;
  unfiltered: boolean;
  terminalGrids: boolean;
  rowCountsMatch: boolean;
  periodRowCounts: readonly number[];
  unbilledRowCount: number;
  recordCount: number;
  settledSummaryEvidencePresent: boolean;
  grids: readonly FubonCreditCardGrid[];
};

export type FubonCreditCardStatementEvidence = {
  kind: "issuer-settled-cycle-summary";
  sourceRecordKey: string;
  settled: true;
};

export type FubonCreditCardStatementInput = {
  statementKey: string;
  revisionKey: string;
  cycleStart: string;
  cycleEnd: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  balance: string | FubonCreditCardExactAmount;
  minimumPayment?: string | FubonCreditCardExactAmount;
  transactionSourceKeys: readonly string[];
  evidence: FubonCreditCardStatementEvidence | Record<string, unknown>;
};

export type FubonCreditCardRelationInput = {
  kind:
    | "pending_to_posted"
    | "refund_of"
    | "reversal_of"
    | "transfer_counterpart"
    | "installment_of";
  fromSourceRecordKey: string;
  toSourceRecordKey: string;
  evidence: {
    kind: "explicit-source-linkage";
    sourceRecordKey: string;
    contractVersion: string;
  } | Record<string, unknown>;
};

export type FubonCreditCardCaptureInput = {
  captureId: string;
  identity: {
    sourceConnectionKey: string;
    identityEpochKey: string;
    /** Opaque fallback identity when the bank exposes no full PAN. */
    humanAttestedAccountKey?: string;
    /** Ephemeral bank-page value. Admission strips it before returning. */
    fullPan?: string;
  };
  observedAt: string;
  scope: {
    startDate: string;
    endDate: string;
    completeness: FubonCreditCardCompleteness;
  };
  instruments: readonly FubonCreditCardInstrumentInput[];
  transactions: readonly FubonCreditCardTransactionInput[];
  statements: readonly FubonCreditCardStatementInput[];
  relations: readonly FubonCreditCardRelationInput[];
};

export type FubonCreditCardAdmittedTransaction = Omit<
  FubonCreditCardTransactionInput,
  "bookedAmount" | "foreignAmount" | "consumeDate" | "postingDate" | "postingStatus" | "sourceKey"
> & {
  occurrenceGroup?: CanonicalOccurrenceGroup;
  sourceKey: `sha256:${string}`;
  bookedAmount: FubonCreditCardExactAmount;
  foreignAmount: FubonCreditCardExactAmount | null;
  consumeDate: string | null;
  postingDate: string;
  effectiveDateBasis: "consume-date" | "posting-date-fallback";
  postingStatus: "posted";
  normalizedDescription: string;
};

export type FubonCreditCardAdmittedStatement = Omit<
  FubonCreditCardStatementInput,
  "balance" | "minimumPayment" | "evidence"
> & {
  balance: FubonCreditCardExactAmount;
  minimumPayment: FubonCreditCardExactAmount | null;
  evidence: FubonCreditCardStatementEvidence;
};

export type FubonCreditCardAdmittedCapture = Omit<
  FubonCreditCardCaptureInput,
  "identity" | "scope" | "instruments" | "transactions" | "statements" | "relations"
> & {
  identity: Omit<FubonCreditCardCaptureInput["identity"], "fullPan"> & {
    accountNaturalKey: string;
    accountType: "credit";
    accountSubtype: "credit_card";
    stream: "credit-card";
    providerGuaranteed: false;
    occurrenceProviderGuaranteed: false;
    identityMethod: "human-attested" | "pan-hmac";
    panFingerprint?: `sha256:${string}`;
    panLast4?: `${number}${number}${number}${number}`;
    panFingerprintKeyVersion?: string;
  };
  scope: FubonCreditCardCaptureInput["scope"];
  instruments: readonly FubonCreditCardInstrumentInput[];
  transactions: readonly FubonCreditCardAdmittedTransaction[];
  statements: readonly FubonCreditCardAdmittedStatement[];
  relations: readonly FubonCreditCardRelationInput[];
  contractVersion: "fubon/credit-card/human-attested-v2";
  authorityRoute: "fubon/credit-card/human-attested-v2";
};

export type FubonCreditCardValidatedCapture = FubonCreditCardAdmittedCapture & {
  readonly __runtimeValidatedFubonCreditCardCapture: true;
};

export const FUBON_CREDIT_CARD_CAPTURE_CONTRACT = Object.freeze({
  source: "fubon",
  stream: "credit-card",
  authorityRoute: FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.authorityRoute,
  contractVersion: FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.evidenceVersion,
  accountType: "credit",
  accountSubtype: "credit_card",
  providerGuaranteed: false,
  occurrenceProviderGuaranteed: false,
  postingRule: "posting-date-present-means-posted",
  billingRule: "billed-or-unbilled-independent-of-posting",
  transactionIdentityRule: "statement-key-or-source-scope-scoped-occurrence-v2",
  statementRule: "issuer-settled-cycle-summary-only",
  relationRule: "explicit-source-linkage-only",
} as const);

export class FubonCreditCardAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FubonCreditCardAdmissionError";
  }
}

export type FubonCreditCardAdmissionOptions = {
  readonly panFingerprintKey?: FubonCreditCardPanFingerprintKey;
};

export type FubonCreditCardIdentityMetadata = {
  readonly identityMethod: "human-attested" | "pan-hmac";
  readonly accountNaturalKey: `sha256:${string}`;
  readonly humanAttestedAccountKey?: string;
  readonly panFingerprint?: `sha256:${string}`;
  readonly panLast4?: `${number}${number}${number}${number}`;
  readonly panFingerprintKeyVersion?: string;
};
const VALIDATED_CAPTURES = new WeakSet<object>();

function fail(message: string): never {
  throw new FubonCreditCardAdmissionError(message);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required.`);
  return value.trim();
}

function validDate(value: unknown, label: string): string {
  const normalized = text(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized))
    fail(`${label} must be YYYY-MM-DD.`);
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  )
    fail(`${label} must be a valid date.`);
  return normalized;
}

function exactAmount(
  input: string | FubonCreditCardExactAmount,
  label: string,
): FubonCreditCardExactAmount {
  if (typeof input === "object" && input !== null) {
    if (
      !/^(?:0|[1-9]\d*)$/.test(input.coefficient) ||
      !Number.isSafeInteger(input.scale) ||
      input.scale < 0
    )
      fail(`${label} must be an exact non-negative amount.`);
    return {
      coefficient: input.coefficient,
      scale: input.scale,
    };
  }
  const value = text(input, label).replaceAll(",", "");
  const match = value.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) fail(`${label} must be a non-negative exact decimal.`);
  const integer = match[1]!.replace(/^0+(?=\d)/, "");
  const fraction = match[2] ?? "";
  const coefficient = `${integer}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const scale = fraction.length;
  if (coefficient === "0") return { coefficient: "0", scale: 0 };
  return { coefficient, scale };
}

function signedAmount(value: string): { sign: "positive" | "negative" | "zero" } {
  const normalized = text(value, "Signed amount").replaceAll(",", "");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized))
    fail("Signed amount must be an exact decimal.");
  const unsigned = normalized.replace(/^[+-]/, "").replace(/^0+(?=\d)/, "");
  if (/^0(?:\.0+)?$/.test(unsigned)) return { sign: "zero" };
  return normalized.startsWith("-") ? { sign: "negative" } : { sign: "positive" };
}

function currency(value: unknown, label: string): string {
  const normalized = text(value, label).toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) fail(`${label} must be an ISO currency.`);
  return normalized;
}

function normalizedDescription(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function stableTuple(value: readonly unknown[]): string {
  return JSON.stringify(value);
}

type FubonCreditCardIdentityInput = FubonCreditCardCaptureInput["identity"];

function rejectUntrustedPanMetadata(identity: object): void {
  if (
    Object.hasOwn(identity, "panFingerprint") ||
    Object.hasOwn(identity, "panLast4") ||
    Object.hasOwn(identity, "panFingerprintKeyVersion")
  )
    fail("Fubon PAN identity metadata must be derived from an observed PAN during admission.");
}

function resolvedFubonCreditCardIdentity(
  identity: FubonCreditCardIdentityInput,
  options: FubonCreditCardAdmissionOptions = {},
): {
  readonly sourceConnectionKey: string;
  readonly identityEpochKey: string;
  readonly humanAttestedAccountKey?: string;
  readonly panFingerprint?: `sha256:${string}`;
  readonly panLast4?: `${number}${number}${number}${number}`;
  readonly panFingerprintKeyVersion?: string;
  readonly identityMethod: "human-attested" | "pan-hmac";
  readonly accountNaturalKey: `sha256:${string}`;
} {
  const sourceConnectionKey = text(identity.sourceConnectionKey, "Source connection key");
  const identityEpochKey = text(identity.identityEpochKey, "Identity epoch key");
  rejectUntrustedPanMetadata(identity);
  if (identity.fullPan !== undefined) {
    if (!options.panFingerprintKey)
      fail("Fubon PAN fingerprint key is unavailable.");
    let metadata: FubonCreditCardPanIdentityMetadata;
    try {
      metadata = fubonCreditCardPanFingerprint(
        identity.fullPan,
        options.panFingerprintKey,
      );
    } catch (error) {
      if (error instanceof FubonCreditCardAdmissionError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (/key (?:is )?unavailable|key version/i.test(message))
        fail("Fubon PAN fingerprint key is unavailable.");
      fail("Fubon card number is invalid.");
    }
    return {
      sourceConnectionKey,
      identityEpochKey,
      panFingerprint: metadata.fingerprint,
      panLast4: metadata.last4,
      panFingerprintKeyVersion: metadata.keyVersion,
      identityMethod: "pan-hmac",
      accountNaturalKey: metadata.fingerprint,
    };
  }
  const accountKey = text(identity.humanAttestedAccountKey, "Human-attested account key");
  if (!isFubonCreditCardHumanAttestedAccountKey(accountKey))
    fail("Human-attested account key must be opaque and independent of card identity.");
  const accountNaturalKey = `sha256:${createHash("sha256")
    .update(JSON.stringify(["fubon-credit-account-v2", sourceConnectionKey, identityEpochKey, accountKey]))
    .digest("base64url")}` as `sha256:${string}`;
  return {
    sourceConnectionKey,
    identityEpochKey,
    humanAttestedAccountKey: accountKey,
    identityMethod: "human-attested",
    accountNaturalKey,
  };
}

export function buildFubonCreditCardAccountIdentityKey(identity: {
  sourceConnectionKey: string;
  identityEpochKey: string;
  humanAttestedAccountKey?: string;
  fullPan?: string;
}, options: FubonCreditCardAdmissionOptions = {}): `sha256:${string}` {
  return resolvedFubonCreditCardIdentity(identity, options).accountNaturalKey;
}

export function resolveFubonCreditCardIdentity(
  identity: FubonCreditCardIdentityInput,
  options: FubonCreditCardAdmissionOptions = {},
): FubonCreditCardIdentityMetadata & {
  readonly sourceConnectionKey: string;
  readonly identityEpochKey: string;
} {
  return resolvedFubonCreditCardIdentity(identity, options);
}

export function buildFubonCreditCardTransactionSourceKey(
  identity: FubonCreditCardIdentityInput,
  record: FubonCreditCardTransactionInput,
  options: FubonCreditCardAdmissionOptions = {},
): `sha256:${string}` {
  const accountKey = buildFubonCreditCardAccountIdentityKey(identity, options);
  const amount = exactAmount(record.bookedAmount, "Booked amount");
  const foreignCurrency = record.foreignCurrency
    ? currency(record.foreignCurrency, "Foreign currency")
    : null;
  const foreignAmount = record.foreignAmount == null
    ? null
    : exactAmount(record.foreignAmount, "Foreign amount");
  if ((foreignCurrency === null) !== (foreignAmount === null))
    fail("Foreign currency and foreign amount must be provided together.");
  const statementKey = record.statementKey?.trim() || null;
  const sourceScopeKey = record.sourceScopeKey?.trim() || null;
  const tuple = stableTuple([
    "fubon-credit-card-transaction-v2",
    accountKey,
    text(record.instrumentKey, "Card instrument key"),
    statementKey,
    record.consumeDate == null || record.consumeDate.trim() === ""
      ? null
      : validDate(record.consumeDate, "Consume date"),
    record.postingDate ? validDate(record.postingDate, "Posting date") : null,
    record.direction,
    amount.coefficient,
    amount.scale,
    currency(record.bookedCurrency, "Booked currency"),
    foreignCurrency,
    foreignAmount?.coefficient ?? null,
    foreignAmount?.scale ?? null,
    normalizedDescription(text(record.description, "Transaction description")),
    record.installmentKey?.trim() || null,
    ...(sourceScopeKey ? [sourceScopeKey] : []),
    record.occurrenceIndex,
  ]);
  return `sha256:${createHash("sha256").update(tuple).digest("base64url")}`;
}

/** Identify the economic transaction independently of billing and statement lifecycle. */
function buildFubonCreditCardTransactionEconomicIdentityKey(
  identity: FubonCreditCardIdentityInput,
  record: Pick<
    FubonCreditCardTransactionInput,
    | "instrumentKey"
    | "consumeDate"
    | "postingDate"
    | "direction"
    | "bookedAmount"
    | "bookedCurrency"
    | "foreignCurrency"
    | "foreignAmount"
    | "description"
    | "installmentKey"
  >,
  options: FubonCreditCardAdmissionOptions = {},
): `sha256:${string}` {
  const accountKey = buildFubonCreditCardAccountIdentityKey(identity, options);
  const amount = exactAmount(record.bookedAmount, "Booked amount");
  const foreignCurrency = record.foreignCurrency
    ? currency(record.foreignCurrency, "Foreign currency")
    : null;
  const foreignAmount = record.foreignAmount == null
    ? null
    : exactAmount(record.foreignAmount, "Foreign amount");
  if ((foreignCurrency === null) !== (foreignAmount === null))
    fail("Foreign currency and foreign amount must be provided together.");
  const tuple = stableTuple([
    "fubon-credit-card-economic-v2",
    accountKey,
    text(record.instrumentKey, "Card instrument key"),
    record.consumeDate == null || record.consumeDate.trim() === ""
      ? null
      : validDate(record.consumeDate, "Consume date"),
    record.postingDate ? validDate(record.postingDate, "Posting date") : null,
    record.direction,
    amount.coefficient,
    amount.scale,
    currency(record.bookedCurrency, "Booked currency"),
    foreignCurrency,
    foreignAmount?.coefficient ?? null,
    foreignAmount?.scale ?? null,
    normalizedDescription(text(record.description, "Transaction description")),
    record.installmentKey?.trim() || null,
  ]);
  return `sha256:${createHash("sha256").update(tuple).digest("base64url")}`;
}

export function buildFubonCreditCardStatementEvidenceKey(
  identity: FubonCreditCardCaptureInput["identity"],
  statement: Pick<
    FubonCreditCardStatementInput,
    "statementKey" | "cycleStart" | "cycleEnd"
  >,
  options: FubonCreditCardAdmissionOptions = {},
): `sha256:${string}` {
  const accountKey = buildFubonCreditCardAccountIdentityKey(identity, options);
  const tuple = [
    "fubon-credit-card-statement-summary-v2",
    text(identity.sourceConnectionKey, "Source connection key"),
    text(identity.identityEpochKey, "Identity epoch key"),
    accountKey,
    text(statement.statementKey, "Statement key"),
    validDate(statement.cycleStart, "Statement cycle start"),
    validDate(statement.cycleEnd, "Statement cycle end"),
  ];
  return `sha256:${createHash("sha256").update(JSON.stringify(tuple)).digest("base64url")}`;
}

function hasValidFubonGridTerminalEvidence(grid: FubonCreditCardGrid): boolean {
  if (
    !Number.isSafeInteger(grid.currentPage) ||
    grid.currentPage !== 1 ||
    !Number.isSafeInteger(grid.pageSize) ||
    !Number.isSafeInteger(grid.maximumPageSize) ||
    grid.maximumPageSize <= 0 ||
    grid.pageSize !== grid.maximumPageSize ||
    !grid.terminal ||
    !Number.isSafeInteger(grid.capturedRowCount) ||
    grid.capturedRowCount < 0 ||
    grid.capturedRowCount > grid.pageSize
  )
    return false;

  if (grid.terminalEvidence === "source-declared-total")
    return (
      Object.hasOwn(grid, "sourceDeclaredRowCount") &&
      Object.hasOwn(grid, "sourceDeclaredScopeRowCount") &&
      Number.isSafeInteger(grid.sourceDeclaredRowCount) &&
      grid.sourceDeclaredRowCount >= 0 &&
      grid.capturedRowCount === grid.sourceDeclaredRowCount &&
      Number.isSafeInteger(grid.sourceDeclaredScopeRowCount) &&
      grid.sourceDeclaredScopeRowCount >= grid.sourceDeclaredRowCount
    );

  if (grid.terminalEvidence === "short-page")
    return (
      !Object.hasOwn(grid, "sourceDeclaredRowCount") &&
      !Object.hasOwn(grid, "sourceDeclaredScopeRowCount") &&
      grid.capturedRowCount < grid.pageSize
    );

  return false;
}

function validateCompleteness(
  capture: FubonCreditCardCaptureInput,
  transactions: readonly FubonCreditCardAdmittedTransaction[],
): void {
  const completeness = capture.scope.completeness;
  if (!Array.isArray(completeness.billedPeriods) || completeness.billedPeriods.length !== 6)
    fail("Fubon credit-card capture requires six billed periods.");
  if (new Set(completeness.billedPeriods).size !== 6)
    fail("Fubon billed periods must be distinct.");
  if (!completeness.unbilledIncluded)
    fail("Fubon credit-card capture must include the unbilled grid.");
  if (!completeness.unfiltered)
    fail("Fubon credit-card completeness requires an unfiltered grid.");
  if (!completeness.terminalGrids)
    fail("Fubon credit-card capture requires terminal grids.");
  if (!completeness.rowCountsMatch)
    fail("Fubon credit-card grid row counts do not match captured records.");
  if (
    completeness.periodRowCounts.length !== 6 ||
    completeness.periodRowCounts.some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    ) ||
    !Number.isSafeInteger(completeness.unbilledRowCount) ||
    completeness.unbilledRowCount < 0 ||
    !Number.isSafeInteger(completeness.recordCount) ||
    completeness.recordCount < 0
  )
    fail("Fubon credit-card completeness counts are invalid.");
  if (
    !Array.isArray(completeness.grids) ||
    completeness.grids.length !== 7 ||
    completeness.grids.filter((grid) => grid.kind === "billed").length !== 6 ||
    completeness.grids.filter((grid) => grid.kind === "unbilled").length !== 1 ||
    completeness.grids.some((grid) => !hasValidFubonGridTerminalEvidence(grid))
  )
    fail("Fubon credit-card grids lack terminal maximum-page matching-count evidence.");
  const billedGrids = completeness.grids.filter(
    (grid) => grid.kind === "billed",
  );
  const unbilledGrid = completeness.grids.find(
    (grid) => grid.kind === "unbilled",
  );
  if (
    billedGrids.some(
      (grid, index) =>
        grid.period !== completeness.billedPeriods[index] ||
        grid.capturedRowCount !== completeness.periodRowCounts[index] ||
        (grid.terminalEvidence === "source-declared-total" &&
          grid.sourceDeclaredRowCount !== completeness.periodRowCounts[index]),
    ) ||
    !unbilledGrid ||
    unbilledGrid.period !== "unbilled" ||
    unbilledGrid.capturedRowCount !== completeness.unbilledRowCount ||
    (unbilledGrid.terminalEvidence === "source-declared-total" &&
      unbilledGrid.sourceDeclaredRowCount !== completeness.unbilledRowCount)
  )
    fail("Fubon credit-card grid periods or row counts do not match completeness evidence.");
  const billedCount = transactions.filter((row) => row.billingStatus === "billed").length;
  const unbilledCount = transactions.filter((row) => row.billingStatus === "unbilled").length;
  if (
    completeness.recordCount !== transactions.length ||
    completeness.unbilledRowCount !== unbilledCount ||
    completeness.periodRowCounts.reduce((sum, count) => sum + count, 0) !== billedCount
  )
    fail("Fubon credit-card completeness count drifted from records.");
  if (!completeness.settledSummaryEvidencePresent)
    fail("Fubon credit-card capture is missing settled statement summary evidence.");
  for (const transaction of transactions) {
    const bucketKey = text(
      transaction.occurrenceGroupBucketKey,
      "Fubon transaction query bucket key",
    );
    if (
      transaction.billingStatus === "billed" &&
      (!bucketKey.startsWith("statement:") ||
        !completeness.billedPeriods.includes(bucketKey.slice("statement:".length)))
    )
      fail("Fubon transaction query bucket is outside the complete billed-period inventory.");
  }
}

function validateInstrument(instrument: FubonCreditCardInstrumentInput): FubonCreditCardInstrumentInput {
  const instrumentKey = text(instrument.instrumentKey, "Card instrument key");
  if (/\d[\d\s-]{11,}\d/u.test(instrumentKey))
    fail("Card instrument key must not contain a full card number.");
  if (
    !instrument.evidence ||
    instrument.evidence.kind !== "explicit-instrument-role" ||
    instrument.evidence.contractVersion !== FUBON_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion
  )
    fail(`${instrument.role} card instrument lacks explicit versioned role evidence.`);
  if (instrument.lifecycle && !instrument.evidence) {
    fail("Card lifecycle facts require explicit versioned evidence.");
  }
  const cardMask = instrument.cardMask?.trim() || undefined;
  if (cardMask !== undefined && !/^\*{4}\d{4}$/u.test(cardMask))
    fail("Card instrument display mask must contain only four stars and four digits.");
  const productName = instrument.productName?.trim() || undefined;
  if (productName && /\d[\d\s-]{11,}\d/u.test(productName))
    fail("Card instrument product name must not contain a full card number.");
  return {
    ...instrument,
    instrumentKey,
    cardMask,
    productName,
  };
}

function validateTransaction(
  identity: FubonCreditCardCaptureInput["identity"],
  instruments: ReadonlyMap<string, FubonCreditCardInstrumentInput>,
  record: FubonCreditCardTransactionInput,
  options: FubonCreditCardAdmissionOptions,
): FubonCreditCardAdmittedTransaction {
  const sourceRecordKey = text(record.sourceRecordKey, "Source record key");
  if (!Number.isSafeInteger(record.occurrenceIndex) || record.occurrenceIndex < 0)
    fail("Transaction occurrence index must be a non-negative integer.");
  const instrumentKey = text(record.instrumentKey, "Card instrument key");
  if (!instruments.has(instrumentKey)) fail("Transaction references an unknown card instrument.");
  const suppliedConsumeDate = record.consumeDate == null || record.consumeDate.trim() === ""
    ? null
    : validDate(record.consumeDate, "Consume date");
  const suppliedPostingDate = record.postingDate == null || record.postingDate.trim() === ""
    ? null
    : validDate(record.postingDate, "Posting date");
  if (!suppliedPostingDate) fail("Posting date is required.");
  const consumeDate = suppliedConsumeDate ?? suppliedPostingDate;
  const postingDate = suppliedPostingDate ?? suppliedConsumeDate;
  if (!consumeDate || !postingDate)
    fail("Fubon transaction requires a consume date or posting date.");
  const effectiveDateBasis = suppliedConsumeDate
    ? "consume-date" as const
    : "posting-date-fallback" as const;
  if (record.postingStatus === "pending")
    fail("Fubon v2 requires posted credit-card transactions when posting date is present.");
  const bookedAmount = exactAmount(record.bookedAmount, "Booked amount");
  const bookedCurrency = currency(record.bookedCurrency, "Booked currency");
  const description = text(record.description, "Transaction description");
  const statementKey = record.statementKey?.trim() || undefined;
  const sourceScopeKey = record.sourceScopeKey?.trim() || undefined;
  const occurrenceGroupBucketKey = text(
    record.occurrenceGroupBucketKey,
    "Queried source bucket",
  );
  if (
    (record.billingStatus === "unbilled" && occurrenceGroupBucketKey !== "unbilled") ||
    (record.billingStatus === "billed" && !occurrenceGroupBucketKey.startsWith("statement:"))
  )
    fail("Fubon transaction query bucket conflicts with its billing status.");
  if (sourceScopeKey && sourceScopeKey.length > 256)
    fail("Transaction source scope key is too long.");
  if (record.billingStatus === "billed" && !statementKey)
    if (!sourceScopeKey)
      fail("Billed Fubon transactions require a statement or source scope identity.");
  const normalized = normalizedDescription(description);
  if (!normalized) fail("Transaction description cannot be empty.");
  if (record.signedAmount !== undefined) {
    const sign = signedAmount(record.signedAmount).sign;
    if (
      sign === "zero" ||
      (sign === "negative" && record.direction !== "inflow") ||
      (sign === "positive" && record.direction !== "outflow")
    )
      fail("Signed amount conflicts with transaction direction.");
  }
  const foreignCurrency = record.foreignCurrency
    ? currency(record.foreignCurrency, "Foreign currency")
    : null;
  const foreignAmount = record.foreignAmount == null
    ? null
    : exactAmount(record.foreignAmount, "Foreign amount");
  if ((foreignCurrency === null) !== (foreignAmount === null))
    fail("Foreign currency and foreign amount must be provided together.");
  if (record.correctionKey) {
    if (
      !record.correctionEvidence ||
      record.correctionEvidence.kind !== "explicit-source-correction" ||
      record.correctionEvidence.contractVersion !== FUBON_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion
    )
      fail("Transaction correction requires explicit versioned correction evidence.");
  }
  const normalizedRecord = {
    ...record,
    ...(statementKey ? { statementKey } : {}),
    ...(sourceScopeKey ? { sourceScopeKey } : {}),
  };
  const sourceKey = buildFubonCreditCardTransactionSourceKey(
    identity,
    normalizedRecord,
    options,
  );
  if (record.sourceKey && record.sourceKey !== sourceKey)
    fail("Provided transaction source key does not match the contract tuple.");
  return {
    ...normalizedRecord,
    occurrenceGroupBucketKey,
    sourceRecordKey,
    instrumentKey,
    consumeDate,
    postingDate,
    effectiveDateBasis,
    postingStatus: "posted",
    bookedAmount,
    bookedCurrency,
    foreignCurrency,
    foreignAmount,
    description,
    normalizedDescription: normalized,
    sourceKey,
  };
}

function validateStatement(
  identity: FubonCreditCardCaptureInput["identity"],
  statement: FubonCreditCardStatementInput,
  transactions: ReadonlyMap<string, FubonCreditCardAdmittedTransaction>,
  options: FubonCreditCardAdmissionOptions,
): FubonCreditCardAdmittedStatement {
  const statementKey = text(statement.statementKey, "Statement key");
  const revisionKey = text(statement.revisionKey, "Statement revision key");
  const cycleStart = validDate(statement.cycleStart, "Statement cycle start");
  const cycleEnd = validDate(statement.cycleEnd, "Statement cycle end");
  const issueDate = validDate(statement.issueDate, "Statement issue date");
  const dueDate = validDate(statement.dueDate, "Statement due date");
  if (cycleStart > cycleEnd || issueDate < cycleEnd || dueDate < issueDate)
    fail("Settled statement cycle or billing dates are invalid.");
  const evidence = statement.evidence;
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    evidence.kind !== "issuer-settled-cycle-summary" ||
    evidence.settled !== true ||
    typeof evidence.sourceRecordKey !== "string" ||
    !evidence.sourceRecordKey.trim()
  )
    fail("Only issuer settled-cycle summary evidence may establish a Statement.");
  if (
    evidence.sourceRecordKey.trim() !==
    buildFubonCreditCardStatementEvidenceKey(
      identity,
      { statementKey, cycleStart, cycleEnd },
      options,
    )
  )
    fail("Statement summary evidence is not scoped to this attested account and cycle.");
  for (const sourceKey of statement.transactionSourceKeys) {
    const transaction = transactions.get(sourceKey);
    if (!transaction)
      fail("Statement membership references an unknown source record.");
    if (transaction.billingStatus !== "billed")
      fail("Statement membership cannot reference an unbilled transaction.");
  }
  return {
    ...statement,
    statementKey,
    revisionKey,
    cycleStart,
    cycleEnd,
    issueDate,
    dueDate,
    currency: currency(statement.currency, "Statement currency"),
    balance: exactAmount(statement.balance, "Statement balance"),
    minimumPayment:
      statement.minimumPayment == null
        ? null
        : exactAmount(statement.minimumPayment, "Statement minimum payment"),
    transactionSourceKeys: [...statement.transactionSourceKeys],
    evidence: {
      kind: "issuer-settled-cycle-summary",
      sourceRecordKey: evidence.sourceRecordKey.trim(),
      settled: true,
    },
  };
}

function validateRelation(
  relation: FubonCreditCardRelationInput,
  transactionsBySourceRecord: ReadonlyMap<
    string,
    FubonCreditCardAdmittedTransaction
  >,
): FubonCreditCardRelationInput {
  if (relation === null || typeof relation !== "object")
    fail("Fubon transaction relation is required.");
  const fromSourceRecordKey = text(
    relation.fromSourceRecordKey,
    "Transaction relation from source record key",
  );
  const toSourceRecordKey = text(
    relation.toSourceRecordKey,
    "Transaction relation to source record key",
  );
  if (fromSourceRecordKey === toSourceRecordKey)
    fail("Transaction relation cannot connect a transaction to itself.");
  const from = transactionsBySourceRecord.get(fromSourceRecordKey);
  const to = transactionsBySourceRecord.get(toSourceRecordKey);
  if (!from || !to)
    fail("Transaction relation references an unknown source record.");

  const relationKinds = new Set<FubonCreditCardRelationInput["kind"]>([
    "pending_to_posted",
    "refund_of",
    "reversal_of",
    "transfer_counterpart",
    "installment_of",
  ]);
  if (!relationKinds.has(relation.kind))
    fail("Transaction relation kind is unsupported.");

  const evidence = relation.evidence;
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    evidence.kind !== "explicit-source-linkage" ||
    evidence.contractVersion !== FUBON_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion ||
    typeof evidence.sourceRecordKey !== "string" ||
    !evidence.sourceRecordKey.trim()
  )
    fail("Transaction relations require explicit source linkage; similarity is not evidence.");
  const evidenceSourceRecordKey = evidence.sourceRecordKey.trim();
  if (
    evidenceSourceRecordKey !== fromSourceRecordKey &&
    evidenceSourceRecordKey !== toSourceRecordKey
  )
    fail(
      "Transaction relation evidence must identify one of its in-capture endpoint source records.",
    );
  if (!transactionsBySourceRecord.has(evidenceSourceRecordKey))
    fail("Transaction relation evidence references an unknown source record.");

  switch (relation.kind) {
    case "pending_to_posted":
      if ((from.postingStatus as string) !== "pending" || to.postingStatus !== "posted")
        fail("pending_to_posted relations require a pending source and posted target.");
      break;
    case "refund_of":
      if (from.direction !== "inflow" || to.direction !== "outflow")
        fail("refund_of relations require an inflow refund and an outflow original.");
      break;
    case "reversal_of":
      if (from.direction === to.direction)
        fail("reversal_of relations require opposite transaction directions.");
      break;
    case "transfer_counterpart":
      if (from.direction === to.direction)
        fail("transfer_counterpart relations require opposite transaction directions.");
      break;
    case "installment_of":
      if (from.direction !== "outflow" || to.direction !== "outflow")
        fail("installment_of relations require outflow installment and original transactions.");
      if ((from.consumeDate ?? from.postingDate) < (to.consumeDate ?? to.postingDate))
        fail("installment_of relations require the installment date to follow the original.");
      break;
  }

  return {
    ...relation,
    kind: relation.kind,
    fromSourceRecordKey,
    toSourceRecordKey,
    evidence: {
      kind: "explicit-source-linkage",
      sourceRecordKey: evidenceSourceRecordKey,
      contractVersion: evidence.contractVersion,
    },
  };
}

const freezeDeep = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object") freezeDeep(child, seen);
  }
  return Object.freeze(value);
};

export function admitFubonCreditCardCapture(
  capture: FubonCreditCardCaptureInput,
  options: FubonCreditCardAdmissionOptions = {},
): FubonCreditCardValidatedCapture {
  if (!isFubonCreditCardHumanAttestedV2Active())
    fail("Fubon credit-card human-attested v2 contract is revoked.");
  if (capture === null || typeof capture !== "object") fail("Fubon credit-card capture is required.");
  text(capture.captureId, "Capture ID");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text(capture.observedAt, "Observed at")))
    fail("Observed at must be an ISO timestamp.");
  const identity = resolvedFubonCreditCardIdentity(capture.identity, options);
  const accountNaturalKey = identity.accountNaturalKey;
  const startDate = validDate(capture.scope.startDate, "Capture start date");
  const endDate = validDate(capture.scope.endDate, "Capture end date");
  if (startDate > endDate) fail("Capture date scope is inverted.");
  if (!Array.isArray(capture.instruments) || capture.instruments.length === 0)
    fail("Fubon credit-card capture requires card instruments.");
  const instruments = new Map<string, FubonCreditCardInstrumentInput>();
  for (const instrument of capture.instruments) {
    const normalized = validateInstrument(instrument);
    if (instruments.has(normalized.instrumentKey)) fail("Duplicate card instrument key.");
    instruments.set(normalized.instrumentKey, normalized);
  }
  if (!Array.isArray(capture.transactions)) fail("Fubon credit-card transactions are required.");
  const transactions: FubonCreditCardAdmittedTransaction[] = [];
  const sourceKeys = new Set<string>();
  const sourceRecordKeys = new Set<string>();
  const transactionsBySourceRecord = new Map<string, FubonCreditCardAdmittedTransaction>();
  for (const record of capture.transactions) {
    const normalized = validateTransaction(
      capture.identity,
      instruments,
      record,
      options,
    );
    if (sourceRecordKeys.has(normalized.sourceRecordKey)) fail("Duplicate source record key.");
    if (sourceKeys.has(normalized.sourceKey)) fail("Transaction identity collision within one capture.");
    sourceRecordKeys.add(normalized.sourceRecordKey);
    transactionsBySourceRecord.set(normalized.sourceRecordKey, normalized);
    sourceKeys.add(normalized.sourceKey);
    transactions.push(normalized);
  }
  const ambiguity = findOccurrenceGroupCaptureAmbiguity({
    rows: transactions,
    fingerprint: (transaction) => buildFubonCreditCardTransactionEconomicIdentityKey(
      capture.identity,
      transaction,
      options,
    ),
    billingStatus: (transaction) => transaction.billingStatus,
    bucketKey: (transaction) => text(transaction.occurrenceGroupBucketKey, "Fubon transaction query bucket key"),
  });
  if (ambiguity.billingStatusConflict)
    fail("Fubon billed and unbilled grids contain an ambiguous identical economic transaction.");
  if (ambiguity.queryBucketConflict)
    fail("Fubon query buckets contain an ambiguous identical economic transaction.");
  for (const instrument of instruments.values()) {
    const evidenceKey = text(
      instrument.evidence?.sourceRecordKey,
      `${instrument.role} instrument role evidence source record key`,
    );
    const evidenceTransaction = transactionsBySourceRecord.get(evidenceKey);
    if (!evidenceTransaction || evidenceTransaction.instrumentKey !== instrument.instrumentKey)
      fail(
        "Card instrument role evidence must reference a transaction source record for the same capture and instrument.",
      );
  }
  validateCompleteness(capture, transactions);
  const occurrenceScopeKey = opaqueFubonSpineToken(
    "fubon-credit-card-occurrence-scope-v1",
    accountNaturalKey,
  );
  const slots = assignOccurrenceSlots({
    rows: transactions,
    complete: true,
    scopeKey: () => occurrenceScopeKey,
    fingerprint: (transaction) => buildFubonCreditCardTransactionEconomicIdentityKey(
      capture.identity,
      transaction,
      options,
    ),
    partitionDate: (transaction) => transaction.consumeDate ?? transaction.postingDate,
  });
  slots.forEach(({ row, group }, index) => {
    const grouped = { ...row, occurrenceGroup: group };
    transactions[index] = grouped;
    transactionsBySourceRecord.set(grouped.sourceRecordKey, grouped);
  });
  if (!Array.isArray(capture.statements)) fail("Fubon credit-card statements are required.");
  const statements: FubonCreditCardAdmittedStatement[] = [];
  const statementKeys = new Set<string>();
  for (const statement of capture.statements) {
    const normalized = validateStatement(
      capture.identity,
      statement,
      transactionsBySourceRecord,
      options,
    );
    if (statementKeys.has(normalized.statementKey)) fail("Duplicate Statement key within one capture.");
    statementKeys.add(normalized.statementKey);
    statements.push(normalized);
  }
  if (!Array.isArray(capture.relations)) fail("Fubon credit-card relations are required.");
  const relations = capture.relations.map((relation) =>
    validateRelation(relation, transactionsBySourceRecord),
  );
  const result = {
    captureId: capture.captureId,
    observedAt: capture.observedAt,
    identity: {
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      ...(identity.humanAttestedAccountKey
        ? { humanAttestedAccountKey: identity.humanAttestedAccountKey }
        : {}),
      ...(identity.panFingerprint
        ? {
            panFingerprint: identity.panFingerprint,
            panLast4: identity.panLast4,
            panFingerprintKeyVersion: identity.panFingerprintKeyVersion,
          }
        : {}),
      accountNaturalKey,
      accountType: "credit" as const,
      accountSubtype: "credit_card" as const,
      stream: "credit-card" as const,
      providerGuaranteed: false as const,
      occurrenceProviderGuaranteed: false as const,
      identityMethod: identity.identityMethod,
    },
    scope: {
      startDate,
      endDate,
      completeness: {
        ...capture.scope.completeness,
        billedPeriods: [...capture.scope.completeness.billedPeriods],
        periodRowCounts: [...capture.scope.completeness.periodRowCounts],
        grids: capture.scope.completeness.grids.map((grid) => ({ ...grid })),
      },
    },
    instruments: [...instruments.values()],
    transactions,
    statements,
    relations,
    contractVersion: FUBON_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion,
    authorityRoute: FUBON_CREDIT_CARD_CAPTURE_CONTRACT.authorityRoute,
  } satisfies FubonCreditCardAdmittedCapture;
  const frozen = freezeDeep(result) as unknown as FubonCreditCardValidatedCapture;
  VALIDATED_CAPTURES.add(frozen);
  return frozen;
}

export function isAdmittedFubonCreditCardCapture(
  value: unknown,
): value is FubonCreditCardValidatedCapture {
  return value !== null && typeof value === "object" && VALIDATED_CAPTURES.has(value);
}

export const admitFubonCreditCardCaptureEvidence = admitFubonCreditCardCapture;
export const isValidatedFubonCreditCardCapture = isAdmittedFubonCreditCardCapture;

function opaqueFubonSpineToken(label: string, value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([label, value]))
    .digest("base64url")}`;
}

export function fubonCanonicalSpineCapture(
  capture: FubonCreditCardValidatedCapture,
): CanonicalFinancialDepositValidatedCapture {
  const instrumentsByKey = new Map(
    capture.instruments.map((instrument) => [instrument.instrumentKey, instrument]),
  );
  const records = capture.transactions.map((transaction, sourceOrderOrdinal) => {
    if (!transaction.occurrenceGroup)
      throw new FubonCreditCardAdmissionError(
        "Fubon transaction is missing its admitted occurrence group.",
      );
    const instrument = instrumentsByKey.get(transaction.instrumentKey);
    if (!instrument)
      throw new FubonCreditCardAdmissionError(
        "Fubon transaction instrument is missing from the validated capture.",
      );
    const effectiveDate = transaction.consumeDate ?? transaction.postingDate;
    const occurrenceKey = canonicalOccurrenceGroupKey(transaction.occurrenceGroup);
    const compact = JSON.stringify({
      instrumentKey: transaction.instrumentKey,
      cardMask: instrument.cardMask ?? null,
      consumeDate: transaction.consumeDate,
      postingDate: transaction.postingDate,
      amount: transaction.bookedAmount,
      currency: transaction.bookedCurrency,
      direction: transaction.direction,
      description: transaction.description,
    });
    return {
      occurrenceKey,
      occurrenceGroup: transaction.occurrenceGroup,
      occurrenceGroupBucketKey: transaction.occurrenceGroupBucketKey,
      collisionKey: occurrenceKey,
      providerKey: "human-attested:no-provider-key",
      humanAttestedOccurrenceKey: occurrenceKey,
      contentHash: opaqueFubonSpineToken("fubon-credit-content-v3", compact),
      sequenceLexeme: `observed-source-order:${sourceOrderOrdinal}`,
      compactJson: compact,
      amount: transaction.bookedAmount,
      balanceAfter: null,
      currency: transaction.bookedCurrency,
      direction: transaction.direction,
      sourceTime: {
        localDate: effectiveDate,
        localTime: "00:00:00",
        timeZone: "Asia/Taipei",
        epochMilliseconds: Date.parse(`${effectiveDate}T00:00:00+08:00`),
        precision: "date" as const,
        timeOrigin: "defaulted_local_midnight" as const,
      },
      effectiveOn: effectiveDate,
      transactionDateTimeLocal: `${effectiveDate}T00:00:00`,
      description: transaction.description,
      ...(transaction.foreignAmount && transaction.foreignCurrency
        ? {
            conversionEvidence: {
              originalAmount: transaction.foreignAmount,
              originalCurrency: transaction.foreignCurrency,
              bookedAmount: transaction.bookedAmount,
              bookedCurrency: transaction.bookedCurrency,
              sourceReportedRate: null,
              impliedRate: null,
              comparison: "not-comparable" as const,
              evidenceOrigin: "fubon-credit-card-source-reported-original-amount",
            },
          }
        : {}),
    };
  });
  const fingerprint = opaqueFubonSpineToken("fubon-credit-contract-v2", {
    authority: capture.authorityRoute,
    periods: capture.scope.completeness.billedPeriods,
  });
  const nonTransactionRecords = capture.statements.map((statement) => {
    const compactJson = JSON.stringify({
      statementKey: statement.statementKey,
      cycleStart: statement.cycleStart,
      cycleEnd: statement.cycleEnd,
      issueDate: statement.issueDate,
      dueDate: statement.dueDate,
      currency: statement.currency,
      balance: statement.balance,
      minimumPayment: statement.minimumPayment,
    });
    return {
      recordType: "statement-evidence" as const,
      recordKind: "fubon-credit-card-statement-summary",
      occurrenceKey: statement.evidence.sourceRecordKey,
      collisionKey: statement.evidence.sourceRecordKey,
      providerKey: "human-attested:no-provider-key",
      contentHash: opaqueFubonSpineToken(
        "fubon-credit-statement-summary-v2",
        compactJson,
      ),
      sequenceLexeme: `statement-summary:${statement.statementKey}`,
      compactJson,
      description: null,
    };
  });
  return admitCanonicalFinancialDepositCapture({
    captureId: capture.captureId,
    authorityRoute: capture.authorityRoute,
    contractVersion: capture.contractVersion,
    identity: {
      integrationNamespace: "fubon",
      // The caller already supplies the stable, product-independent Source
      // Connection identity. Keep product-specific domain separation on the
      // credit-card account/epoch fields below, but never fork the shared
      // connection key at this persistence seam.
      sourceConnectionKey: capture.identity.sourceConnectionKey,
      identityEpochKey: opaqueFubonSpineToken(
        "fubon-credit-epoch-v2",
        capture.identity.identityEpochKey,
      ),
      stream: "credit-card",
      recordKind: "fubon-credit-card-transaction",
      subjectDigest: capture.identity.accountNaturalKey as `sha256:${string}`,
      accountNo: capture.identity.accountNaturalKey,
      accountType: "credit",
      currency: "TWD",
    },
    observedAt: capture.observedAt,
    scope: {
      startDate: capture.scope.startDate,
      endDate: capture.scope.endDate,
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "six-billed-periods-plus-unbilled-terminal-grids",
      completenessRuleVersion: capture.contractVersion,
      absenceAuthority: null,
      contractFingerprint: fingerprint,
      preflightFingerprint: fingerprint,
      pageCount: 7,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: capture.contractVersion,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: capture.contractVersion,
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: capture.contractVersion,
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      timeOrigin: "defaulted_local_midnight",
      requireBalance: false,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: capture.scope.completeness.grids.map((grid, pageOrdinal) => ({
      pageOrdinal,
      responseCode: "200",
      terminal: grid.terminal,
      rowCount: grid.capturedRowCount,
      responseDigest: opaqueFubonSpineToken("fubon-credit-page-v2", [
        capture.captureId,
        pageOrdinal,
        grid,
      ]),
      proofKind:
        grid.terminalEvidence === "short-page"
          ? "short-page-terminal-grid"
          : "source-declared-terminal-grid",
      contractFingerprint: fingerprint,
      preflightFingerprint: fingerprint,
      metadataJson: JSON.stringify(grid),
    })),
    records,
    occurrenceGroupCoverage: [{
      scopeKey: opaqueFubonSpineToken(
        "fubon-credit-card-occurrence-scope-v1",
        capture.identity.accountNaturalKey,
      ),
      startDate: capture.scope.startDate,
      endDate: capture.scope.endDate,
      contractVersion: capture.contractVersion,
      bucketKeys: [
        ...capture.scope.completeness.billedPeriods.map((period) => `statement:${period}`),
        "unbilled",
      ],
    }],
    nonTransactionRecords,
  });
}
