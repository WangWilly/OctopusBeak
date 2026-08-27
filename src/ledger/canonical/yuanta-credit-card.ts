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
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  isYuantaCreditCardHumanAttestedAccountKey,
  isYuantaCreditCardHumanAttestedV1Active,
  isYuantaCreditCardHumanAttestationDurablyActive,
  peekYuantaCreditCardHumanAttestationStatus,
  recordInitialYuantaCreditCardHumanAttestationIfMissing,
} from "./yuanta-credit-card-human-attestation.ts";

export type YuantaCreditCardExactAmount = {
  coefficient: string;
  scale: number;
};

export type YuantaCreditCardInstrumentRole =
  | "primary"
  | "supplementary"
  | "virtual"
  | "replacement";

export type YuantaCreditCardInstrumentEvidence = {
  kind: "explicit-instrument-role";
  sourceRecordKey: string;
  contractVersion: string;
};

export type YuantaCreditCardInstrumentInput = {
  instrumentKey: string;
  cardMask: `****${number}${number}${number}${number}`;
  productName?: string;
  role: YuantaCreditCardInstrumentRole;
  lifecycle?: "active" | "suspended" | "closed" | "replaced";
  evidence: YuantaCreditCardInstrumentEvidence;
};

export type YuantaCreditCardTransactionInput = {
  sourceRecordKey: string;
  occurrenceIndex: number;
  instrumentKey: string;
  consumeDate: string;
  postingDate: string;
  postingStatus?: "posted";
  direction: "inflow" | "outflow";
  bookedAmount: string | YuantaCreditCardExactAmount;
  bookedCurrency: string;
  /** The provider's signed amount lexeme, when available. */
  signedAmount?: string;
  foreignCurrency?: string | null;
  foreignAmount?: string | YuantaCreditCardExactAmount | null;
  description: string;
  billingStatus: "billed" | "unbilled";
  statementKey?: string;
  sourceKey?: string;
};

export type YuantaCreditCardStatementEvidence = {
  kind: "issuer-settled-cycle-summary";
  sourceRecordKey: string;
  settled: true;
};

export type YuantaCreditCardStatementInput = {
  statementKey: string;
  revisionKey: string;
  cycleStart: string;
  cycleEnd: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  balance: string | YuantaCreditCardExactAmount;
  minimumPayment?: string | YuantaCreditCardExactAmount;
  transactionSourceKeys: readonly string[];
  evidence: YuantaCreditCardStatementEvidence;
};

export type YuantaCreditCardRelationInput = {
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
  };
};

export type YuantaCreditCardGrid = {
  kind: "billed" | "unbilled";
  period: string;
  currentPage: number;
  pageSize: number;
  capturedRowCount: number;
  terminal: true;
  terminalEvidence: "no-pager-terminal";
};

export type YuantaCreditCardCompleteness = {
  billedPeriods: readonly string[];
  unbilledIncluded: boolean;
  unfiltered: boolean;
  terminalGrids: boolean;
  rowCountsMatch: boolean;
  periodRowCounts: readonly number[];
  unbilledRowCount: number;
  recordCount: number;
  settledSummaryEvidencePresent: boolean;
  grids: readonly YuantaCreditCardGrid[];
};

export type YuantaCreditCardCaptureInput = {
  captureId: string;
  identity: {
    sourceConnectionKey: string;
    identityEpochKey: string;
    /** An opaque HMAC-derived portfolio key; never a raw login value. */
    humanAttestedAccountKey: string;
  };
  observedAt: string;
  scope: {
    startDate: string;
    endDate: string;
    completeness: YuantaCreditCardCompleteness;
  };
  instruments: readonly YuantaCreditCardInstrumentInput[];
  transactions: readonly YuantaCreditCardTransactionInput[];
  statements: readonly YuantaCreditCardStatementInput[];
  relations: readonly YuantaCreditCardRelationInput[];
};

export type YuantaCreditCardAdmittedTransaction = Omit<
  YuantaCreditCardTransactionInput,
  "bookedAmount" | "foreignAmount" | "sourceKey" | "postingStatus"
> & {
  sourceKey: `sha256:${string}`;
  bookedAmount: YuantaCreditCardExactAmount;
  foreignAmount: YuantaCreditCardExactAmount | null;
  postingStatus: "posted";
  normalizedDescription: string;
};

export type YuantaCreditCardAdmittedStatement = Omit<
  YuantaCreditCardStatementInput,
  "balance" | "minimumPayment"
> & {
  balance: YuantaCreditCardExactAmount;
  minimumPayment: YuantaCreditCardExactAmount | null;
};

export type YuantaCreditCardAdmittedCapture = Omit<
  YuantaCreditCardCaptureInput,
  "identity" | "scope" | "instruments" | "transactions" | "statements"
> & {
  identity: {
    sourceConnectionKey: string;
    identityEpochKey: string;
    humanAttestedAccountKey: string;
    accountNaturalKey: `sha256:${string}`;
    accountType: "credit";
    accountSubtype: "credit_card";
    stream: "credit-card";
    providerGuaranteed: false;
    occurrenceProviderGuaranteed: false;
    identityMethod: "human-attested";
  };
  scope: YuantaCreditCardCaptureInput["scope"];
  instruments: readonly YuantaCreditCardInstrumentInput[];
  transactions: readonly YuantaCreditCardAdmittedTransaction[];
  statements: readonly YuantaCreditCardAdmittedStatement[];
  contractVersion: typeof YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion;
  authorityRoute: typeof YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute;
};

export type YuantaCreditCardValidatedCapture =
  YuantaCreditCardAdmittedCapture & {
    readonly __runtimeValidatedYuantaCreditCardCapture: true;
  };

export const YUANTA_CREDIT_CARD_CAPTURE_CONTRACT = Object.freeze({
  source: "yuanta",
  stream: "credit-card",
  authorityRoute: YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute,
  contractVersion:
    YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion,
  accountType: "credit",
  accountSubtype: "credit_card",
  providerGuaranteed: false,
  occurrenceProviderGuaranteed: false,
  postingRule: "posting-date-present-means-posted",
  billingRule: "billed-or-unbilled-independent-of-posting",
  transactionIdentityRule:
    "normalized-content-tuple-plus-contiguous-exact-duplicate-ordinal-v1",
  statementRule: "issuer-settled-cycle-summary-only",
  relationRule: "explicit-source-linkage-only",
  completenessRule: "six-billed-months-plus-unbilled-terminal-no-pager",
} as const);

export class YuantaCreditCardAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YuantaCreditCardAdmissionError";
  }
}

const VALIDATED_CAPTURES = new WeakSet<object>();

function fail(message: string): never {
  throw new YuantaCreditCardAdmissionError(message);
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

function exactAmount(
  input: string | YuantaCreditCardExactAmount,
  label: string,
): YuantaCreditCardExactAmount {
  if (typeof input === "object" && input !== null) {
    if (
      !/^(?:0|[1-9]\d*)$/u.test(input.coefficient) ||
      !Number.isSafeInteger(input.scale) ||
      input.scale < 0
    )
      fail(`${label} must be an exact non-negative amount.`);
    return { coefficient: input.coefficient, scale: input.scale };
  }
  const normalized = text(input, label).replaceAll(",", "");
  const match = normalized.match(/^(\d+)(?:\.(\d+))?$/u);
  if (!match) fail(`${label} must be a non-negative exact decimal.`);
  const integer = match[1]!.replace(/^0+(?=\d)/u, "");
  const fraction = match[2] ?? "";
  const coefficient = `${integer}${fraction}`.replace(/^0+(?=\d)/u, "") || "0";
  return coefficient === "0"
    ? { coefficient: "0", scale: 0 }
    : { coefficient, scale: fraction.length };
}

function signedAmount(value: string): "positive" | "negative" | "zero" {
  const normalized = text(value, "Signed amount").replaceAll(",", "");
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(normalized))
    fail("Signed amount must be an exact decimal.");
  const unsigned = normalized
    .replace(/^[+-]/u, "")
    .replace(/^0+(?=\d)/u, "");
  if (/^0(?:\.0+)?$/u.test(unsigned)) return "zero";
  return normalized.startsWith("-") ? "negative" : "positive";
}

function currency(value: unknown, label: string): string {
  const normalized = text(value, label).toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalized)) fail(`${label} must be an ISO currency.`);
  return normalized;
}

function normalizedDescription(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function digest(domain: string, values: readonly unknown[]): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([domain, ...values]))
    .digest("base64url")}`;
}

function stableTuple(values: readonly unknown[]): string {
  return JSON.stringify(values);
}

export type YuantaCreditCardIdentityInput =
  YuantaCreditCardCaptureInput["identity"];

export function buildYuantaCreditCardAccountIdentityKey(
  identity: YuantaCreditCardIdentityInput,
): `sha256:${string}` {
  const sourceConnectionKey = text(
    identity.sourceConnectionKey,
    "Source connection key",
  );
  const identityEpochKey = text(identity.identityEpochKey, "Identity epoch key");
  const accountKey = text(
    identity.humanAttestedAccountKey,
    "Human-attested account key",
  );
  if (!isYuantaCreditCardHumanAttestedAccountKey(accountKey))
    fail("Human-attested account key must be opaque and independent of card identity.");
  return digest("yuanta-credit-account-v1", [
    sourceConnectionKey,
    identityEpochKey,
    accountKey,
  ]);
}

export function buildYuantaCreditCardTransactionSourceKey(
  identity: YuantaCreditCardIdentityInput,
  record: YuantaCreditCardTransactionInput,
): `sha256:${string}` {
  const accountKey = buildYuantaCreditCardAccountIdentityKey(identity);
  const amount = exactAmount(record.bookedAmount, "Booked amount");
  const foreignCurrency = record.foreignCurrency
    ? currency(record.foreignCurrency, "Foreign currency")
    : null;
  const foreignAmount = record.foreignAmount == null
    ? null
    : exactAmount(record.foreignAmount, "Foreign amount");
  if ((foreignCurrency === null) !== (foreignAmount === null))
    fail("Foreign currency and foreign amount must be provided together.");
  return digest("yuanta-credit-card-transaction-v1", [
    accountKey,
    text(record.instrumentKey, "Card instrument key"),
    validDate(record.consumeDate, "Consume date"),
    validDate(record.postingDate, "Posting date"),
    record.direction,
    amount.coefficient,
    amount.scale,
    currency(record.bookedCurrency, "Booked currency"),
    foreignCurrency,
    foreignAmount?.coefficient ?? null,
    foreignAmount?.scale ?? null,
    normalizedDescription(text(record.description, "Transaction description")),
    record.occurrenceIndex,
  ]);
}

export function buildYuantaCreditCardStatementEvidenceKey(
  identity: YuantaCreditCardIdentityInput,
  statement: Pick<
    YuantaCreditCardStatementInput,
    "statementKey" | "cycleStart" | "cycleEnd"
  >,
): `sha256:${string}` {
  return digest("yuanta-credit-card-statement-summary-v1", [
    buildYuantaCreditCardAccountIdentityKey(identity),
    text(statement.statementKey, "Statement key"),
    validDate(statement.cycleStart, "Statement cycle start"),
    validDate(statement.cycleEnd, "Statement cycle end"),
  ]);
}

function validateGrid(grid: YuantaCreditCardGrid): void {
  if (
    grid.currentPage !== 1 ||
    !Number.isSafeInteger(grid.pageSize) ||
    grid.pageSize < grid.capturedRowCount ||
    !Number.isSafeInteger(grid.capturedRowCount) ||
    grid.capturedRowCount < 0 ||
    grid.terminal !== true ||
    grid.terminalEvidence !== "no-pager-terminal"
  )
    fail("Yuanta credit-card grid lacks terminal no-pager evidence.");
}

function validateCompleteness(
  completeness: YuantaCreditCardCompleteness,
  transactions: readonly YuantaCreditCardAdmittedTransaction[],
): void {
  if (
    !Array.isArray(completeness.billedPeriods) ||
    completeness.billedPeriods.length !== 6 ||
    new Set(completeness.billedPeriods).size !== 6
  )
    fail("Yuanta credit-card capture requires six distinct billed months.");
  if (
    completeness.unbilledIncluded !== true ||
    completeness.unfiltered !== true ||
    completeness.terminalGrids !== true ||
    completeness.rowCountsMatch !== true
  )
    fail("Yuanta credit-card capture is not complete.");
  if (typeof completeness.settledSummaryEvidencePresent !== "boolean")
    fail("Yuanta settled statement evidence flag is invalid.");
  if (
    !Array.isArray(completeness.periodRowCounts) ||
    completeness.periodRowCounts.length !== 6 ||
    completeness.periodRowCounts.some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    ) ||
    !Number.isSafeInteger(completeness.unbilledRowCount) ||
    completeness.unbilledRowCount < 0 ||
    !Number.isSafeInteger(completeness.recordCount) ||
    completeness.recordCount !== transactions.length ||
    !Array.isArray(completeness.grids) ||
    completeness.grids.length !== 7
  )
    fail("Yuanta credit-card completeness counts are invalid.");
  completeness.grids.forEach(validateGrid);
  const billedCount = transactions.filter((row) => row.billingStatus === "billed").length;
  const unbilledCount = transactions.filter((row) => row.billingStatus === "unbilled").length;
  if (
    completeness.periodRowCounts.reduce((sum, count) => sum + count, 0) !== billedCount ||
    completeness.unbilledRowCount !== unbilledCount
  )
    fail("Yuanta credit-card completeness counts drifted from records.");
  for (const [index, period] of completeness.billedPeriods.entries()) {
    const grid = completeness.grids[index];
    if (
      !grid ||
      grid.kind !== "billed" ||
      grid.period !== period ||
      grid.capturedRowCount !== completeness.periodRowCounts[index]
    )
      fail("Yuanta billed grid periods or row counts are inconsistent.");
  }
  const unbilledGrid = completeness.grids[6];
  if (
    !unbilledGrid ||
    unbilledGrid.kind !== "unbilled" ||
    unbilledGrid.period !== "unbilled" ||
    unbilledGrid.capturedRowCount !== completeness.unbilledRowCount
  )
    fail("Yuanta unbilled grid is inconsistent with completeness evidence.");
}

function validateInstrument(
  instrument: YuantaCreditCardInstrumentInput,
): YuantaCreditCardInstrumentInput {
  const instrumentKey = text(instrument.instrumentKey, "Card instrument key");
  if (/\d[\d\s-]{11,}\d/u.test(instrumentKey))
    fail("Card instrument key must not contain a full card number.");
  if (!/^\*{4}\d{4}$/u.test(instrument.cardMask))
    fail("Yuanta card instrument must retain a four-digit display mask.");
  if (
    !instrument.evidence ||
    instrument.evidence.kind !== "explicit-instrument-role" ||
    instrument.evidence.contractVersion !==
      YUANTA_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion
  )
    fail("Yuanta card instrument lacks explicit versioned role evidence.");
  if (instrument.productName && /\d[\d\s-]{11,}\d/u.test(instrument.productName))
    fail("Card product name must not contain a full card number.");
  return {
    ...instrument,
    instrumentKey,
    cardMask: instrument.cardMask,
    productName: instrument.productName?.trim() || undefined,
  };
}

function validateTransaction(
  identity: YuantaCreditCardIdentityInput,
  instruments: ReadonlyMap<string, YuantaCreditCardInstrumentInput>,
  record: YuantaCreditCardTransactionInput,
): YuantaCreditCardAdmittedTransaction {
  const sourceRecordKey = text(record.sourceRecordKey, "Source record key");
  if (!Number.isSafeInteger(record.occurrenceIndex) || record.occurrenceIndex < 0)
    fail("Transaction occurrence index must be a non-negative integer.");
  const instrumentKey = text(record.instrumentKey, "Card instrument key");
  if (!instruments.has(instrumentKey))
    fail("Transaction references an unknown card instrument.");
  const consumeDate = validDate(record.consumeDate, "Consume date");
  const postingDate = validDate(record.postingDate, "Posting date");
  if (record.postingStatus !== undefined && record.postingStatus !== "posted")
    fail("Yuanta credit-card transactions must be posted.");
  const bookedAmount = exactAmount(record.bookedAmount, "Booked amount");
  const bookedCurrency = currency(record.bookedCurrency, "Booked currency");
  const description = text(record.description, "Transaction description");
  if (record.billingStatus === "billed" &&
      record.statementKey !== undefined &&
      !record.statementKey.trim())
    fail("Billed Yuanta transaction statement keys must be non-empty when supplied.");
  if (record.billingStatus === "unbilled" && record.statementKey)
    fail("Unbilled Yuanta transactions cannot belong to a Statement.");
  if (record.signedAmount !== undefined) {
    const sign = signedAmount(record.signedAmount);
    if (
      sign === "zero" ||
      (sign === "positive" && record.direction !== "outflow") ||
      (sign === "negative" && record.direction !== "inflow")
    )
      fail("Signed amount conflicts with Yuanta transaction direction.");
  }
  if (bookedAmount.coefficient === "0")
    fail("Zero-value Yuanta credit-card rows cannot establish direction.");
  if (record.direction !== "inflow" && record.direction !== "outflow")
    fail("Transaction direction is invalid.");
  const foreignCurrency = record.foreignCurrency
    ? currency(record.foreignCurrency, "Foreign currency")
    : null;
  const foreignAmount = record.foreignAmount == null
    ? null
    : exactAmount(record.foreignAmount, "Foreign amount");
  if ((foreignCurrency === null) !== (foreignAmount === null))
    fail("Foreign currency and foreign amount must be provided together.");
  const normalizedRecord = {
    ...record,
    sourceRecordKey,
    instrumentKey,
    consumeDate,
    postingDate,
    bookedAmount,
    bookedCurrency,
    description,
    foreignCurrency,
    foreignAmount,
    postingStatus: "posted" as const,
  };
  const sourceKey = buildYuantaCreditCardTransactionSourceKey(
    identity,
    normalizedRecord,
  );
  if (record.sourceKey && record.sourceKey !== sourceKey)
    fail("Provided transaction source key does not match the contract tuple.");
  return {
    ...normalizedRecord,
    sourceKey,
    normalizedDescription: normalizedDescription(description),
  };
}

function validateStatement(
  identity: YuantaCreditCardIdentityInput,
  statement: YuantaCreditCardStatementInput,
  transactions: ReadonlyMap<string, YuantaCreditCardAdmittedTransaction>,
): YuantaCreditCardAdmittedStatement {
  const statementKey = text(statement.statementKey, "Statement key");
  const revisionKey = text(statement.revisionKey, "Statement revision key");
  const cycleStart = validDate(statement.cycleStart, "Statement cycle start");
  const cycleEnd = validDate(statement.cycleEnd, "Statement cycle end");
  const issueDate = validDate(statement.issueDate, "Statement issue date");
  const dueDate = validDate(statement.dueDate, "Statement due date");
  if (cycleStart > cycleEnd || issueDate < cycleEnd || dueDate < issueDate)
    fail("Yuanta settled statement cycle or billing dates are invalid.");
  if (
    statement.evidence.kind !== "issuer-settled-cycle-summary" ||
    statement.evidence.settled !== true ||
    text(statement.evidence.sourceRecordKey, "Statement evidence source record key") !==
      buildYuantaCreditCardStatementEvidenceKey(identity, {
        statementKey,
        cycleStart,
        cycleEnd,
      })
  )
    fail("Statement evidence is not scoped to this Yuanta account and cycle.");
  for (const sourceRecordKey of statement.transactionSourceKeys) {
    const transaction = transactions.get(sourceRecordKey);
    if (
      !transaction ||
      transaction.billingStatus !== "billed" ||
      transaction.statementKey !== statementKey
    )
      fail("Statement membership must reference billed transactions in the capture.");
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
      sourceRecordKey: statement.evidence.sourceRecordKey,
      settled: true,
    },
  };
}

function validateRelations(
  relations: readonly YuantaCreditCardRelationInput[],
  transactions: ReadonlyMap<string, YuantaCreditCardAdmittedTransaction>,
): YuantaCreditCardRelationInput[] {
  return relations.map((relation) => {
    const from = transactions.get(text(relation.fromSourceRecordKey, "Relation source"));
    const to = transactions.get(text(relation.toSourceRecordKey, "Relation target"));
    if (!from || !to || from.sourceRecordKey === to.sourceRecordKey)
      fail("Yuanta relation references an invalid transaction endpoint.");
    if (
      relation.evidence.kind !== "explicit-source-linkage" ||
      relation.evidence.contractVersion !==
        YUANTA_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion ||
      (relation.evidence.sourceRecordKey !== from.sourceRecordKey &&
        relation.evidence.sourceRecordKey !== to.sourceRecordKey)
    )
      fail("Yuanta relations require explicit source linkage evidence.");
    if (relation.kind === "pending_to_posted")
      fail("Yuanta v1 does not admit pending credit-card transactions.");
    if (
      (relation.kind === "refund_of" &&
        (from.direction !== "inflow" || to.direction !== "outflow")) ||
      ((relation.kind === "reversal_of" || relation.kind === "transfer_counterpart") &&
        from.direction === to.direction) ||
      (relation.kind === "installment_of" &&
        (from.direction !== "outflow" || to.direction !== "outflow"))
    )
      fail("Yuanta relation directions are inconsistent.");
    return {
      ...relation,
      fromSourceRecordKey: from.sourceRecordKey,
      toSourceRecordKey: to.sourceRecordKey,
      evidence: { ...relation.evidence },
    };
  });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object") deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

export function admitYuantaCreditCardCapture(
  capture: YuantaCreditCardCaptureInput,
): YuantaCreditCardValidatedCapture {
  if (!isYuantaCreditCardHumanAttestedV1Active())
    fail("Yuanta credit-card human-attested v1 contract is revoked.");
  if (capture === null || typeof capture !== "object")
    fail("Yuanta credit-card capture is required.");
  const captureId = text(capture.captureId, "Capture ID");
  const observedAt = text(capture.observedAt, "Observed at");
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(observedAt))
    fail("Observed at must be an ISO timestamp.");
  const sourceConnectionKey = text(
    capture.identity.sourceConnectionKey,
    "Source connection key",
  );
  const identityEpochKey = text(
    capture.identity.identityEpochKey,
    "Identity epoch key",
  );
  const humanAttestedAccountKey = text(
    capture.identity.humanAttestedAccountKey,
    "Human-attested account key",
  );
  if (!isYuantaCreditCardHumanAttestedAccountKey(humanAttestedAccountKey))
    fail("Human-attested account key must be opaque and independent of card identity.");
  const identity = {
    sourceConnectionKey,
    identityEpochKey,
    humanAttestedAccountKey,
  } satisfies YuantaCreditCardIdentityInput;
  const startDate = validDate(capture.scope.startDate, "Capture start date");
  const endDate = validDate(capture.scope.endDate, "Capture end date");
  if (startDate > endDate) fail("Capture date scope is inverted.");
  if (!Array.isArray(capture.instruments) || capture.instruments.length === 0)
    fail("Yuanta credit-card capture requires card instruments.");
  const instruments = new Map<string, YuantaCreditCardInstrumentInput>();
  for (const instrument of capture.instruments) {
    const normalized = validateInstrument(instrument);
    if (instruments.has(normalized.instrumentKey))
      fail("Duplicate Yuanta card instrument key.");
    instruments.set(normalized.instrumentKey, normalized);
  }
  if (!Array.isArray(capture.transactions))
    fail("Yuanta credit-card transactions are required.");
  const transactions: YuantaCreditCardAdmittedTransaction[] = [];
  const sourceKeys = new Set<string>();
  const sourceRecords = new Set<string>();
  const occurrenceOrdinals = new Map<string, number>();
  const bySourceRecord = new Map<string, YuantaCreditCardAdmittedTransaction>();
  for (const record of capture.transactions) {
    const base = buildYuantaCreditCardTransactionSourceKey(identity, {
      ...record,
      occurrenceIndex: 0,
    });
    const expected = occurrenceOrdinals.get(base) ?? 0;
    if (record.occurrenceIndex !== expected)
      fail("Yuanta duplicate occurrence indexes must be contiguous in source order.");
    occurrenceOrdinals.set(base, expected + 1);
    const normalized = validateTransaction(identity, instruments, record);
    if (sourceRecords.has(normalized.sourceRecordKey))
      fail("Duplicate Yuanta source record key.");
    if (sourceKeys.has(normalized.sourceKey))
      fail("Yuanta transaction identity collision within one capture.");
    sourceRecords.add(normalized.sourceRecordKey);
    sourceKeys.add(normalized.sourceKey);
    bySourceRecord.set(normalized.sourceRecordKey, normalized);
    transactions.push(normalized);
  }
  for (const instrument of instruments.values()) {
    const evidenceKey = text(
      instrument.evidence.sourceRecordKey,
      "Instrument role evidence source record key",
    );
    const transaction = bySourceRecord.get(evidenceKey);
    if (!transaction || transaction.instrumentKey !== instrument.instrumentKey)
      fail("Instrument role evidence must reference a transaction for the same card.");
  }
  validateCompleteness(capture.scope.completeness, transactions);
  if (!Array.isArray(capture.statements))
    fail("Yuanta credit-card statements are required.");
  const statements = capture.statements.map((statement) =>
    validateStatement(identity, statement, bySourceRecord),
  );
  if (
    capture.scope.completeness.settledSummaryEvidencePresent !==
    (statements.length > 0)
  )
    fail("Yuanta settled statement evidence flag does not match supplied statements.");
  if (!Array.isArray(capture.relations))
    fail("Yuanta credit-card relations are required.");
  const relations = validateRelations(capture.relations, bySourceRecord);
  const result = {
    captureId,
    observedAt,
    identity: {
      ...identity,
      accountNaturalKey: buildYuantaCreditCardAccountIdentityKey(identity),
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
        periodRowCounts: [...capture.scope.completeness.periodRowCounts],
        grids: capture.scope.completeness.grids.map((grid) => ({ ...grid })),
      },
    },
    instruments: [...instruments.values()],
    transactions,
    statements,
    relations,
    contractVersion: YUANTA_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion,
    authorityRoute: YUANTA_CREDIT_CARD_CAPTURE_CONTRACT.authorityRoute,
  } satisfies YuantaCreditCardAdmittedCapture;
  const frozen = deepFreeze(result) as unknown as YuantaCreditCardValidatedCapture;
  VALIDATED_CAPTURES.add(frozen);
  return frozen;
}

export function isAdmittedYuantaCreditCardCapture(
  value: unknown,
): value is YuantaCreditCardValidatedCapture {
  return value !== null && typeof value === "object" && VALIDATED_CAPTURES.has(value);
}

/**
 * Translate admitted Yuanta facts to the provider-neutral credit-card
 * extension shape.  The generic writer uses an admitted transaction's
 * sourceKey as its source occurrence, so all extension evidence references
 * are translated from the provider-facing sourceRecordKey to that key.
 */
export function yuantaNeutralCreditCardCapture(
  capture: YuantaCreditCardValidatedCapture,
): CanonicalCreditCardPersistenceCapture {
  const sourceKeyBySourceRecordKey = new Map(
    capture.transactions.map((transaction) => [
      transaction.sourceRecordKey,
      transaction.sourceKey,
    ]),
  );
  const sourceKeyFor = (sourceRecordKey: string): string => {
    const sourceKey = sourceKeyBySourceRecordKey.get(sourceRecordKey);
    if (!sourceKey)
      throw new YuantaCreditCardAdmissionError(
        "Yuanta credit-card evidence references a missing transaction.",
      );
    return sourceKey;
  };
  return {
    integrationNamespace: "yuanta",
    captureId: capture.captureId,
    identity: {
      accountNaturalKey: capture.identity.accountNaturalKey,
      identityMethod: capture.identity.identityMethod,
    },
    instruments: capture.instruments.map((instrument) => ({
      instrumentKey: instrument.instrumentKey,
      cardMask: instrument.cardMask,
      role: instrument.role,
      lifecycle: instrument.lifecycle,
      evidence: {
        sourceRecordKey: sourceKeyFor(instrument.evidence.sourceRecordKey),
      },
    })),
    transactions: capture.transactions.map((transaction) => ({
      sourceRecordKey: transaction.sourceKey,
      sourceKey: transaction.sourceKey,
      instrumentKey: transaction.instrumentKey,
      billingStatus: transaction.billingStatus,
      ...(transaction.statementKey
        ? { statementKey: transaction.statementKey }
        : {}),
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
      transactionSourceKeys: statement.transactionSourceKeys.map(sourceKeyFor),
      evidence: {
        sourceRecordKey: statement.evidence.sourceRecordKey,
        settled: true as const,
      },
    })),
    relations: capture.relations.map((relation) => ({
      kind: relation.kind,
      fromSourceRecordKey: sourceKeyFor(relation.fromSourceRecordKey),
      toSourceRecordKey: sourceKeyFor(relation.toSourceRecordKey),
      evidence: {
        sourceRecordKey: sourceKeyFor(relation.evidence.sourceRecordKey),
      },
    })),
  };
}

export type YuantaCreditCardWriterStore = Pick<
  CanonicalSourceStore,
  "db" | "databasePath" | "commitClock"
> & {
  readonly beforeYuantaCreditExtensionCommit?: (db: DatabaseSync) => void;
};

export type YuantaCreditCardCommitResult = {
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

function opaqueYuantaSpineToken(
  label: string,
  value: unknown,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([label, value]))
    .digest("base64url")}`;
}

function yuantaCanonicalSpineCapture(
  capture: YuantaCreditCardValidatedCapture,
): CanonicalFinancialDepositValidatedCapture {
  const instrumentsByKey = new Map(
    capture.instruments.map((instrument) => [instrument.instrumentKey, instrument]),
  );
  const records = capture.transactions.map((transaction, sourceOrderOrdinal) => {
    const instrument = instrumentsByKey.get(transaction.instrumentKey);
    if (!instrument)
      throw new YuantaCreditCardAdmissionError(
        "Yuanta transaction instrument is missing from the validated capture.",
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
      foreignAmount: transaction.foreignAmount,
      foreignCurrency: transaction.foreignCurrency,
      description: transaction.description,
      billingStatus: transaction.billingStatus,
      statementKey: transaction.statementKey ?? null,
    });
    return {
      occurrenceKey: transaction.sourceKey,
      collisionKey: transaction.sourceKey,
      providerKey: "human-attested:no-provider-key",
      humanAttestedOccurrenceKey: transaction.sourceKey,
      contentHash: opaqueYuantaSpineToken("yuanta-credit-content-v1", compact),
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
        epochMilliseconds: Date.parse(
          `${transaction.postingDate}T00:00:00+08:00`,
        ),
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
              evidenceOrigin:
                "yuanta-credit-card-source-reported-original-amount",
            },
          }
        : {}),
    };
  });
  const fingerprint = opaqueYuantaSpineToken("yuanta-credit-contract-v1", {
    authority: capture.authorityRoute,
    contractVersion: capture.contractVersion,
    periods: capture.scope.completeness.billedPeriods,
  });
  return admitCanonicalFinancialDepositCapture({
    captureId: capture.captureId,
    authorityRoute: capture.authorityRoute,
    contractVersion: capture.contractVersion,
    identity: {
      integrationNamespace: "yuanta",
      sourceConnectionKey: opaqueYuantaSpineToken(
        "yuanta-credit-connection-v1",
        capture.identity.sourceConnectionKey,
      ),
      identityEpochKey: opaqueYuantaSpineToken(
        "yuanta-credit-epoch-v1",
        capture.identity.identityEpochKey,
      ),
      stream: "credit-card",
      recordKind: "yuanta-credit-card-transaction",
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
      completenessBasis: "six-billed-months-plus-unbilled-terminal-no-pager",
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
      responseDigest: opaqueYuantaSpineToken("yuanta-credit-page-v1", [
        capture.captureId,
        pageOrdinal,
        grid,
      ]),
      proofKind: "no-pager-terminal-grid",
      contractFingerprint: fingerprint,
      preflightFingerprint: fingerprint,
      metadataJson: JSON.stringify(grid),
    })),
    records,
  });
}

function hasValidatedYuantaCreditCardCapture(
  capture: unknown,
): capture is YuantaCreditCardValidatedCapture {
  return isAdmittedYuantaCreditCardCapture(capture);
}

function hasCurrentYuantaCreditCardRevisions(
  db: DatabaseSync,
  capture: YuantaCreditCardValidatedCapture,
): boolean {
  const captureRow = db.prepare(
    "SELECT capture_id FROM source_captures WHERE capture_key = ?",
  ).get(capture.captureId) as { capture_id?: Uint8Array } | undefined;
  if (!captureRow?.capture_id) return false;
  const row = db.prepare(
    `SELECT COUNT(DISTINCT source_record.source_record_id) AS count
     FROM source_records source_record
     JOIN transaction_revisions revision
       ON revision.source_record_id = source_record.source_record_id
     WHERE source_record.capture_id = ?
       AND source_record.record_kind = 'yuanta-credit-card-transaction'`,
  ).get(captureRow.capture_id) as { count?: number } | undefined;
  return Number(row?.count ?? 0) === capture.transactions.length;
}

export async function commitYuantaCreditCardCapture(
  store: YuantaCreditCardWriterStore,
  capture: YuantaCreditCardValidatedCapture,
): Promise<YuantaCreditCardCommitResult> {
  return (await commitYuantaCreditCardCaptureBatch(store, [capture]))[0]!;
}

export async function commitYuantaCreditCardCaptureBatch(
  store: YuantaCreditCardWriterStore,
  captures: readonly YuantaCreditCardValidatedCapture[],
): Promise<YuantaCreditCardCommitResult[]> {
  if (captures.length === 0)
    throw new YuantaCreditCardAdmissionError(
      "Yuanta credit-card capture batch cannot be empty.",
    );
  for (const capture of captures) {
    if (!hasValidatedYuantaCreditCardCapture(capture))
      throw new YuantaCreditCardAdmissionError(
        "Yuanta credit-card batch contains an unvalidated capture.",
      );
  }
  if (
    !isYuantaCreditCardHumanAttestedV1Active() ||
    peekYuantaCreditCardHumanAttestationStatus(store.db) === "revoked"
  )
    throw new YuantaCreditCardAdmissionError(
      "Yuanta credit-card durable human attestation is revoked.",
    );
  const committed = await commitCanonicalFinancialDepositCaptureBatch(
    store,
    captures.map(yuantaCanonicalSpineCapture),
    (db) => {
      ensureCanonicalCreditCardSchema(db);
      if (!isYuantaCreditCardHumanAttestedV1Active())
        throw new YuantaCreditCardAdmissionError(
          "Yuanta credit-card durable human attestation is revoked.",
        );
      recordInitialYuantaCreditCardHumanAttestationIfMissing(db);
      if (!isYuantaCreditCardHumanAttestationDurablyActive(db))
        throw new YuantaCreditCardAdmissionError(
          "Yuanta credit-card durable human attestation is revoked.",
        );
      store.beforeYuantaCreditExtensionCommit?.(db);
      const extensionCaptures = captures.map((capture) => {
        const neutral = yuantaNeutralCreditCardCapture(capture);
        if (hasCurrentYuantaCreditCardRevisions(db, capture)) return neutral;
        // The generic writer intentionally reuses an unchanged transaction
        // revision on a repeated capture.  Keep neutral instrument evidence
        // for that observation, but do not ask the extension helper to resolve
        // source records that have no revision in the current capture.
        return {
          ...neutral,
          transactions: [],
          statements: [],
          relations: [],
        };
      });
      persistCanonicalCreditCardExtensions(
        db,
        extensionCaptures,
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
      throw new Error("Yuanta shared canonical account is missing after commit.");
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

export type YuantaCreditCardSourceRow = {
  creditCardNo: string;
  creditCardName: string;
  consumeDate: string;
  postedDate: string;
  description: string;
  countryCurrency: string;
  foreignExchangeDate: string;
  foreignAmount: string;
  twdAmount: string;
  paymentStatus: string;
  period: string | null;
  /**
   * Opaque HMAC of the provider/account-scoped first-six + last-four
   * projection. The projection itself must never cross this boundary.
   */
  instrumentKey: string;
};

export type YuantaCreditCardStatementSummary = {
  period: string;
  cycleStart: string;
  cycleEnd: string;
  issueDate: string;
  dueDate: string;
  balance: string;
  minimumPayment?: string;
};

export type YuantaCreditCardCaptureBuilderOptions = {
  captureId: string;
  observedAt: string;
  identity: YuantaCreditCardIdentityInput;
  billedRows: readonly YuantaCreditCardSourceRow[];
  unbilledRows: readonly YuantaCreditCardSourceRow[];
  billedPeriods: readonly string[];
  /** The no-pager check is performed by the browser workflow. */
  terminalPages?: readonly boolean[];
  statementSummaries?: readonly YuantaCreditCardStatementSummary[];
};

function instrumentKeyForRow(row: YuantaCreditCardSourceRow): string {
  const instrumentKey = row.instrumentKey.trim();
  if (!/^yuanta_instrument_[A-Za-z0-9_-]{43}$/u.test(instrumentKey))
    throw new Error("Yuanta canonical capture requires an opaque projected instrument key.");
  return instrumentKey;
}

function cardMaskForRow(
  row: YuantaCreditCardSourceRow,
): `****${number}${number}${number}${number}` {
  if (!/^\*{4}\d{4}$/u.test(row.creditCardNo))
    throw new Error("Yuanta canonical capture requires a four-digit display mask.");
  return row.creditCardNo as `****${number}${number}${number}${number}`;
}

function safeCardName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/(?<!\d)(?:\d[\s-]*){12,19}(?!\d)/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function parseCurrency(value: string): string | null {
  const match = value.toUpperCase().match(/\b([A-Z]{3})\b/u);
  return match?.[1] ?? null;
}

function canonicalDate(value: string, label: string): string {
  const normalized = text(value, label).replace(/[.\/]/gu, "-");
  const match = normalized.match(/^(\d{3,4})-(\d{2})-(\d{2})$/u);
  if (!match) throw new Error(`Yuanta ${label} must be a calendar date.`);
  const year = Number(match[1]!.length === 3 ? Number(match[1]) + 1911 : match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const result = date.toISOString().slice(0, 10);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new Error(`Yuanta ${label} must be a valid calendar date.`);
  return result;
}

function parseSignedDecimal(value: string, label: string): {
  amount: string;
  direction: "inflow" | "outflow";
  signed: string;
} {
  const normalized = text(value, label).replaceAll(",", "");
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(normalized))
    throw new Error(`Yuanta ${label} must be an exact signed decimal.`);
  const sign = normalized.startsWith("-") ? "inflow" : "outflow";
  const unsigned = normalized.replace(/^[+-]/u, "");
  if (/^0(?:\.0+)?$/u.test(unsigned))
    throw new Error("Zero-value Yuanta credit-card rows cannot establish direction.");
  return { amount: unsigned, direction: sign, signed: normalized };
}

function canonicalRowBase(
  row: YuantaCreditCardSourceRow,
  instrumentKey: string,
  settledPeriods: ReadonlySet<string>,
): Omit<YuantaCreditCardTransactionInput, "sourceRecordKey" | "occurrenceIndex"> {
  const signed = parseSignedDecimal(row.twdAmount, "TWD amount");
  const foreignCurrency = row.foreignAmount.trim()
    ? parseCurrency(row.countryCurrency)
    : null;
  const foreignAmount = row.foreignAmount.trim()
    ? text(row.foreignAmount, "Foreign amount").replace(/^[+]/u, "")
    : null;
  if (foreignAmount && !foreignCurrency)
    throw new Error("Yuanta foreign amount is missing its ISO currency.");
  return {
    instrumentKey,
    consumeDate: canonicalDate(row.consumeDate, "consume date"),
    postingDate: canonicalDate(row.postedDate, "posting date"),
    postingStatus: "posted",
    direction: signed.direction,
    bookedAmount: signed.amount,
    bookedCurrency: "TWD",
    signedAmount: signed.signed,
    foreignCurrency,
    foreignAmount,
    description: row.description,
    billingStatus: row.period ? "billed" : "unbilled",
    ...(row.period && settledPeriods.has(row.period)
      ? { statementKey: digest("yuanta-credit-statement-v1", [row.period]) }
      : {}),
  };
}

/**
 * Build and admit one complete Yuanta portfolio capture from redacted parsed
 * rows.  The identity key is intentionally supplied separately from rows;
 * card labels can only display subordinate instruments. Instrument identity
 * must already be an opaque, provider/account-scoped HMAC produced at the
 * workflow boundary.
 */
export function buildYuantaCanonicalCreditCardCapture(
  options: YuantaCreditCardCaptureBuilderOptions,
): YuantaCreditCardValidatedCapture {
  if (options.billedPeriods.length !== 6 || new Set(options.billedPeriods).size !== 6)
    throw new Error("Yuanta canonical capture requires all six billed periods.");
  if (options.terminalPages &&
      (options.terminalPages.length !== 7 || options.terminalPages.some((value) => value !== true)))
    throw new Error("Yuanta canonical capture requires seven terminal no-pager results.");
  const summaries = new Map<string, YuantaCreditCardStatementSummary>();
  for (const summary of options.statementSummaries ?? []) {
    const period = text(summary.period, "Statement summary period");
    if (!options.billedPeriods.includes(period))
      throw new Error("Yuanta statement summary period is outside the captured billed periods.");
    if (summaries.has(period))
      throw new Error("Yuanta statement summary periods must be unique.");
    summaries.set(period, { ...summary, period });
  }
  const settledPeriods = new Set(summaries.keys());
  const allRows = [...options.billedRows, ...options.unbilledRows];
  if (allRows.length === 0) throw new Error("Yuanta canonical capture requires observed rows.");
  const cardDescriptors = new Map<
    string,
    { cardMask: `****${number}${number}${number}${number}`; descriptor: string }
  >();
  for (const row of allRows) {
    const instrumentKey = instrumentKeyForRow(row);
    const cardMask = cardMaskForRow(row);
    const descriptor = safeCardName(row.creditCardName);
    const previous = cardDescriptors.get(instrumentKey);
    if (
      previous !== undefined &&
      (previous.cardMask !== cardMask || previous.descriptor !== descriptor)
    )
      throw new Error("Yuanta projected card evidence conflicts for one instrument key.");
    cardDescriptors.set(instrumentKey, { cardMask, descriptor });
  }
  const descriptors = allRows.map((row, inputIndex) => {
    const instrumentKey = instrumentKeyForRow(row);
    const base = canonicalRowBase(row, instrumentKey, settledPeriods);
    const baseIdentity = stableTuple([
      instrumentKey,
      base.consumeDate,
      base.postingDate,
      base.direction,
      base.bookedAmount,
      base.bookedCurrency,
      base.foreignCurrency,
      base.foreignAmount,
      normalizedDescription(base.description),
    ]);
    return { row, inputIndex, instrumentKey, base, baseIdentity };
  });
  const ordered = descriptors.slice().sort((left, right) =>
    left.baseIdentity.localeCompare(right.baseIdentity) || left.inputIndex - right.inputIndex,
  );
  const occurrences = new Map<string, number>();
  const transactions = ordered.map((descriptor) => {
    const occurrenceIndex = occurrences.get(descriptor.baseIdentity) ?? 0;
    occurrences.set(descriptor.baseIdentity, occurrenceIndex + 1);
    return {
      sourceRecordKey: digest("yuanta-credit-card-source-record-v1", [
        descriptor.baseIdentity,
        occurrenceIndex,
      ]),
      occurrenceIndex,
      ...descriptor.base,
    } satisfies YuantaCreditCardTransactionInput;
  });
  const firstTransactionByInstrument = new Map<string, YuantaCreditCardTransactionInput>();
  for (const transaction of transactions)
    if (!firstTransactionByInstrument.has(transaction.instrumentKey))
      firstTransactionByInstrument.set(transaction.instrumentKey, transaction);
  const instruments = [...cardDescriptors.entries()].map(([instrumentKey, card]) => ({
    instrumentKey,
    cardMask: card.cardMask,
    productName: card.descriptor || undefined,
    role: "primary" as const,
    evidence: {
      kind: "explicit-instrument-role" as const,
      sourceRecordKey: firstTransactionByInstrument.get(instrumentKey)!.sourceRecordKey,
      contractVersion: YUANTA_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion,
    },
  }));
  const statements = options.billedPeriods.flatMap((period) => {
    const summary = summaries.get(period);
    if (!summary) return [];
    const cycleStart = canonicalDate(summary.cycleStart, "statement cycle start");
    const cycleEnd = canonicalDate(summary.cycleEnd, "statement cycle end");
    const statementKey = digest("yuanta-credit-statement-v1", [period]);
    const periodTransactions = transactions.filter(
      (transaction) => transaction.billingStatus === "billed" && transaction.statementKey === statementKey,
    );
    const sourceRecordKeys = periodTransactions.map((transaction) => transaction.sourceRecordKey);
    const issueDate = canonicalDate(summary.issueDate, "statement issue date");
    const dueDate = canonicalDate(summary.dueDate, "statement due date");
    return [{
      statementKey,
      revisionKey: digest("yuanta-credit-statement-revision-v1", [
        statementKey,
        sourceRecordKeys,
        summary.balance,
      ]),
      cycleStart,
      cycleEnd,
      issueDate,
      dueDate,
      currency: "TWD",
      balance: summary.balance,
      ...(summary.minimumPayment !== undefined
        ? { minimumPayment: summary.minimumPayment }
        : {}),
      transactionSourceKeys: sourceRecordKeys,
      evidence: {
        kind: "issuer-settled-cycle-summary" as const,
        sourceRecordKey: buildYuantaCreditCardStatementEvidenceKey(options.identity, {
          statementKey,
          cycleStart,
          cycleEnd,
        }),
        settled: true as const,
      },
    } satisfies YuantaCreditCardStatementInput];
  });
  // `canonicalRowBase` has already normalized ROC dates to ISO dates.  Scope
  // dates must be derived from those admitted values; using the raw provider
  // lexemes here would make a ROC year look earlier than the actual capture
  // and would fail admission's YYYY-MM-DD invariant.
  const dates = transactions.flatMap((transaction) => [
    transaction.consumeDate,
    transaction.postingDate,
  ]);
  const capture: YuantaCreditCardCaptureInput = {
    captureId: options.captureId,
    identity: options.identity,
    observedAt: options.observedAt,
    scope: {
      startDate: dates.slice().sort()[0] ?? "2026-01-01",
      endDate: dates.slice().sort().at(-1) ?? "2026-12-31",
      completeness: {
        billedPeriods: [...options.billedPeriods],
        unbilledIncluded: true,
        unfiltered: true,
        terminalGrids: true,
        rowCountsMatch: true,
        periodRowCounts: options.billedPeriods.map(
          (period) => options.billedRows.filter((row) => row.period === period).length,
        ),
        unbilledRowCount: options.unbilledRows.length,
        recordCount: transactions.length,
        settledSummaryEvidencePresent: statements.length > 0,
        grids: [
          ...options.billedPeriods.map((period) => ({
            kind: "billed" as const,
            period,
            currentPage: 1,
            pageSize: Math.max(1, options.billedRows.filter((row) => row.period === period).length),
            capturedRowCount: options.billedRows.filter((row) => row.period === period).length,
            terminal: true as const,
            terminalEvidence: "no-pager-terminal" as const,
          })),
          {
            kind: "unbilled" as const,
            period: "unbilled",
            currentPage: 1,
            pageSize: Math.max(1, options.unbilledRows.length),
            capturedRowCount: options.unbilledRows.length,
            terminal: true as const,
            terminalEvidence: "no-pager-terminal" as const,
          },
        ],
      },
    },
    instruments,
    transactions,
    statements,
    relations: [],
  };
  return admitYuantaCreditCardCapture(capture);
}

export const buildYuantaCanonicalCreditCardCaptures = (
  options: YuantaCreditCardCaptureBuilderOptions,
): YuantaCreditCardValidatedCapture[] => [buildYuantaCanonicalCreditCardCapture(options)];
