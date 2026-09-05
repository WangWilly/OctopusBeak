import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CanonicalSourceStore } from "./canonical-source-store.ts";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCaptureBatch,
  type CanonicalFinancialDepositValidatedCapture,
} from "./canonical-financial-deposit-writer.ts";
import {
  ensureCanonicalCreditCardSchema,
  persistCanonicalCreditCardExtensions,
  type CanonicalCreditCardPersistenceCapture,
} from "./canonical-credit-card-persistence.ts";
import {
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
  isEsunCreditCardHumanAttestedAccountKey,
  isEsunCreditCardHumanAttestationDurablyActive,
  isEsunCreditCardHumanAttestedV2Active,
  recordInitialEsunCreditCardHumanAttestationIfMissing,
} from "./esun-credit-card-human-attestation.ts";

export {
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
} from "./esun-credit-card-human-attestation.ts";

export const ESUN_CREDIT_CARD_CAPTURE_CONTRACT = Object.freeze({
  source: "esun",
  stream: "credit-card",
  authorityRoute: ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
  contractVersion: ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.evidenceVersion,
  accountType: "credit",
  accountSubtype: "credit_card",
  providerGuaranteed: false,
  occurrenceProviderGuaranteed: false,
  postingRule: "credit-card-records-are-posted-billing-status-independent",
  billingRule: "billed-or-unbilled-independent-of-posting",
  transactionIdentityRule:
    "normalized-content-tuple-plus-contiguous-deterministic-occurrence-v1",
  statementRule: "issuer-close-due-total-minimum-with-prior-close-cycle-start",
  relationRule: "explicit-source-linkage-only",
  completenessRule:
    "default-one-year-combined-grid-page-one-maximum-page-size-card-counts",
} as const);

export const ESUN_CREDIT_CARD_MAX_PAGE_SIZE = 2_147_483_647;

export type EsunCreditCardExactAmount = {
  coefficient: string;
  scale: number;
};

export type EsunCreditCardInstrumentRole =
  | "primary"
  | "supplementary"
  | "virtual"
  | "replacement";

export type EsunCreditCardInstrumentEvidence = {
  kind: "masked-card-projection-hmac";
  sourceRecordKey: string;
  contractVersion: string;
};

export type EsunCreditCardInstrumentInput = {
  instrumentKey: string;
  cardKey: `${number}${number}${number}${number}`;
  cardMask: `****${number}${number}${number}${number}`;
  productName?: string;
  role: EsunCreditCardInstrumentRole;
  evidence: EsunCreditCardInstrumentEvidence;
};

export type EsunCreditCardTransactionInput = {
  sourceRecordKey: string;
  occurrenceIndex: number;
  instrumentKey: string;
  /** The provider's card-consumption date; E.SUN exposes date precision. */
  consumeDate: string;
  /** E.SUN has no separate posting date. The builder uses consumeDate as a
   * date-only posting anchor while retaining the explicit posted status. */
  postingDate?: string | null;
  postingStatus?: "posted" | "pending";
  direction: "inflow" | "outflow";
  bookedAmount: string | EsunCreditCardExactAmount;
  bookedCurrency: string;
  /** Optional source signed lexeme. Its sign must agree with direction. */
  signedAmount?: string;
  foreignCurrency?: string | null;
  foreignAmount?: string | EsunCreditCardExactAmount | null;
  description: string;
  billingStatus: "billed" | "unbilled";
  /** Optional issuer-settled billed-period key; it is never a query date. */
  statementPeriod?: string | null;
  statementKey?: string;
  sourceKey?: string;
};

export type EsunCreditCardGrid = {
  kind: "combined";
  currentPage: number;
  pageSize: number;
  maximumPageSize: number;
  capturedRowCount: number;
  terminal: boolean;
};

export type EsunCreditCardCompleteness = {
  snapshotMode: "full";
  grid: EsunCreditCardGrid;
  billedPeriods: readonly string[];
  billedRowCount: number;
  unbilledRowCount: number;
  recordCount: number;
  cardRowCounts: Readonly<Record<string, number>>;
  /** True only when explicit settled statement evidence is supplied. */
  settledSummaryEvidencePresent?: boolean;
};

export type EsunCreditCardStatementEvidence = {
  kind: "issuer-settled-cycle-summary";
  sourceRecordKey: string;
  settled: true;
};

export type EsunCreditCardStatementInput = {
  statementKey: string;
  revisionKey: string;
  cycleStart: string;
  cycleEnd: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  balance: string | EsunCreditCardExactAmount;
  minimumPayment?: string | EsunCreditCardExactAmount;
  transactionSourceKeys: readonly string[];
  evidence: EsunCreditCardStatementEvidence;
  /** Source period whose billed rows are members of this statement. */
  period?: string;
};

export type EsunCreditCardCaptureInput = {
  captureId: string;
  identity: {
    sourceConnectionKey: string;
    identityEpochKey: string;
    /** Opaque HMAC-derived portfolio key; never a login value or card key. */
    humanAttestedAccountKey: string;
  };
  observedAt: string;
  scope: {
    startDate: string;
    endDate: string;
    completeness: EsunCreditCardCompleteness;
  };
  instruments: readonly EsunCreditCardInstrumentInput[];
  transactions: readonly EsunCreditCardTransactionInput[];
  statements: readonly EsunCreditCardStatementInput[];
};

export type EsunCreditCardAdmittedTransaction = Omit<
  EsunCreditCardTransactionInput,
  "bookedAmount" | "foreignAmount" | "postingDate" | "postingStatus" | "sourceKey"
> & {
  sourceKey: `sha256:${string}`;
  bookedAmount: EsunCreditCardExactAmount;
  foreignAmount: EsunCreditCardExactAmount | null;
  postingDate: string;
  postingStatus: "posted";
  normalizedDescription: string;
};

export type EsunCreditCardAdmittedStatement = Omit<
  EsunCreditCardStatementInput,
  "balance" | "minimumPayment" | "evidence"
> & {
  balance: EsunCreditCardExactAmount;
  minimumPayment: EsunCreditCardExactAmount | null;
  evidence: EsunCreditCardStatementEvidence;
};

export type EsunCreditCardAdmittedCapture = Omit<
  EsunCreditCardCaptureInput,
  "identity" | "scope" | "instruments" | "transactions" | "statements"
> & {
  identity: EsunCreditCardCaptureInput["identity"] & {
    accountNaturalKey: `sha256:${string}`;
    accountType: "credit";
    accountSubtype: "credit_card";
    stream: "credit-card";
    providerGuaranteed: false;
    occurrenceProviderGuaranteed: false;
    identityMethod: "human-attested";
  };
  scope: EsunCreditCardCaptureInput["scope"];
  instruments: readonly EsunCreditCardInstrumentInput[];
  transactions: readonly EsunCreditCardAdmittedTransaction[];
  statements: readonly EsunCreditCardAdmittedStatement[];
  contractVersion: "esun/credit-card/human-attested-v2";
  authorityRoute: "esun/credit-card/human-attested-v2";
};

export type EsunCreditCardValidatedCapture = EsunCreditCardAdmittedCapture & {
  readonly __runtimeValidatedEsunCreditCardCapture: true;
};

export type EsunCreditCardIdentityInput = EsunCreditCardCaptureInput["identity"];

/** A row shape emitted by the E.SUN combined billed/unbilled grid. */
export type EsunCreditCardSourceRow = {
  /**
   * Optional issuer-settled period supplied with the source row. This is
   * intentionally separate from the workflow's rolling query range.
   */
  issuerStatementPeriod?: string | null;
  /** Opaque HMAC of the issuer's masked first-four + last-four projection. */
  instrumentKey: string;
  cardNumber: string;
  consumeDate: string;
  description: string;
  foreignCurrency: string;
  foreignAmount: string;
  paymentCurrency: string;
  twdAmount: string;
  paymentStatus: string;
};

export type EsunCreditCardSettledPeriod = {
  period: string;
  statementKey?: string;
  revisionKey?: string;
  cycleStart: string;
  cycleEnd: string;
  issueDate: string;
  dueDate: string;
  currency?: string;
  balance: string | EsunCreditCardExactAmount;
  minimumPayment?: string | EsunCreditCardExactAmount;
};

export class EsunCreditCardAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EsunCreditCardAdmissionError";
  }
}

const VALIDATED_CAPTURES = new WeakSet<object>();

function fail(message: string): never {
  throw new EsunCreditCardAdmissionError(message);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required.`);
  return value.trim();
}

function validDate(value: unknown, label: string): string {
  const normalized = text(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized))
    fail(`${label} must be YYYY-MM-DD.`);
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  )
    fail(`${label} must be a valid date.`);
  return normalized;
}

function sourceDate(value: string, label: string): string {
  const normalized = text(value, label).replace(/\./gu, "/");
  const match = normalized.match(/^(\d{3,4})\/(\d{2})\/(\d{2})$/u);
  if (!match) return validDate(normalized, label);
  const year = match[1]!.length === 3 ? Number(match[1]) + 1911 : Number(match[1]);
  return validDate(
    `${String(year).padStart(4, "0")}-${match[2]}-${match[3]}`,
    label,
  );
}

function exactAmount(
  input: string | EsunCreditCardExactAmount,
  label: string,
): EsunCreditCardExactAmount {
  if (typeof input === "object" && input !== null) {
    if (
      !/^(?:0|[1-9]\d*)$/u.test(input.coefficient) ||
      !Number.isSafeInteger(input.scale) ||
      input.scale < 0
    )
      fail(`${label} must be an exact non-negative amount.`);
    return { coefficient: input.coefficient, scale: input.scale };
  }
  const value = text(input, label).replaceAll(",", "");
  const match = value.match(/^(\d+)(?:\.(\d+))?$/u);
  if (!match) fail(`${label} must be a non-negative exact decimal.`);
  const integer = match[1]!.replace(/^0+(?=\d)/u, "");
  const fraction = match[2] ?? "";
  const coefficient = `${integer}${fraction}`.replace(/^0+(?=\d)/u, "") || "0";
  if (coefficient === "0") return { coefficient: "0", scale: 0 };
  return { coefficient, scale: fraction.length };
}

function signedAmount(value: string, label: string): {
  sign: "positive" | "negative" | "zero";
  amount: EsunCreditCardExactAmount;
  lexeme: string;
} {
  const normalized = text(value, label).replaceAll(",", "");
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(normalized))
    fail(`${label} must be an exact decimal.`);
  const unsigned = normalized.replace(/^[+-]/u, "");
  const amount = exactAmount(unsigned, label);
  const sign = amount.coefficient === "0"
    ? "zero"
    : normalized.startsWith("-")
      ? "negative"
      : "positive";
  return { sign, amount, lexeme: normalized };
}

function currency(value: unknown, label: string): string {
  const normalized = text(value, label).toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalized)) fail(`${label} must be an ISO currency.`);
  return normalized;
}

function normalizedDescription(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function stableTuple(value: readonly unknown[]): string {
  return JSON.stringify(value);
}

function digest(label: string, value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([label, value]))
    .digest("base64url")}`;
}

function rejectRawIdentityFields(identity: object): void {
  if (
    Object.hasOwn(identity, "account") ||
    Object.hasOwn(identity, "accountNumber") ||
    Object.hasOwn(identity, "fullPan") ||
    Object.hasOwn(identity, "cardNumber") ||
    Object.hasOwn(identity, "pan")
  )
    fail("E.SUN credit-card identity must not contain a raw credential or card number.");
}

function resolvedIdentity(identity: EsunCreditCardIdentityInput): {
  sourceConnectionKey: string;
  identityEpochKey: string;
  humanAttestedAccountKey: string;
  accountNaturalKey: `sha256:${string}`;
} {
  if (identity === null || typeof identity !== "object") fail("E.SUN credit-card identity is required.");
  rejectRawIdentityFields(identity);
  const sourceConnectionKey = text(identity.sourceConnectionKey, "Source connection key");
  const identityEpochKey = text(identity.identityEpochKey, "Identity epoch key");
  const humanAttestedAccountKey = text(
    identity.humanAttestedAccountKey,
    "Human-attested account key",
  );
  if (!isEsunCreditCardHumanAttestedAccountKey(humanAttestedAccountKey))
    fail("Human-attested account key must be opaque and independent of card identity.");
  return {
    sourceConnectionKey,
    identityEpochKey,
    humanAttestedAccountKey,
    accountNaturalKey: digest("esun-credit-account-v1", [
      sourceConnectionKey,
      identityEpochKey,
      humanAttestedAccountKey,
    ]),
  };
}

export function resolveEsunCreditCardIdentity(
  identity: EsunCreditCardIdentityInput,
): {
  readonly sourceConnectionKey: string;
  readonly identityEpochKey: string;
  readonly humanAttestedAccountKey: string;
  readonly accountNaturalKey: `sha256:${string}`;
  readonly identityMethod: "human-attested";
} {
  return { ...resolvedIdentity(identity), identityMethod: "human-attested" };
}

export function buildEsunCreditCardAccountIdentityKey(
  identity: EsunCreditCardIdentityInput,
): `sha256:${string}` {
  return resolvedIdentity(identity).accountNaturalKey;
}

function normalizeSourceScope(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function validateDirection(
  direction: unknown,
): asserts direction is "inflow" | "outflow" {
  if (direction !== "inflow" && direction !== "outflow")
    fail("Transaction direction is required and must be inflow or outflow.");
}

export function buildEsunCreditCardTransactionSourceKey(
  identity: EsunCreditCardIdentityInput,
  record: Pick<
    EsunCreditCardTransactionInput,
    | "instrumentKey"
    | "consumeDate"
    | "postingDate"
    | "direction"
    | "bookedAmount"
    | "bookedCurrency"
    | "signedAmount"
    | "foreignCurrency"
    | "foreignAmount"
    | "description"
    | "billingStatus"
    | "statementKey"
  > & { occurrenceIndex: number; statementKey?: string | null },
): `sha256:${string}` {
  const accountKey = buildEsunCreditCardAccountIdentityKey(identity);
  const amount = record.signedAmount
    ? signedAmount(record.signedAmount, "Signed amount").amount
    : exactAmount(record.bookedAmount, "Booked amount");
  const foreignCurrency = record.foreignCurrency
    ? currency(record.foreignCurrency, "Foreign currency")
    : null;
  const foreignAmount = record.foreignAmount == null
    ? null
    : exactAmount(record.foreignAmount, "Foreign amount");
  if ((foreignCurrency === null) !== (foreignAmount === null))
    fail("Foreign currency and foreign amount must be provided together.");
  validateDirection(record.direction);
  if (!Number.isSafeInteger(record.occurrenceIndex) || record.occurrenceIndex < 0)
    fail("Transaction occurrence index must be a non-negative integer.");
  const tuple = stableTuple([
    "esun-credit-card-transaction-v1",
    accountKey,
    text(record.instrumentKey, "Card instrument key"),
    sourceDate(record.consumeDate, "Consume date"),
    record.postingDate ? sourceDate(record.postingDate, "Posting date") : null,
    record.direction,
    amount.coefficient,
    amount.scale,
    currency(record.bookedCurrency, "Booked currency"),
    foreignCurrency,
    foreignAmount?.coefficient ?? null,
    foreignAmount?.scale ?? null,
    normalizedDescription(text(record.description, "Transaction description")),
    record.billingStatus,
    normalizeSourceScope(record.statementKey),
    record.occurrenceIndex,
  ]);
  return `sha256:${createHash("sha256").update(tuple).digest("base64url")}`;
}

export function buildEsunCreditCardStatementEvidenceKey(
  identity: EsunCreditCardIdentityInput,
  statement: Pick<EsunCreditCardStatementInput, "statementKey" | "cycleStart" | "cycleEnd">,
): `sha256:${string}` {
  const accountKey = buildEsunCreditCardAccountIdentityKey(identity);
  return digest("esun-credit-card-statement-summary-v1", [
    accountKey,
    text(statement.statementKey, "Statement key"),
    validDate(statement.cycleStart, "Statement cycle start"),
    validDate(statement.cycleEnd, "Statement cycle end"),
  ]);
}

function cardKeyFromValue(value: unknown): `${number}${number}${number}${number}` {
  const normalized = text(value, "Card key");
  const digits = normalized.replace(/\D/gu, "");
  if (/^\d{12,19}$/u.test(digits))
    fail("E.SUN source did not provide a display-safe card key; raw card numbers are rejected.");
  if (!/^\d{4}$/u.test(digits))
    fail("E.SUN card instrument requires an explicit four-digit card key.");
  return digits as `${number}${number}${number}${number}`;
}

function validateInstrument(
  instrument: EsunCreditCardInstrumentInput,
): EsunCreditCardInstrumentInput {
  const instrumentKey = text(instrument.instrumentKey, "Card instrument key");
  if (/\d[\d\s-]{11,}\d/u.test(instrumentKey))
    fail("Card instrument key must not contain a full card number.");
  const cardKey = cardKeyFromValue(instrument.cardKey);
  const cardMask = text(instrument.cardMask, "Card display mask");
  if (cardMask !== `****${cardKey}`)
    fail("Card display mask must contain four stars and the same four-digit card key.");
  if (
    instrument.evidence?.kind !== "masked-card-projection-hmac" ||
    instrument.evidence.contractVersion !== ESUN_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion
  )
    fail("E.SUN card instrument lacks versioned masked-projection HMAC evidence.");
  const productName = instrument.productName?.trim() || undefined;
  if (productName && /\d[\d\s-]{11,}\d/u.test(productName))
    fail("Card product name must not contain a full card number.");
  return {
    ...instrument,
    instrumentKey,
    cardKey,
    cardMask: `****${cardKey}`,
    productName,
  };
}

function validateTransaction(
  identity: EsunCreditCardIdentityInput,
  instruments: ReadonlyMap<string, EsunCreditCardInstrumentInput>,
  record: EsunCreditCardTransactionInput,
): EsunCreditCardAdmittedTransaction {
  const sourceRecordKey = text(record.sourceRecordKey, "Source record key");
  if (!Number.isSafeInteger(record.occurrenceIndex) || record.occurrenceIndex < 0)
    fail("Transaction occurrence index must be a non-negative integer.");
  const instrumentKey = text(record.instrumentKey, "Card instrument key");
  if (!instruments.has(instrumentKey)) fail("Transaction references an unknown card instrument.");
  const consumeDate = validDate(record.consumeDate, "Consume date");
  const postingDate = record.postingDate
    ? validDate(record.postingDate, "Posting date")
    : consumeDate;
  if (record.postingStatus === "pending")
    fail("E.SUN credit-card capture requires a resolved posted status.");
  const bookedCurrency = currency(record.bookedCurrency, "Booked currency");
  const parsedSigned = record.signedAmount
    ? signedAmount(record.signedAmount, "Signed amount")
    : null;
  const bookedAmount = exactAmount(record.bookedAmount, "Booked amount");
  if (
    parsedSigned &&
    (parsedSigned.amount.coefficient !== bookedAmount.coefficient ||
      parsedSigned.amount.scale !== bookedAmount.scale)
  )
    fail("Signed amount does not match booked amount.");
  if (
    parsedSigned &&
    (parsedSigned.sign === "zero" ||
      (parsedSigned.sign === "negative" && record.direction !== "outflow") ||
      (parsedSigned.sign === "positive" && record.direction !== "inflow"))
  )
    fail("Signed amount conflicts with transaction direction.");
  validateDirection(record.direction);
  const description = text(record.description, "Transaction description");
  const normalized = normalizedDescription(description);
  if (!normalized) fail("Transaction description cannot be empty.");
  const foreignCurrency = record.foreignCurrency
    ? currency(record.foreignCurrency, "Foreign currency")
    : null;
  const foreignAmount = record.foreignAmount == null
    ? null
    : exactAmount(record.foreignAmount, "Foreign amount");
  if ((foreignCurrency === null) !== (foreignAmount === null))
    fail("Foreign currency and foreign amount must be provided together.");
  const billingStatus = record.billingStatus;
  if (billingStatus !== "billed" && billingStatus !== "unbilled")
    fail("E.SUN billing status is unsupported.");
  const normalizedRecord = {
    ...record,
    sourceRecordKey,
    instrumentKey,
    consumeDate,
    postingDate,
    postingStatus: "posted" as const,
    bookedAmount,
    bookedCurrency,
    direction: record.direction,
    description,
    normalizedDescription: normalized,
    foreignCurrency,
    foreignAmount,
    billingStatus,
    ...(record.statementKey?.trim()
      ? { statementKey: record.statementKey.trim() }
      : {}),
  };
  const sourceKey = buildEsunCreditCardTransactionSourceKey(identity, normalizedRecord);
  if (record.sourceKey && record.sourceKey !== sourceKey)
    fail("Provided transaction source key does not match the contract tuple.");
  return { ...normalizedRecord, sourceKey };
}

function validateCompleteness(
  capture: EsunCreditCardCaptureInput,
  transactions: readonly EsunCreditCardAdmittedTransaction[],
): void {
  const completeness = capture.scope.completeness;
  if (completeness.snapshotMode !== "full")
    fail("E.SUN canonical admission requires a complete capture.");
  const grid = completeness.grid;
  if (
    grid.kind !== "combined" ||
    grid.currentPage !== 1 ||
    grid.pageSize !== ESUN_CREDIT_CARD_MAX_PAGE_SIZE ||
    grid.maximumPageSize !== ESUN_CREDIT_CARD_MAX_PAGE_SIZE ||
    !grid.terminal ||
    !Number.isSafeInteger(grid.capturedRowCount) ||
    grid.capturedRowCount < 0 ||
    grid.capturedRowCount !== transactions.length
  )
    fail("E.SUN capture requires a terminal page-one maximum-size grid with matching row count.");
  const billedCount = transactions.filter((row) => row.billingStatus === "billed").length;
  const unbilledCount = transactions.filter((row) => row.billingStatus === "unbilled").length;
  if (
    completeness.billedRowCount !== billedCount ||
    completeness.unbilledRowCount !== unbilledCount ||
    completeness.recordCount !== transactions.length
  )
    fail("E.SUN completeness counts do not match captured records.");
  if (!Array.isArray(completeness.billedPeriods))
    fail("E.SUN billed periods evidence is required.");
  if (new Set(completeness.billedPeriods).size !== completeness.billedPeriods.length)
    fail("E.SUN billed periods must be distinct.");
  const cardCounts = new Map<string, number>();
  for (const instrument of capture.instruments)
    cardCounts.set(instrument.instrumentKey, 0);
  for (const transaction of transactions) {
    const instrument = capture.instruments.find(
      (candidate) => candidate.instrumentKey === transaction.instrumentKey,
    );
    if (!instrument) fail("E.SUN card instrument is missing from completeness evidence.");
    cardCounts.set(
      instrument.instrumentKey,
      (cardCounts.get(instrument.instrumentKey) ?? 0) + 1,
    );
  }
  const evidenceKeys = Object.keys(completeness.cardRowCounts).sort();
  const observedKeys = [...cardCounts.keys()].sort();
  if (stableTuple(evidenceKeys) !== stableTuple(observedKeys))
    fail("E.SUN card row-count keys do not match observed card instruments.");
  for (const key of observedKeys) {
    const count = completeness.cardRowCounts[key];
    if (!Number.isSafeInteger(count) || count < 0 || count !== cardCounts.get(key))
      fail("E.SUN card row counts do not match captured records.");
  }
  const billedPeriodsFromRows = new Set(
    transactions
      .filter((row) => row.billingStatus === "billed")
      .map((row) => row.statementPeriod?.trim())
      .filter((period): period is string => Boolean(period)),
  );
  if (
    [...billedPeriodsFromRows].some(
      (period) => !completeness.billedPeriods.includes(period),
    )
  )
    fail("E.SUN billed period evidence does not cover all billed rows.");
}

function validateStatement(
  identity: EsunCreditCardIdentityInput,
  statement: EsunCreditCardStatementInput,
  transactions: ReadonlyMap<string, EsunCreditCardAdmittedTransaction>,
): EsunCreditCardAdmittedStatement {
  const statementKey = text(statement.statementKey, "Statement key");
  const revisionKey = text(statement.revisionKey, "Statement revision key");
  const cycleStart = validDate(statement.cycleStart, "Statement cycle start");
  const cycleEnd = validDate(statement.cycleEnd, "Statement cycle end");
  const issueDate = validDate(statement.issueDate, "Statement issue date");
  const dueDate = validDate(statement.dueDate, "Statement due date");
  if (
    cycleStart > cycleEnd ||
    issueDate !== cycleEnd ||
    dueDate < issueDate
  )
    fail("Settled statement cycle or billing dates are invalid.");
  if (statement.minimumPayment == null)
    fail("E.SUN settled statement requires issuer minimum-payment evidence.");
  if (
    statement.evidence?.kind !== "issuer-settled-cycle-summary" ||
    statement.evidence.settled !== true ||
    !text(statement.evidence.sourceRecordKey, "Statement evidence source key")
  )
    fail("Only issuer settled-cycle summary evidence may establish a Statement.");
  if (
    statement.evidence.sourceRecordKey !==
    buildEsunCreditCardStatementEvidenceKey(identity, {
      statementKey,
      cycleStart,
      cycleEnd,
    })
  )
    fail("Statement summary evidence is not scoped to this attested account and cycle.");
  for (const sourceRecordKey of statement.transactionSourceKeys) {
    const transaction = transactions.get(sourceRecordKey);
    if (!transaction) fail("Statement membership references an unknown source record.");
    if (transaction.billingStatus !== "billed")
      fail("Statement membership cannot reference an unbilled transaction.");
    if (transaction.consumeDate < cycleStart || transaction.consumeDate > cycleEnd)
      fail("Statement membership crosses issuer cycle dates.");
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
    minimumPayment: exactAmount(
      statement.minimumPayment,
      "Statement minimum payment",
    ),
    transactionSourceKeys: [...statement.transactionSourceKeys],
    evidence: {
      kind: "issuer-settled-cycle-summary",
      sourceRecordKey: statement.evidence.sourceRecordKey,
      settled: true,
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

export function admitEsunCreditCardCapture(
  capture: EsunCreditCardCaptureInput,
): EsunCreditCardValidatedCapture {
  if (!isEsunCreditCardHumanAttestedV2Active())
    fail("E.SUN credit-card human-attested v1 contract is revoked.");
  if (capture === null || typeof capture !== "object")
    fail("E.SUN credit-card capture is required.");
  text(capture.captureId, "Capture ID");
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(text(capture.observedAt, "Observed at")))
    fail("Observed at must be an ISO timestamp.");
  const identity = resolvedIdentity(capture.identity);
  const startDate = validDate(capture.scope.startDate, "Capture start date");
  const endDate = validDate(capture.scope.endDate, "Capture end date");
  if (startDate > endDate) fail("Capture date scope is inverted.");
  if (!Array.isArray(capture.instruments)) fail("E.SUN card instruments are required.");
  const instruments = new Map<string, EsunCreditCardInstrumentInput>();
  const cardKeys = new Set<string>();
  for (const instrument of capture.instruments) {
    const normalized = validateInstrument(instrument);
    if (instruments.has(normalized.instrumentKey)) fail("Duplicate card instrument key.");
    if (cardKeys.has(normalized.cardKey))
      fail("E.SUN card key is ambiguous; distinct cards cannot share a last-four key.");
    instruments.set(normalized.instrumentKey, normalized);
    cardKeys.add(normalized.cardKey);
  }
  if (!Array.isArray(capture.transactions)) fail("E.SUN transactions are required.");
  const transactions: EsunCreditCardAdmittedTransaction[] = [];
  const sourceKeys = new Set<string>();
  const sourceRecordKeys = new Set<string>();
  const occurrenceOrdinals = new Map<string, number>();
  const transactionsBySourceRecord = new Map<string, EsunCreditCardAdmittedTransaction>();
  for (const record of capture.transactions) {
    const contentIdentity = buildEsunCreditCardTransactionSourceKey(
      capture.identity,
      { ...record, occurrenceIndex: 0 },
    );
    const expected = occurrenceOrdinals.get(contentIdentity) ?? 0;
    if (record.occurrenceIndex !== expected)
      fail("Transaction occurrence indexes must be contiguous in complete observed source order.");
    occurrenceOrdinals.set(contentIdentity, expected + 1);
    const normalized = validateTransaction(capture.identity, instruments, record);
    if (sourceRecordKeys.has(normalized.sourceRecordKey)) fail("Duplicate source record key.");
    if (sourceKeys.has(normalized.sourceKey)) fail("Transaction identity collision within one capture.");
    sourceRecordKeys.add(normalized.sourceRecordKey);
    sourceKeys.add(normalized.sourceKey);
    transactionsBySourceRecord.set(normalized.sourceRecordKey, normalized);
    transactions.push(normalized);
  }
  for (const instrument of instruments.values()) {
    const evidenceKey = text(
      instrument.evidence.sourceRecordKey,
      "Card instrument evidence source record key",
    );
    const evidenceTransaction = transactionsBySourceRecord.get(evidenceKey);
    if (!evidenceTransaction || evidenceTransaction.instrumentKey !== instrument.instrumentKey)
      fail("Card instrument evidence must reference a transaction for the same instrument.");
  }
  validateCompleteness(capture, transactions);
  if (!Array.isArray(capture.statements)) fail("E.SUN statements are required.");
  const statements: EsunCreditCardAdmittedStatement[] = [];
  const statementKeys = new Set<string>();
  for (const statement of capture.statements) {
    const normalized = validateStatement(
      capture.identity,
      statement,
      transactionsBySourceRecord,
    );
    if (statementKeys.has(normalized.statementKey)) fail("Duplicate Statement key within one capture.");
    statementKeys.add(normalized.statementKey);
    statements.push(normalized);
  }
  if (
    statements.length > 0 &&
    capture.scope.completeness.settledSummaryEvidencePresent !== true
  )
    fail("E.SUN settled statement evidence flag is missing.");
  const result = {
    captureId: capture.captureId,
    observedAt: capture.observedAt,
    identity: {
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      humanAttestedAccountKey: identity.humanAttestedAccountKey,
      accountNaturalKey: identity.accountNaturalKey,
      accountType: "credit" as const,
      accountSubtype: "credit_card" as const,
      stream: "credit-card" as const,
      providerGuaranteed: false as const,
      occurrenceProviderGuaranteed: false as const,
      identityMethod: "human-attested" as const,
    },
    scope: {
      startDate,
      endDate,
      completeness: {
        ...capture.scope.completeness,
        billedPeriods: [...capture.scope.completeness.billedPeriods],
        cardRowCounts: { ...capture.scope.completeness.cardRowCounts },
        grid: { ...capture.scope.completeness.grid },
      },
    },
    instruments: [...instruments.values()],
    transactions,
    statements,
    contractVersion: ESUN_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion,
    authorityRoute: ESUN_CREDIT_CARD_CAPTURE_CONTRACT.authorityRoute,
  } satisfies EsunCreditCardAdmittedCapture;
  const frozen = freezeDeep(result) as unknown as EsunCreditCardValidatedCapture;
  VALIDATED_CAPTURES.add(frozen);
  return frozen;
}

export function isAdmittedEsunCreditCardCapture(
  value: unknown,
): value is EsunCreditCardValidatedCapture {
  return value !== null && typeof value === "object" && VALIDATED_CAPTURES.has(value);
}

export const admitEsunCreditCardCaptureEvidence = admitEsunCreditCardCapture;
export const isValidatedEsunCreditCardCapture = isAdmittedEsunCreditCardCapture;

function normalizeSourceRowDate(value: string): string {
  return sourceDate(value, "Consume date");
}

function sourceRowCardKey(row: EsunCreditCardSourceRow): `${number}${number}${number}${number}` {
  return cardKeyFromValue(row.cardNumber);
}

function sourceRowBillingStatus(row: EsunCreditCardSourceRow): "billed" | "unbilled" {
  if (row.paymentStatus === "已入帳") return "billed";
  if (row.paymentStatus === "未入帳") return "unbilled";
  fail("E.SUN payment status is unsupported; capture admission is cancelled.");
}

function sourceRowSignedAmount(row: EsunCreditCardSourceRow): {
  signed: ReturnType<typeof signedAmount>;
  direction: "inflow" | "outflow";
} {
  const signed = signedAmount(row.twdAmount, "TWD amount");
  if (signed.sign === "zero") fail("E.SUN zero-value rows cannot establish direction.");
  return {
    signed,
    direction: signed.sign === "negative" ? "outflow" : "inflow",
  };
}

function sourceRowForeignEvidence(row: EsunCreditCardSourceRow): {
  currency: string | null;
  amount: EsunCreditCardExactAmount | null;
} {
  const foreignCurrency = row.foreignCurrency.trim();
  const foreignAmount = row.foreignAmount.trim();
  if (Boolean(foreignCurrency) !== Boolean(foreignAmount))
    fail("E.SUN foreign currency and foreign amount evidence must be complete together.");
  if (!foreignCurrency) return { currency: null, amount: null };
  return {
    currency: currency(foreignCurrency, "Foreign currency"),
    amount: exactAmount(foreignAmount, "Foreign amount"),
  };
}

function sourceRowBaseIdentity(
  accountIdentity: EsunCreditCardIdentityInput,
  row: EsunCreditCardSourceRow,
  instrumentKey: string,
): string {
  const signed = sourceRowSignedAmount(row);
  const foreign = sourceRowForeignEvidence(row);
  return JSON.stringify([
    instrumentKey,
    normalizeSourceRowDate(row.consumeDate),
    signed.direction,
    signed.signed.amount,
    currency(row.paymentCurrency || "TWD", "Payment currency"),
    foreign.currency,
    foreign.amount,
    normalizedDescription(text(row.description, "Transaction description")),
    sourceRowBillingStatus(row),
    buildEsunCreditCardAccountIdentityKey(accountIdentity),
  ]);
}

function createSourceRowTransaction(
  identity: EsunCreditCardIdentityInput,
  row: EsunCreditCardSourceRow,
  instrumentKey: string,
  occurrenceIndex: number,
): EsunCreditCardTransactionInput {
  const signed = sourceRowSignedAmount(row);
  const foreign = sourceRowForeignEvidence(row);
  const consumeDate = normalizeSourceRowDate(row.consumeDate);
  const billingStatus = sourceRowBillingStatus(row);
  const bookedCurrency = currency(row.paymentCurrency || "TWD", "Payment currency");
  const sourceKey = buildEsunCreditCardTransactionSourceKey(identity, {
    instrumentKey,
    consumeDate,
    postingDate: consumeDate,
    direction: signed.direction,
    bookedAmount: signed.signed.amount,
    bookedCurrency,
    signedAmount: signed.signed.lexeme,
    foreignCurrency: foreign.currency,
    foreignAmount: foreign.amount,
    description: row.description,
    billingStatus,
    statementKey: undefined,
    occurrenceIndex,
  });
  return {
    sourceRecordKey: digest("esun-credit-card-source-record-v1", sourceKey),
    sourceKey,
    occurrenceIndex,
    instrumentKey,
    consumeDate,
    postingDate: consumeDate,
    postingStatus: "posted",
    direction: signed.direction,
    bookedAmount: signed.signed.amount,
    bookedCurrency,
    signedAmount: signed.signed.lexeme,
    foreignCurrency: foreign.currency,
    foreignAmount: foreign.amount,
    description: text(row.description, "Transaction description"),
    billingStatus,
    ...(row.paymentStatus === "已入帳" && row.issuerStatementPeriod?.trim()
      ? { statementPeriod: row.issuerStatementPeriod.trim() }
      : {}),
  };
}

function buildSettledStatements(
  identity: EsunCreditCardIdentityInput,
  periods: readonly EsunCreditCardSettledPeriod[],
  transactions: readonly EsunCreditCardTransactionInput[],
): EsunCreditCardStatementInput[] {
  return periods.map((period) => {
    const statementKey = period.statementKey?.trim() ||
      digest("esun-credit-card-statement-v1", period.period);
    const cycleStart = validDate(period.cycleStart, "Statement cycle start");
    const cycleEnd = validDate(period.cycleEnd, "Statement cycle end");
    if (cycleStart > cycleEnd)
      fail("E.SUN statement cycle start must not follow its cycle end.");
    const memberKeys = transactions
      .filter((transaction) =>
        transaction.billingStatus === "billed" &&
        transaction.consumeDate >= cycleStart &&
        transaction.consumeDate <= cycleEnd)
      .map((transaction) => transaction.sourceRecordKey);
    return {
      statementKey,
      revisionKey:
        period.revisionKey?.trim() ||
        digest("esun-credit-card-statement-revision-v1", [
          statementKey,
          memberKeys,
        ]),
      cycleStart,
      cycleEnd,
      issueDate: period.issueDate,
      dueDate: period.dueDate,
      currency: period.currency ?? "TWD",
      balance: period.balance,
      ...(period.minimumPayment == null
        ? {}
        : { minimumPayment: period.minimumPayment }),
      transactionSourceKeys: memberKeys,
      period: period.period,
      evidence: {
        kind: "issuer-settled-cycle-summary" as const,
        sourceRecordKey: buildEsunCreditCardStatementEvidenceKey(identity, {
          statementKey,
          cycleStart: period.cycleStart,
          cycleEnd: period.cycleEnd,
        }),
        settled: true as const,
      },
    };
  });
}

export type EsunCreditCardCanonicalCaptureOptions = {
  captureId: string;
  observedAt: string;
  startDate: string;
  endDate: string;
  identity: EsunCreditCardIdentityInput;
  statementRows: readonly EsunCreditCardSourceRow[];
  unbilledRows?: readonly EsunCreditCardSourceRow[];
  grid: EsunCreditCardGrid;
  settledPeriods?: readonly EsunCreditCardSettledPeriod[];
};

/**
 * Convert one complete E.SUN combined grid into the strict source contract.
 * Query dates and capture IDs are scope/provenance only; neither enters the
 * transaction identity tuple.  Rows with equal semantic content receive a
 * deterministic ordinal after stable content ordering, preserving legitimate
 * same-day/same-merchant/same-amount duplicates.
 */
export function buildEsunCanonicalCreditCardCapture(
  options: EsunCreditCardCanonicalCaptureOptions,
): EsunCreditCardValidatedCapture {
  if (
    options.grid.currentPage !== 1 ||
    options.grid.pageSize !== ESUN_CREDIT_CARD_MAX_PAGE_SIZE ||
    options.grid.maximumPageSize !== ESUN_CREDIT_CARD_MAX_PAGE_SIZE ||
    !options.grid.terminal
  )
    fail("E.SUN canonical capture requires a complete terminal maximum-size grid.");
  const identity = resolvedIdentity(options.identity);
  const allRows = [
    ...options.statementRows,
    ...(options.unbilledRows ?? []),
  ];
  const instrumentsByKey = new Map<string, `${number}${number}${number}${number}`>();
  for (const row of allRows) {
    const instrumentKey = text(row.instrumentKey, "Card instrument key");
    if (!/^esun_instrument_[A-Za-z0-9_-]{20,}$/u.test(instrumentKey))
      fail("E.SUN source row requires an opaque projected instrument key.");
    const cardKey = sourceRowCardKey(row);
    const knownCardKey = instrumentsByKey.get(instrumentKey);
    if (knownCardKey && knownCardKey !== cardKey)
      fail("E.SUN projected instrument identity conflicts with its display mask.");
    instrumentsByKey.set(instrumentKey, cardKey);
  }
  const descriptors = allRows.map((row, inputIndex) => {
    const cardKey = sourceRowCardKey(row);
    const instrumentKey = text(row.instrumentKey, "Card instrument key");
    return {
      row,
      inputIndex,
      cardKey,
      instrumentKey,
      baseIdentity: sourceRowBaseIdentity(options.identity, row, instrumentKey),
    };
  });
  const ordered = descriptors.slice().sort(
    (left, right) =>
      left.baseIdentity.localeCompare(right.baseIdentity) ||
      left.inputIndex - right.inputIndex,
  );
  const occurrenceIndexes = new Map<string, number>();
  const transactionsByInputIndex = new Map<number, EsunCreditCardTransactionInput>();
  for (const descriptor of ordered) {
    const occurrenceIndex = occurrenceIndexes.get(descriptor.baseIdentity) ?? 0;
    occurrenceIndexes.set(descriptor.baseIdentity, occurrenceIndex + 1);
    transactionsByInputIndex.set(
      descriptor.inputIndex,
      createSourceRowTransaction(
        options.identity,
        descriptor.row,
        descriptor.instrumentKey,
        occurrenceIndex,
      ),
    );
  }
  const transactions = descriptors.map(
    (descriptor) => transactionsByInputIndex.get(descriptor.inputIndex)!,
  );
  const instruments = [...instrumentsByKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([instrumentKey, cardKey]) => {
    const first = transactions.find((transaction) => transaction.instrumentKey === instrumentKey);
    if (!first) fail("E.SUN card instrument has no transaction evidence.");
    return {
      instrumentKey,
      cardKey: cardKey as `${number}${number}${number}${number}`,
      cardMask: `****${cardKey}` as `****${number}${number}${number}${number}`,
      role: "primary" as const,
      evidence: {
        kind: "masked-card-projection-hmac" as const,
        sourceRecordKey: first.sourceRecordKey,
        contractVersion: ESUN_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion,
      },
    };
  });
  const billedRows = transactions.filter((row) => row.billingStatus === "billed");
  const unbilledRows = transactions.filter((row) => row.billingStatus === "unbilled");
  const billedPeriods = [
    ...new Set(
      billedRows
        .map((row) => row.statementPeriod?.trim())
        .filter((period): period is string => Boolean(period)),
    ),
  ];
  const cardRowCounts = Object.fromEntries(
    [...instrumentsByKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([instrumentKey]) => [
      instrumentKey,
      transactions.filter(
        (transaction) => transaction.instrumentKey === instrumentKey,
      ).length,
    ]),
  );
  const statements = buildSettledStatements(
    options.identity,
    options.settledPeriods ?? [],
    transactions,
  );
  return admitEsunCreditCardCapture({
    captureId: text(options.captureId, "Capture ID"),
    identity: {
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      humanAttestedAccountKey: identity.humanAttestedAccountKey,
    },
    observedAt: text(options.observedAt, "Observed at"),
    scope: {
      startDate: sourceDate(options.startDate, "Capture start date"),
      endDate: sourceDate(options.endDate, "Capture end date"),
      completeness: {
        snapshotMode: "full",
        grid: { ...options.grid },
        billedPeriods,
        billedRowCount: billedRows.length,
        unbilledRowCount: unbilledRows.length,
        recordCount: transactions.length,
        cardRowCounts,
        settledSummaryEvidencePresent: statements.length > 0,
      },
    },
    instruments,
    transactions,
    statements,
  });
}

export const buildEsunCanonicalCreditCardCaptures = (
  options: EsunCreditCardCanonicalCaptureOptions,
): EsunCreditCardValidatedCapture[] => [
  buildEsunCanonicalCreditCardCapture(options),
];

/**
 * Project an admitted E.SUN capture into the provider-neutral credit-card
 * extension shape.  The generic writer uses a transaction's source key as
 * its occurrence key, so every extension source-record reference is resolved
 * to that same key before persistence.
 */
export function esunNeutralCreditCardCapture(
  capture: EsunCreditCardValidatedCapture,
): CanonicalCreditCardPersistenceCapture {
  if (!isAdmittedEsunCreditCardCapture(capture))
    fail("E.SUN credit-card neutral projection requires an admitted capture.");

  const transactionsBySourceRecordKey = new Map(
    capture.transactions.map((transaction) => [
      transaction.sourceRecordKey,
      transaction,
    ]),
  );
  const spineOccurrenceKey = (value: string): string => {
    const transaction = transactionsBySourceRecordKey.get(value);
    if (!transaction)
      fail("E.SUN neutral credit-card evidence references an unknown source record.");
    return transaction.sourceKey;
  };

  return {
    integrationNamespace: "esun",
    captureId: capture.captureId,
    identity: {
      accountNaturalKey: capture.identity.accountNaturalKey,
      identityMethod: capture.identity.identityMethod,
    },
    instruments: capture.instruments.map((instrument) => ({
      instrumentKey: instrument.instrumentKey,
      cardMask: instrument.cardMask,
      role: instrument.role,
      evidence: {
        sourceRecordKey: spineOccurrenceKey(instrument.evidence.sourceRecordKey),
      },
    })),
    transactions: capture.transactions.map((transaction) => ({
      sourceRecordKey: transaction.sourceKey,
      sourceKey: transaction.sourceKey,
      instrumentKey: transaction.instrumentKey,
      billingStatus: transaction.billingStatus,
      ...(transaction.statementKey === undefined
        ? {}
        : { statementKey: transaction.statementKey }),
    })),
    statements: capture.statements.map((statement) => ({
      statementKey: statement.statementKey,
      revisionKey: statement.revisionKey,
      cycleStart: statement.cycleStart,
      cycleEnd: statement.cycleEnd,
      issueDate: statement.issueDate,
      dueDate: statement.dueDate,
      currency: statement.currency,
      balance: statement.balance,
      minimumPayment: statement.minimumPayment,
      transactionSourceKeys: statement.transactionSourceKeys.map(spineOccurrenceKey),
      evidence: {
        sourceRecordKey: statement.evidence.sourceRecordKey,
        settled: true as const,
      },
    })),
  };
}

export type EsunCreditCardWriterStore = Pick<
  CanonicalSourceStore,
  "db" | "databasePath" | "commitClock"
> & {
  readonly beforeEsunCreditExtensionCommit?: (db: DatabaseSync) => void;
};

export type EsunCreditCardCommitResult = {
  status: "canonical-live";
  canonicalAdmission: "admitted";
  captureId: string;
  accountId: string;
  commitSequence: number;
  transactionCount: number;
  statementCount: number;
  provenanceCount: number;
};

function opaqueEsunSpineToken(label: string, value: unknown): `sha256:${string}` {
  return digest(label, value);
}

function esunCanonicalSpineCapture(
  capture: EsunCreditCardValidatedCapture,
): CanonicalFinancialDepositValidatedCapture {
  const instrumentsByKey = new Map(
    capture.instruments.map((instrument) => [instrument.instrumentKey, instrument]),
  );
  const records = capture.transactions.map((transaction, sourceOrderOrdinal) => {
    const instrument = instrumentsByKey.get(transaction.instrumentKey);
    if (!instrument)
      throw new EsunCreditCardAdmissionError(
        "E.SUN transaction instrument is missing from the validated capture.",
      );
    const compact = JSON.stringify({
      sourceRecordKey: transaction.sourceRecordKey,
      occurrenceIndex: transaction.occurrenceIndex,
      instrumentKey: transaction.instrumentKey,
      cardMask: instrument.cardMask,
      consumeDate: transaction.consumeDate,
      postingDate: transaction.postingDate,
      amount: transaction.bookedAmount,
      currency: transaction.bookedCurrency,
      direction: transaction.direction,
      description: transaction.description,
      billingStatus: transaction.billingStatus,
      statementPeriod: transaction.statementPeriod ?? null,
    });
    return {
      occurrenceKey: transaction.sourceKey,
      collisionKey: transaction.sourceKey,
      providerKey: "human-attested:no-provider-key",
      humanAttestedOccurrenceKey: transaction.sourceKey,
      contentHash: opaqueEsunSpineToken("esun-credit-content-v1", compact),
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
              evidenceOrigin: "esun-credit-card-source-reported-original-amount",
            },
          }
        : {}),
    };
  });
  const fingerprint = opaqueEsunSpineToken("esun-credit-contract-v1", {
    authority: capture.authorityRoute,
    billedPeriods: capture.scope.completeness.billedPeriods,
    grid: capture.scope.completeness.grid,
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
      recordKind: "esun-credit-card-statement-summary",
      occurrenceKey: statement.evidence.sourceRecordKey,
      collisionKey: statement.evidence.sourceRecordKey,
      providerKey: "human-attested:no-provider-key",
      contentHash: `sha256:${createHash("sha256").update(compactJson).digest("hex")}`,
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
      integrationNamespace: "esun",
      sourceConnectionKey: opaqueEsunSpineToken(
        "esun-credit-connection-v1",
        capture.identity.sourceConnectionKey,
      ),
      identityEpochKey: opaqueEsunSpineToken(
        "esun-credit-epoch-v1",
        capture.identity.identityEpochKey,
      ),
      stream: "credit-card",
      recordKind: "esun-credit-card-transaction",
      subjectDigest: capture.identity.accountNaturalKey,
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
      completenessBasis:
        "default-one-year-combined-grid-page-one-maximum-page-size-card-counts",
      completenessRuleVersion: capture.contractVersion,
      absenceAuthority: null,
      contractFingerprint: fingerprint,
      preflightFingerprint: fingerprint,
      pageCount: 1,
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
    pages: [{
      pageOrdinal: 0,
      responseCode: "200",
      terminal: true,
      rowCount: records.length,
      responseDigest: opaqueEsunSpineToken("esun-credit-page-v1", [
        capture.captureId,
        capture.scope.completeness.grid,
      ]),
      proofKind: "source-declared-terminal-grid",
      contractFingerprint: fingerprint,
      preflightFingerprint: fingerprint,
      metadataJson: JSON.stringify(capture.scope.completeness.grid),
    }],
    records,
    nonTransactionRecords,
  });
}

function esunNeutralCreditCardCaptureForCommit(
  db: DatabaseSync,
  capture: EsunCreditCardValidatedCapture,
): CanonicalCreditCardPersistenceCapture {
  const projected = esunNeutralCreditCardCapture(capture);
  const currentRevisionKeys = new Set(
    projected.transactions
      .filter((transaction) =>
        db.prepare(`
          SELECT 1
          FROM source_records record
          JOIN transaction_revisions revision
            ON revision.source_record_id = record.source_record_id
          JOIN financial_transactions financial
            ON financial.transaction_id = revision.transaction_id
          WHERE record.capture_id = (
            SELECT capture_id FROM source_captures WHERE capture_key = ?
          )
            AND record.occurrence_key = ?
            AND financial.source_sequence = ?
        `).get(
          capture.captureId,
          transaction.sourceRecordKey,
          transaction.sourceKey,
        ) !== undefined,
      )
      .map((transaction) => transaction.sourceRecordKey),
  );
  if (currentRevisionKeys.size === projected.transactions.length)
    return projected;
  return {
    ...projected,
    // The generic writer intentionally deduplicates an identical occurrence
    // without creating a second revision.  The neutral persistence contract
    // can only link extension facts to a revision in this capture, so retain
    // only rows with a current-capture revision on repeat observations.
    transactions: projected.transactions.filter((transaction) =>
      currentRevisionKeys.has(transaction.sourceRecordKey),
    ),
    statements: projected.statements.filter((statement) =>
      statement.transactionSourceKeys.every((key) => currentRevisionKeys.has(key)),
    ),
  };
}

function hasValidatedEsunCreditCardCapture(
  capture: unknown,
): capture is EsunCreditCardValidatedCapture {
  return isAdmittedEsunCreditCardCapture(capture);
}

export async function commitEsunCreditCardCapture(
  store: EsunCreditCardWriterStore,
  capture: EsunCreditCardValidatedCapture,
): Promise<EsunCreditCardCommitResult> {
  return (await commitEsunCreditCardCaptureBatch(store, [capture]))[0]!;
}

export async function commitEsunCreditCardCaptureBatch(
  store: EsunCreditCardWriterStore,
  captures: readonly EsunCreditCardValidatedCapture[],
): Promise<EsunCreditCardCommitResult[]> {
  if (captures.length === 0)
    throw new EsunCreditCardAdmissionError(
      "E.SUN credit-card capture batch cannot be empty.",
    );
  for (const capture of captures) {
    if (!hasValidatedEsunCreditCardCapture(capture))
      throw new EsunCreditCardAdmissionError(
        "E.SUN credit-card batch contains an unvalidated capture.",
      );
  }
  if (!isEsunCreditCardHumanAttestedV2Active())
    throw new EsunCreditCardAdmissionError(
      "E.SUN credit-card human-attested v1 contract is revoked.",
    );
  const committed = await commitCanonicalFinancialDepositCaptureBatch(
    store,
    captures.map(esunCanonicalSpineCapture),
    (db) => {
      ensureCanonicalCreditCardSchema(db);
      recordInitialEsunCreditCardHumanAttestationIfMissing(db);
      if (!isEsunCreditCardHumanAttestationDurablyActive(db))
        throw new EsunCreditCardAdmissionError(
          "E.SUN credit-card durable human attestation is revoked.",
        );
      store.beforeEsunCreditExtensionCommit?.(db);
      persistCanonicalCreditCardExtensions(
        db,
        captures.map((capture) => esunNeutralCreditCardCaptureForCommit(db, capture)),
      );
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
      throw new Error("E.SUN shared canonical account is missing after commit.");
    return {
      status: "canonical-live",
      canonicalAdmission: "admitted",
      captureId: capture.captureId,
      accountId: row.account_id.toLowerCase(),
      commitSequence: result.commitSequence,
      transactionCount: result.transactionCount,
      statementCount: capture.statements.length,
      provenanceCount: result.provenanceCount,
    };
  });
}
