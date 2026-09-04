import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CanonicalSourceStore } from "./canonical-source-store.ts";
import {
  isValidatedCanonicalDatabase,
  runCanonicalSchemaRepair,
} from "./canonical-schema-lifecycle.ts";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCaptureBatch,
  type CanonicalFinancialDepositValidatedCapture,
} from "./canonical-financial-deposit-writer.ts";
import {
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  isFubonCreditCardHumanAttestedAccountKey,
  isFubonCreditCardHumanAttestedV2Active,
  isFubonCreditCardHumanAttestationV2DurablyActive,
  peekFubonCreditCardHumanAttestationStatus,
  recordInitialFubonCreditCardHumanAttestationV2IfMissing,
} from "./fubon-credit-card-human-attestation.ts";
import {
  fubonCreditCardPanFingerprint,
  type FubonCreditCardPanFingerprintKey,
  type FubonCreditCardPanIdentityMetadata,
} from "./fubon-credit-card-pan.ts";

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
  consumeDate: string;
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
  "bookedAmount" | "foreignAmount" | "postingDate" | "postingStatus" | "sourceKey"
> & {
  sourceKey: `sha256:${string}`;
  bookedAmount: FubonCreditCardExactAmount;
  foreignAmount: FubonCreditCardExactAmount | null;
  postingDate: string;
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
    validDate(record.consumeDate, "Consume date"),
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
  const consumeDate = validDate(record.consumeDate, "Consume date");
  const postingDate = validDate(record.postingDate, "Posting date");
  if (record.postingStatus === "pending")
    fail("Fubon v2 requires posted credit-card transactions when posting date is present.");
  const bookedAmount = exactAmount(record.bookedAmount, "Booked amount");
  const bookedCurrency = currency(record.bookedCurrency, "Booked currency");
  const description = text(record.description, "Transaction description");
  const statementKey = record.statementKey?.trim() || undefined;
  const sourceScopeKey = record.sourceScopeKey?.trim() || undefined;
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
      (sign === "negative" && record.direction !== "outflow") ||
      (sign === "positive" && record.direction !== "inflow")
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
    sourceRecordKey,
    instrumentKey,
    consumeDate,
    postingDate,
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
      if (from.consumeDate < to.consumeDate)
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
  const occurrenceOrdinals = new Map<string, number>();
  const transactionsBySourceRecord = new Map<string, FubonCreditCardAdmittedTransaction>();
  for (const record of capture.transactions) {
    const contentIdentity = buildFubonCreditCardTransactionSourceKey(
      capture.identity,
      { ...record, occurrenceIndex: 0 },
      options,
    );
    const expectedOccurrenceIndex = occurrenceOrdinals.get(contentIdentity) ?? 0;
    if (record.occurrenceIndex !== expectedOccurrenceIndex)
      fail(
        "Transaction occurrence indexes must be contiguous in complete observed source order.",
      );
    occurrenceOrdinals.set(contentIdentity, expectedOccurrenceIndex + 1);
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

export type FubonCreditCardWriterStore = Pick<
  CanonicalSourceStore,
  "db" | "databasePath" | "commitClock"
> & {
  readonly beforeFubonCreditExtensionCommit?: (db: DatabaseSync) => void;
};

export function ensureFubonCreditCardSchema(db: DatabaseSync): void {
  if (isValidatedCanonicalDatabase(db)) {
    try {
      validateFubonCreditCardSchema(db);
    } catch {
      runCanonicalSchemaRepair(db, "canonical/fubon-credit-card-extension/v1");
      validateFubonCreditCardSchema(db);
    }
    return;
  }
  db.exec(`
CREATE TABLE IF NOT EXISTS fubon_credit_instrument_details (
  instrument_id BLOB PRIMARY KEY CHECK(length(instrument_id) = 16),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  instrument_key TEXT NOT NULL,
  card_mask TEXT CHECK(
    card_mask IS NULL OR
    (length(card_mask) = 8 AND substr(card_mask, 1, 4) = '****' AND
      substr(card_mask, 5) GLOB '[0-9][0-9][0-9][0-9]')
  ),
  role TEXT NOT NULL CHECK(role IN ('primary','supplementary','virtual','replacement')),
  lifecycle TEXT,
  UNIQUE(account_id, instrument_key)
);
CREATE TABLE IF NOT EXISTS fubon_credit_account_identity_details (
  account_id BLOB PRIMARY KEY REFERENCES financial_accounts(account_id),
  identity_method TEXT NOT NULL CHECK(identity_method IN ('human-attested','pan-hmac')),
  pan_fingerprint TEXT,
  pan_last4 TEXT CHECK(pan_last4 IS NULL OR pan_last4 GLOB '[0-9][0-9][0-9][0-9]'),
  pan_fingerprint_key_version TEXT,
  CHECK(
    (identity_method = 'pan-hmac' AND pan_fingerprint IS NOT NULL AND pan_last4 IS NOT NULL AND pan_fingerprint_key_version IS NOT NULL)
    OR
    (identity_method = 'human-attested' AND pan_fingerprint IS NULL AND pan_last4 IS NULL AND pan_fingerprint_key_version IS NULL)
  )
);
CREATE TABLE IF NOT EXISTS fubon_credit_instrument_role_evidence (
  instrument_id BLOB NOT NULL REFERENCES fubon_credit_instrument_details(instrument_id),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  PRIMARY KEY(instrument_id, capture_id, source_record_id)
);
CREATE TABLE IF NOT EXISTS fubon_credit_transaction_details (
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  instrument_id BLOB NOT NULL REFERENCES fubon_credit_instrument_details(instrument_id),
  billing_status TEXT NOT NULL CHECK(billing_status IN ('billed','unbilled')),
  statement_key TEXT,
  PRIMARY KEY(revision_id, source_record_id)
);
CREATE TABLE IF NOT EXISTS fubon_credit_statement_details (
  statement_id BLOB PRIMARY KEY CHECK(length(statement_id) = 16),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  statement_key TEXT NOT NULL,
  UNIQUE(account_id, statement_key)
);
CREATE TABLE IF NOT EXISTS fubon_credit_statement_revision_details (
  statement_revision_id BLOB PRIMARY KEY CHECK(length(statement_revision_id) = 16),
  statement_id BLOB NOT NULL REFERENCES fubon_credit_statement_details(statement_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  revision_key TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  cycle_start TEXT NOT NULL, cycle_end TEXT NOT NULL,
  issue_date TEXT NOT NULL, due_date TEXT NOT NULL,
  currency TEXT NOT NULL, balance_coefficient TEXT NOT NULL,
  balance_scale INTEGER NOT NULL, minimum_coefficient TEXT, minimum_scale INTEGER,
  evidence_source_record_key TEXT NOT NULL,
  UNIQUE(statement_id, revision_key)
);
CREATE TABLE IF NOT EXISTS fubon_credit_statement_membership_details (
  statement_revision_id BLOB NOT NULL REFERENCES fubon_credit_statement_revision_details(statement_revision_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  transaction_revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  PRIMARY KEY(statement_revision_id, transaction_id)
);
CREATE TABLE IF NOT EXISTS fubon_credit_statement_summary_evidence (
  statement_revision_id BLOB NOT NULL REFERENCES fubon_credit_statement_revision_details(statement_revision_id),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  evidence_key TEXT NOT NULL,
  evidence_source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  PRIMARY KEY(statement_revision_id, capture_id),
  UNIQUE(account_id, capture_id, evidence_key)
);
CREATE TABLE IF NOT EXISTS fubon_credit_relation_details (
  relation_id BLOB PRIMARY KEY CHECK(length(relation_id) = 16),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  relation_kind TEXT NOT NULL,
  from_transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  to_transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  evidence_source_record_key TEXT NOT NULL,
  UNIQUE(account_id, relation_kind, from_transaction_id, to_transaction_id)
);
  `);

  const instrumentColumns = db.prepare(
    "PRAGMA table_info(fubon_credit_instrument_details)",
  ).all() as Array<{ name?: string }>;
  if (!instrumentColumns.some((column) => column.name === "card_mask")) {
    db.exec(
      "ALTER TABLE fubon_credit_instrument_details ADD COLUMN card_mask TEXT",
    );
  }

  // Databases created before statement Source Record lineage was added have
  // valid summary rows but no evidence_source_record_id.  Keep those rows
  // intact and leave the new lineage column nullable for the legacy rows; the
  // replacement trigger below rejects any new row without a real Source
  // Record, so the compatibility exception cannot be used for new writes.
  const summaryColumns = db.prepare(
    "PRAGMA table_info(fubon_credit_statement_summary_evidence)",
  ).all() as Array<{ name?: string }>;
  if (!summaryColumns.some((column) => column.name === "evidence_source_record_id")) {
    db.exec(
      "ALTER TABLE fubon_credit_statement_summary_evidence " +
      "ADD COLUMN evidence_source_record_id BLOB REFERENCES source_records(source_record_id)",
    );
  }

  // CREATE TRIGGER IF NOT EXISTS would preserve the pre-lineage trigger on a
  // reused database. Drop and recreate both guards so upgrades are idempotent
  // and always enforce the current scope contract.
  db.exec(`
DROP TRIGGER IF EXISTS fubon_credit_role_evidence_scope_guard;
DROP TRIGGER IF EXISTS fubon_credit_summary_evidence_scope_guard;
CREATE TRIGGER fubon_credit_role_evidence_scope_guard
BEFORE INSERT ON fubon_credit_instrument_role_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM source_record_scopes scoped
  JOIN source_records source_record
    ON source_record.source_record_id = scoped.source_record_id
  JOIN fubon_credit_instrument_details instrument
    ON instrument.instrument_id = NEW.instrument_id
  WHERE scoped.source_record_id = NEW.source_record_id
    AND scoped.capture_id = NEW.capture_id
    AND scoped.account_id = NEW.account_id
    AND instrument.account_id = NEW.account_id
    AND json_extract(source_record.payload_json, '$.instrumentKey') = instrument.instrument_key
    AND (
      (instrument.card_mask IS NULL AND
        json_extract(source_record.payload_json, '$.cardMask') IS NULL)
      OR
      (instrument.card_mask IS NOT NULL AND
        json_extract(source_record.payload_json, '$.cardMask') = instrument.card_mask)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Fubon instrument role evidence crosses capture, account, or instrument scope (or has an inconsistent card mask)');
END;
CREATE TRIGGER fubon_credit_summary_evidence_scope_guard
BEFORE INSERT ON fubon_credit_statement_summary_evidence
WHEN NEW.evidence_source_record_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM capture_scopes scoped
  JOIN fubon_credit_statement_revision_details revision
    ON revision.statement_revision_id = NEW.statement_revision_id
  JOIN fubon_credit_statement_details statement
    ON statement.statement_id = revision.statement_id
  JOIN source_record_scopes evidence_scope
    ON evidence_scope.source_record_id = NEW.evidence_source_record_id
  JOIN source_records evidence_record
    ON evidence_record.source_record_id = evidence_scope.source_record_id
  JOIN source_subjects evidence_subject
    ON evidence_subject.source_subject_id = evidence_record.source_subject_id
  WHERE scoped.capture_id = NEW.capture_id
    AND scoped.account_id = NEW.account_id
    AND statement.account_id = NEW.account_id
    AND evidence_scope.capture_id = NEW.capture_id
    AND evidence_scope.account_id = NEW.account_id
    AND evidence_record.record_kind = 'fubon-credit-card-statement-summary'
    AND evidence_record.occurrence_key = NEW.evidence_key
    AND evidence_subject.source_connection_id = scoped.source_connection_id
    AND evidence_subject.identity_epoch_id = scoped.identity_epoch_id
    AND json_extract(evidence_record.payload_json, '$.statementKey') = statement.statement_key
)
BEGIN
  SELECT RAISE(ABORT, 'Fubon statement summary evidence crosses capture or account scope');
END;
  `);
}

/** Assert the provider extension is already present; lifecycle-opened
 * databases must never create or alter physical objects from a writer. */
export function validateFubonCreditCardSchema(db: DatabaseSync): void {
  const requiredColumns: Record<string, readonly string[]> = {
    fubon_credit_instrument_details: [
      "instrument_id",
      "account_id",
      "instrument_key",
      "card_mask",
      "role",
      "lifecycle",
    ],
    fubon_credit_account_identity_details: [
      "account_id",
      "identity_method",
      "pan_fingerprint",
      "pan_last4",
      "pan_fingerprint_key_version",
    ],
    fubon_credit_instrument_role_evidence: [
      "instrument_id",
      "account_id",
      "capture_id",
      "source_record_id",
    ],
    fubon_credit_transaction_details: [
      "transaction_id",
      "revision_id",
      "source_record_id",
      "capture_id",
      "instrument_id",
      "billing_status",
      "statement_key",
    ],
    fubon_credit_statement_details: [
      "statement_id",
      "account_id",
      "statement_key",
    ],
    fubon_credit_statement_revision_details: [
      "statement_revision_id",
      "statement_id",
      "capture_id",
      "revision_key",
      "revision_number",
      "cycle_start",
      "cycle_end",
      "issue_date",
      "due_date",
      "currency",
      "balance_coefficient",
      "balance_scale",
      "minimum_coefficient",
      "minimum_scale",
      "evidence_source_record_key",
    ],
    fubon_credit_statement_membership_details: [
      "statement_revision_id",
      "transaction_id",
      "transaction_revision_id",
      "source_record_id",
    ],
    fubon_credit_statement_summary_evidence: [
      "statement_revision_id",
      "account_id",
      "capture_id",
      "evidence_key",
      "evidence_source_record_id",
    ],
    fubon_credit_relation_details: [
      "relation_id",
      "account_id",
      "relation_kind",
      "from_transaction_id",
      "to_transaction_id",
      "evidence_source_record_key",
    ],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table)
    )
      throw new Error(`Fubon credit-card table ${table} is missing.`);
    const actual = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).map(
        (column) => column.name,
      ),
    );
    for (const column of columns)
      if (!actual.has(column))
        throw new Error(`Fubon credit-card column ${table}.${column} is missing.`);
  }
  for (const trigger of [
    "fubon_credit_role_evidence_scope_guard",
    "fubon_credit_summary_evidence_scope_guard",
  ])
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get(trigger)
    )
      throw new Error(`Fubon credit-card trigger ${trigger} is missing.`);
}

function canonicalId(): Buffer {
  return randomBytes(16);
}

function validateFubonInstrumentEvidencePayload(
  db: DatabaseSync,
  sourceRecordId: Uint8Array,
  instrument: FubonCreditCardInstrumentInput,
): void {
  const row = db.prepare(
    "SELECT payload_json FROM source_records WHERE source_record_id = ?",
  ).get(sourceRecordId) as { payload_json?: string } | undefined;
  if (!row?.payload_json)
    throw new FubonCreditCardAdmissionError(
      "Fubon instrument role evidence source record is missing.",
    );
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    throw new FubonCreditCardAdmissionError(
      "Fubon instrument role evidence source payload is not valid JSON.",
    );
  }
  const cardMask = payload.cardMask === undefined ? null : payload.cardMask;
  if (
    payload.instrumentKey !== instrument.instrumentKey ||
    cardMask !== (instrument.cardMask ?? null) ||
    (cardMask !== null &&
      (typeof cardMask !== "string" || !/^\*{4}\d{4}$/u.test(cardMask))) ||
    Object.hasOwn(payload, "fullPan") ||
    Object.hasOwn(payload, "cardNumber") ||
    Object.hasOwn(payload, "sourceLabel")
  )
    throw new FubonCreditCardAdmissionError(
      "Fubon instrument role evidence source payload is inconsistent with the instrument.",
    );
}

export type FubonCreditCardCommitResult = {
  status: "canonical-live";
  canonicalAdmission: "admitted";
  captureId: string;
  accountId: string;
  commitSequence: number;
  transactionCount: number;
  statementCount: number;
  relationCount: number;
  provenanceCount: number;
};

function hasValidatedCapture(
  capture: unknown,
): capture is FubonCreditCardValidatedCapture {
  return isAdmittedFubonCreditCardCapture(capture);
}

export async function commitFubonCreditCardCapture(
  store: FubonCreditCardWriterStore,
  capture: FubonCreditCardValidatedCapture,
): Promise<FubonCreditCardCommitResult> {
  return (await commitFubonCreditCardCaptureBatch(store, [capture]))[0]!;
}

function opaqueFubonSpineToken(label: string, value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([label, value]))
    .digest("base64url")}`;
}

function fubonCanonicalSpineCapture(
  capture: FubonCreditCardValidatedCapture,
): CanonicalFinancialDepositValidatedCapture {
  const instrumentsByKey = new Map(
    capture.instruments.map((instrument) => [instrument.instrumentKey, instrument]),
  );
  const records = capture.transactions.map((transaction, sourceOrderOrdinal) => {
    const instrument = instrumentsByKey.get(transaction.instrumentKey);
    if (!instrument)
      throw new FubonCreditCardAdmissionError(
        "Fubon transaction instrument is missing from the validated capture.",
      );
    const compact = JSON.stringify({
      occurrenceIndex: transaction.occurrenceIndex,
      sourceScopeKey: transaction.sourceScopeKey ?? null,
      statementKey: transaction.statementKey ?? null,
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
      occurrenceKey: transaction.sourceKey,
      collisionKey: transaction.sourceKey,
      providerKey: "human-attested:no-provider-key",
      humanAttestedOccurrenceKey: transaction.sourceKey,
      contentHash: opaqueFubonSpineToken("fubon-credit-content-v2", compact),
      sequenceLexeme: `observed-source-order:${sourceOrderOrdinal}`,
      compactJson: compact,
      amount: transaction.bookedAmount,
      balanceAfter: null,
      currency: transaction.bookedCurrency,
      direction: transaction.direction,
      sourceTime: {
        localDate: transaction.postingDate,
        localTime: "00:00:00",
        timeZone: "Asia/Taipei",
        epochMilliseconds: Date.parse(`${transaction.postingDate}T00:00:00+08:00`),
        precision: "date" as const,
        timeOrigin: "defaulted_local_midnight" as const,
      },
      effectiveOn: transaction.postingDate,
      transactionDateTimeLocal: `${transaction.postingDate}T00:00:00`,
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
  });
}

function persistFubonCanonicalExtensions(
  db: DatabaseSync,
  captures: readonly FubonCreditCardValidatedCapture[],
): void {
  for (const capture of captures) {
    const scope = db.prepare(
      `SELECT source_capture.capture_id, capture_scope.account_id,
              source_capture.source_subject_id, source_capture.commit_id,
              capture_scope.scope_id
       FROM source_captures source_capture
       JOIN capture_scopes capture_scope
         ON capture_scope.capture_id = source_capture.capture_id
       WHERE source_capture.capture_key = ?`,
    ).get(capture.captureId) as
      | {
          capture_id?: Uint8Array;
          account_id?: Uint8Array;
          source_subject_id?: Uint8Array;
          commit_id?: Uint8Array;
          scope_id?: Uint8Array;
        }
      | undefined;
    if (
      !scope?.capture_id ||
      !scope.account_id ||
      !scope.source_subject_id ||
      !scope.commit_id ||
      !scope.scope_id
    )
      throw new Error("Fubon shared canonical capture scope is missing.");
    const identityMetadata = capture.identity;
    const existingIdentity = db.prepare(
      `SELECT identity_method, pan_fingerprint, pan_last4,
              pan_fingerprint_key_version
       FROM fubon_credit_account_identity_details
       WHERE account_id = ?`,
    ).get(scope.account_id) as
      | {
          identity_method?: string;
          pan_fingerprint?: string | null;
          pan_last4?: string | null;
          pan_fingerprint_key_version?: string | null;
        }
      | undefined;
    const desiredIdentity = {
      identityMethod: identityMetadata.identityMethod,
      panFingerprint: identityMetadata.panFingerprint ?? null,
      panLast4: identityMetadata.panLast4 ?? null,
      panFingerprintKeyVersion: identityMetadata.panFingerprintKeyVersion ?? null,
    };
    if (
      existingIdentity &&
      (existingIdentity.identity_method !== desiredIdentity.identityMethod ||
        (existingIdentity.pan_fingerprint ?? null) !== desiredIdentity.panFingerprint ||
        (existingIdentity.pan_last4 ?? null) !== desiredIdentity.panLast4 ||
        (existingIdentity.pan_fingerprint_key_version ?? null) !==
          desiredIdentity.panFingerprintKeyVersion)
    )
      throw new FubonCreditCardAdmissionError(
        "Fubon account identity metadata changed without a new identity epoch.",
      );
    if (!existingIdentity)
      db.prepare(
        `INSERT INTO fubon_credit_account_identity_details(
          account_id, identity_method, pan_fingerprint, pan_last4,
          pan_fingerprint_key_version
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        scope.account_id,
        desiredIdentity.identityMethod,
        desiredIdentity.panFingerprint,
        desiredIdentity.panLast4,
        desiredIdentity.panFingerprintKeyVersion,
      );

    const statementEvidenceSourceRecord = new Map<string, Uint8Array>();
    for (const statement of capture.statements) {
      const existingRecord = db.prepare(
        `SELECT source_record_id FROM source_records
         WHERE capture_id = ? AND record_kind = 'fubon-credit-card-statement-summary'
           AND occurrence_key = ?`,
      ).get(scope.capture_id, statement.evidence.sourceRecordKey) as
        | { source_record_id?: Uint8Array }
        | undefined;
      const sourceRecordId = existingRecord?.source_record_id ?? canonicalId();
      if (!existingRecord) {
        const payload = JSON.stringify({
          statementKey: statement.statementKey,
          revisionKey: statement.revisionKey,
          cycleStart: statement.cycleStart,
          cycleEnd: statement.cycleEnd,
          issueDate: statement.issueDate,
          dueDate: statement.dueDate,
          currency: statement.currency,
          balance: statement.balance,
          minimumPayment: statement.minimumPayment,
        });
        db.prepare(
          `INSERT INTO source_records(
            source_record_id, capture_id, source_subject_id, commit_id,
            record_kind, sequence_lexeme, provider_key, content_hash,
            occurrence_key, collision_key, description, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          sourceRecordId,
          scope.capture_id,
          scope.source_subject_id,
          scope.commit_id,
          "fubon-credit-card-statement-summary",
          `statement-summary:${statement.statementKey}`,
          "human-attested:no-provider-key",
          opaqueFubonSpineToken("fubon-credit-statement-summary-v2", payload),
          statement.evidence.sourceRecordKey,
          statement.evidence.sourceRecordKey,
          null,
          payload,
        );
        db.prepare(
          `INSERT INTO source_record_scopes(
            source_record_id, scope_id, capture_id, account_id,
            source_subject_id, sequence_lexeme, occurrence_key, commit_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          sourceRecordId,
          scope.scope_id,
          scope.capture_id,
          scope.account_id,
          scope.source_subject_id,
          `statement-summary:${statement.statementKey}`,
          statement.evidence.sourceRecordKey,
          scope.commit_id,
        );
      }
      statementEvidenceSourceRecord.set(statement.evidence.sourceRecordKey, sourceRecordId);
    }
    const sharedTransactions = new Map<
      string,
      { transactionId: Uint8Array; revisionId: Uint8Array; sourceRecordId: Uint8Array }
    >();
    for (const transaction of capture.transactions) {
      const row = db.prepare(
        `SELECT financial_transaction.transaction_id, current_row.revision_id,
                source_record.source_record_id
         FROM financial_transactions financial_transaction
         JOIN current_transactions current_row
           ON current_row.transaction_id = financial_transaction.transaction_id
         JOIN source_records source_record
           ON source_record.capture_id = ? AND source_record.occurrence_key = ?
         WHERE financial_transaction.account_id = ?
           AND financial_transaction.source_sequence = ?`,
      ).get(
        scope.capture_id,
        transaction.sourceKey,
        scope.account_id,
        transaction.sourceKey,
      ) as
        | { transaction_id?: Uint8Array; revision_id?: Uint8Array; source_record_id?: Uint8Array }
        | undefined;
      if (!row?.transaction_id || !row.revision_id || !row.source_record_id)
        throw new Error("Fubon shared canonical transaction is missing.");
      sharedTransactions.set(transaction.sourceRecordKey, {
        transactionId: row.transaction_id,
        revisionId: row.revision_id,
        sourceRecordId: row.source_record_id,
      });
    }
    const instruments = new Map<string, Uint8Array>();
    for (const instrument of capture.instruments) {
      const evidenceTransaction = sharedTransactions.get(
        instrument.evidence!.sourceRecordKey,
      );
      if (!evidenceTransaction)
        throw new FubonCreditCardAdmissionError(
          "Fubon instrument role evidence is not a shared source record in this capture.",
        );
      validateFubonInstrumentEvidencePayload(
        db,
        evidenceTransaction.sourceRecordId,
        instrument,
      );
      const existing = db.prepare(
        `SELECT instrument_id, role, lifecycle, card_mask
         FROM fubon_credit_instrument_details
         WHERE account_id = ? AND instrument_key = ?`,
      ).get(scope.account_id, instrument.instrumentKey) as
        | {
            instrument_id?: Uint8Array;
            role?: string;
            lifecycle?: string | null;
            card_mask?: string | null;
          }
        | undefined;
      if (
        existing &&
        (existing.role !== instrument.role ||
          (existing.lifecycle ?? null) !== (instrument.lifecycle ?? null) ||
          (existing.card_mask !== null &&
            instrument.cardMask !== undefined &&
            existing.card_mask !== instrument.cardMask))
      )
        throw new FubonCreditCardAdmissionError(
          "Fubon card instrument evidence changed without a new identity epoch.",
        );
      const instrumentId = existing?.instrument_id ?? canonicalId();
      if (!existing)
        db.prepare(
          `INSERT INTO fubon_credit_instrument_details(
            instrument_id, account_id, instrument_key, card_mask, role, lifecycle
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          instrumentId,
          scope.account_id,
          instrument.instrumentKey,
          instrument.cardMask ?? null,
          instrument.role,
          instrument.lifecycle ?? null,
        );
      else if (existing.card_mask === null && instrument.cardMask !== undefined)
        db.prepare(
          `UPDATE fubon_credit_instrument_details
           SET card_mask = ?
           WHERE instrument_id = ?`,
        ).run(instrument.cardMask, instrumentId);
      db.prepare(
        `INSERT INTO fubon_credit_instrument_role_evidence(
          instrument_id, account_id, capture_id, source_record_id
        ) VALUES (?, ?, ?, ?)`,
      ).run(
        instrumentId,
        scope.account_id,
        scope.capture_id,
        evidenceTransaction.sourceRecordId,
      );
      instruments.set(instrument.instrumentKey, instrumentId);
    }
    for (const transaction of capture.transactions) {
      const row = sharedTransactions.get(transaction.sourceRecordKey);
      if (!row) throw new Error("Fubon shared canonical transaction is missing.");
      const instrumentId = instruments.get(transaction.instrumentKey);
      if (!instrumentId)
        throw new Error("Fubon typed card instrument is missing.");
      db.prepare(
        `INSERT INTO fubon_credit_transaction_details(
          transaction_id, revision_id, source_record_id, capture_id,
          instrument_id, billing_status, statement_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.transactionId,
        row.revisionId,
        row.sourceRecordId,
        scope.capture_id,
        instrumentId,
        transaction.billingStatus,
        transaction.statementKey ?? null,
      );
    }
    for (const statement of capture.statements) {
      const existingStatement = db.prepare(
        `SELECT statement_id FROM fubon_credit_statement_details
         WHERE account_id = ? AND statement_key = ?`,
      ).get(scope.account_id, statement.statementKey) as
        | { statement_id?: Uint8Array }
        | undefined;
      const statementId = existingStatement?.statement_id ?? canonicalId();
      if (!existingStatement)
        db.prepare(
          `INSERT INTO fubon_credit_statement_details(
            statement_id, account_id, statement_key
          ) VALUES (?, ?, ?)`,
        ).run(statementId, scope.account_id, statement.statementKey);
      const existingRevision = db.prepare(
        `SELECT statement_revision_id, cycle_start, cycle_end, issue_date, due_date,
                currency, balance_coefficient, balance_scale,
                minimum_coefficient, minimum_scale, evidence_source_record_key
         FROM fubon_credit_statement_revision_details
         WHERE statement_id = ? AND revision_key = ?`,
      ).get(statementId, statement.revisionKey) as
        | {
            statement_revision_id?: Uint8Array;
            cycle_start?: string;
            cycle_end?: string;
            issue_date?: string;
            due_date?: string;
            currency?: string;
            balance_coefficient?: string;
            balance_scale?: number;
            minimum_coefficient?: string | null;
            minimum_scale?: number | null;
            evidence_source_record_key?: string;
          }
        | undefined;
      if (existingRevision?.statement_revision_id) {
        const storedMembership = db.prepare(
          `SELECT hex(transaction_id) AS transaction_id,
                  hex(transaction_revision_id) AS transaction_revision_id
           FROM fubon_credit_statement_membership_details
           WHERE statement_revision_id = ?
           ORDER BY transaction_id, transaction_revision_id`,
        ).all(existingRevision.statement_revision_id) as Array<{
          transaction_id?: string;
          transaction_revision_id?: string;
        }>;
        const desiredMembership = statement.transactionSourceKeys
          .map((sourceRecordKey) => {
            const transaction = sharedTransactions.get(sourceRecordKey);
            if (!transaction)
              throw new Error("Fubon Statement shared membership transaction is missing.");
            return {
              transaction_id: Buffer.from(transaction.transactionId).toString("hex").toUpperCase(),
              transaction_revision_id: Buffer.from(transaction.revisionId).toString("hex").toUpperCase(),
            };
          })
          .sort((left, right) =>
            `${left.transaction_id}:${left.transaction_revision_id}`.localeCompare(
              `${right.transaction_id}:${right.transaction_revision_id}`,
            ),
          );
        const sameSummary =
          existingRevision.cycle_start === statement.cycleStart &&
          existingRevision.cycle_end === statement.cycleEnd &&
          existingRevision.issue_date === statement.issueDate &&
          existingRevision.due_date === statement.dueDate &&
          existingRevision.currency === statement.currency &&
          existingRevision.balance_coefficient === statement.balance.coefficient &&
          existingRevision.balance_scale === statement.balance.scale &&
          (existingRevision.minimum_coefficient ?? null) ===
            (statement.minimumPayment?.coefficient ?? null) &&
          (existingRevision.minimum_scale ?? null) ===
            (statement.minimumPayment?.scale ?? null) &&
          existingRevision.evidence_source_record_key === statement.evidence.sourceRecordKey;
        if (!sameSummary || JSON.stringify(storedMembership) !== JSON.stringify(desiredMembership))
          throw new FubonCreditCardAdmissionError(
            "Fubon Statement revision key was reused with changed summary or pinned membership.",
          );
        db.prepare(
          `INSERT INTO fubon_credit_statement_summary_evidence(
            statement_revision_id, account_id, capture_id, evidence_key,
            evidence_source_record_id
          ) VALUES (?, ?, ?, ?, ?)`,
        ).run(
          existingRevision.statement_revision_id,
          scope.account_id,
          scope.capture_id,
          statement.evidence.sourceRecordKey,
          statementEvidenceSourceRecord.get(statement.evidence.sourceRecordKey)!,
        );
        continue;
      }
      const revisionNumber = Number(
        (
          db.prepare(
            `SELECT COALESCE(MAX(revision_number), 0) AS value
             FROM fubon_credit_statement_revision_details WHERE statement_id = ?`,
          ).get(statementId) as { value?: number }
        ).value ?? 0,
      ) + 1;
      const statementRevisionId = canonicalId();
      db.prepare(
        `INSERT INTO fubon_credit_statement_revision_details(
          statement_revision_id, statement_id, capture_id, revision_key,
          revision_number, cycle_start, cycle_end, issue_date, due_date,
          currency, balance_coefficient, balance_scale, minimum_coefficient,
          minimum_scale, evidence_source_record_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        statementRevisionId,
        statementId,
        scope.capture_id,
        statement.revisionKey,
        revisionNumber,
        statement.cycleStart,
        statement.cycleEnd,
        statement.issueDate,
        statement.dueDate,
        statement.currency,
        statement.balance.coefficient,
        statement.balance.scale,
        statement.minimumPayment?.coefficient ?? null,
        statement.minimumPayment?.scale ?? null,
        statement.evidence.sourceRecordKey,
      );
      for (const sourceRecordKey of statement.transactionSourceKeys) {
        const transaction = sharedTransactions.get(sourceRecordKey);
        if (!transaction)
          throw new Error("Fubon Statement shared membership transaction is missing.");
        db.prepare(
          `INSERT INTO fubon_credit_statement_membership_details(
            statement_revision_id, transaction_id, transaction_revision_id,
            source_record_id
          ) VALUES (?, ?, ?, ?)`,
        ).run(
          statementRevisionId,
          transaction.transactionId,
          transaction.revisionId,
          transaction.sourceRecordId,
        );
      }
      db.prepare(
        `INSERT INTO fubon_credit_statement_summary_evidence(
          statement_revision_id, account_id, capture_id, evidence_key,
          evidence_source_record_id
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        statementRevisionId,
        scope.account_id,
        scope.capture_id,
        statement.evidence.sourceRecordKey,
        statementEvidenceSourceRecord.get(statement.evidence.sourceRecordKey)!,
      );
    }
    for (const relation of capture.relations) {
      const from = sharedTransactions.get(relation.fromSourceRecordKey);
      const to = sharedTransactions.get(relation.toSourceRecordKey);
      if (!from || !to)
        throw new Error("Fubon explicit relation endpoint is missing from shared canonical.");
      db.prepare(
        `INSERT OR IGNORE INTO fubon_credit_relation_details(
          relation_id, account_id, relation_kind, from_transaction_id,
          to_transaction_id, evidence_source_record_key
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        canonicalId(),
        scope.account_id,
        relation.kind,
        from.transactionId,
        to.transactionId,
        (relation.evidence as { sourceRecordKey: string }).sourceRecordKey,
      );
    }
  }
}

export async function commitFubonCreditCardCaptureBatch(
  store: FubonCreditCardWriterStore,
  captures: readonly FubonCreditCardValidatedCapture[],
): Promise<FubonCreditCardCommitResult[]> {
  if (captures.length === 0) throw new FubonCreditCardAdmissionError("Fubon credit-card capture batch cannot be empty.");
  for (const capture of captures) {
    if (!hasValidatedCapture(capture))
      throw new FubonCreditCardAdmissionError("Fubon credit-card batch contains an unvalidated capture.");
  }
  if (peekFubonCreditCardHumanAttestationStatus(store.db) === "revoked")
    throw new FubonCreditCardAdmissionError("Fubon credit-card durable human attestation is revoked.");
  const committed = await commitCanonicalFinancialDepositCaptureBatch(
      store,
      captures.map(fubonCanonicalSpineCapture),
    (db) => {
      ensureFubonCreditCardSchema(db);
      recordInitialFubonCreditCardHumanAttestationV2IfMissing(db);
      if (!isFubonCreditCardHumanAttestationV2DurablyActive(db))
        throw new FubonCreditCardAdmissionError(
          "Fubon credit-card durable human attestation is revoked.",
        );
      store.beforeFubonCreditExtensionCommit?.(db);
      persistFubonCanonicalExtensions(db, captures);
    },
  );
  return committed.map((result, index) => {
    const capture = captures[index]!;
    const row = store.db.prepare(
      `SELECT hex(scope.account_id) AS account_id
       FROM source_captures capture
       JOIN capture_scopes scope ON scope.capture_id = capture.capture_id
       WHERE capture.capture_key = ?`,
    ).get(capture.captureId) as { account_id?: string } | undefined;
    if (!row?.account_id)
      throw new Error("Fubon shared canonical account is missing after commit.");
    return {
      status: "canonical-live",
      canonicalAdmission: "admitted",
      captureId: capture.captureId,
      accountId: row.account_id.toLowerCase(),
      commitSequence: result.commitSequence,
      transactionCount: result.transactionCount,
      statementCount: capture.statements.length,
      relationCount: capture.relations.length,
      provenanceCount: result.provenanceCount,
    };
  });
}
