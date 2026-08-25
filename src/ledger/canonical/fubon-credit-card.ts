import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CanonicalSourceStore } from "./canonical-source-store.ts";
import {
  withCanonicalSnapshot,
  withCanonicalWriterQueue,
} from "./canonical-runtime.ts";
import {
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  getFubonCreditCardHumanAttestedV1Manifest,
  isFubonCreditCardHumanAttestedAccountKey,
  isFubonCreditCardHumanAttestedV1Active,
  recordInitialFubonCreditCardHumanAttestationIfMissing,
} from "./fubon-credit-card-human-attestation.ts";

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
    humanAttestedAccountKey: string;
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
  identity: FubonCreditCardCaptureInput["identity"] & {
    accountNaturalKey: string;
    accountType: "credit";
    accountSubtype: "credit_card";
    stream: "credit-card";
    providerGuaranteed: false;
    occurrenceProviderGuaranteed: false;
  };
  scope: FubonCreditCardCaptureInput["scope"];
  instruments: readonly FubonCreditCardInstrumentInput[];
  transactions: readonly FubonCreditCardAdmittedTransaction[];
  statements: readonly FubonCreditCardAdmittedStatement[];
  relations: readonly FubonCreditCardRelationInput[];
  contractVersion: "fubon/credit-card/human-attested-v1";
  authorityRoute: "fubon/credit-card/human-attested-v1";
};

export type FubonCreditCardValidatedCapture = FubonCreditCardAdmittedCapture & {
  readonly __runtimeValidatedFubonCreditCardCapture: true;
};

export const FUBON_CREDIT_CARD_CAPTURE_CONTRACT = Object.freeze({
  source: "fubon",
  stream: "credit-card",
  authorityRoute: FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute,
  contractVersion: FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion,
  accountType: "credit",
  accountSubtype: "credit_card",
  providerGuaranteed: false,
  occurrenceProviderGuaranteed: false,
  postingRule: "posting-date-present-means-posted",
  billingRule: "billed-or-unbilled-independent-of-posting",
  statementRule: "issuer-settled-cycle-summary-only",
  relationRule: "explicit-source-linkage-only",
} as const);

export class FubonCreditCardAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FubonCreditCardAdmissionError";
  }
}

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

export function buildFubonCreditCardAccountIdentityKey(identity: {
  sourceConnectionKey: string;
  identityEpochKey: string;
  humanAttestedAccountKey: string;
}): string {
  const connection = text(identity.sourceConnectionKey, "Source connection key");
  const epoch = text(identity.identityEpochKey, "Identity epoch key");
  const accountKey = text(identity.humanAttestedAccountKey, "Human-attested account key");
  if (!isFubonCreditCardHumanAttestedAccountKey(accountKey))
    fail("Human-attested account key must be opaque and independent of card identity.");
  return `fubon:${connection}:${epoch}:credit-card:${accountKey}`;
}

export function buildFubonCreditCardTransactionSourceKey(
  identity: {
    sourceConnectionKey: string;
    identityEpochKey: string;
    humanAttestedAccountKey: string;
  },
  record: FubonCreditCardTransactionInput,
): `sha256:${string}` {
  const accountKey = buildFubonCreditCardAccountIdentityKey(identity);
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
    "fubon-credit-card-transaction-v1",
    accountKey,
    text(record.instrumentKey, "Card instrument key"),
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
  ]);
  return `sha256:${createHash("sha256").update(tuple).digest("base64url")}`;
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
  if (instrument.role !== "primary") {
    if (
      !instrument.evidence ||
      instrument.evidence.kind !== "explicit-instrument-role" ||
      instrument.evidence.contractVersion !== FUBON_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion
    )
      fail(`Unsupported ${instrument.role} card instrument lacks explicit versioned evidence.`);
  }
  if (instrument.lifecycle && !instrument.evidence) {
    fail("Card lifecycle facts require explicit versioned evidence.");
  }
  return {
    ...instrument,
    instrumentKey,
    cardMask: instrument.cardMask?.trim() || undefined,
    productName: instrument.productName?.trim() || undefined,
  };
}

function validateTransaction(
  identity: FubonCreditCardCaptureInput["identity"],
  instruments: ReadonlyMap<string, FubonCreditCardInstrumentInput>,
  record: FubonCreditCardTransactionInput,
): FubonCreditCardAdmittedTransaction {
  const sourceRecordKey = text(record.sourceRecordKey, "Source record key");
  const instrumentKey = text(record.instrumentKey, "Card instrument key");
  if (!instruments.has(instrumentKey)) fail("Transaction references an unknown card instrument.");
  const consumeDate = validDate(record.consumeDate, "Consume date");
  const postingDate = validDate(record.postingDate, "Posting date");
  if (record.postingStatus === "pending")
    fail("Fubon v1 requires posted credit-card transactions when posting date is present.");
  const bookedAmount = exactAmount(record.bookedAmount, "Booked amount");
  const bookedCurrency = currency(record.bookedCurrency, "Booked currency");
  const description = text(record.description, "Transaction description");
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
  const sourceKey = buildFubonCreditCardTransactionSourceKey(identity, record);
  if (record.sourceKey && record.sourceKey !== sourceKey)
    fail("Provided transaction source key does not match the contract tuple.");
  return {
    ...record,
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
  statement: FubonCreditCardStatementInput,
  sourceRecordKeys: ReadonlySet<string>,
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
  for (const sourceKey of statement.transactionSourceKeys) {
    if (!sourceRecordKeys.has(sourceKey))
      fail("Statement membership references an unknown source record.");
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
  sourceRecordKeys: ReadonlySet<string>,
): FubonCreditCardRelationInput {
  if (!sourceRecordKeys.has(relation.fromSourceRecordKey) || !sourceRecordKeys.has(relation.toSourceRecordKey))
    fail("Transaction relation references an unknown source record.");
  if (relation.fromSourceRecordKey === relation.toSourceRecordKey)
    fail("Transaction relation cannot connect a transaction to itself.");
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
  return {
    ...relation,
    fromSourceRecordKey: relation.fromSourceRecordKey.trim(),
    toSourceRecordKey: relation.toSourceRecordKey.trim(),
    evidence: {
      kind: "explicit-source-linkage",
      sourceRecordKey: evidence.sourceRecordKey.trim(),
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
): FubonCreditCardValidatedCapture {
  if (!isFubonCreditCardHumanAttestedV1Active())
    fail("Fubon credit-card human-attested v1 contract is revoked.");
  if (capture === null || typeof capture !== "object") fail("Fubon credit-card capture is required.");
  text(capture.captureId, "Capture ID");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text(capture.observedAt, "Observed at")))
    fail("Observed at must be an ISO timestamp.");
  const accountNaturalKey = buildFubonCreditCardAccountIdentityKey(capture.identity);
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
  for (const record of capture.transactions) {
    const normalized = validateTransaction(capture.identity, instruments, record);
    if (sourceRecordKeys.has(normalized.sourceRecordKey)) fail("Duplicate source record key.");
    if (sourceKeys.has(normalized.sourceKey)) fail("Transaction identity collision within one capture.");
    sourceRecordKeys.add(normalized.sourceRecordKey);
    sourceKeys.add(normalized.sourceKey);
    transactions.push(normalized);
  }
  validateCompleteness(capture, transactions);
  if (!Array.isArray(capture.statements)) fail("Fubon credit-card statements are required.");
  const statements: FubonCreditCardAdmittedStatement[] = [];
  const statementKeys = new Set<string>();
  for (const statement of capture.statements) {
    const normalized = validateStatement(statement, sourceRecordKeys);
    if (statementKeys.has(normalized.statementKey)) fail("Duplicate Statement key within one capture.");
    statementKeys.add(normalized.statementKey);
    statements.push(normalized);
  }
  if (statements.length === 0) fail("Fubon credit-card capture is missing settled statement summary.");
  if (!Array.isArray(capture.relations)) fail("Fubon credit-card relations are required.");
  const relations = capture.relations.map((relation) => validateRelation(relation, sourceRecordKeys));
  const result = {
    captureId: capture.captureId,
    observedAt: capture.observedAt,
    identity: {
      ...capture.identity,
      accountNaturalKey,
      accountType: "credit" as const,
      accountSubtype: "credit_card" as const,
      stream: "credit-card" as const,
      providerGuaranteed: false as const,
      occurrenceProviderGuaranteed: false as const,
    },
    scope: {
      startDate,
      endDate,
      completeness: {
        ...capture.scope.completeness,
        billedPeriods: [...capture.scope.completeness.billedPeriods],
        periodRowCounts: [...capture.scope.completeness.periodRowCounts],
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
>;

const FUBON_CREDIT_CARD_SCHEMA = `
CREATE TABLE IF NOT EXISTS fubon_credit_accounts (
  account_id BLOB PRIMARY KEY CHECK(length(account_id) = 16),
  source_connection_key TEXT NOT NULL,
  identity_epoch_key TEXT NOT NULL,
  stream TEXT NOT NULL CHECK(stream = 'credit-card'),
  human_attested_account_key TEXT NOT NULL,
  account_natural_key TEXT NOT NULL UNIQUE,
  account_type TEXT NOT NULL CHECK(account_type = 'credit'),
  account_subtype TEXT NOT NULL CHECK(account_subtype = 'credit_card'),
  provider_guaranteed INTEGER NOT NULL CHECK(provider_guaranteed = 0),
  occurrence_provider_guaranteed INTEGER NOT NULL CHECK(occurrence_provider_guaranteed = 0),
  created_commit_sequence INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fubon_credit_accounts_scope
  ON fubon_credit_accounts(source_connection_key, identity_epoch_key, stream, human_attested_account_key);

CREATE TABLE IF NOT EXISTS fubon_credit_card_instruments (
  instrument_id BLOB PRIMARY KEY CHECK(length(instrument_id) = 16),
  account_id BLOB NOT NULL REFERENCES fubon_credit_accounts(account_id),
  instrument_key TEXT NOT NULL,
  card_mask TEXT,
  product_name TEXT,
  role TEXT NOT NULL CHECK(role IN ('primary','supplementary','virtual','replacement')),
  lifecycle TEXT,
  created_commit_sequence INTEGER NOT NULL,
  UNIQUE(account_id, instrument_key)
);
CREATE INDEX IF NOT EXISTS idx_fubon_credit_card_instruments_account
  ON fubon_credit_card_instruments(account_id, instrument_key);

CREATE TABLE IF NOT EXISTS fubon_credit_card_captures (
  capture_id TEXT PRIMARY KEY,
  account_id BLOB NOT NULL REFERENCES fubon_credit_accounts(account_id),
  observed_at TEXT NOT NULL,
  scope_start TEXT NOT NULL,
  scope_end TEXT NOT NULL,
  completeness_json TEXT NOT NULL,
  authority_route TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  commit_sequence INTEGER NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS fubon_credit_card_transactions (
  transaction_id BLOB PRIMARY KEY CHECK(length(transaction_id) = 16),
  account_id BLOB NOT NULL REFERENCES fubon_credit_accounts(account_id),
  source_key TEXT NOT NULL,
  created_commit_sequence INTEGER NOT NULL,
  UNIQUE(account_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_fubon_credit_card_transactions_account
  ON fubon_credit_card_transactions(account_id, source_key);

CREATE TABLE IF NOT EXISTS fubon_credit_card_source_records (
  source_record_id BLOB PRIMARY KEY CHECK(length(source_record_id) = 16),
  capture_id TEXT NOT NULL REFERENCES fubon_credit_card_captures(capture_id),
  account_id BLOB NOT NULL REFERENCES fubon_credit_accounts(account_id),
  source_record_key TEXT NOT NULL,
  source_key TEXT NOT NULL,
  transaction_id BLOB NOT NULL REFERENCES fubon_credit_card_transactions(transaction_id),
  compact_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  commit_sequence INTEGER NOT NULL,
  UNIQUE(capture_id, source_record_key)
);
CREATE INDEX IF NOT EXISTS idx_fubon_credit_card_source_records_identity
  ON fubon_credit_card_source_records(account_id, source_record_key, commit_sequence);

CREATE TABLE IF NOT EXISTS fubon_credit_card_transaction_revisions (
  revision_id BLOB PRIMARY KEY CHECK(length(revision_id) = 16),
  transaction_id BLOB NOT NULL REFERENCES fubon_credit_card_transactions(transaction_id),
  source_record_id BLOB NOT NULL REFERENCES fubon_credit_card_source_records(source_record_id),
  capture_id TEXT NOT NULL REFERENCES fubon_credit_card_captures(capture_id),
  revision_number INTEGER NOT NULL,
  instrument_key TEXT NOT NULL,
  consume_date TEXT NOT NULL,
  posting_date TEXT NOT NULL,
  posting_status TEXT NOT NULL CHECK(posting_status = 'posted'),
  direction TEXT NOT NULL CHECK(direction IN ('inflow','outflow')),
  booked_coefficient TEXT NOT NULL,
  booked_scale INTEGER NOT NULL CHECK(booked_scale >= 0),
  booked_currency TEXT NOT NULL,
  foreign_coefficient TEXT,
  foreign_scale INTEGER,
  foreign_currency TEXT,
  description TEXT NOT NULL,
  normalized_description TEXT NOT NULL,
  installment_key TEXT,
  correction_key TEXT,
  commit_sequence INTEGER NOT NULL,
  UNIQUE(transaction_id, revision_number)
);
CREATE INDEX IF NOT EXISTS idx_fubon_credit_card_revisions_transaction
  ON fubon_credit_card_transaction_revisions(transaction_id, revision_number, commit_sequence);

CREATE TABLE IF NOT EXISTS fubon_credit_card_current_transactions (
  transaction_id BLOB PRIMARY KEY REFERENCES fubon_credit_card_transactions(transaction_id),
  revision_id BLOB NOT NULL REFERENCES fubon_credit_card_transaction_revisions(revision_id),
  commit_sequence INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fubon_credit_card_transaction_provenance (
  transaction_id BLOB NOT NULL REFERENCES fubon_credit_card_transactions(transaction_id),
  capture_id TEXT NOT NULL REFERENCES fubon_credit_card_captures(capture_id),
  source_record_id BLOB NOT NULL REFERENCES fubon_credit_card_source_records(source_record_id),
  source_record_key TEXT NOT NULL,
  commit_sequence INTEGER NOT NULL,
  PRIMARY KEY(transaction_id, capture_id, source_record_id)
);
CREATE INDEX IF NOT EXISTS idx_fubon_credit_card_transaction_provenance_capture
  ON fubon_credit_card_transaction_provenance(capture_id, transaction_id);

CREATE TABLE IF NOT EXISTS fubon_credit_card_billing_observations (
  observation_id BLOB PRIMARY KEY CHECK(length(observation_id) = 16),
  transaction_id BLOB NOT NULL REFERENCES fubon_credit_card_transactions(transaction_id),
  capture_id TEXT NOT NULL REFERENCES fubon_credit_card_captures(capture_id),
  source_record_id BLOB NOT NULL REFERENCES fubon_credit_card_source_records(source_record_id),
  billing_status TEXT NOT NULL CHECK(billing_status IN ('billed','unbilled')),
  statement_key TEXT,
  commit_sequence INTEGER NOT NULL,
  UNIQUE(transaction_id, capture_id, source_record_id)
);
CREATE INDEX IF NOT EXISTS idx_fubon_credit_card_billing_latest
  ON fubon_credit_card_billing_observations(transaction_id, commit_sequence, observation_id);

CREATE TABLE IF NOT EXISTS fubon_credit_statements (
  statement_id BLOB PRIMARY KEY CHECK(length(statement_id) = 16),
  account_id BLOB NOT NULL REFERENCES fubon_credit_accounts(account_id),
  statement_key TEXT NOT NULL,
  created_commit_sequence INTEGER NOT NULL,
  UNIQUE(account_id, statement_key)
);

CREATE TABLE IF NOT EXISTS fubon_credit_statement_revisions (
  statement_revision_id BLOB PRIMARY KEY CHECK(length(statement_revision_id) = 16),
  statement_id BLOB NOT NULL REFERENCES fubon_credit_statements(statement_id),
  capture_id TEXT NOT NULL REFERENCES fubon_credit_card_captures(capture_id),
  revision_key TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  cycle_start TEXT NOT NULL,
  cycle_end TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  balance_coefficient TEXT NOT NULL,
  balance_scale INTEGER NOT NULL,
  minimum_coefficient TEXT,
  minimum_scale INTEGER,
  evidence_source_record_key TEXT NOT NULL,
  commit_sequence INTEGER NOT NULL,
  UNIQUE(statement_id, revision_key),
  UNIQUE(statement_id, revision_number)
);
CREATE INDEX IF NOT EXISTS idx_fubon_credit_statement_revisions_statement
  ON fubon_credit_statement_revisions(statement_id, revision_number, commit_sequence);

CREATE TABLE IF NOT EXISTS fubon_credit_statement_memberships (
  statement_revision_id BLOB NOT NULL REFERENCES fubon_credit_statement_revisions(statement_revision_id),
  transaction_id BLOB NOT NULL REFERENCES fubon_credit_card_transactions(transaction_id),
  transaction_revision_id BLOB NOT NULL REFERENCES fubon_credit_card_transaction_revisions(revision_id),
  source_record_key TEXT NOT NULL,
  commit_sequence INTEGER NOT NULL,
  PRIMARY KEY(statement_revision_id, transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_fubon_credit_statement_memberships_transaction
  ON fubon_credit_statement_memberships(transaction_id, statement_revision_id);

CREATE TABLE IF NOT EXISTS fubon_credit_statement_provenance (
  statement_revision_id BLOB NOT NULL REFERENCES fubon_credit_statement_revisions(statement_revision_id),
  capture_id TEXT NOT NULL REFERENCES fubon_credit_card_captures(capture_id),
  evidence_source_record_key TEXT NOT NULL,
  commit_sequence INTEGER NOT NULL,
  PRIMARY KEY(statement_revision_id, capture_id, evidence_source_record_key)
);

CREATE TABLE IF NOT EXISTS fubon_credit_transaction_relations (
  relation_id BLOB PRIMARY KEY CHECK(length(relation_id) = 16),
  account_id BLOB NOT NULL REFERENCES fubon_credit_accounts(account_id),
  relation_kind TEXT NOT NULL CHECK(relation_kind IN ('pending_to_posted','refund_of','reversal_of','transfer_counterpart','installment_of')),
  from_transaction_id BLOB NOT NULL REFERENCES fubon_credit_card_transactions(transaction_id),
  to_transaction_id BLOB NOT NULL REFERENCES fubon_credit_card_transactions(transaction_id),
  evidence_source_record_key TEXT NOT NULL,
  commit_sequence INTEGER NOT NULL,
  CHECK(from_transaction_id <> to_transaction_id),
  UNIQUE(account_id, relation_kind, from_transaction_id, to_transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_fubon_credit_transaction_relations_endpoints
  ON fubon_credit_transaction_relations(account_id, from_transaction_id, to_transaction_id, relation_kind);

CREATE TABLE IF NOT EXISTS fubon_credit_sync_states (
  account_id BLOB PRIMARY KEY REFERENCES fubon_credit_accounts(account_id),
  stream TEXT NOT NULL CHECK(stream = 'credit-card'),
  last_capture_id TEXT NOT NULL REFERENCES fubon_credit_card_captures(capture_id),
  commit_sequence INTEGER NOT NULL
);
`;

export function ensureFubonCreditCardSchema(db: DatabaseSync): void {
  db.exec(FUBON_CREDIT_CARD_SCHEMA);
}

function canonicalId(): Buffer {
  return randomBytes(16);
}

function idText(value: unknown): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== 16)
    throw new Error("Fubon credit-card canonical ID is invalid.");
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function idBytes(value: string): Buffer {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value))
    throw new Error("Fubon credit-card canonical ID text is invalid.");
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function exactText(amount: FubonCreditCardExactAmount): string {
  if (amount.scale === 0) return amount.coefficient;
  const coefficient = amount.coefficient.padStart(amount.scale + 1, "0");
  return `${coefficient.slice(0, -amount.scale)}.${coefficient.slice(-amount.scale)}`;
}

function jsonHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("base64url")}`;
}

function latestCommitSequence(db: DatabaseSync): number {
  return Number(
    (
      db.prepare("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits").get() as {
        value?: number;
      }
    ).value ?? 0,
  );
}

function nextCommitSequence(db: DatabaseSync): number {
  return latestCommitSequence(db) + 1;
}

function commitKnowledgeTime(store: FubonCreditCardWriterStore): number {
  const value = store.commitClock();
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Fubon credit-card commit clock returned an invalid value.");
  const previous = Number(
    (
      store.db.prepare("SELECT COALESCE(MAX(recorded_at_utc_us), -1) AS value FROM canonical_commits").get() as {
        value?: number;
      }
    ).value ?? -1,
  );
  return Math.max(value, previous + 1);
}

function revisionMatches(
  db: DatabaseSync,
  revisionId: Uint8Array,
  row: FubonCreditCardAdmittedTransaction,
): boolean {
  const current = db.prepare(
    `SELECT instrument_key, consume_date, posting_date, posting_status, direction,
            booked_coefficient, booked_scale, booked_currency, foreign_coefficient,
            foreign_scale, foreign_currency, normalized_description, installment_key
     FROM fubon_credit_card_transaction_revisions WHERE revision_id = ?`,
  ).get(revisionId) as Record<string, unknown> | undefined;
  if (!current) throw new Error("Fubon credit-card current revision is missing.");
  return (
    current.instrument_key === row.instrumentKey &&
    current.consume_date === row.consumeDate &&
    current.posting_date === row.postingDate &&
    current.posting_status === "posted" &&
    current.direction === row.direction &&
    current.booked_coefficient === row.bookedAmount.coefficient &&
    Number(current.booked_scale) === row.bookedAmount.scale &&
    current.booked_currency === row.bookedCurrency &&
    (current.foreign_coefficient ?? null) === (row.foreignAmount?.coefficient ?? null) &&
    (current.foreign_scale == null ? null : Number(current.foreign_scale)) ===
      (row.foreignAmount?.scale ?? null) &&
    (current.foreign_currency ?? null) === (row.foreignCurrency ?? null) &&
    current.normalized_description === row.normalizedDescription &&
    (current.installment_key ?? null) === (row.installmentKey?.trim() || null)
  );
}

function currentRevisionId(
  db: DatabaseSync,
  transactionId: Uint8Array,
): Uint8Array {
  const row = db.prepare(
    "SELECT revision_id FROM fubon_credit_card_current_transactions WHERE transaction_id = ?",
  ).get(transactionId) as { revision_id?: Uint8Array } | undefined;
  if (!row?.revision_id) throw new Error("Fubon credit-card transaction projection is missing.");
  return row.revision_id;
}

function insertTransactionRevision(
  db: DatabaseSync,
  values: {
    transactionId: Uint8Array;
    sourceRecordId: Uint8Array;
    captureId: string;
    row: FubonCreditCardAdmittedTransaction;
    revisionNumber: number;
    commitSequence: number;
  },
): Uint8Array {
  const revisionId = canonicalId();
  db.prepare(
    `INSERT INTO fubon_credit_card_transaction_revisions(
      revision_id, transaction_id, source_record_id, capture_id, revision_number,
      instrument_key, consume_date, posting_date, posting_status, direction,
      booked_coefficient, booked_scale, booked_currency, foreign_coefficient,
      foreign_scale, foreign_currency, description, normalized_description,
      installment_key, correction_key, commit_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    revisionId,
    values.transactionId,
    values.sourceRecordId,
    values.captureId,
    values.revisionNumber,
    values.row.instrumentKey,
    values.row.consumeDate,
    values.row.postingDate,
    values.row.direction,
    values.row.bookedAmount.coefficient,
    values.row.bookedAmount.scale,
    values.row.bookedCurrency,
    values.row.foreignAmount?.coefficient ?? null,
    values.row.foreignAmount?.scale ?? null,
    values.row.foreignCurrency ?? null,
    values.row.description,
    values.row.normalizedDescription,
    values.row.installmentKey?.trim() || null,
    values.row.correctionKey ?? null,
    values.commitSequence,
  );
  db.prepare(
    `INSERT INTO fubon_credit_card_current_transactions(transaction_id, revision_id, commit_sequence)
     VALUES (?, ?, ?)
     ON CONFLICT(transaction_id) DO UPDATE SET revision_id = excluded.revision_id, commit_sequence = excluded.commit_sequence`,
  ).run(values.transactionId, revisionId, values.commitSequence);
  return revisionId;
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

function accountIdForCapture(
  db: DatabaseSync,
  capture: FubonCreditCardValidatedCapture,
  commitSequence: number,
): Uint8Array {
  const existing = db.prepare(
    `SELECT account_id, source_connection_key, identity_epoch_key, stream,
            human_attested_account_key, account_natural_key
     FROM fubon_credit_accounts WHERE account_natural_key = ?`,
  ).get(capture.identity.accountNaturalKey) as Record<string, unknown> | undefined;
  if (existing) {
    if (
      existing.source_connection_key !== capture.identity.sourceConnectionKey ||
      existing.identity_epoch_key !== capture.identity.identityEpochKey ||
      existing.stream !== "credit-card" ||
      existing.human_attested_account_key !== capture.identity.humanAttestedAccountKey
    )
      throw new FubonCreditCardAdmissionError("Fubon account identity scope drifted.");
    return existing.account_id as Uint8Array;
  }
  const accountId = canonicalId();
  db.prepare(
    `INSERT INTO fubon_credit_accounts(
      account_id, source_connection_key, identity_epoch_key, stream,
      human_attested_account_key, account_natural_key, account_type,
      account_subtype, provider_guaranteed, occurrence_provider_guaranteed,
      created_commit_sequence
    ) VALUES (?, ?, ?, 'credit-card', ?, ?, 'credit', 'credit_card', 0, 0, ?)`,
  ).run(
    accountId,
    capture.identity.sourceConnectionKey,
    capture.identity.identityEpochKey,
    capture.identity.humanAttestedAccountKey,
    capture.identity.accountNaturalKey,
    commitSequence,
  );
  return accountId;
}

function addCardInstruments(
  db: DatabaseSync,
  accountId: Uint8Array,
  capture: FubonCreditCardValidatedCapture,
  commitSequence: number,
): void {
  for (const instrument of capture.instruments) {
    const existing = db.prepare(
      `SELECT role, lifecycle, card_mask, product_name
       FROM fubon_credit_card_instruments
       WHERE account_id = ? AND instrument_key = ?`,
    ).get(accountId, instrument.instrumentKey) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.role !== instrument.role)
        throw new FubonCreditCardAdmissionError("Card instrument role changed without a new identity epoch.");
      continue;
    }
    db.prepare(
      `INSERT INTO fubon_credit_card_instruments(
        instrument_id, account_id, instrument_key, card_mask, product_name,
        role, lifecycle, created_commit_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      canonicalId(),
      accountId,
      instrument.instrumentKey,
      instrument.cardMask ?? null,
      instrument.productName ?? null,
      instrument.role,
      instrument.lifecycle ?? null,
      commitSequence,
    );
  }
}

type SourceRecordLookup = {
  source_record_id: Uint8Array;
  source_key: string;
  transaction_id: Uint8Array;
};

function insertSourceRecord(
  db: DatabaseSync,
  values: {
    captureId: string;
    accountId: Uint8Array;
    row: FubonCreditCardAdmittedTransaction;
    transactionId: Uint8Array;
    commitSequence: number;
  },
): Uint8Array {
  const sourceRecordId = canonicalId();
  const compact = {
    sourceRecordKey: values.row.sourceRecordKey,
    sourceKey: values.row.sourceKey,
    instrumentKey: values.row.instrumentKey,
    consumeDate: values.row.consumeDate,
    postingDate: values.row.postingDate,
    direction: values.row.direction,
    bookedAmount: values.row.bookedAmount,
    bookedCurrency: values.row.bookedCurrency,
    foreignAmount: values.row.foreignAmount,
    foreignCurrency: values.row.foreignCurrency,
    description: values.row.description,
    billingStatus: values.row.billingStatus,
    statementKey: values.row.statementKey ?? null,
  };
  db.prepare(
    `INSERT INTO fubon_credit_card_source_records(
      source_record_id, capture_id, account_id, source_record_key, source_key,
      transaction_id, compact_json, content_hash, commit_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sourceRecordId,
    values.captureId,
    values.accountId,
    values.row.sourceRecordKey,
    values.row.sourceKey,
    values.transactionId,
    JSON.stringify(compact),
    jsonHash(compact),
    values.commitSequence,
  );
  return sourceRecordId;
}

function latestSourceRecord(
  db: DatabaseSync,
  accountId: Uint8Array,
  sourceRecordKey: string,
): SourceRecordLookup | undefined {
  return db.prepare(
    `SELECT source_record_id, source_key, transaction_id
     FROM fubon_credit_card_source_records
     WHERE account_id = ? AND source_record_key = ?
     ORDER BY commit_sequence DESC, rowid DESC LIMIT 1`,
  ).get(accountId, sourceRecordKey) as SourceRecordLookup | undefined;
}

function transactionIdBySourceKey(
  db: DatabaseSync,
  accountId: Uint8Array,
  sourceKey: string,
): Uint8Array | undefined {
  const row = db.prepare(
    "SELECT transaction_id FROM fubon_credit_card_transactions WHERE account_id = ? AND source_key = ?",
  ).get(accountId, sourceKey) as { transaction_id?: Uint8Array } | undefined;
  return row?.transaction_id;
}

function nextRevisionNumber(db: DatabaseSync, transactionId: Uint8Array): number {
  return Number(
    (
      db.prepare(
        "SELECT COALESCE(MAX(revision_number), 0) AS value FROM fubon_credit_card_transaction_revisions WHERE transaction_id = ?",
      ).get(transactionId) as { value?: number }
    ).value ?? 0,
  ) + 1;
}

function persistTransaction(
  db: DatabaseSync,
  values: {
    accountId: Uint8Array;
    capture: FubonCreditCardValidatedCapture;
    row: FubonCreditCardAdmittedTransaction;
    commitSequence: number;
  },
): { transactionId: Uint8Array; revisionId: Uint8Array; sourceRecordId: Uint8Array } {
  const existingSource = latestSourceRecord(
    db,
    values.accountId,
    values.row.sourceRecordKey,
  );
  let transactionId = existingSource?.transaction_id ??
    transactionIdBySourceKey(db, values.accountId, values.row.sourceKey);
  if (existingSource && existingSource.source_key !== values.row.sourceKey && !values.row.correctionKey)
    throw new FubonCreditCardAdmissionError(
      "Changed Fubon credit-card source row requires explicit correction evidence.",
    );
  const wasNew = !transactionId;
  if (!transactionId) {
    transactionId = canonicalId();
    db.prepare(
      `INSERT INTO fubon_credit_card_transactions(
        transaction_id, account_id, source_key, created_commit_sequence
      ) VALUES (?, ?, ?, ?)`,
    ).run(transactionId, values.accountId, values.row.sourceKey, values.commitSequence);
  }
  const sourceRecordId = insertSourceRecord(db, {
    captureId: values.capture.captureId,
    accountId: values.accountId,
    row: values.row,
    transactionId,
    commitSequence: values.commitSequence,
  });
  let revisionId: Uint8Array;
  if (wasNew) {
    revisionId = insertTransactionRevision(db, {
      transactionId,
      sourceRecordId,
      captureId: values.capture.captureId,
      row: values.row,
      revisionNumber: 1,
      commitSequence: values.commitSequence,
    });
  } else {
    const current = currentRevisionId(db, transactionId);
    if (revisionMatches(db, current, values.row)) revisionId = current;
    else {
      if (!values.row.correctionKey)
        throw new FubonCreditCardAdmissionError(
          "Changed Fubon credit-card transaction requires explicit correction evidence.",
        );
      revisionId = insertTransactionRevision(db, {
        transactionId,
        sourceRecordId,
        captureId: values.capture.captureId,
        row: values.row,
        revisionNumber: nextRevisionNumber(db, transactionId),
        commitSequence: values.commitSequence,
      });
    }
  }
  db.prepare(
    `INSERT OR IGNORE INTO fubon_credit_card_transaction_provenance(
      transaction_id, capture_id, source_record_id, source_record_key, commit_sequence
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    transactionId,
    values.capture.captureId,
    sourceRecordId,
    values.row.sourceRecordKey,
    values.commitSequence,
  );
  db.prepare(
    `INSERT OR IGNORE INTO fubon_credit_card_billing_observations(
      observation_id, transaction_id, capture_id, source_record_id,
      billing_status, statement_key, commit_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    canonicalId(),
    transactionId,
    values.capture.captureId,
    sourceRecordId,
    values.row.billingStatus,
    values.row.statementKey ?? null,
    values.commitSequence,
  );
  return { transactionId, revisionId, sourceRecordId };
}

function statementRevisionMatches(
  db: DatabaseSync,
  revisionId: Uint8Array,
  statement: FubonCreditCardAdmittedStatement,
): boolean {
  const row = db.prepare(
    `SELECT cycle_start, cycle_end, issue_date, due_date, currency,
            balance_coefficient, balance_scale, minimum_coefficient, minimum_scale,
            evidence_source_record_key
     FROM fubon_credit_statement_revisions WHERE statement_revision_id = ?`,
  ).get(revisionId) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Fubon credit-card statement revision is missing.");
  return (
    row.cycle_start === statement.cycleStart &&
    row.cycle_end === statement.cycleEnd &&
    row.issue_date === statement.issueDate &&
    row.due_date === statement.dueDate &&
    row.currency === statement.currency &&
    row.balance_coefficient === statement.balance.coefficient &&
    Number(row.balance_scale) === statement.balance.scale &&
    (row.minimum_coefficient ?? null) === (statement.minimumPayment?.coefficient ?? null) &&
    (row.minimum_scale == null ? null : Number(row.minimum_scale)) ===
      (statement.minimumPayment?.scale ?? null) &&
    row.evidence_source_record_key === statement.evidence.sourceRecordKey
  );
}

function persistStatement(
  db: DatabaseSync,
  values: {
    accountId: Uint8Array;
    capture: FubonCreditCardValidatedCapture;
    statement: FubonCreditCardAdmittedStatement;
    transactions: ReadonlyMap<string, { transactionId: Uint8Array; revisionId: Uint8Array }>;
    commitSequence: number;
  },
): { statementId: Uint8Array; statementRevisionId: Uint8Array; created: boolean } {
  let statementId: Uint8Array;
  const existing = db.prepare(
    "SELECT statement_id FROM fubon_credit_statements WHERE account_id = ? AND statement_key = ?",
  ).get(values.accountId, values.statement.statementKey) as { statement_id?: Uint8Array } | undefined;
  if (existing?.statement_id) statementId = existing.statement_id;
  else {
    statementId = canonicalId();
    db.prepare(
      `INSERT INTO fubon_credit_statements(statement_id, account_id, statement_key, created_commit_sequence)
       VALUES (?, ?, ?, ?)`,
    ).run(statementId, values.accountId, values.statement.statementKey, values.commitSequence);
  }
  const previous = db.prepare(
    `SELECT statement_revision_id FROM fubon_credit_statement_revisions
     WHERE statement_id = ? AND revision_key = ?`,
  ).get(statementId, values.statement.revisionKey) as { statement_revision_id?: Uint8Array } | undefined;
  let statementRevisionId: Uint8Array;
  let created = false;
  if (previous?.statement_revision_id) {
    if (!statementRevisionMatches(db, previous.statement_revision_id, values.statement))
      throw new FubonCreditCardAdmissionError("Statement revision key was reused for changed summary evidence.");
    statementRevisionId = previous.statement_revision_id;
  } else {
    const revisionNumber = Number(
      (
        db.prepare(
          "SELECT COALESCE(MAX(revision_number), 0) AS value FROM fubon_credit_statement_revisions WHERE statement_id = ?",
        ).get(statementId) as { value?: number }
      ).value ?? 0,
    ) + 1;
    statementRevisionId = canonicalId();
    db.prepare(
      `INSERT INTO fubon_credit_statement_revisions(
        statement_revision_id, statement_id, capture_id, revision_key,
        revision_number, cycle_start, cycle_end, issue_date, due_date, currency,
        balance_coefficient, balance_scale, minimum_coefficient, minimum_scale,
        evidence_source_record_key, commit_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      statementRevisionId,
      statementId,
      values.capture.captureId,
      values.statement.revisionKey,
      revisionNumber,
      values.statement.cycleStart,
      values.statement.cycleEnd,
      values.statement.issueDate,
      values.statement.dueDate,
      values.statement.currency,
      values.statement.balance.coefficient,
      values.statement.balance.scale,
      values.statement.minimumPayment?.coefficient ?? null,
      values.statement.minimumPayment?.scale ?? null,
      values.statement.evidence.sourceRecordKey,
      values.commitSequence,
    );
    created = true;
    for (const sourceRecordKey of values.statement.transactionSourceKeys) {
      const transaction = values.transactions.get(sourceRecordKey);
      if (!transaction)
        throw new FubonCreditCardAdmissionError("Statement membership transaction is missing from capture.");
      db.prepare(
        `INSERT INTO fubon_credit_statement_memberships(
          statement_revision_id, transaction_id, transaction_revision_id,
          source_record_key, commit_sequence
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        statementRevisionId,
        transaction.transactionId,
        transaction.revisionId,
        sourceRecordKey,
        values.commitSequence,
      );
    }
  }
  db.prepare(
    `INSERT OR IGNORE INTO fubon_credit_statement_provenance(
      statement_revision_id, capture_id, evidence_source_record_key, commit_sequence
    ) VALUES (?, ?, ?, ?)`,
  ).run(
    statementRevisionId,
    values.capture.captureId,
    values.statement.evidence.sourceRecordKey,
    values.commitSequence,
  );
  return { statementId, statementRevisionId, created };
}

function persistRelation(
  db: DatabaseSync,
  accountId: Uint8Array,
  relation: FubonCreditCardRelationInput,
  transactions: ReadonlyMap<string, { transactionId: Uint8Array }>,
  commitSequence: number,
): void {
  const from = transactions.get(relation.fromSourceRecordKey);
  const to = transactions.get(relation.toSourceRecordKey);
  if (!from || !to) throw new FubonCreditCardAdmissionError("Transaction relation endpoint is missing.");
  db.prepare(
    `INSERT OR IGNORE INTO fubon_credit_transaction_relations(
      relation_id, account_id, relation_kind, from_transaction_id,
      to_transaction_id, evidence_source_record_key, commit_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    canonicalId(),
    accountId,
    relation.kind,
    from.transactionId,
    to.transactionId,
    (relation.evidence as { sourceRecordKey: string }).sourceRecordKey,
    commitSequence,
  );
}

function commitFubonCreditCardCaptureOnce(
  store: FubonCreditCardWriterStore,
  capture: FubonCreditCardValidatedCapture,
  managesTransaction = true,
): FubonCreditCardCommitResult {
  if (!hasValidatedCapture(capture))
    throw new FubonCreditCardAdmissionError("Fubon credit-card capture did not cross the validated seam.");
  ensureFubonCreditCardSchema(store.db);
  const db = store.db;
  if (managesTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT 1 FROM fubon_credit_card_captures WHERE capture_id = ?").get(capture.captureId))
      throw new FubonCreditCardAdmissionError("Fubon credit-card capture overwrite is forbidden.");
    const commitId = canonicalId();
    const commitSequence = nextCommitSequence(db);
    db.prepare(
      `INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind)
       VALUES (?, ?, ?, ?, 'source_capture')`,
    ).run(
      commitId,
      commitSequence,
      commitKnowledgeTime(store),
      capture.authorityRoute,
    );
    db.prepare(
      `INSERT INTO source_authority_routes(
        authority_route, integration_namespace, stream, contract_version, created_commit_id
      ) VALUES (?, 'fubon', 'credit-card', ?, ?)
      ON CONFLICT(authority_route) DO NOTHING`,
    ).run(capture.authorityRoute, capture.contractVersion, commitId);
    // The durable event is part of the same transaction as the first credit
    // capture. A failed capture therefore cannot leave an attestation marker.
    recordInitialFubonCreditCardHumanAttestationIfMissing(db, capture.observedAt);
    const accountId = accountIdForCapture(db, capture, commitSequence);
    addCardInstruments(db, accountId, capture, commitSequence);
    db.prepare(
      `INSERT INTO fubon_credit_card_captures(
        capture_id, account_id, observed_at, scope_start, scope_end,
        completeness_json, authority_route, contract_version, commit_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      capture.captureId,
      accountId,
      capture.observedAt,
      capture.scope.startDate,
      capture.scope.endDate,
      JSON.stringify(capture.scope.completeness),
      capture.authorityRoute,
      capture.contractVersion,
      commitSequence,
    );
    const transactions = new Map<string, { transactionId: Uint8Array; revisionId: Uint8Array; sourceRecordId: Uint8Array }>();
    for (const row of capture.transactions) {
      const persisted = persistTransaction(db, {
        accountId,
        capture,
        row,
        commitSequence,
      });
      transactions.set(row.sourceRecordKey, persisted);
    }
    for (const statement of capture.statements)
      persistStatement(db, {
        accountId,
        capture,
        statement,
        transactions,
        commitSequence,
      });
    for (const relation of capture.relations)
      persistRelation(db, accountId, relation, transactions, commitSequence);
    db.prepare(
      `INSERT INTO fubon_credit_sync_states(account_id, stream, last_capture_id, commit_sequence)
       VALUES (?, 'credit-card', ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET last_capture_id = excluded.last_capture_id, commit_sequence = excluded.commit_sequence`,
    ).run(accountId, capture.captureId, commitSequence);
    const provenanceCount = Number(
      (
        db.prepare(
          `SELECT
             (SELECT COUNT(*) FROM fubon_credit_card_transaction_provenance WHERE capture_id = ?) +
             (SELECT COUNT(*) FROM fubon_credit_statement_provenance WHERE capture_id = ?) AS count`,
        ).get(capture.captureId, capture.captureId) as { count?: number }
      ).count ?? 0,
    );
    if (managesTransaction) db.exec("COMMIT");
    return {
      status: "canonical-live",
      canonicalAdmission: "admitted",
      captureId: capture.captureId,
      accountId: idText(accountId),
      commitSequence,
      transactionCount: capture.transactions.length,
      statementCount: capture.statements.length,
      relationCount: capture.relations.length,
      provenanceCount,
    };
  } catch (error) {
    if (managesTransaction)
      try {
        db.exec("ROLLBACK");
      } catch {
        /* preserve the original admission error */
      }
    throw error;
  }
}

export async function commitFubonCreditCardCapture(
  store: FubonCreditCardWriterStore,
  capture: FubonCreditCardValidatedCapture,
): Promise<FubonCreditCardCommitResult> {
  return withCanonicalWriterQueue(store.databasePath, () =>
    commitFubonCreditCardCaptureOnce(store, capture),
  );
}

export async function commitFubonCreditCardCaptureBatch(
  store: FubonCreditCardWriterStore,
  captures: readonly FubonCreditCardValidatedCapture[],
): Promise<FubonCreditCardCommitResult[]> {
  if (captures.length === 0) throw new FubonCreditCardAdmissionError("Fubon credit-card capture batch cannot be empty.");
  return withCanonicalWriterQueue(store.databasePath, () => {
    for (const capture of captures) {
      if (!hasValidatedCapture(capture))
        throw new FubonCreditCardAdmissionError("Fubon credit-card batch contains an unvalidated capture.");
    }
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const results = captures.map((capture) =>
        commitFubonCreditCardCaptureOnce(store, capture, false),
      );
      store.db.exec("COMMIT");
      return results;
    } catch (error) {
      try {
        store.db.exec("ROLLBACK");
      } catch {
        /* preserve the original failure */
      }
      throw error;
    }
  });
}

export type FubonCreditCardAmountView = {
  coefficient: string;
  scale: number;
  text: string;
};

export type FubonCreditCardBillingObservationView = {
  observationId: string;
  transactionId: string;
  sourceRecordId: string;
  captureId: string;
  billingStatus: "billed" | "unbilled";
  statementKey: string | null;
  commitSequence: number;
};

export type FubonCreditCardTransactionProvenanceView = {
  transactionId: string;
  sourceRecordId: string;
  sourceRecordKey: string;
  captureId: string;
  commitSequence: number;
};

export type FubonCreditCardTransactionView = {
  id: string;
  transactionId: string;
  accountId: string;
  sourceRecordId: string;
  sourceRecordKey: string;
  sourceKey: string;
  instrumentKey: string;
  consumeDate: string;
  postingDate: string;
  postingStatus: "posted";
  direction: "inflow" | "outflow";
  bookedAmount: string;
  bookedExactAmount: FubonCreditCardAmountView;
  bookedCurrency: string;
  foreignAmount: string | null;
  foreignExactAmount: FubonCreditCardAmountView | null;
  foreignCurrency: string | null;
  description: string;
  normalizedDescription: string;
  installmentKey: string | null;
  correctionKey: string | null;
  billingStatus: "billed" | "unbilled";
  billingObservations: FubonCreditCardBillingObservationView[];
  providerGuaranteed: false;
  occurrenceProviderGuaranteed: false;
  revisionId: string;
  revisionNumber: number;
  captureId: string;
  commitSequence: number;
  provenance: FubonCreditCardTransactionProvenanceView[];
};

export type FubonCreditCardInstrumentView = {
  id: string;
  instrumentId: string;
  accountId: string;
  instrumentKey: string;
  cardMask: string | null;
  productName: string | null;
  role: FubonCreditCardInstrumentRole;
  lifecycle: string | null;
  createdCommitSequence: number;
};

export type FubonCreditCardStatementMembershipView = {
  statementRevisionId: string;
  transactionId: string;
  transactionRevisionId: string;
  sourceRecordKey: string;
  commitSequence: number;
};

export type FubonCreditCardStatementProvenanceView = {
  statementRevisionId: string;
  captureId: string;
  evidenceSourceRecordKey: string;
  commitSequence: number;
};

export type FubonCreditCardStatementRevisionView = {
  id: string;
  statementRevisionId: string;
  statementId: string;
  captureId: string;
  statementKey: string;
  revisionKey: string;
  revisionNumber: number;
  cycleStart: string;
  cycleEnd: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  balance: string;
  balanceExactAmount: FubonCreditCardAmountView;
  minimumPayment: string | null;
  minimumPaymentExactAmount: FubonCreditCardAmountView | null;
  evidenceSourceRecordKey: string;
  commitSequence: number;
  memberships: FubonCreditCardStatementMembershipView[];
  provenance: FubonCreditCardStatementProvenanceView[];
};

export type FubonCreditCardStatementView = {
  id: string;
  statementId: string;
  accountId: string;
  statementKey: string;
  createdCommitSequence: number;
  revisions: FubonCreditCardStatementRevisionView[];
  currentRevision: FubonCreditCardStatementRevisionView | null;
};

export type FubonCreditCardAccountView = {
  id: string;
  accountId: string;
  accountNaturalKey: string;
  sourceConnectionKey: string;
  identityEpochKey: string;
  humanAttestedAccountKey: string;
  stream: "credit-card";
  accountType: "credit";
  accountSubtype: "credit_card";
  providerGuaranteed: false;
  occurrenceProviderGuaranteed: false;
  instruments: FubonCreditCardInstrumentView[];
  transactions: FubonCreditCardTransactionView[];
  statements: FubonCreditCardStatementView[];
  relations: FubonCreditCardRelationView[];
};

export type FubonCreditCardCaptureView = {
  id: string;
  captureId: string;
  accountId: string;
  observedAt: string;
  scopeStart: string;
  scopeEnd: string;
  completeness: FubonCreditCardCompleteness;
  authorityRoute: "fubon/credit-card/human-attested-v1";
  contractVersion: "fubon/credit-card/human-attested-v1";
  commitSequence: number;
};

export type FubonCreditCardRelationView = {
  id: string;
  accountId: string;
  kind: FubonCreditCardRelationInput["kind"];
  fromTransactionId: string;
  toTransactionId: string;
  evidenceSourceRecordKey: string;
  commitSequence: number;
};

type FubonCreditCardQueryBase = {
  status: "canonical-live";
  canonicalAdmission: "admitted";
  accounts: FubonCreditCardAccountView[];
  captures: FubonCreditCardCaptureView[];
  provenanceCount: number;
};

export type FubonCreditCardCurrentQuery = FubonCreditCardQueryBase & {
  kind: "current";
  commitSequence: number;
};

export type FubonCreditCardHistoricalQuery = FubonCreditCardQueryBase & {
  kind: "historical";
  knowledgeAt: number;
};

export type FubonCreditCardHistoricalQueryRequest = {
  knowledgeAt: number;
  accountNaturalKey?: string;
};

export type FubonCreditCardLineageQueryRequest = {
  accountNaturalKey?: string;
  transactionId?: string;
  sourceRecordKey?: string;
  knowledgeAt?: number;
};

export type FubonCreditCardLineageQuery = {
  status: "canonical-live";
  canonicalAdmission: "admitted";
  kind: "lineage";
  accountNaturalKey?: string;
  accounts: FubonCreditCardAccountView[];
  captures: FubonCreditCardCaptureView[];
  transactions: FubonCreditCardTransactionView[];
  statements: FubonCreditCardStatementView[];
  transactionRevisions: FubonCreditCardTransactionView[];
  statementMemberships: FubonCreditCardStatementMembershipView[];
  relations: FubonCreditCardRelationView[];
  provenance: FubonCreditCardTransactionProvenanceView[];
  statementProvenance: FubonCreditCardStatementProvenanceView[];
  provenanceCount: number;
};

export type FubonCreditCardQueryStore = Pick<CanonicalSourceStore, "db">;

type FubonCreditCardQueryOptions = {
  accountNaturalKey?: string;
  knowledgeAt?: number;
  currentOnly: boolean;
};

type FubonCreditCardQueryValue = string | number | Uint8Array;

function hasFubonCreditCardSchema(db: DatabaseSync): boolean {
  const row = db.prepare(
    `SELECT COUNT(*) AS value FROM sqlite_master
     WHERE type = 'table' AND name IN ('fubon_credit_accounts', 'fubon_credit_card_captures',
       'fubon_credit_card_transactions', 'fubon_credit_statement_revisions')`,
  ).get() as { value?: number } | undefined;
  return Number(row?.value ?? 0) === 4;
}

function fubonQueryRowId(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (!(value instanceof Uint8Array))
    throw new Error(`Fubon credit-card query row ${key} is not a canonical ID.`);
  return idText(value);
}

function fubonQueryAmount(
  coefficient: unknown,
  scale: unknown,
): FubonCreditCardAmountView {
  const exact = {
    coefficient: String(coefficient),
    scale: Number(scale),
  };
  return { ...exact, text: exactText(exact) };
}

function fubonQueryLatestCommitSequence(db: DatabaseSync): number {
  return Number(
    (
      db.prepare("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits").get() as {
        value?: number;
      }
    ).value ?? 0,
  );
}

function fubonQueryBillingObservations(
  db: DatabaseSync,
  transactionId: Uint8Array,
  knowledgeAt?: number,
): FubonCreditCardBillingObservationView[] {
  const rows = db.prepare(
    `SELECT observation_id, transaction_id, source_record_id, capture_id,
            billing_status, statement_key, commit_sequence
     FROM fubon_credit_card_billing_observations
     WHERE transaction_id = ?${knowledgeAt === undefined ? "" : " AND commit_sequence <= ?"}
     ORDER BY commit_sequence, observation_id`,
  ).all(
    transactionId,
    ...(knowledgeAt === undefined ? [] : [knowledgeAt]),
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    observationId: fubonQueryRowId(row, "observation_id"),
    transactionId: fubonQueryRowId(row, "transaction_id"),
    sourceRecordId: fubonQueryRowId(row, "source_record_id"),
    captureId: String(row.capture_id),
    billingStatus: row.billing_status as "billed" | "unbilled",
    statementKey: row.statement_key == null ? null : String(row.statement_key),
    commitSequence: Number(row.commit_sequence),
  }));
}

function fubonQueryTransactionProvenance(
  db: DatabaseSync,
  transactionId: Uint8Array,
  knowledgeAt?: number,
): FubonCreditCardTransactionProvenanceView[] {
  const rows = db.prepare(
    `SELECT transaction_id, source_record_id, source_record_key, capture_id, commit_sequence
     FROM fubon_credit_card_transaction_provenance
     WHERE transaction_id = ?${knowledgeAt === undefined ? "" : " AND commit_sequence <= ?"}
     ORDER BY commit_sequence, source_record_id`,
  ).all(
    transactionId,
    ...(knowledgeAt === undefined ? [] : [knowledgeAt]),
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    transactionId: fubonQueryRowId(row, "transaction_id"),
    sourceRecordId: fubonQueryRowId(row, "source_record_id"),
    sourceRecordKey: String(row.source_record_key),
    captureId: String(row.capture_id),
    commitSequence: Number(row.commit_sequence),
  }));
}

function fubonQueryTransactions(
  db: DatabaseSync,
  accountId: Uint8Array,
  options: FubonCreditCardQueryOptions,
): FubonCreditCardTransactionView[] {
  const historical = !options.currentOnly;
  const rows = db.prepare(
    `SELECT transaction_row.transaction_id, transaction_row.account_id,
            transaction_row.source_key AS transaction_source_key,
            revision.revision_id, revision.source_record_id, revision.capture_id,
            revision.revision_number, revision.instrument_key, revision.consume_date,
            revision.posting_date, revision.posting_status, revision.direction,
            revision.booked_coefficient, revision.booked_scale, revision.booked_currency,
            revision.foreign_coefficient, revision.foreign_scale, revision.foreign_currency,
            revision.description, revision.normalized_description, revision.installment_key,
            revision.correction_key, revision.commit_sequence,
            source_record.source_record_key, source_record.source_key AS source_record_source_key
     FROM fubon_credit_card_transactions transaction_row
     JOIN fubon_credit_card_transaction_revisions revision
       ON revision.transaction_id = transaction_row.transaction_id
     ${options.currentOnly
       ? `JOIN fubon_credit_card_current_transactions current_row
          ON current_row.transaction_id = transaction_row.transaction_id
         AND current_row.revision_id = revision.revision_id`
       : ""}
     JOIN fubon_credit_card_source_records source_record
       ON source_record.source_record_id = revision.source_record_id
     WHERE transaction_row.account_id = ?
       ${historical ? "AND transaction_row.created_commit_sequence <= ? AND revision.commit_sequence <= ?" : ""}
       ${historical
         ? `AND revision.revision_number = (
              SELECT MAX(previous.revision_number)
              FROM fubon_credit_card_transaction_revisions previous
              WHERE previous.transaction_id = transaction_row.transaction_id
                AND previous.commit_sequence <= ?
            )`
         : ""}
     ORDER BY revision.consume_date, revision.posting_date, transaction_row.source_key`,
  ).all(
    accountId,
    ...(historical
      ? [options.knowledgeAt!, options.knowledgeAt!, options.knowledgeAt!]
      : []),
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const transactionId = row.transaction_id as Uint8Array;
    const booked = fubonQueryAmount(row.booked_coefficient, row.booked_scale);
    const foreign = row.foreign_coefficient == null
      ? null
      : fubonQueryAmount(row.foreign_coefficient, row.foreign_scale);
    const billingObservations = fubonQueryBillingObservations(
      db,
      transactionId,
      options.knowledgeAt,
    );
    const latestBilling = billingObservations.at(-1);
    return {
      id: idText(transactionId),
      transactionId: idText(transactionId),
      accountId: fubonQueryRowId(row, "account_id"),
      sourceRecordId: fubonQueryRowId(row, "source_record_id"),
      sourceRecordKey: String(row.source_record_key),
      sourceKey: String(row.transaction_source_key),
      instrumentKey: String(row.instrument_key),
      consumeDate: String(row.consume_date),
      postingDate: String(row.posting_date),
      postingStatus: "posted" as const,
      direction: row.direction as "inflow" | "outflow",
      bookedAmount: booked.text,
      bookedExactAmount: booked,
      bookedCurrency: String(row.booked_currency),
      foreignAmount: foreign?.text ?? null,
      foreignExactAmount: foreign,
      foreignCurrency: row.foreign_currency == null ? null : String(row.foreign_currency),
      description: String(row.description),
      normalizedDescription: String(row.normalized_description),
      installmentKey: row.installment_key == null ? null : String(row.installment_key),
      correctionKey: row.correction_key == null ? null : String(row.correction_key),
      billingStatus: latestBilling?.billingStatus ?? "unbilled",
      billingObservations,
      providerGuaranteed: false as const,
      occurrenceProviderGuaranteed: false as const,
      revisionId: fubonQueryRowId(row, "revision_id"),
      revisionNumber: Number(row.revision_number),
      captureId: String(row.capture_id),
      commitSequence: Number(row.commit_sequence),
      provenance: fubonQueryTransactionProvenance(db, transactionId, options.knowledgeAt),
    };
  });
}

function fubonQueryStatementMemberships(
  db: DatabaseSync,
  statementRevisionId: Uint8Array,
  knowledgeAt?: number,
): FubonCreditCardStatementMembershipView[] {
  const rows = db.prepare(
    `SELECT statement_revision_id, transaction_id, transaction_revision_id,
            source_record_key, commit_sequence
     FROM fubon_credit_statement_memberships
     WHERE statement_revision_id = ?${knowledgeAt === undefined ? "" : " AND commit_sequence <= ?"}
     ORDER BY source_record_key, transaction_id`,
  ).all(
    statementRevisionId,
    ...(knowledgeAt === undefined ? [] : [knowledgeAt]),
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    statementRevisionId: fubonQueryRowId(row, "statement_revision_id"),
    transactionId: fubonQueryRowId(row, "transaction_id"),
    transactionRevisionId: fubonQueryRowId(row, "transaction_revision_id"),
    sourceRecordKey: String(row.source_record_key),
    commitSequence: Number(row.commit_sequence),
  }));
}

function fubonQueryStatementProvenance(
  db: DatabaseSync,
  statementRevisionId: Uint8Array,
  knowledgeAt?: number,
): FubonCreditCardStatementProvenanceView[] {
  const rows = db.prepare(
    `SELECT statement_revision_id, capture_id, evidence_source_record_key, commit_sequence
     FROM fubon_credit_statement_provenance
     WHERE statement_revision_id = ?${knowledgeAt === undefined ? "" : " AND commit_sequence <= ?"}
     ORDER BY commit_sequence, capture_id`,
  ).all(
    statementRevisionId,
    ...(knowledgeAt === undefined ? [] : [knowledgeAt]),
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    statementRevisionId: fubonQueryRowId(row, "statement_revision_id"),
    captureId: String(row.capture_id),
    evidenceSourceRecordKey: String(row.evidence_source_record_key),
    commitSequence: Number(row.commit_sequence),
  }));
}

function fubonQueryStatements(
  db: DatabaseSync,
  accountId: Uint8Array,
  knowledgeAt?: number,
): FubonCreditCardStatementView[] {
  const rows = db.prepare(
    `SELECT statement.statement_id, statement.account_id, statement.statement_key,
            statement.created_commit_sequence, revision.statement_revision_id,
            revision.capture_id, revision.revision_key, revision.revision_number,
            revision.cycle_start, revision.cycle_end, revision.issue_date, revision.due_date,
            revision.currency, revision.balance_coefficient, revision.balance_scale,
            revision.minimum_coefficient, revision.minimum_scale,
            revision.evidence_source_record_key, revision.commit_sequence
     FROM fubon_credit_statements statement
     JOIN fubon_credit_statement_revisions revision
       ON revision.statement_id = statement.statement_id
     WHERE statement.account_id = ?
       ${knowledgeAt === undefined ? "" : "AND statement.created_commit_sequence <= ? AND revision.commit_sequence <= ?"}
     ORDER BY statement.statement_key, revision.revision_number`,
  ).all(
    accountId,
    ...(knowledgeAt === undefined ? [] : [knowledgeAt, knowledgeAt]),
  ) as Array<Record<string, unknown>>;
  const grouped = new Map<string, FubonCreditCardStatementView>();
  for (const row of rows) {
    const statementId = fubonQueryRowId(row, "statement_id");
    const revisionId = row.statement_revision_id as Uint8Array;
    const balance = fubonQueryAmount(row.balance_coefficient, row.balance_scale);
    const minimum = row.minimum_coefficient == null
      ? null
      : fubonQueryAmount(row.minimum_coefficient, row.minimum_scale);
    const revision: FubonCreditCardStatementRevisionView = {
      id: idText(revisionId),
      statementRevisionId: idText(revisionId),
      statementId,
      captureId: String(row.capture_id),
      statementKey: String(row.statement_key),
      revisionKey: String(row.revision_key),
      revisionNumber: Number(row.revision_number),
      cycleStart: String(row.cycle_start),
      cycleEnd: String(row.cycle_end),
      issueDate: String(row.issue_date),
      dueDate: String(row.due_date),
      currency: String(row.currency),
      balance: balance.text,
      balanceExactAmount: balance,
      minimumPayment: minimum?.text ?? null,
      minimumPaymentExactAmount: minimum,
      evidenceSourceRecordKey: String(row.evidence_source_record_key),
      commitSequence: Number(row.commit_sequence),
      memberships: fubonQueryStatementMemberships(db, revisionId, knowledgeAt),
      provenance: fubonQueryStatementProvenance(db, revisionId, knowledgeAt),
    };
    const existing = grouped.get(statementId);
    if (existing) existing.revisions.push(revision);
    else {
      grouped.set(statementId, {
        id: statementId,
        statementId,
        accountId: fubonQueryRowId(row, "account_id"),
        statementKey: String(row.statement_key),
        createdCommitSequence: Number(row.created_commit_sequence),
        revisions: [revision],
        currentRevision: revision,
      });
    }
  }
  return [...grouped.values()].map((statement) => ({
    ...statement,
    currentRevision: statement.revisions.at(-1) ?? null,
  }));
}

function fubonQueryInstruments(
  db: DatabaseSync,
  accountId: Uint8Array,
  knowledgeAt?: number,
): FubonCreditCardInstrumentView[] {
  const rows = db.prepare(
    `SELECT instrument_id, account_id, instrument_key, card_mask, product_name,
            role, lifecycle, created_commit_sequence
     FROM fubon_credit_card_instruments
     WHERE account_id = ?${knowledgeAt === undefined ? "" : " AND created_commit_sequence <= ?"}
     ORDER BY instrument_key`,
  ).all(
    accountId,
    ...(knowledgeAt === undefined ? [] : [knowledgeAt]),
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: fubonQueryRowId(row, "instrument_id"),
    instrumentId: fubonQueryRowId(row, "instrument_id"),
    accountId: fubonQueryRowId(row, "account_id"),
    instrumentKey: String(row.instrument_key),
    cardMask: row.card_mask == null ? null : String(row.card_mask),
    productName: row.product_name == null ? null : String(row.product_name),
    role: row.role as FubonCreditCardInstrumentRole,
    lifecycle: row.lifecycle == null ? null : String(row.lifecycle),
    createdCommitSequence: Number(row.created_commit_sequence),
  }));
}

function fubonQueryRelations(
  db: DatabaseSync,
  accountId: Uint8Array,
  knowledgeAt?: number,
): FubonCreditCardRelationView[] {
  const rows = db.prepare(
    `SELECT relation_id, account_id, relation_kind, from_transaction_id,
            to_transaction_id, evidence_source_record_key, commit_sequence
     FROM fubon_credit_transaction_relations
     WHERE account_id = ?${knowledgeAt === undefined ? "" : " AND commit_sequence <= ?"}
     ORDER BY commit_sequence, relation_id`,
  ).all(
    accountId,
    ...(knowledgeAt === undefined ? [] : [knowledgeAt]),
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: fubonQueryRowId(row, "relation_id"),
    accountId: fubonQueryRowId(row, "account_id"),
    kind: row.relation_kind as FubonCreditCardRelationInput["kind"],
    fromTransactionId: fubonQueryRowId(row, "from_transaction_id"),
    toTransactionId: fubonQueryRowId(row, "to_transaction_id"),
    evidenceSourceRecordKey: String(row.evidence_source_record_key),
    commitSequence: Number(row.commit_sequence),
  }));
}

function fubonQueryCaptures(
  db: DatabaseSync,
  accountIds: readonly string[],
  knowledgeAt?: number,
): FubonCreditCardCaptureView[] {
  if (accountIds.length === 0) return [];
  const placeholders = accountIds.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT capture_id, account_id, observed_at, scope_start, scope_end,
            completeness_json, authority_route, contract_version, commit_sequence
     FROM fubon_credit_card_captures
     WHERE account_id IN (${placeholders})
       ${knowledgeAt === undefined ? "" : "AND commit_sequence <= ?"}
     ORDER BY commit_sequence, capture_id`,
  ).all(
    ...accountIds.map(idBytes),
    ...(knowledgeAt === undefined ? [] : [knowledgeAt]),
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.capture_id),
    captureId: String(row.capture_id),
    accountId: fubonQueryRowId(row, "account_id"),
    observedAt: String(row.observed_at),
    scopeStart: String(row.scope_start),
    scopeEnd: String(row.scope_end),
    completeness: JSON.parse(String(row.completeness_json)) as FubonCreditCardCompleteness,
    authorityRoute: row.authority_route as "fubon/credit-card/human-attested-v1",
    contractVersion: row.contract_version as "fubon/credit-card/human-attested-v1",
    commitSequence: Number(row.commit_sequence),
  }));
}

function fubonQueryAccounts(
  db: DatabaseSync,
  options: FubonCreditCardQueryOptions,
): FubonCreditCardAccountView[] {
  const predicates = ["1 = 1"];
  const parameters: FubonCreditCardQueryValue[] = [];
  if (options.accountNaturalKey !== undefined) {
    predicates.push("account_natural_key = ?");
    parameters.push(options.accountNaturalKey);
  }
  if (options.knowledgeAt !== undefined) {
    predicates.push("created_commit_sequence <= ?");
    parameters.push(options.knowledgeAt);
  }
  const rows = db.prepare(
    `SELECT account_id, source_connection_key, identity_epoch_key, stream,
            human_attested_account_key, account_natural_key, account_type,
            account_subtype, provider_guaranteed, occurrence_provider_guaranteed
     FROM fubon_credit_accounts WHERE ${predicates.join(" AND ")}
     ORDER BY account_natural_key`,
  ).all(...parameters) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const accountId = row.account_id as Uint8Array;
    return {
      id: idText(accountId),
      accountId: idText(accountId),
      accountNaturalKey: String(row.account_natural_key),
      sourceConnectionKey: String(row.source_connection_key),
      identityEpochKey: String(row.identity_epoch_key),
      humanAttestedAccountKey: String(row.human_attested_account_key),
      stream: "credit-card" as const,
      accountType: "credit" as const,
      accountSubtype: "credit_card" as const,
      providerGuaranteed: false as const,
      occurrenceProviderGuaranteed: false as const,
      instruments: fubonQueryInstruments(db, accountId, options.knowledgeAt),
      transactions: fubonQueryTransactions(db, accountId, options),
      statements: fubonQueryStatements(db, accountId, options.knowledgeAt),
      relations: fubonQueryRelations(db, accountId, options.knowledgeAt),
    };
  });
}

function fubonQueryProvenanceCount(
  accounts: readonly FubonCreditCardAccountView[],
): number {
  return accounts.reduce(
    (count, account) =>
      count +
      account.transactions.reduce((sum, transaction) => sum + transaction.provenance.length, 0) +
      account.statements.reduce(
        (sum, statement) =>
          sum + statement.revisions.reduce((revisionSum, revision) => revisionSum + revision.provenance.length, 0),
        0,
      ),
    0,
  );
}

function fubonEmptyCurrentQuery(db: DatabaseSync): FubonCreditCardCurrentQuery {
  return {
    status: "canonical-live",
    canonicalAdmission: "admitted",
    kind: "current",
    accounts: [],
    captures: [],
    provenanceCount: 0,
    commitSequence: fubonQueryLatestCommitSequence(db),
  };
}

export function queryFubonCreditCardCurrent(
  store: FubonCreditCardQueryStore,
  options: { accountNaturalKey?: string } = {},
): FubonCreditCardCurrentQuery {
  return withCanonicalSnapshot(store.db, () => {
    if (!hasFubonCreditCardSchema(store.db)) return fubonEmptyCurrentQuery(store.db);
    const accounts = fubonQueryAccounts(store.db, {
      accountNaturalKey: options.accountNaturalKey,
      currentOnly: true,
    });
    const captures = fubonQueryCaptures(
      store.db,
      accounts.map((account) => account.accountId),
    );
    return {
      status: "canonical-live",
      canonicalAdmission: "admitted",
      kind: "current",
      accounts,
      captures,
      provenanceCount: fubonQueryProvenanceCount(accounts),
      commitSequence: fubonQueryLatestCommitSequence(store.db),
    };
  });
}

export function queryFubonCreditCardHistorical(
  store: FubonCreditCardQueryStore,
  request: FubonCreditCardHistoricalQueryRequest,
): FubonCreditCardHistoricalQuery {
  return withCanonicalSnapshot(store.db, () => {
    const latest = fubonQueryLatestCommitSequence(store.db);
    if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt < 0 || request.knowledgeAt > latest)
      throw new Error("Fubon credit-card historical knowledge cutoff is invalid.");
    if (!hasFubonCreditCardSchema(store.db))
      return {
        status: "canonical-live",
        canonicalAdmission: "admitted",
        kind: "historical",
        knowledgeAt: request.knowledgeAt,
        accounts: [],
        captures: [],
        provenanceCount: 0,
      };
    const accounts = fubonQueryAccounts(store.db, {
      accountNaturalKey: request.accountNaturalKey,
      knowledgeAt: request.knowledgeAt,
      currentOnly: false,
    });
    const captures = fubonQueryCaptures(
      store.db,
      accounts.map((account) => account.accountId),
      request.knowledgeAt,
    );
    return {
      status: "canonical-live",
      canonicalAdmission: "admitted",
      kind: "historical",
      knowledgeAt: request.knowledgeAt,
      accounts,
      captures,
      provenanceCount: fubonQueryProvenanceCount(accounts),
    };
  });
}

export function queryFubonCreditCardLineage(
  store: FubonCreditCardQueryStore,
  request: FubonCreditCardLineageQueryRequest = {},
): FubonCreditCardLineageQuery {
  return withCanonicalSnapshot(store.db, () => {
    const latest = fubonQueryLatestCommitSequence(store.db);
    const knowledgeAt = request.knowledgeAt;
    if (knowledgeAt !== undefined && (!Number.isSafeInteger(knowledgeAt) || knowledgeAt < 0 || knowledgeAt > latest))
      throw new Error("Fubon credit-card lineage knowledge cutoff is invalid.");
    if (!hasFubonCreditCardSchema(store.db))
      return {
        status: "canonical-live",
        canonicalAdmission: "admitted",
        kind: "lineage",
        accountNaturalKey: request.accountNaturalKey,
        accounts: [],
        captures: [],
        transactions: [],
        statements: [],
        transactionRevisions: [],
        statementMemberships: [],
        relations: [],
        provenance: [],
        statementProvenance: [],
        provenanceCount: 0,
      };
    const accounts = fubonQueryAccounts(store.db, {
      accountNaturalKey: request.accountNaturalKey,
      knowledgeAt,
      currentOnly: knowledgeAt === undefined,
    });
    const accountTransactions = accounts.flatMap((account) => account.transactions);
    const transactions = accountTransactions.filter((transaction) =>
      (request.transactionId === undefined || transaction.transactionId === request.transactionId) &&
      (request.sourceRecordKey === undefined || transaction.sourceRecordKey === request.sourceRecordKey),
    );
    const selectedTransactionIds = new Set(transactions.map((transaction) => transaction.transactionId));
    const selectedAccounts = request.transactionId === undefined && request.sourceRecordKey === undefined
      ? accounts
      : accounts.filter((account) => account.transactions.some((transaction) => selectedTransactionIds.has(transaction.transactionId)));
    const statements = selectedAccounts.flatMap((account) => account.statements);
    const statementMemberships = statements.flatMap((statement) =>
      statement.revisions.flatMap((revision) => revision.memberships),
    ).filter((membership) => selectedTransactionIds.size === 0 || selectedTransactionIds.has(membership.transactionId));
    const relations = selectedAccounts.flatMap((account) => account.relations).filter((relation) =>
      selectedTransactionIds.size === 0 ||
      (selectedTransactionIds.has(relation.fromTransactionId) && selectedTransactionIds.has(relation.toTransactionId)),
    );
    const provenance = transactions.flatMap((transaction) => transaction.provenance);
    const statementProvenance = statements.flatMap((statement) =>
      statement.revisions.flatMap((revision) => revision.provenance),
    );
    return {
      status: "canonical-live",
      canonicalAdmission: "admitted",
      kind: "lineage",
      accountNaturalKey: request.accountNaturalKey,
      accounts: selectedAccounts,
      captures: fubonQueryCaptures(
        store.db,
        selectedAccounts.map((account) => account.accountId),
        knowledgeAt,
      ),
      transactions,
      statements,
      transactionRevisions: transactions,
      statementMemberships,
      relations,
      provenance,
      statementProvenance,
      provenanceCount: provenance.length + statementProvenance.length,
    };
  });
}

export const queryFubonCreditCardCurrentView = queryFubonCreditCardCurrent;
export const queryFubonCreditCardHistoricalView = queryFubonCreditCardHistorical;
export const queryFubonCreditCardLineageView = queryFubonCreditCardLineage;
