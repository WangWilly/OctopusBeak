import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCaptureBatch,
  type CanonicalFinancialDepositCapture,
  type CanonicalFinancialDepositCommitResult,
  type CanonicalFinancialDepositValidatedCapture,
} from "./canonical-financial-deposit-writer.ts";
import {
  createCanonicalSourceStore,
  validateCanonicalLoanExtensionSchema,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";
import { withCanonicalSnapshot } from "./canonical-runtime.ts";

export type LoanSourceId = "fubon" | "yuanta";

export const ADVERTISED_LOAN_SOURCE_IDS = ["fubon", "yuanta"] as const;

export const LOAN_CANONICAL_CONTRACT_VERSION = "loan/canonical/v1" as const;
export const FUBON_LOAN_CONTRACT_VERSION =
  `${LOAN_CANONICAL_CONTRACT_VERSION}.fubon` as const;
export const YUANTA_LOAN_CONTRACT_VERSION =
  `${LOAN_CANONICAL_CONTRACT_VERSION}.yuanta` as const;

export const FUBON_LOAN_AUTHORITY_ROUTE = "fubon/loan/canonical-v1" as const;
export const YUANTA_LOAN_AUTHORITY_ROUTE = "yuanta/loan/canonical-v1" as const;
export const FUBON_LOAN_COUNTERPART_AUTHORITY_ROUTE =
  "fubon/loan/counterpart-deposit-v1" as const;
export const YUANTA_LOAN_COUNTERPART_AUTHORITY_ROUTE =
  "yuanta/loan/counterpart-deposit-v1" as const;
export const FUBON_LOAN_COUNTERPART_CONTRACT_VERSION =
  "loan/counterpart/v1.fubon" as const;
export const YUANTA_LOAN_COUNTERPART_CONTRACT_VERSION =
  "loan/counterpart/v1.yuanta" as const;

export type LoanExactAmount = {
  coefficient: string;
  scale: number;
};

export type LoanEventKind = "disbursement" | "payment" | "interest" | "fee";

type LoanEventContractMapping = {
  eventKind: LoanEventKind;
  direction: "inflow" | "outflow";
};

/** Source-code mappings are part of each provider contract.  A source code is
 * not merely descriptive text: it is the evidence that makes the loan
 * boundary direction total and fail closed. */
export const LOAN_EVENT_CONTRACT_MAPPINGS: Readonly<
  Record<LoanSourceId, Readonly<Record<string, LoanEventContractMapping>>>
> = Object.freeze({
  fubon: Object.freeze({
    "LOAN-DISBURSEMENT": {
      eventKind: "disbursement",
      direction: "outflow",
    } as LoanEventContractMapping,
    "LOAN-PAYMENT": {
      eventKind: "payment",
      direction: "inflow",
    } as LoanEventContractMapping,
    "LOAN-INTEREST": {
      eventKind: "interest",
      direction: "inflow",
    } as LoanEventContractMapping,
    "LOAN-FEE": {
      eventKind: "fee",
      direction: "inflow",
    } as LoanEventContractMapping,
  }),
  yuanta: Object.freeze({
    "LOAN-DISBURSEMENT": {
      eventKind: "disbursement",
      direction: "outflow",
    } as LoanEventContractMapping,
    "LOAN-PAYMENT": {
      eventKind: "payment",
      direction: "inflow",
    } as LoanEventContractMapping,
    "LOAN-INTEREST": {
      eventKind: "interest",
      direction: "inflow",
    } as LoanEventContractMapping,
    "LOAN-FEE": {
      eventKind: "fee",
      direction: "inflow",
    } as LoanEventContractMapping,
  }),
});

export type LoanEventEvidence = {
  kind: "source-coded-loan-event";
  sourceRecordKey: string;
  sourceCode: string;
  contractVersion: string;
};

export type LoanComponentEvidence = {
  kind: "explicit-source-component";
  sourceRecordKey: string;
  contractVersion: string;
};

/** Contract-projected fields retained in the compact Source Record. Canonical
 * balance facts must match one of these claims exactly; repeating values only
 * on the Observation input is not evidence. */
export type LoanBalanceSourceEvidence = {
  kind: "source-reported-balance";
  balanceKind:
    "loan_outstanding" | "outstanding_principal" | "outstanding_total";
  balanceField: "statement-balance";
  balance: LoanExactAmount;
  effectiveAtField: "statement-as-of";
  effectiveAt: string;
  contractVersion: string;
  correctionOfObservationKey?: string;
};

export type LoanTransactionInput = {
  sourceRecordKey: string;
  occurrenceIndex: number;
  effectiveOn: string;
  sourceTime: {
    localTime: string;
    precision: "date" | "minute" | "second";
    timeOrigin: "source_reported" | "defaulted_local_midnight";
  };
  postingStatus: "posted";
  eventKind: LoanEventKind;
  eventEvidence: LoanEventEvidence;
  direction: "inflow" | "outflow";
  amount: LoanExactAmount;
  currency: "TWD";
  description?: string;
  principal?: LoanExactAmount;
  interest?: LoanExactAmount;
  fee?: LoanExactAmount;
  componentEvidence?: LoanComponentEvidence;
  balanceSourceEvidence?: readonly LoanBalanceSourceEvidence[];
};

export type LoanCounterpartTransactionInput = {
  captureId: string;
  sourceRecordKey: string;
  occurrenceIndex: number;
  sourceConnectionKey: string;
  identityEpochKey: string;
  accountKey: string;
  subjectDigest: string;
  accountNo: string;
  accountType: "depository";
  stream: "domestic-deposit";
  recordKind: string;
  authorityRoute: string;
  contractVersion: string;
  effectiveOn: string;
  sourceTime: LoanTransactionInput["sourceTime"];
  postingStatus: "posted";
  direction: "inflow" | "outflow";
  amount: LoanExactAmount;
  currency: "TWD";
  description?: string;
  sourceEvidence: {
    kind: "source-linked-counterpart";
    sourceRecordKey: string;
    relationId: string;
    contractVersion: string;
  };
};

export type LoanBalanceEffectiveTimeEvidence = {
  kind: "source-reported-balance-effective-time";
  sourceRecordKey: string;
  sourceField: "statement-as-of";
  value: string;
  contractVersion: string;
};

export type LoanBalanceCorrectionEvidence = {
  kind: "source-correction";
  sourceRecordKey: string;
  observationKey: string;
  contractVersion: string;
};

export type LoanBalanceObservationInput = {
  observationKey: string;
  sourceRecordKey: string;
  balanceKind:
    "loan_outstanding" | "outstanding_principal" | "outstanding_total";
  balance: LoanExactAmount;
  currency: "TWD";
  effectiveAt: string;
  effectiveTimeBasis: "source-reported";
  effectiveTimeRuleVersion: string;
  effectiveTimeEvidence: LoanBalanceEffectiveTimeEvidence;
  correctionEvidence?: LoanBalanceCorrectionEvidence;
};

export type LoanTransferRelationInput = {
  kind: "transfer_counterpart";
  fromSourceRecordKey: string;
  toSourceRecordKey: string;
  fromAccountKey: string;
  toAccountKey: string;
  fromDirection: "inflow" | "outflow";
  toDirection: "inflow" | "outflow";
  evidence: {
    kind: "explicit-source-linkage";
    sourceRecordKey: string;
    relationId: string;
    contractVersion: string;
  };
};

export type LoanCaptureInput = {
  captureId: string;
  sourceId: LoanSourceId;
  authorityRoute: string;
  contractVersion: string;
  identity: {
    sourceConnectionKey: string;
    identityEpochKey: string;
    accountKey: string;
    subjectDigest: string;
    accountType: "loan";
    accountNo: string;
    stream: "loan";
    recordKind: string;
    currency: "TWD";
  };
  observedAt: string;
  scope: {
    startDate: string;
    endDate: string;
    completeness: "complete-range";
    completenessBasis: "source-declared-terminal-range";
    completenessRuleVersion: string;
    pageCount: number;
    terminal: true;
  };
  semantics: {
    status: "posted";
    effectiveTimeBasis: "source-reported";
    effectiveTimeRuleVersion: string;
    timeZone: "Asia/Taipei";
  };
  pages: readonly LoanCapturePage[];
  records: readonly LoanTransactionInput[];
  counterpartTransactions: readonly LoanCounterpartTransactionInput[];
  balanceObservations: readonly LoanBalanceObservationInput[];
  relations: readonly LoanTransferRelationInput[];
};

export type LoanCapturePage = {
  pageOrdinal: number;
  responseCode: "200";
  terminal: boolean;
  rowCount: number;
  proofKind: "source-declared-terminal-range";
};

export type LoanValidatedCapture = LoanCaptureInput & {
  readonly __runtimeValidatedCanonicalLoanCapture: true;
};

export type LoanFinancialStore = {
  readonly db: DatabaseSync;
  readonly databasePath: string;
  readonly sourceStore: CanonicalSourceStore;
  readonly commitClock: () => number;
  close(): void;
};

export type LoanFinancialCommitResult =
  CanonicalFinancialDepositCommitResult & {
    balanceObservationCount: number;
    relationCount: number;
  };

export type LoanAccount = {
  id: string;
  sourceId: LoanSourceId;
  sourceConnectionKey: string;
  identityEpochKey: string;
  accountKey: string;
  accountNo: string;
  accountType: "loan";
  stream: "loan";
  recordKind: string;
  currency: "TWD";
};

export type LoanTransaction = {
  id: string;
  accountId: string;
  account: LoanAccount;
  sourceRecordKey: string;
  /** Compatibility spelling used by the source-record query APIs. */
  sourceOccurrenceKey: string;
  occurrenceIndex: number | null;
  effectiveOn: string;
  effectiveTimeBasis: "source-reported";
  sourceTime: {
    localTime: string;
    timeZone: "Asia/Taipei";
    precision: "date" | "minute" | "second";
    timeOrigin: "source_reported" | "defaulted_local_midnight";
  };
  postingStatus: "posted";
  eventKind: LoanEventKind;
  direction: "inflow" | "outflow";
  amount: LoanExactAmount;
  currency: "TWD";
  description: string | null;
  principal: LoanExactAmount | null;
  interest: LoanExactAmount | null;
  fee: LoanExactAmount | null;
  knowledgeCommitSequence: number;
};

export type LoanBalanceObservation = LoanBalanceObservationInput & {
  accountId: string;
  account: LoanAccount;
  captureId: string;
  commitSequence: number;
  observedAt: string;
};

export type LoanTransferRelation = LoanTransferRelationInput & {
  accountId: string;
  commitSequence: number;
  fromTransactionId: string | null;
  toTransactionId: string | null;
};

export type LoanLineageEntry = {
  sourceRecordKey: string;
  captureId: string;
  commitSequence: number;
  contentHash: string;
  payload: Record<string, unknown>;
};

export type LoanQueryResult = {
  status: "canonical-live";
  kind: "current" | "historical" | "lineage";
  accounts: LoanAccount[];
  financialAccounts: LoanAccount[];
  transactions: LoanTransaction[];
  balanceObservations: LoanBalanceObservation[];
  balanceEvidence: LoanBalanceObservation[];
  relations: LoanTransferRelation[];
  transferRelations: LoanTransferRelation[];
  lineage: LoanLineageEntry[];
  provenance: LoanLineageEntry[];
  knowledgeAt: number;
  financialAt: string | null;
};

export type LoanHistoricalQuery = {
  knowledgeAt: number;
  financialAt: string;
  sourceId?: LoanSourceId;
  integrationNamespace?: LoanSourceId;
};

export type LoanLineageQuery = {
  sourceRecordKey?: string;
  sourceOccurrenceKey?: string;
  sourceId?: LoanSourceId;
  integrationNamespace?: LoanSourceId;
};

export class CanonicalLoanAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalLoanAdmissionError";
  }
}

export class CanonicalLoanConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalLoanConflictError";
  }
}

const VALIDATED_CAPTURES = new WeakSet<object>();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_LOCAL_TIME = /^\d{2}:\d{2}:\d{2}$/;
const OPAQUE_TOKEN = /^sha256:[A-Za-z0-9_-]+$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SOURCE_RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?\+08:00$/;

function id(): Uint8Array {
  return randomBytes(16);
}

function token(...parts: string[]): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("base64url")}`;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new CanonicalLoanAdmissionError(`${label} is required.`);
  return value.trim();
}

function requireOpaque(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!OPAQUE_TOKEN.test(text))
    throw new CanonicalLoanAdmissionError(
      `${label} must be an opaque sha256 token.`,
    );
  return text;
}

function requireDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !ISO_DATE.test(value))
    throw new CanonicalLoanAdmissionError(`${label} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (date.toISOString().slice(0, 10) !== value)
    throw new CanonicalLoanAdmissionError(
      `${label} must be a valid calendar date.`,
    );
  return value;
}

function requireSourceTime(value: LoanTransactionInput["sourceTime"]): void {
  if (!ISO_LOCAL_TIME.test(value.localTime))
    throw new CanonicalLoanAdmissionError("Loan source local time is invalid.");
  const [hour, minute, second] = value.localTime.split(":").map(Number);
  if (hour > 23 || minute > 59 || second > 59)
    throw new CanonicalLoanAdmissionError("Loan source local time is invalid.");
  if (value.precision === "date") {
    if (
      value.localTime !== "00:00:00" ||
      value.timeOrigin !== "defaulted_local_midnight"
    )
      throw new CanonicalLoanAdmissionError(
        "Date-only loan time must be explicitly marked defaulted_local_midnight.",
      );
  } else if (value.timeOrigin !== "source_reported") {
    throw new CanonicalLoanAdmissionError(
      "Minute/second loan time must be source-reported.",
    );
  }
}

function requireAmount(value: unknown, label: string): LoanExactAmount {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as LoanExactAmount).coefficient !== "string" ||
    !/^(?:0|[1-9]\d*)$/.test((value as LoanExactAmount).coefficient) ||
    !Number.isSafeInteger((value as LoanExactAmount).scale) ||
    (value as LoanExactAmount).scale < 0
  )
    throw new CanonicalLoanAdmissionError(
      `${label} must be an exact non-negative coefficient/scale amount.`,
    );
  return {
    coefficient: (value as LoanExactAmount).coefficient,
    scale: (value as LoanExactAmount).scale,
  };
}

function sourceEpoch(localDate: string, localTime: string): number {
  const value = Date.parse(`${localDate}T${localTime}+08:00`);
  if (!Number.isSafeInteger(value))
    throw new CanonicalLoanAdmissionError(
      "Loan source time is not representable.",
    );
  return value;
}

function dateFromSourceTime(effectiveOn: string, localTime: string): string {
  return `${effectiveOn}T${localTime}`;
}

function dateFromEffectiveAt(value: string): string {
  return value.slice(0, 10);
}

function expectedContract(sourceId: LoanSourceId): string {
  return sourceId === "fubon"
    ? FUBON_LOAN_CONTRACT_VERSION
    : YUANTA_LOAN_CONTRACT_VERSION;
}

function expectedAuthority(sourceId: LoanSourceId): string {
  return sourceId === "fubon"
    ? FUBON_LOAN_AUTHORITY_ROUTE
    : YUANTA_LOAN_AUTHORITY_ROUTE;
}

function expectedRecordKind(sourceId: LoanSourceId): string {
  return `${sourceId}-loan-transaction`;
}

function expectedCounterpartAuthority(sourceId: LoanSourceId): string {
  return sourceId === "fubon"
    ? FUBON_LOAN_COUNTERPART_AUTHORITY_ROUTE
    : YUANTA_LOAN_COUNTERPART_AUTHORITY_ROUTE;
}

function expectedCounterpartContract(sourceId: LoanSourceId): string {
  return sourceId === "fubon"
    ? FUBON_LOAN_COUNTERPART_CONTRACT_VERSION
    : YUANTA_LOAN_COUNTERPART_CONTRACT_VERSION;
}

function expectedCounterpartRecordKind(sourceId: LoanSourceId): string {
  return `${sourceId}-loan-counterpart-deposit`;
}

function validateRelation(
  relation: LoanTransferRelationInput,
  records: ReadonlyMap<string, LoanTransactionInput>,
  counterpartRecords: ReadonlyMap<string, LoanCounterpartTransactionInput>,
  accountKey: string,
  contractVersion: string,
  sourceConnectionKey: string,
  identityEpochKey: string,
): void {
  requireOpaque(
    relation.fromSourceRecordKey,
    "Loan relation from source record key",
  );
  requireOpaque(
    relation.toSourceRecordKey,
    "Loan relation to source record key",
  );
  requireOpaque(relation.fromAccountKey, "Loan relation from account key");
  requireOpaque(relation.toAccountKey, "Loan relation to account key");
  if (relation.fromSourceRecordKey === relation.toSourceRecordKey)
    throw new CanonicalLoanAdmissionError(
      "Loan relation cannot connect a record to itself.",
    );
  const fromLoan = records.get(relation.fromSourceRecordKey);
  const toLoan = records.get(relation.toSourceRecordKey);
  const fromCounterpart = counterpartRecords.get(relation.fromSourceRecordKey);
  const toCounterpart = counterpartRecords.get(relation.toSourceRecordKey);
  const from = fromLoan ?? fromCounterpart;
  const to = toLoan ?? toCounterpart;
  if (!from || !to || Boolean(fromLoan) === Boolean(toLoan))
    throw new CanonicalLoanAdmissionError(
      "Loan transfer relations must connect one loan and one persisted deposit counterpart.",
    );
  const fromAccountKey = fromLoan ? accountKey : fromCounterpart!.accountKey;
  const toAccountKey = toLoan ? accountKey : toCounterpart!.accountKey;
  if (
    relation.fromAccountKey !== fromAccountKey ||
    relation.toAccountKey !== toAccountKey
  )
    throw new CanonicalLoanAdmissionError(
      "Loan transfer relation endpoint account identity is not evidenced.",
    );
  if (from && from.direction !== relation.fromDirection)
    throw new CanonicalLoanAdmissionError(
      "Loan relation source direction is not evidenced.",
    );
  if (to && to.direction !== relation.toDirection)
    throw new CanonicalLoanAdmissionError(
      "Loan relation target direction is not evidenced.",
    );
  const counterpart = fromCounterpart ?? toCounterpart;
  if (
    !counterpart ||
    counterpart.sourceConnectionKey !== sourceConnectionKey ||
    counterpart.identityEpochKey !== identityEpochKey
  )
    throw new CanonicalLoanAdmissionError(
      "Loan transfer relation endpoints must share one source connection and identity epoch source scope.",
    );
  if (
    relation.kind !== "transfer_counterpart" ||
    relation.fromDirection === relation.toDirection ||
    relation.evidence?.kind !== "explicit-source-linkage" ||
    relation.evidence.contractVersion !== contractVersion ||
    !requireOpaque(
      relation.evidence.sourceRecordKey,
      "Loan relation evidence source record key",
    ) ||
    !requireOpaque(relation.evidence.relationId, "Loan relation evidence ID") ||
    (!records.has(relation.evidence.sourceRecordKey) &&
      !counterpartRecords.has(relation.evidence.sourceRecordKey)) ||
    (relation.evidence.sourceRecordKey !== relation.fromSourceRecordKey &&
      relation.evidence.sourceRecordKey !== relation.toSourceRecordKey)
  )
    throw new CanonicalLoanAdmissionError(
      "Loan transfer relations require explicit source linkage evidence.",
    );
  if (
    counterpart &&
    (counterpart.sourceEvidence.relationId !== relation.evidence.relationId ||
      counterpart.sourceEvidence.sourceRecordKey !==
        counterpart.sourceRecordKey)
  )
    throw new CanonicalLoanAdmissionError(
      "Loan counterpart transaction is not linked by the same source relation evidence.",
    );
}

function validateCapture(capture: LoanCaptureInput): void {
  if (capture === null || typeof capture !== "object")
    throw new CanonicalLoanAdmissionError("A loan capture object is required.");
  requireText(capture.captureId, "Loan capture ID");
  if (capture.sourceId !== "fubon" && capture.sourceId !== "yuanta")
    throw new CanonicalLoanAdmissionError("Loan source is not advertised.");
  const contractVersion = expectedContract(capture.sourceId);
  if (capture.contractVersion !== contractVersion)
    throw new CanonicalLoanAdmissionError(
      "Loan contract version is unsupported.",
    );
  if (capture.authorityRoute !== expectedAuthority(capture.sourceId))
    throw new CanonicalLoanAdmissionError(
      "Loan authority route is unsupported.",
    );
  const identity = capture.identity;
  if (
    identity.accountType !== "loan" ||
    identity.stream !== "loan" ||
    identity.currency !== "TWD" ||
    identity.recordKind !== expectedRecordKind(capture.sourceId)
  )
    throw new CanonicalLoanAdmissionError(
      "Loan account identity is not source-scoped.",
    );
  for (const [value, label] of [
    [identity.sourceConnectionKey, "Loan source connection key"],
    [identity.identityEpochKey, "Loan identity epoch key"],
    [identity.accountKey, "Loan account key"],
    [identity.subjectDigest, "Loan subject digest"],
    [identity.accountNo, "Loan account number"],
  ] as const)
    requireOpaque(value, label);
  if (
    !RFC3339.test(capture.observedAt) ||
    Number.isNaN(Date.parse(capture.observedAt))
  )
    throw new CanonicalLoanAdmissionError(
      "Loan observedAt must be RFC3339 UTC.",
    );
  const start = requireDate(capture.scope.startDate, "Loan scope start date");
  const end = requireDate(capture.scope.endDate, "Loan scope end date");
  if (start > end)
    throw new CanonicalLoanAdmissionError("Loan scope dates are inverted.");
  if (
    capture.scope.completeness !== "complete-range" ||
    capture.scope.completenessBasis !== "source-declared-terminal-range" ||
    capture.scope.completenessRuleVersion !== contractVersion ||
    !Number.isSafeInteger(capture.scope.pageCount) ||
    capture.scope.pageCount < 1 ||
    capture.scope.terminal !== true
  )
    throw new CanonicalLoanAdmissionError(
      "Loan completeness contract is incomplete.",
    );
  if (
    capture.semantics.status !== "posted" ||
    capture.semantics.effectiveTimeBasis !== "source-reported" ||
    capture.semantics.effectiveTimeRuleVersion !== contractVersion ||
    capture.semantics.timeZone !== "Asia/Taipei"
  )
    throw new CanonicalLoanAdmissionError(
      "Loan source time/status semantics are unsupported.",
    );
  if (
    !Array.isArray(capture.pages) ||
    capture.pages.length !== capture.scope.pageCount
  )
    throw new CanonicalLoanAdmissionError(
      "Loan page count does not match the contract.",
    );
  let pageRows = 0;
  let terminalPages = 0;
  for (const [index, page] of capture.pages.entries()) {
    if (
      page.pageOrdinal !== index ||
      page.responseCode !== "200" ||
      !Number.isSafeInteger(page.rowCount) ||
      page.rowCount < 0 ||
      page.proofKind !== "source-declared-terminal-range"
    )
      throw new CanonicalLoanAdmissionError(
        "Loan page evidence is incomplete.",
      );
    pageRows += page.rowCount;
    if (page.terminal) terminalPages += 1;
    if (index < capture.pages.length - 1 && page.terminal)
      throw new CanonicalLoanAdmissionError(
        "Loan terminal page cannot precede the final page.",
      );
  }
  if (terminalPages !== 1 || !capture.pages.at(-1)?.terminal)
    throw new CanonicalLoanAdmissionError(
      "Loan capture must have one terminal page.",
    );
  if (pageRows !== capture.records.length)
    throw new CanonicalLoanAdmissionError(
      "Loan page row counts do not match records.",
    );

  const records = new Map<string, LoanTransactionInput>();
  const collisions = new Set<string>();
  for (const record of capture.records) {
    const sourceRecordKey = requireOpaque(
      record.sourceRecordKey,
      "Loan source record key",
    );
    if (records.has(sourceRecordKey))
      throw new CanonicalLoanConflictError("Duplicate loan source record key.");
    if (
      !Number.isSafeInteger(record.occurrenceIndex) ||
      record.occurrenceIndex < 1
    )
      throw new CanonicalLoanAdmissionError(
        "Loan occurrence index is invalid.",
      );
    if (collisions.has(String(record.occurrenceIndex)))
      throw new CanonicalLoanConflictError("Duplicate loan occurrence index.");
    collisions.add(String(record.occurrenceIndex));
    const effectiveOn = requireDate(
      record.effectiveOn,
      "Loan transaction effective date",
    );
    if (effectiveOn < start || effectiveOn > end)
      throw new CanonicalLoanAdmissionError(
        "Loan transaction is outside the captured range.",
      );
    requireSourceTime(record.sourceTime);
    if (record.postingStatus !== "posted" || record.currency !== "TWD")
      throw new CanonicalLoanAdmissionError(
        "Loan transaction status/currency is unsupported.",
      );
    if (
      record.eventEvidence?.kind !== "source-coded-loan-event" ||
      record.eventEvidence.sourceRecordKey !== sourceRecordKey ||
      record.eventEvidence.contractVersion !== contractVersion ||
      !requireText(record.eventEvidence.sourceCode, "Loan event source code")
    )
      throw new CanonicalLoanAdmissionError(
        "Loan event direction requires source-coded evidence.",
      );
    const eventMapping =
      LOAN_EVENT_CONTRACT_MAPPINGS[capture.sourceId][
        record.eventEvidence.sourceCode
      ];
    if (
      !eventMapping ||
      eventMapping.eventKind !== record.eventKind ||
      eventMapping.direction !== record.direction
    )
      throw new CanonicalLoanAdmissionError(
        "Loan event source code, event kind, and direction do not match the source contract.",
      );
    const amount = requireAmount(record.amount, "Loan transaction amount");
    if (amount.coefficient === "0")
      throw new CanonicalLoanAdmissionError(
        "Loan transaction amount must be positive.",
      );
    for (const [component, label] of [
      [record.principal, "Loan principal"],
      [record.interest, "Loan interest"],
      [record.fee, "Loan fee"],
    ] as const)
      if (component !== undefined) requireAmount(component, label);
    const hasComponents =
      record.principal !== undefined ||
      record.interest !== undefined ||
      record.fee !== undefined;
    if (hasComponents) {
      if (
        record.componentEvidence?.kind !== "explicit-source-component" ||
        record.componentEvidence.sourceRecordKey !== sourceRecordKey ||
        record.componentEvidence.contractVersion !== contractVersion
      )
        throw new CanonicalLoanAdmissionError(
          "Loan principal/interest/fee requires explicit source component evidence.",
        );
    } else if (record.componentEvidence !== undefined) {
      throw new CanonicalLoanAdmissionError(
        "Loan component evidence cannot exist without source-distinguished components.",
      );
    }
    records.set(sourceRecordKey, record);
  }

  if (!Array.isArray(capture.counterpartTransactions))
    throw new CanonicalLoanAdmissionError(
      "Loan transfer relations require an explicit counterpart transaction list.",
    );
  const counterpartRecords = new Map<string, LoanCounterpartTransactionInput>();
  for (const counterpart of capture.counterpartTransactions) {
    const sourceRecordKey = requireOpaque(
      counterpart.sourceRecordKey,
      "Loan counterpart source record key",
    );
    if (records.has(sourceRecordKey) || counterpartRecords.has(sourceRecordKey))
      throw new CanonicalLoanConflictError(
        "Loan source record key is reused across account boundaries.",
      );
    requireText(counterpart.captureId, "Loan counterpart capture ID");
    if (
      counterpart.authorityRoute !==
        expectedCounterpartAuthority(capture.sourceId) ||
      counterpart.contractVersion !==
        expectedCounterpartContract(capture.sourceId) ||
      counterpart.accountType !== "depository" ||
      counterpart.stream !== "domestic-deposit" ||
      counterpart.recordKind !==
        expectedCounterpartRecordKind(capture.sourceId) ||
      counterpart.currency !== "TWD" ||
      counterpart.postingStatus !== "posted"
    )
      throw new CanonicalLoanAdmissionError(
        "Loan counterpart identity or source contract is unsupported.",
      );
    for (const [value, label] of [
      [
        counterpart.sourceConnectionKey,
        "Loan counterpart source connection key",
      ],
      [counterpart.identityEpochKey, "Loan counterpart identity epoch key"],
      [counterpart.accountKey, "Loan counterpart account key"],
      [counterpart.subjectDigest, "Loan counterpart subject digest"],
      [counterpart.accountNo, "Loan counterpart account number"],
    ] as const)
      requireOpaque(value, label);
    if (
      !Number.isSafeInteger(counterpart.occurrenceIndex) ||
      counterpart.occurrenceIndex < 1
    )
      throw new CanonicalLoanAdmissionError(
        "Loan counterpart occurrence index is invalid.",
      );
    const effectiveOn = requireDate(
      counterpart.effectiveOn,
      "Loan counterpart effective date",
    );
    if (effectiveOn < start || effectiveOn > end)
      throw new CanonicalLoanAdmissionError(
        "Loan counterpart transaction is outside the captured range.",
      );
    requireSourceTime(counterpart.sourceTime);
    const amount = requireAmount(
      counterpart.amount,
      "Loan counterpart transaction amount",
    );
    if (amount.coefficient === "0")
      throw new CanonicalLoanAdmissionError(
        "Loan counterpart transaction amount must be positive.",
      );
    if (
      counterpart.direction !== "inflow" &&
      counterpart.direction !== "outflow"
    )
      throw new CanonicalLoanAdmissionError(
        "Loan counterpart direction is unsupported.",
      );
    if (
      counterpart.sourceEvidence?.kind !== "source-linked-counterpart" ||
      counterpart.sourceEvidence.sourceRecordKey !== sourceRecordKey ||
      counterpart.sourceEvidence.contractVersion !==
        expectedCounterpartContract(capture.sourceId) ||
      !requireOpaque(
        counterpart.sourceEvidence.relationId,
        "Loan counterpart relation ID",
      )
    )
      throw new CanonicalLoanAdmissionError(
        "Loan counterpart requires explicit source linkage evidence.",
      );
    counterpartRecords.set(sourceRecordKey, counterpart);
  }

  const observationKeys = new Set<string>();
  for (const observation of capture.balanceObservations) {
    const observationKey = requireOpaque(
      observation.observationKey,
      "Loan balance observation key",
    );
    if (observationKeys.has(observationKey))
      throw new CanonicalLoanConflictError(
        "Duplicate loan balance observation key.",
      );
    observationKeys.add(observationKey);
    const sourceRecordKey = requireOpaque(
      observation.sourceRecordKey,
      "Loan balance source record key",
    );
    if (!records.has(sourceRecordKey))
      throw new CanonicalLoanAdmissionError(
        "Loan balance must cite a captured source record.",
      );
    if (
      observation.balanceKind !== "loan_outstanding" &&
      observation.balanceKind !== "outstanding_principal" &&
      observation.balanceKind !== "outstanding_total"
    )
      throw new CanonicalLoanAdmissionError(
        "Loan balance kind is unsupported.",
      );
    requireAmount(observation.balance, "Loan balance amount");
    const sourceRecord = records.get(sourceRecordKey)!;
    const retainedEvidence = sourceRecord.balanceSourceEvidence?.find(
      (evidence) =>
        evidence.kind === "source-reported-balance" &&
        evidence.balanceKind === observation.balanceKind &&
        evidence.balanceField === "statement-balance" &&
        evidence.balance.coefficient === observation.balance.coefficient &&
        evidence.balance.scale === observation.balance.scale &&
        evidence.effectiveAtField ===
          observation.effectiveTimeEvidence.sourceField &&
        evidence.effectiveAt === observation.effectiveAt &&
        evidence.contractVersion === contractVersion,
    );
    if (!retainedEvidence)
      throw new CanonicalLoanAdmissionError(
        "Loan balance amount, kind, and effective time must match retained source field evidence.",
      );
    if (
      observation.currency !== "TWD" ||
      observation.effectiveTimeBasis !== "source-reported" ||
      observation.effectiveTimeRuleVersion !== contractVersion ||
      !SOURCE_RFC3339.test(observation.effectiveAt) ||
      Number.isNaN(Date.parse(observation.effectiveAt))
    )
      throw new CanonicalLoanAdmissionError(
        "Loan balance effective time is not source-reported.",
      );
    if (
      observation.effectiveTimeEvidence?.kind !==
        "source-reported-balance-effective-time" ||
      observation.effectiveTimeEvidence.sourceRecordKey !== sourceRecordKey ||
      observation.effectiveTimeEvidence.sourceField !== "statement-as-of" ||
      observation.effectiveTimeEvidence.value !== observation.effectiveAt ||
      observation.effectiveTimeEvidence.contractVersion !== contractVersion
    )
      throw new CanonicalLoanAdmissionError(
        "Loan balance effective time must match an explicit source field evidence value.",
      );
    if (observation.correctionEvidence !== undefined) {
      if (
        observation.correctionEvidence.kind !== "source-correction" ||
        observation.correctionEvidence.sourceRecordKey !== sourceRecordKey ||
        observation.correctionEvidence.observationKey !== observationKey ||
        observation.correctionEvidence.contractVersion !== contractVersion
      )
        throw new CanonicalLoanAdmissionError(
          "Loan balance correction evidence does not identify its observation.",
        );
      if (retainedEvidence.correctionOfObservationKey !== observationKey)
        throw new CanonicalLoanAdmissionError(
          "Loan balance correction requires contract-projected source correction evidence.",
        );
    } else if (retainedEvidence.correctionOfObservationKey !== undefined) {
      throw new CanonicalLoanAdmissionError(
        "Loan source correction evidence requires an explicit Observation correction.",
      );
    }
    if (Date.parse(observation.effectiveAt) >= Date.parse(capture.observedAt))
      throw new CanonicalLoanAdmissionError(
        "Loan balance effective time cannot use collection/import time.",
      );
    const effectiveDate = dateFromEffectiveAt(observation.effectiveAt);
    if (effectiveDate < start || effectiveDate > end)
      throw new CanonicalLoanAdmissionError(
        "Loan balance is outside the captured range.",
      );
  }
  for (const relation of capture.relations)
    validateRelation(
      relation,
      records,
      counterpartRecords,
      identity.accountKey,
      contractVersion,
      identity.sourceConnectionKey,
      identity.identityEpochKey,
    );
  const referencedCounterparts = new Set(
    capture.relations.flatMap((relation) =>
      counterpartRecords.has(relation.fromSourceRecordKey)
        ? [relation.fromSourceRecordKey]
        : counterpartRecords.has(relation.toSourceRecordKey)
          ? [relation.toSourceRecordKey]
          : [],
    ),
  );
  if (referencedCounterparts.size !== counterpartRecords.size)
    throw new CanonicalLoanAdmissionError(
      "Every loan counterpart transaction must be connected by an explicit relation.",
    );
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object))
    return value;
  seen.add(value as object);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object") freezeDeep(child, seen);
  }
  return Object.freeze(value);
}

export function admitCanonicalLoanCapture(
  capture: LoanCaptureInput,
): LoanValidatedCapture {
  validateCapture(capture);
  freezeDeep(capture);
  VALIDATED_CAPTURES.add(capture);
  return capture as LoanValidatedCapture;
}

function hasValidatedBrand(value: unknown): value is LoanValidatedCapture {
  return (
    value !== null && typeof value === "object" && VALIDATED_CAPTURES.has(value)
  );
}

function opaqueText(value: string): string {
  return value;
}

function compactRecord(record: LoanTransactionInput): Record<string, unknown> {
  return {
    sourceRecordKey: opaqueText(record.sourceRecordKey),
    occurrenceIndex: record.occurrenceIndex,
    effectiveOn: record.effectiveOn,
    sourceTime: record.sourceTime,
    postingStatus: record.postingStatus,
    eventKind: record.eventKind,
    eventEvidence: record.eventEvidence,
    direction: record.direction,
    amount: record.amount,
    currency: record.currency,
    ...(record.description === undefined
      ? {}
      : { description: record.description }),
    ...(record.principal === undefined ? {} : { principal: record.principal }),
    ...(record.interest === undefined ? {} : { interest: record.interest }),
    ...(record.fee === undefined ? {} : { fee: record.fee }),
    ...(record.componentEvidence === undefined
      ? {}
      : { componentEvidence: record.componentEvidence }),
    ...(record.balanceSourceEvidence === undefined
      ? {}
      : { balanceSourceEvidence: record.balanceSourceEvidence }),
  };
}

function compactHash(compact: Record<string, unknown>): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(compact))
    .digest("base64url")}`;
}

function canonicalDateTime(record: LoanTransactionInput): string {
  return dateFromSourceTime(record.effectiveOn, record.sourceTime.localTime);
}

function canonicalLoanSpineCapture(
  capture: LoanValidatedCapture,
): CanonicalFinancialDepositValidatedCapture {
  const records = capture.records.map((record) => {
    const compact = compactRecord(record);
    const sourceTime = {
      localDate: record.effectiveOn,
      localTime: record.sourceTime.localTime,
      timeZone: "Asia/Taipei",
      epochMilliseconds: sourceEpoch(
        record.effectiveOn,
        record.sourceTime.localTime,
      ),
      precision: record.sourceTime.precision,
      timeOrigin: record.sourceTime.timeOrigin,
    } satisfies {
      localDate: string;
      localTime: string;
      timeZone: string;
      epochMilliseconds: number;
      precision: "date" | "minute" | "second";
      timeOrigin: "source_reported" | "defaulted_local_midnight";
    };
    return {
      occurrenceKey: record.sourceRecordKey,
      collisionKey: token(
        capture.sourceId,
        capture.identity.accountKey,
        String(record.occurrenceIndex),
      ),
      providerKey: token(
        capture.sourceId,
        record.eventEvidence.sourceCode,
        String(record.occurrenceIndex),
      ),
      contentHash: compactHash(compact),
      sequenceLexeme: String(record.occurrenceIndex),
      compactJson: JSON.stringify(compact),
      amount: record.amount,
      balanceAfter: null,
      currency: record.currency,
      direction: record.direction,
      sourceTime,
      effectiveOn: record.effectiveOn,
      transactionDateTimeLocal: canonicalDateTime(record),
      description: record.description ?? null,
    };
  });
  return admitCanonicalFinancialDepositCapture({
    captureId: capture.captureId,
    authorityRoute: capture.authorityRoute,
    contractVersion: capture.contractVersion,
    identity: {
      integrationNamespace: capture.sourceId,
      sourceConnectionKey: capture.identity.sourceConnectionKey,
      identityEpochKey: capture.identity.identityEpochKey,
      stream: capture.identity.stream,
      recordKind: capture.identity.recordKind,
      subjectDigest: capture.identity.subjectDigest,
      // The generic spine's historical column name is account_no, but its
      // natural identity role is the contract-defined stable account key.
      accountNo: capture.identity.accountKey,
      accountType: capture.identity.accountType,
      currency: capture.identity.currency,
    },
    observedAt: capture.observedAt,
    scope: {
      startDate: capture.scope.startDate,
      endDate: capture.scope.endDate,
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: capture.scope.completenessBasis,
      completenessRuleVersion: capture.scope.completenessRuleVersion,
      absenceAuthority: null,
      contractFingerprint: token("loan-contract", capture.contractVersion),
      preflightFingerprint: token("loan-scope", capture.captureId),
      pageCount: capture.scope.pageCount,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: capture.semantics.status,
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: capture.authorityRoute,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: capture.authorityRoute,
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: capture.authorityRoute,
      timeZone: capture.semantics.timeZone,
      timePrecision: capture.records[0]?.sourceTime.precision ?? "date",
      timeOrigin:
        capture.records[0]?.sourceTime.timeOrigin ?? "defaulted_local_midnight",
      requireBalance: false,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: capture.pages.map((page) => ({
      pageOrdinal: page.pageOrdinal,
      responseCode: page.responseCode,
      terminal: page.terminal,
      rowCount: page.rowCount,
      responseDigest: token(
        "loan-page",
        capture.captureId,
        String(page.pageOrdinal),
      ),
      proofKind: page.proofKind,
      contractFingerprint: token("loan-contract", capture.contractVersion),
      preflightFingerprint: token("loan-scope", capture.captureId),
      metadataJson: JSON.stringify({
        pageOrdinal: page.pageOrdinal,
        rowCount: page.rowCount,
      }),
    })),
    records,
  });
}

function canonicalLoanCounterpartCapture(
  capture: LoanValidatedCapture,
  counterpart: LoanCounterpartTransactionInput,
): CanonicalFinancialDepositValidatedCapture {
  const sourceTime = {
    localDate: counterpart.effectiveOn,
    localTime: counterpart.sourceTime.localTime,
    timeZone: "Asia/Taipei",
    epochMilliseconds: sourceEpoch(
      counterpart.effectiveOn,
      counterpart.sourceTime.localTime,
    ),
    precision: counterpart.sourceTime.precision,
    timeOrigin: counterpart.sourceTime.timeOrigin,
  } satisfies {
    localDate: string;
    localTime: string;
    timeZone: string;
    epochMilliseconds: number;
    precision: "date" | "minute" | "second";
    timeOrigin: "source_reported" | "defaulted_local_midnight";
  };
  const compact = {
    sourceRecordKey: counterpart.sourceRecordKey,
    occurrenceIndex: counterpart.occurrenceIndex,
    effectiveOn: counterpart.effectiveOn,
    sourceTime: counterpart.sourceTime,
    postingStatus: counterpart.postingStatus,
    direction: counterpart.direction,
    amount: counterpart.amount,
    currency: counterpart.currency,
    sourceEvidence: counterpart.sourceEvidence,
  } satisfies Record<string, unknown>;
  const authorityRoute = counterpart.authorityRoute;
  return admitCanonicalFinancialDepositCapture({
    captureId: counterpart.captureId,
    authorityRoute,
    contractVersion: counterpart.contractVersion,
    identity: {
      integrationNamespace: capture.sourceId,
      sourceConnectionKey: counterpart.sourceConnectionKey,
      identityEpochKey: counterpart.identityEpochKey,
      stream: counterpart.stream,
      recordKind: counterpart.recordKind,
      subjectDigest: counterpart.subjectDigest,
      accountNo: counterpart.accountKey,
      accountType: counterpart.accountType,
      currency: counterpart.currency,
    },
    observedAt: capture.observedAt,
    scope: {
      startDate: capture.scope.startDate,
      endDate: capture.scope.endDate,
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: capture.scope.completenessBasis,
      completenessRuleVersion: counterpart.contractVersion,
      absenceAuthority: null,
      contractFingerprint: token(
        "loan-counterpart-contract",
        counterpart.contractVersion,
      ),
      preflightFingerprint: token(
        "loan-counterpart-scope",
        capture.captureId,
        counterpart.captureId,
      ),
      pageCount: 1,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: counterpart.postingStatus,
      postingOrigin: "human-attested",
      postingBasis: "statement-posted-history",
      postingRuleVersion: authorityRoute,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: authorityRoute,
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: authorityRoute,
      timeZone: "Asia/Taipei",
      timePrecision: counterpart.sourceTime.precision,
      timeOrigin: counterpart.sourceTime.timeOrigin,
      requireBalance: false,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: 1,
        responseDigest: token("loan-counterpart-page", counterpart.captureId),
        proofKind: "source-declared-terminal-range",
        contractFingerprint: token(
          "loan-counterpart-contract",
          counterpart.contractVersion,
        ),
        preflightFingerprint: token(
          "loan-counterpart-scope",
          capture.captureId,
          counterpart.captureId,
        ),
        metadataJson: JSON.stringify({ rowCount: 1 }),
      },
    ],
    records: [
      {
        occurrenceKey: counterpart.sourceRecordKey,
        collisionKey: token(
          capture.sourceId,
          counterpart.accountKey,
          counterpart.sourceRecordKey,
        ),
        providerKey: token(
          capture.sourceId,
          counterpart.accountKey,
          counterpart.sourceRecordKey,
          counterpart.occurrenceIndex.toString(),
        ),
        contentHash: compactHash(compact),
        sequenceLexeme: String(counterpart.occurrenceIndex),
        compactJson: JSON.stringify(compact),
        amount: counterpart.amount,
        balanceAfter: null,
        currency: counterpart.currency,
        direction: counterpart.direction,
        sourceTime,
        effectiveOn: counterpart.effectiveOn,
        transactionDateTimeLocal: dateFromSourceTime(
          counterpart.effectiveOn,
          counterpart.sourceTime.localTime,
        ),
        description: counterpart.description ?? null,
      },
    ],
  });
}

function hasLoanExtensionSchema(db: DatabaseSync): boolean {
  try {
    validateCanonicalLoanExtensionSchema(db);
    return true;
  } catch {
    return false;
  }
}

export function createCanonicalLoanStore(
  databasePath: string,
  options: { commitClock?: () => number } = {},
): LoanFinancialStore {
  const sourceStore = createCanonicalSourceStore(databasePath, options);
  validateCanonicalLoanExtensionSchema(sourceStore.db);
  let closed = false;
  return {
    db: sourceStore.db,
    databasePath: sourceStore.databasePath,
    sourceStore,
    commitClock: sourceStore.commitClock,
    close() {
      if (!closed) {
        sourceStore.close();
        closed = true;
      }
    },
  };
}

function asWriterStore(store: LoanFinancialStore | CanonicalSourceStore): {
  db: DatabaseSync;
  databasePath: string;
  commitClock: () => number;
} {
  return {
    db: store.db,
    databasePath: store.databasePath,
    commitClock: store.commitClock,
  };
}

function binaryId(value: unknown): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== 16)
    throw new Error("Canonical loan ID is invalid.");
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sourceCaptureContext(
  db: DatabaseSync,
  captureId: string,
): { captureId: Uint8Array; commitId: Uint8Array; accountId: Uint8Array } {
  const row = db
    .prepare(
      `SELECT capture.capture_id, capture.commit_id, scope.account_id
       FROM source_captures capture
       JOIN capture_scopes scope ON scope.capture_id = capture.capture_id
       WHERE capture.capture_key = ? LIMIT 1`,
    )
    .get(captureId) as
    | { capture_id?: unknown; commit_id?: unknown; account_id?: unknown }
    | undefined;
  if (
    !row ||
    !(row.capture_id instanceof Uint8Array) ||
    !(row.commit_id instanceof Uint8Array) ||
    !(row.account_id instanceof Uint8Array)
  )
    throw new Error("Canonical loan source capture context is missing.");
  return {
    captureId: row.capture_id,
    commitId: row.commit_id,
    accountId: row.account_id,
  };
}

function sourceRecordContext(
  db: DatabaseSync,
  captureId: Uint8Array,
  sourceRecordKey: string,
): Uint8Array {
  const row = db
    .prepare(
      `SELECT source_record_id FROM source_records
       WHERE capture_id = ? AND occurrence_key = ? LIMIT 1`,
    )
    .get(captureId, sourceRecordKey) as
    { source_record_id?: unknown } | undefined;
  if (!(row?.source_record_id instanceof Uint8Array))
    throw new CanonicalLoanAdmissionError(
      "Loan extension evidence source record is missing after canonical commit.",
    );
  return row.source_record_id;
}

function persistLoanAccountIdentity(
  db: DatabaseSync,
  context: { accountId: Uint8Array; commitId: Uint8Array },
  identity: {
    sourceConnectionKey: string;
    identityEpochKey: string;
    accountKey: string;
    accountNo: string;
    accountType: "loan" | "depository";
    stream: "loan" | "domestic-deposit";
  },
): void {
  const account = db
    .prepare(
      `SELECT source_connection_id, identity_epoch_id, account_no, account_type, stream
       FROM financial_accounts WHERE account_id = ?`,
    )
    .get(context.accountId) as
    | {
        source_connection_id?: unknown;
        identity_epoch_id?: unknown;
        account_no?: unknown;
        account_type?: unknown;
        stream?: unknown;
      }
    | undefined;
  if (
    !account ||
    !(account.source_connection_id instanceof Uint8Array) ||
    !(account.identity_epoch_id instanceof Uint8Array) ||
    account.account_no !== identity.accountKey ||
    account.account_type !== identity.accountType ||
    account.stream !== identity.stream
  )
    throw new CanonicalLoanConflictError(
      "Loan endpoint account identity does not match the canonical account.",
    );
  const connection = db
    .prepare(
      "SELECT source_connection_key FROM source_connections WHERE source_connection_id = ?",
    )
    .get(account.source_connection_id) as
    { source_connection_key?: unknown } | undefined;
  const epoch = db
    .prepare(
      "SELECT epoch_key FROM identity_epochs WHERE identity_epoch_id = ?",
    )
    .get(account.identity_epoch_id) as { epoch_key?: unknown } | undefined;
  if (
    connection?.source_connection_key !== identity.sourceConnectionKey ||
    epoch?.epoch_key !== identity.identityEpochKey
  )
    throw new CanonicalLoanConflictError(
      "Loan endpoint source scope does not match the canonical account.",
    );
  const existing = db
    .prepare(
      `SELECT account_key, account_no, account_type, stream
       FROM loan_account_identities WHERE account_id = ?`,
    )
    .get(context.accountId) as
    | {
        account_key?: unknown;
        account_no?: unknown;
        account_type?: unknown;
        stream?: unknown;
      }
    | undefined;
  if (existing) {
    if (
      existing.account_key !== identity.accountKey ||
      existing.account_no !== identity.accountNo ||
      existing.account_type !== identity.accountType ||
      existing.stream !== identity.stream
    )
      throw new CanonicalLoanConflictError(
        "Loan stable account identifier overwrite is forbidden.",
      );
    return;
  }
  db.prepare(
    `INSERT INTO loan_account_identities(
      account_id, source_connection_id, identity_epoch_id, created_commit_id,
      account_key, account_no, account_type, stream
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    context.accountId,
    account.source_connection_id,
    account.identity_epoch_id,
    context.commitId,
    identity.accountKey,
    identity.accountNo,
    identity.accountType,
    identity.stream,
  );
}

function transactionContext(
  db: DatabaseSync,
  accountId: Uint8Array,
  sourceRecordKey: string,
): Uint8Array {
  const row = db
    .prepare(
      `SELECT transaction_id FROM financial_transactions
       WHERE account_id = ? AND source_sequence = ?`,
    )
    .get(accountId, sourceRecordKey) as
    { transaction_id?: unknown } | undefined;
  if (!(row?.transaction_id instanceof Uint8Array))
    throw new CanonicalLoanConflictError(
      "Loan relation endpoint transaction was not persisted.",
    );
  return row.transaction_id;
}

function latestTransactionRevision(
  db: DatabaseSync,
  transactionId: Uint8Array,
): {
  revisionId: Uint8Array;
  sourceRecordId: Uint8Array;
  captureId: Uint8Array;
  commitId: Uint8Array;
  revisionNumber: number;
} {
  const row = db
    .prepare(
      `SELECT revision_id, source_record_id, capture_id, commit_id, revision_number
       FROM transaction_revisions
       WHERE transaction_id = ? ORDER BY revision_number DESC LIMIT 1`,
    )
    .get(transactionId) as
    | {
        revision_id?: unknown;
        source_record_id?: unknown;
        capture_id?: unknown;
        commit_id?: unknown;
        revision_number?: unknown;
      }
    | undefined;
  if (
    !row ||
    !(row.revision_id instanceof Uint8Array) ||
    !(row.source_record_id instanceof Uint8Array) ||
    !(row.capture_id instanceof Uint8Array) ||
    !(row.commit_id instanceof Uint8Array)
  )
    throw new CanonicalLoanConflictError(
      "Loan transaction revision is missing after canonical commit.",
    );
  return {
    revisionId: row.revision_id,
    sourceRecordId: row.source_record_id,
    captureId: row.capture_id,
    commitId: row.commit_id,
    revisionNumber: Number(row.revision_number),
  };
}

function persistLoanTransactionFacts(
  db: DatabaseSync,
  context: { captureId: Uint8Array; accountId: Uint8Array },
  capture: LoanValidatedCapture,
): void {
  for (const record of capture.records) {
    const transactionId = transactionContext(
      db,
      context.accountId,
      record.sourceRecordKey,
    );
    const revision = latestTransactionRevision(db, transactionId);
    const existing = db
      .prepare(
        `SELECT occurrence_index, event_kind, event_source_code,
                event_evidence_contract_version, principal_coefficient, principal_scale,
                interest_coefficient, interest_scale, fee_coefficient, fee_scale,
                component_evidence_source_record_key, component_evidence_contract_version
         FROM loan_transaction_facts WHERE revision_id = ?`,
      )
      .get(revision.revisionId) as Record<string, unknown> | undefined;
    const expected = {
      occurrence_index: record.occurrenceIndex,
      event_kind: record.eventKind,
      event_source_code: record.eventEvidence.sourceCode,
      event_evidence_contract_version: record.eventEvidence.contractVersion,
      principal_coefficient: record.principal?.coefficient ?? null,
      principal_scale: record.principal?.scale ?? null,
      interest_coefficient: record.interest?.coefficient ?? null,
      interest_scale: record.interest?.scale ?? null,
      fee_coefficient: record.fee?.coefficient ?? null,
      fee_scale: record.fee?.scale ?? null,
      component_evidence_source_record_key:
        record.componentEvidence?.sourceRecordKey ?? null,
      component_evidence_contract_version:
        record.componentEvidence?.contractVersion ?? null,
    };
    if (existing) {
      for (const [key, value] of Object.entries(expected))
        if (existing[key] !== value)
          throw new CanonicalLoanConflictError(
            "Typed loan transaction facts cannot be overwritten.",
          );
      continue;
    }
    db.prepare(
      `INSERT INTO loan_transaction_facts(
        transaction_id, revision_id, source_record_id, capture_id, commit_id,
        occurrence_index, event_kind, event_source_code,
        event_evidence_contract_version, principal_coefficient, principal_scale,
        interest_coefficient, interest_scale, fee_coefficient, fee_scale,
        component_evidence_source_record_key, component_evidence_contract_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      transactionId,
      revision.revisionId,
      revision.sourceRecordId,
      revision.captureId,
      revision.commitId,
      expected.occurrence_index,
      expected.event_kind,
      expected.event_source_code,
      expected.event_evidence_contract_version,
      expected.principal_coefficient,
      expected.principal_scale,
      expected.interest_coefficient,
      expected.interest_scale,
      expected.fee_coefficient,
      expected.fee_scale,
      expected.component_evidence_source_record_key,
      expected.component_evidence_contract_version,
    );
  }
}

function activeLoanProjectionGeneration(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT generation.generation_id
       FROM active_projection_generation active
       JOIN projection_generations generation
         ON generation.generation_id = active.generation_id
       WHERE active.singleton_id = 1 AND generation.status = 'active'`,
    )
    .get() as { generation_id?: unknown } | undefined;
  if (!row || !Number.isSafeInteger(Number(row.generation_id)))
    throw new CanonicalLoanConflictError(
      "Active canonical projection generation is missing.",
    );
  return Number(row.generation_id);
}

function projectLoanAccount(
  db: DatabaseSync,
  generationId: number,
  context: { accountId: Uint8Array; commitId: Uint8Array },
): void {
  const created = db
    .prepare(
      "SELECT created_commit_id FROM financial_accounts WHERE account_id = ?",
    )
    .get(context.accountId) as { created_commit_id?: unknown } | undefined;
  if (!(created?.created_commit_id instanceof Uint8Array))
    throw new CanonicalLoanConflictError(
      "Loan account creation lineage is missing.",
    );
  db.prepare(
    `INSERT INTO current_loan_accounts(
       generation_id, account_id, projection_commit_id, created_commit_id
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(generation_id, account_id) DO UPDATE SET
       projection_commit_id = excluded.projection_commit_id`,
  ).run(
    generationId,
    context.accountId,
    context.commitId,
    created.created_commit_id,
  );
}

type PersistedRelationEndpoint = {
  accountId: Uint8Array;
  transactionId: Uint8Array;
  accountKey: string;
  sourceRecordKey: string;
  direction: "inflow" | "outflow";
};

function canonicalRelationEndpoints(
  left: PersistedRelationEndpoint,
  right: PersistedRelationEndpoint,
): readonly [PersistedRelationEndpoint, PersistedRelationEndpoint] {
  const leftKey = Buffer.concat([left.accountId, left.transactionId]);
  const rightKey = Buffer.concat([right.accountId, right.transactionId]);
  return Buffer.compare(leftKey, rightKey) <= 0 ? [left, right] : [right, left];
}

function canonicalRelationKey(
  sourceConnectionId: Uint8Array,
  identityEpochId: Uint8Array,
  from: PersistedRelationEndpoint,
  to: PersistedRelationEndpoint,
): string {
  return [
    "loan-relation-v9",
    Buffer.from(sourceConnectionId).toString("hex"),
    Buffer.from(identityEpochId).toString("hex"),
    Buffer.from(from.accountId).toString("hex"),
    Buffer.from(from.transactionId).toString("hex"),
    Buffer.from(to.accountId).toString("hex"),
    Buffer.from(to.transactionId).toString("hex"),
  ].join(":");
}

function persistLoanExtensions(
  db: DatabaseSync,
  capture: LoanValidatedCapture,
  counterpartCaptures: readonly LoanCounterpartTransactionInput[],
): void {
  validateCanonicalLoanExtensionSchema(db);
  const context = sourceCaptureContext(db, capture.captureId);
  const generationId = activeLoanProjectionGeneration(db);
  persistLoanAccountIdentity(db, context, {
    sourceConnectionKey: capture.identity.sourceConnectionKey,
    identityEpochKey: capture.identity.identityEpochKey,
    accountKey: capture.identity.accountKey,
    accountNo: capture.identity.accountNo,
    accountType: "loan",
    stream: "loan",
  });
  projectLoanAccount(db, generationId, context);
  for (const counterpart of counterpartCaptures) {
    const counterpartContext = sourceCaptureContext(db, counterpart.captureId);
    persistLoanAccountIdentity(db, counterpartContext, {
      sourceConnectionKey: counterpart.sourceConnectionKey,
      identityEpochKey: counterpart.identityEpochKey,
      accountKey: counterpart.accountKey,
      accountNo: counterpart.accountNo,
      accountType: counterpart.accountType,
      stream: counterpart.stream,
    });
  }
  persistLoanTransactionFacts(db, context, capture);
  for (const observation of capture.balanceObservations) {
    const sourceRecordId = sourceRecordContext(
      db,
      context.captureId,
      observation.sourceRecordKey,
    );
    const correction = observation.correctionEvidence;
    const existingObservation = correction
      ? (db
          .prepare(
            `SELECT observation.observation_id
             FROM balance_observations observation
             JOIN canonical_commits created
               ON created.commit_id = observation.created_commit_id
             WHERE observation.account_id = ? AND observation.observation_key = ?
               AND observation.balance_kind = ?
             ORDER BY created.commit_sequence DESC LIMIT 1`,
          )
          .get(
            context.accountId,
            correction.observationKey,
            observation.balanceKind,
          ) as { observation_id?: unknown } | undefined)
      : undefined;
    if (!existingObservation && correction)
      throw new CanonicalLoanConflictError(
        "Loan correction evidence must target an existing observation.",
      );
    const observationId =
      existingObservation?.observation_id instanceof Uint8Array
        ? existingObservation.observation_id
        : id();
    if (!existingObservation)
      db.prepare(
        `INSERT INTO balance_observations(
          observation_id, account_id, observation_key, balance_kind,
          created_capture_id, created_commit_id
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        observationId,
        context.accountId,
        observation.observationKey,
        observation.balanceKind,
        context.captureId,
        context.commitId,
      );
    const priorRevision = db
      .prepare(
        `SELECT COALESCE(MAX(revision_number), 0) AS revision_number
         FROM balance_observation_revisions WHERE observation_id = ?`,
      )
      .get(observationId) as { revision_number?: number };
    const duplicateRevision = db
      .prepare(
        `SELECT revision_id FROM balance_observation_revisions
         WHERE observation_id = ? AND balance_coefficient = ? AND balance_scale = ?
           AND effective_at = ? AND effective_time_evidence_value = ?`,
      )
      .get(
        observationId,
        observation.balance.coefficient,
        observation.balance.scale,
        observation.effectiveAt,
        observation.effectiveTimeEvidence.value,
      );
    if (duplicateRevision) continue;
    const revisionId = id();
    db.prepare(
      `INSERT INTO balance_observation_revisions(
        revision_id, observation_id, source_record_id, capture_id, commit_id,
        revision_number, balance_coefficient, balance_scale, currency,
        effective_at, effective_time_basis, effective_time_rule_version,
        effective_time_evidence_source_record_key, effective_time_evidence_source_field,
        effective_time_evidence_value, effective_time_evidence_contract_version, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      revisionId,
      observationId,
      sourceRecordId,
      context.captureId,
      context.commitId,
      Number(priorRevision.revision_number ?? 0) + 1,
      observation.balance.coefficient,
      observation.balance.scale,
      observation.currency,
      observation.effectiveAt,
      observation.effectiveTimeBasis,
      observation.effectiveTimeRuleVersion,
      observation.effectiveTimeEvidence.sourceRecordKey,
      observation.effectiveTimeEvidence.sourceField,
      observation.effectiveTimeEvidence.value,
      observation.effectiveTimeEvidence.contractVersion,
      capture.observedAt,
    );
    db.prepare(
      `INSERT INTO current_loan_balance_observations(
         generation_id, account_id, balance_kind, observation_id, revision_id,
         projection_commit_id, revision_commit_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(generation_id, account_id, balance_kind) DO UPDATE SET
         observation_id = excluded.observation_id,
         revision_id = excluded.revision_id,
         projection_commit_id = excluded.projection_commit_id,
         revision_commit_id = excluded.revision_commit_id`,
    ).run(
      generationId,
      context.accountId,
      observation.balanceKind,
      observationId,
      revisionId,
      context.commitId,
      context.commitId,
    );
  }
  const transactionIds = new Map<
    string,
    { accountId: Uint8Array; transactionId: Uint8Array }
  >();
  for (const record of capture.records)
    transactionIds.set(record.sourceRecordKey, {
      accountId: context.accountId,
      transactionId: transactionContext(
        db,
        context.accountId,
        record.sourceRecordKey,
      ),
    });
  for (const counterpart of counterpartCaptures) {
    const counterpartContext = sourceCaptureContext(db, counterpart.captureId);
    transactionIds.set(counterpart.sourceRecordKey, {
      accountId: counterpartContext.accountId,
      transactionId: transactionContext(
        db,
        counterpartContext.accountId,
        counterpart.sourceRecordKey,
      ),
    });
  }
  for (const relation of capture.relations) {
    const fromTransaction = transactionIds.get(relation.fromSourceRecordKey);
    const toTransaction = transactionIds.get(relation.toSourceRecordKey);
    if (!fromTransaction || !toTransaction)
      throw new CanonicalLoanConflictError(
        "Loan relation endpoints must be persisted transactions.",
      );
    const scope = db
      .prepare(
        `SELECT source_connection_id, identity_epoch_id
         FROM loan_account_identities WHERE account_id = ?`,
      )
      .get(context.accountId) as Record<string, unknown> | undefined;
    if (
      !(scope?.source_connection_id instanceof Uint8Array) ||
      !(scope.identity_epoch_id instanceof Uint8Array)
    )
      throw new CanonicalLoanConflictError("Loan relation source scope is missing.");
    const [from, to] = canonicalRelationEndpoints(
      {
        ...fromTransaction,
        accountKey: relation.fromAccountKey,
        sourceRecordKey: relation.fromSourceRecordKey,
        direction: relation.fromDirection,
      },
      {
        ...toTransaction,
        accountKey: relation.toAccountKey,
        sourceRecordKey: relation.toSourceRecordKey,
        direction: relation.toDirection,
      },
    );
    const relationKey = canonicalRelationKey(
      scope.source_connection_id,
      scope.identity_epoch_id,
      from,
      to,
    );
    const existing = db
      .prepare(
        `SELECT relation_id, from_account_id, to_account_id,
                from_transaction_id, to_transaction_id,
                from_direction, to_direction
         FROM transaction_relations WHERE account_id = ? AND relation_key = ?`,
      )
      .get(context.accountId, relationKey) as
      Record<string, unknown> | undefined;
    let relationId: Uint8Array;
    if (existing) {
      const equalBlob = (left: unknown, right: Uint8Array) =>
        left instanceof Uint8Array &&
        Buffer.from(left).equals(Buffer.from(right));
      if (
        !(existing.relation_id instanceof Uint8Array) ||
        !equalBlob(existing.from_account_id, from.accountId) ||
        !equalBlob(existing.to_account_id, to.accountId) ||
        !equalBlob(existing.from_transaction_id, from.transactionId) ||
        !equalBlob(existing.to_transaction_id, to.transactionId) ||
        existing.from_direction !== from.direction ||
        existing.to_direction !== to.direction
      )
        throw new CanonicalLoanConflictError(
          "Loan transfer relation identity overwrite is forbidden.",
        );
      relationId = existing.relation_id;
    } else {
      relationId = id();
      db.prepare(
        `INSERT INTO transaction_relations(
          relation_id, account_id, source_connection_id, identity_epoch_id,
          commit_id, relation_key, relation_kind,
          from_source_record_key, to_source_record_key, from_direction, to_direction,
          from_account_id, to_account_id, from_transaction_id, to_transaction_id,
          evidence_source_record_key, evidence_relation_id, evidence_contract_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        relationId,
        context.accountId,
        scope.source_connection_id,
        scope.identity_epoch_id,
        context.commitId,
        relationKey,
        relation.kind,
        from.sourceRecordKey,
        to.sourceRecordKey,
        from.direction,
        to.direction,
        from.accountId,
        to.accountId,
        from.transactionId,
        to.transactionId,
        relation.evidence.sourceRecordKey,
        relation.evidence.relationId,
        relation.evidence.contractVersion,
      );
    }
    const counterpartEvidence = counterpartCaptures.find(
      (counterpart) =>
        counterpart.sourceRecordKey === relation.evidence.sourceRecordKey,
    );
    const evidenceCaptureId = counterpartEvidence
      ? sourceCaptureContext(db, counterpartEvidence.captureId).captureId
      : context.captureId;
    const evidenceRecordId = sourceRecordContext(
      db,
      evidenceCaptureId,
      relation.evidence.sourceRecordKey,
    );
    db.prepare(
      `INSERT OR IGNORE INTO transaction_relation_provenance(
         relation_id, source_record_id, capture_id, commit_id,
         evidence_source_record_key, evidence_relation_id,
         evidence_contract_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      relationId,
      evidenceRecordId,
      evidenceCaptureId,
      context.commitId,
      relation.evidence.sourceRecordKey,
      relation.evidence.relationId,
      relation.evidence.contractVersion,
    );
    db.prepare(
      `INSERT INTO current_loan_relations(
         generation_id, relation_id, projection_commit_id, relation_commit_id
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(generation_id, relation_id) DO UPDATE SET
         projection_commit_id = excluded.projection_commit_id`,
    ).run(generationId, relationId, context.commitId, context.commitId);
  }
}

export async function commitCanonicalLoanCapture(
  store: LoanFinancialStore | CanonicalSourceStore,
  capture: LoanValidatedCapture,
): Promise<LoanFinancialCommitResult> {
  if (!hasValidatedBrand(capture))
    throw new CanonicalLoanConflictError(
      "Loan capture did not cross the runtime-validated admission seam.",
    );
  validateCapture(capture);
  const counterpartCaptures = capture.counterpartTransactions.map(
    (counterpart) => canonicalLoanCounterpartCapture(capture, counterpart),
  );
  const loanSpineCapture = canonicalLoanSpineCapture(capture);
  const result = await commitCanonicalFinancialDepositCaptureBatch(
    asWriterStore(store),
    [...counterpartCaptures, loanSpineCapture],
    () =>
      persistLoanExtensions(store.db, capture, capture.counterpartTransactions),
  );
  const committed = result.at(-1)!;
  return {
    ...committed,
    balanceObservationCount: capture.balanceObservations.length,
    relationCount: capture.relations.length,
  };
}

function latestCommitSequence(db: DatabaseSync): number {
  return Number(
    (
      db
        .prepare(
          "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
        )
        .get() as {
        value?: number;
      }
    ).value ?? 0,
  );
}

function currentProjectionSequence(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT generation.build_cutoff_commit_sequence AS commit_sequence
       FROM active_projection_generation active
       JOIN projection_generations generation
         ON generation.generation_id = active.generation_id
       WHERE active.singleton_id = 1 AND generation.status = 'active'`,
    )
    .get() as { commit_sequence?: unknown } | undefined;
  if (!row || !Number.isSafeInteger(Number(row.commit_sequence)))
    throw new CanonicalLoanConflictError(
      "Canonical loan current projection cutoff is missing.",
    );
  return Number(row.commit_sequence);
}

function parseCompact(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function amountFromColumns(
  coefficient: unknown,
  scale: unknown,
): LoanExactAmount | null {
  if (
    typeof coefficient !== "string" ||
    !/^(?:0|[1-9]\d*)$/.test(coefficient) ||
    !Number.isSafeInteger(Number(scale)) ||
    Number(scale) < 0
  )
    return null;
  return { coefficient, scale: Number(scale) };
}

function accountFromRow(row: Record<string, unknown>): LoanAccount {
  if (typeof row.account_key !== "string" || row.account_key.length === 0)
    throw new CanonicalLoanConflictError(
      "Loan stable account identifier is missing from the canonical projection.",
    );
  return {
    id: binaryId(row.account_id),
    sourceId: String(row.integration_namespace) as LoanSourceId,
    sourceConnectionKey: String(row.source_connection_key),
    identityEpochKey: String(row.epoch_key),
    accountKey: row.account_key,
    accountNo: String(row.account_no),
    accountType: "loan",
    stream: "loan",
    recordKind: String(row.record_kind),
    currency: "TWD",
  };
}

function accountRows(
  db: DatabaseSync,
  knowledgeAt: number,
  sourceId?: LoanSourceId,
  currentOnly = false,
): LoanAccount[] {
  const currentJoin = currentOnly
    ? `JOIN active_projection_generation active
         ON active.singleton_id = 1
       JOIN current_loan_accounts current_account
         ON current_account.generation_id = active.generation_id
        AND current_account.account_id = account.account_id`
    : "";
  const rows = db
    .prepare(
      `SELECT account.account_id, loan_identity.account_no, account.account_type,
              account.stream, account.currency, connection.integration_namespace,
              connection.source_connection_key, epoch.epoch_key,
              subject.record_kind, subject.subject_digest,
              loan_identity.account_key
       FROM financial_accounts account
       JOIN canonical_commits account_commit ON account_commit.commit_id = account.created_commit_id
       JOIN source_connections connection
         ON connection.source_connection_id = account.source_connection_id
       JOIN identity_epochs epoch ON epoch.identity_epoch_id = account.identity_epoch_id
       LEFT JOIN source_subjects subject
         ON subject.source_connection_id = account.source_connection_id
        AND subject.identity_epoch_id = account.identity_epoch_id
        AND subject.stream = account.stream
       JOIN loan_account_identities loan_identity
         ON loan_identity.account_id = account.account_id
        AND loan_identity.account_type = 'loan'
        AND loan_identity.stream = 'loan'
       ${currentJoin}
       WHERE account_commit.commit_sequence <= ?
         AND account.account_type = 'loan'
         AND account.stream = 'loan'
         AND (? IS NULL OR connection.integration_namespace = ?)
       ORDER BY connection.integration_namespace, account.account_no`,
    )
    .all(knowledgeAt, sourceId ?? null, sourceId ?? null) as Array<
    Record<string, unknown>
  >;
  return rows.map(accountFromRow);
}

function transactionRows(
  db: DatabaseSync,
  knowledgeAt: number,
  financialAt: string | null,
  sourceId?: LoanSourceId,
  sourceRecordKey?: string,
  currentOnly = false,
): LoanTransaction[] {
  const clauses = [
    "revision_commit.commit_sequence <= ?",
    "connection.integration_namespace IN ('fubon','yuanta')",
    "account.account_type = 'loan'",
    "account.stream = 'loan'",
  ];
  const params: Array<number | string | null> = [knowledgeAt];
  if (sourceId) {
    clauses.push("connection.integration_namespace = ?");
    params.push(sourceId);
  }
  if (financialAt) {
    clauses.push("revision.effective_on <= ?");
    params.push(financialAt);
  }
  if (sourceRecordKey) {
    clauses.push("transaction_row.source_sequence = ?");
    params.push(sourceRecordKey);
  }
  const currentJoin = currentOnly
    ? `JOIN active_projection_generation active
         ON active.singleton_id = 1
       JOIN projection_generation_transactions current_row
         ON current_row.generation_id = active.generation_id
        AND current_row.transaction_id = transaction_row.transaction_id
        AND current_row.revision_id = revision.revision_id
       JOIN projection_generations projection_generation
         ON projection_generation.generation_id = active.generation_id`
    : "";
  if (currentOnly)
    clauses.push(
      "revision_commit.commit_sequence <= projection_generation.build_cutoff_commit_sequence",
    );
  const rows = db
    .prepare(
      `SELECT transaction_row.transaction_id, account.account_id,
              loan_identity.account_no,
              connection.integration_namespace, connection.source_connection_key,
              epoch.epoch_key, subject.record_kind, subject.subject_digest,
              loan_identity.account_key,
              transaction_row.source_sequence,
              revision.amount_coefficient, revision.amount_scale, revision.currency,
              revision.direction, revision.posting_status, revision.effective_on,
              revision.transaction_date_time_local, revision.time_precision,
              revision.time_origin, revision.description, revision_commit.commit_sequence,
              revision.effective_time_basis, revision.effective_time_rule_version,
              loan_fact.occurrence_index, loan_fact.event_kind,
              loan_fact.principal_coefficient, loan_fact.principal_scale,
              loan_fact.interest_coefficient, loan_fact.interest_scale,
              loan_fact.fee_coefficient, loan_fact.fee_scale
       FROM financial_transactions transaction_row
       JOIN financial_accounts account ON account.account_id = transaction_row.account_id
       JOIN source_connections connection
         ON connection.source_connection_id = account.source_connection_id
       JOIN identity_epochs epoch ON epoch.identity_epoch_id = account.identity_epoch_id
       LEFT JOIN source_subjects subject
         ON subject.source_connection_id = account.source_connection_id
        AND subject.identity_epoch_id = account.identity_epoch_id
        AND subject.stream = account.stream
       JOIN loan_account_identities loan_identity
         ON loan_identity.account_id = account.account_id
        AND loan_identity.account_type = 'loan'
        AND loan_identity.stream = 'loan'
       JOIN transaction_revisions revision ON revision.transaction_id = transaction_row.transaction_id
       JOIN canonical_commits revision_commit ON revision_commit.commit_id = revision.commit_id
       JOIN source_records source_record ON source_record.source_record_id = revision.source_record_id
       JOIN loan_transaction_facts loan_fact ON loan_fact.revision_id = revision.revision_id
       ${currentJoin}
       WHERE ${clauses.join(" AND ")}
         AND NOT EXISTS (
           SELECT 1 FROM transaction_revisions newer
           JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.commit_id
           WHERE newer.transaction_id = revision.transaction_id
             AND newer_commit.commit_sequence <= ?
             AND newer_commit.commit_sequence > revision_commit.commit_sequence
         )
       ORDER BY connection.integration_namespace, account.account_no,
                revision.effective_on, transaction_row.source_sequence`,
    )
    .all(...params, knowledgeAt) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const account = accountFromRow(row);
    const localValue = String(row.transaction_date_time_local);
    const localTime = localValue.slice(11, 19);
    return {
      id: binaryId(row.transaction_id),
      accountId: binaryId(row.account_id),
      account,
      sourceRecordKey: String(row.source_sequence),
      sourceOccurrenceKey: String(row.source_sequence),
      occurrenceIndex: Number(row.occurrence_index),
      effectiveOn: String(row.effective_on),
      effectiveTimeBasis: String(row.effective_time_basis) as "source-reported",
      sourceTime: {
        localTime,
        timeZone: "Asia/Taipei",
        precision: String(row.time_precision) as "date" | "minute" | "second",
        timeOrigin: String(row.time_origin) as
          "source_reported" | "defaulted_local_midnight",
      },
      postingStatus: String(row.posting_status) as "posted",
      eventKind: String(row.event_kind) as LoanEventKind,
      direction: String(row.direction) as "inflow" | "outflow",
      amount: {
        coefficient: String(row.amount_coefficient),
        scale: Number(row.amount_scale),
      },
      currency: "TWD",
      description: row.description == null ? null : String(row.description),
      principal: amountFromColumns(
        row.principal_coefficient,
        row.principal_scale,
      ),
      interest: amountFromColumns(row.interest_coefficient, row.interest_scale),
      fee: amountFromColumns(row.fee_coefficient, row.fee_scale),
      knowledgeCommitSequence: Number(row.commit_sequence),
    };
  });
}

function balanceRows(
  db: DatabaseSync,
  knowledgeAt: number,
  financialAt: string | null,
  sourceId?: LoanSourceId,
  currentOnly = false,
): LoanBalanceObservation[] {
  const clauses = [
    "commit_row.commit_sequence <= ?",
    "connection.integration_namespace IN ('fubon','yuanta')",
    "account.account_type = 'loan'",
  ];
  const params: Array<number | string> = [knowledgeAt];
  if (sourceId) {
    clauses.push("connection.integration_namespace = ?");
    params.push(sourceId);
  }
  if (financialAt) {
    clauses.push("substr(revision.effective_at, 1, 10) <= ?");
    params.push(financialAt);
  }
  const currentJoin = currentOnly
    ? `JOIN active_projection_generation active
         ON active.singleton_id = 1
       JOIN current_loan_balance_observations current_balance
         ON current_balance.generation_id = active.generation_id
        AND current_balance.observation_id = observation.observation_id
        AND current_balance.revision_id = revision.revision_id`
    : "";
  const rows = db
    .prepare(
      `SELECT observation.observation_key, observation.balance_kind,
              revision.balance_coefficient,
              revision.balance_scale, revision.currency, revision.effective_at,
              revision.effective_time_basis, revision.effective_time_rule_version,
              revision.effective_time_evidence_source_record_key,
              revision.effective_time_evidence_source_field,
              revision.effective_time_evidence_value,
              revision.effective_time_evidence_contract_version,
              revision.observed_at, revision.capture_id, revision.commit_id,
              revision.source_record_id,
              account.account_id, loan_identity.account_no,
              connection.integration_namespace,
              connection.source_connection_key, epoch.epoch_key, subject.record_kind,
              subject.subject_digest, loan_identity.account_key,
              capture.capture_key, commit_row.commit_sequence
       FROM balance_observations observation
       JOIN balance_observation_revisions revision
         ON revision.observation_id = observation.observation_id
       JOIN financial_accounts account ON account.account_id = observation.account_id
       JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
       JOIN identity_epochs epoch ON epoch.identity_epoch_id = account.identity_epoch_id
       LEFT JOIN source_subjects subject
         ON subject.source_connection_id = account.source_connection_id
        AND subject.identity_epoch_id = account.identity_epoch_id
        AND subject.stream = account.stream
       JOIN loan_account_identities loan_identity
         ON loan_identity.account_id = account.account_id
        AND loan_identity.account_type = 'loan'
        AND loan_identity.stream = 'loan'
       JOIN source_captures capture ON capture.capture_id = revision.capture_id
       JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
       ${currentJoin}
       WHERE ${clauses.join(" AND ")}
         AND NOT EXISTS (
           SELECT 1 FROM balance_observation_revisions newer
           JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.commit_id
           WHERE newer.observation_id = observation.observation_id
             AND newer_commit.commit_sequence <= ?
             AND newer_commit.commit_sequence > commit_row.commit_sequence
         )
       ORDER BY connection.integration_namespace, account.account_no, revision.effective_at`,
    )
    .all(...params, knowledgeAt) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const account = accountFromRow(row);
    return {
      observationKey: String(row.observation_key),
      sourceRecordKey: String(
        (
          db
            .prepare(
              "SELECT occurrence_key FROM source_records WHERE capture_id = ? AND source_record_id = ?",
            )
            .get(
              row.capture_id as Uint8Array,
              row.source_record_id as Uint8Array,
            ) as { occurrence_key?: unknown } | undefined
        )?.occurrence_key ?? "",
      ),
      balanceKind: String(row.balance_kind) as
        "loan_outstanding" | "outstanding_principal" | "outstanding_total",
      balance: {
        coefficient: String(row.balance_coefficient),
        scale: Number(row.balance_scale),
      },
      currency: "TWD",
      effectiveAt: String(row.effective_at),
      effectiveTimeBasis: "source-reported",
      effectiveTimeRuleVersion: String(row.effective_time_rule_version),
      effectiveTimeEvidence: {
        kind: "source-reported-balance-effective-time",
        sourceRecordKey: String(row.effective_time_evidence_source_record_key),
        sourceField: String(
          row.effective_time_evidence_source_field,
        ) as "statement-as-of",
        value: String(row.effective_time_evidence_value),
        contractVersion: String(row.effective_time_evidence_contract_version),
      },
      accountId: binaryId(row.account_id),
      account,
      captureId: String(row.capture_key),
      commitSequence: Number(row.commit_sequence),
      observedAt: String(row.observed_at),
    };
  });
}

function relationRows(
  db: DatabaseSync,
  knowledgeAt: number,
  financialAt: string | null,
  sourceId?: LoanSourceId,
  currentOnly = false,
): LoanTransferRelation[] {
  const clauses = [
    "commit_row.commit_sequence <= ?",
    "(? IS NULL OR connection.integration_namespace = ?)",
  ];
  const params: Array<number | string | null> = [
    knowledgeAt,
    sourceId ?? null,
    sourceId ?? null,
  ];
  if (financialAt) {
    clauses.push(`COALESCE(
      (SELECT MAX(from_revision.effective_on)
       FROM financial_transactions from_transaction
       JOIN transaction_revisions from_revision
         ON from_revision.transaction_id = from_transaction.transaction_id
       JOIN canonical_commits from_commit
         ON from_commit.commit_id = from_revision.commit_id
       WHERE from_transaction.transaction_id = relation.from_transaction_id
         AND from_commit.commit_sequence <= ?),
      (SELECT MAX(to_revision.effective_on)
       FROM financial_transactions to_transaction
       JOIN transaction_revisions to_revision
         ON to_revision.transaction_id = to_transaction.transaction_id
       JOIN canonical_commits to_commit
         ON to_commit.commit_id = to_revision.commit_id
       WHERE to_transaction.transaction_id = relation.to_transaction_id
         AND to_commit.commit_sequence <= ?)
    ) <= ?`);
    params.push(knowledgeAt, knowledgeAt, financialAt);
  }
  const currentJoin = currentOnly
    ? `JOIN active_projection_generation active
         ON active.singleton_id = 1
       JOIN current_loan_relations current_relation
         ON current_relation.generation_id = active.generation_id
        AND current_relation.relation_id = relation.relation_id`
    : "";
  const rows = db
    .prepare(
      `SELECT relation.relation_kind, relation.from_source_record_key,
              relation.to_source_record_key, relation.from_direction,
              relation.to_direction, relation.evidence_source_record_key,
              relation.evidence_relation_id, relation.evidence_contract_version,
              relation.from_account_id, relation.to_account_id,
              relation.from_transaction_id, relation.to_transaction_id,
              from_identity.account_key AS from_account_key,
              to_identity.account_key AS to_account_key,
              account.account_id, connection.integration_namespace,
              commit_row.commit_sequence
       FROM transaction_relations relation
       JOIN financial_accounts account ON account.account_id = relation.account_id
       JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
       JOIN loan_account_identities from_identity
         ON from_identity.account_id = relation.from_account_id
       JOIN loan_account_identities to_identity
         ON to_identity.account_id = relation.to_account_id
       JOIN canonical_commits commit_row ON commit_row.commit_id = relation.commit_id
       ${currentJoin}
       WHERE ${clauses.join(" AND ")}
         AND NOT EXISTS (
           SELECT 1 FROM transaction_relations newer
           JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.commit_id
           WHERE newer.account_id = relation.account_id
             AND newer.relation_key = relation.relation_key
             AND newer_commit.commit_sequence <= ?
             AND newer_commit.commit_sequence > commit_row.commit_sequence
         )
       ORDER BY connection.integration_namespace, commit_row.commit_sequence, relation.relation_key`,
    )
    .all(...params, knowledgeAt) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    kind: "transfer_counterpart",
    fromSourceRecordKey: String(row.from_source_record_key),
    toSourceRecordKey: String(row.to_source_record_key),
    fromAccountKey: String(row.from_account_key),
    toAccountKey: String(row.to_account_key),
    fromDirection: String(row.from_direction) as "inflow" | "outflow",
    toDirection: String(row.to_direction) as "inflow" | "outflow",
    evidence: {
      kind: "explicit-source-linkage",
      sourceRecordKey: String(row.evidence_source_record_key),
      relationId: String(row.evidence_relation_id),
      contractVersion: String(row.evidence_contract_version),
    },
    accountId: binaryId(row.account_id),
    commitSequence: Number(row.commit_sequence),
    fromTransactionId:
      row.from_transaction_id instanceof Uint8Array
        ? binaryId(row.from_transaction_id)
        : null,
    toTransactionId:
      row.to_transaction_id instanceof Uint8Array
        ? binaryId(row.to_transaction_id)
        : null,
  }));
}

function lineageRows(
  db: DatabaseSync,
  knowledgeAt: number,
  sourceRecordKey: string,
  sourceId?: LoanSourceId,
): LoanLineageEntry[] {
  const rows = db
    .prepare(
      `SELECT source_record.occurrence_key, capture.capture_key,
              source_record.content_hash, source_record.payload_json,
              commit_row.commit_sequence
       FROM source_records source_record
       JOIN source_captures capture ON capture.capture_id = source_record.capture_id
       JOIN canonical_commits commit_row ON commit_row.commit_id = source_record.commit_id
       JOIN source_connections connection ON connection.source_connection_id = capture.source_connection_id
       WHERE source_record.occurrence_key = ?
         AND commit_row.commit_sequence <= ?
         AND (? IS NULL OR connection.integration_namespace = ?)
       ORDER BY commit_row.commit_sequence, capture.capture_key`,
    )
    .all(
      sourceRecordKey,
      knowledgeAt,
      sourceId ?? null,
      sourceId ?? null,
    ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    sourceRecordKey: String(row.occurrence_key),
    captureId: String(row.capture_key),
    commitSequence: Number(row.commit_sequence),
    contentHash: String(row.content_hash),
    payload: parseCompact(row.payload_json),
  }));
}

function normalizeFinancialDate(value: string): string {
  if (!ISO_DATE.test(value))
    throw new Error("Loan financial cutoff must be YYYY-MM-DD.");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (parsed.toISOString().slice(0, 10) !== value)
    throw new Error("Loan financial cutoff must be a calendar date.");
  return value;
}

function queryLoan(
  store: LoanFinancialStore | CanonicalSourceStore,
  request: {
    kind: LoanQueryResult["kind"];
    knowledgeAt: number;
    financialAt: string | null;
    sourceId?: LoanSourceId;
    sourceRecordKey?: string;
    currentOnly?: boolean;
  },
): LoanQueryResult {
  if (!hasLoanExtensionSchema(store.db))
    throw new CanonicalLoanConflictError(
      "Canonical loan query requires an initialized loan schema.",
    );
  return withCanonicalSnapshot(store.db, () => {
    const knowledgeAt = request.currentOnly
      ? currentProjectionSequence(store.db)
      : request.knowledgeAt;
    if (!Number.isSafeInteger(knowledgeAt) || knowledgeAt < 0)
      throw new CanonicalLoanConflictError(
        "Canonical loan query knowledge cutoff is invalid.",
      );
    if (knowledgeAt > latestCommitSequence(store.db))
      throw new CanonicalLoanConflictError(
        "Canonical loan query knowledge cutoff exceeds known commits.",
      );
    const accounts = accountRows(
      store.db,
      knowledgeAt,
      request.sourceId,
      request.currentOnly,
    );
    const transactions = transactionRows(
      store.db,
      knowledgeAt,
      request.financialAt,
      request.sourceId,
      request.sourceRecordKey,
      request.currentOnly,
    );
    const balanceObservations = balanceRows(
      store.db,
      knowledgeAt,
      request.financialAt,
      request.sourceId,
      request.currentOnly,
    );
    const relations = relationRows(
      store.db,
      knowledgeAt,
      request.financialAt,
      request.sourceId,
      request.currentOnly,
    );
    const lineage = request.sourceRecordKey
      ? lineageRows(
          store.db,
          knowledgeAt,
          request.sourceRecordKey,
          request.sourceId,
        )
      : [];
    return {
      status: "canonical-live",
      kind: request.kind,
      accounts,
      financialAccounts: accounts,
      transactions,
      balanceObservations,
      balanceEvidence: balanceObservations,
      relations,
      transferRelations: relations,
      lineage,
      provenance: lineage,
      knowledgeAt,
      financialAt: request.financialAt,
    };
  });
}

export function queryCanonicalLoanCurrent(
  store: LoanFinancialStore | CanonicalSourceStore,
  request: {
    sourceId?: LoanSourceId;
    integrationNamespace?: LoanSourceId;
  } = {},
): LoanQueryResult {
  return queryLoan(store, {
    kind: "current",
    knowledgeAt: 0,
    financialAt: null,
    sourceId: request.sourceId ?? request.integrationNamespace,
    currentOnly: true,
  });
}

export function queryCanonicalLoanHistorical(
  store: LoanFinancialStore | CanonicalSourceStore,
  request: LoanHistoricalQuery,
): LoanQueryResult {
  if (!Number.isSafeInteger(request.knowledgeAt) || request.knowledgeAt < 0)
    throw new Error(
      "Loan knowledge cutoff must be a safe non-negative integer.",
    );
  const financialAt = normalizeFinancialDate(request.financialAt);
  return queryLoan(store, {
    kind: "historical",
    knowledgeAt: request.knowledgeAt,
    financialAt,
    sourceId: request.sourceId ?? request.integrationNamespace,
  });
}

export function queryCanonicalLoanLineage(
  store: LoanFinancialStore | CanonicalSourceStore,
  request: LoanLineageQuery,
): LoanQueryResult {
  const sourceRecordKey = requireOpaque(
    request.sourceRecordKey ?? request.sourceOccurrenceKey,
    "Loan lineage source record key",
  );
  return queryLoan(store, {
    kind: "lineage",
    knowledgeAt: 0,
    financialAt: null,
    sourceId: request.sourceId ?? request.integrationNamespace,
    sourceRecordKey,
    currentOnly: true,
  });
}

export const queryLoanCurrent = queryCanonicalLoanCurrent;
export const queryLoanHistorical = queryCanonicalLoanHistorical;
export const queryLoanLineage = queryCanonicalLoanLineage;

function fixtureToken(
  sourceId: LoanSourceId,
  label: string,
): `sha256:${string}` {
  return token("fixture", sourceId, label);
}

function fixture(sourceId: LoanSourceId): LoanCaptureInput {
  const contractVersion = expectedContract(sourceId);
  const accountKey = fixtureToken(sourceId, "loan-account-key");
  const subjectDigest = fixtureToken(sourceId, "loan-subject");
  const accountNo = fixtureToken(sourceId, "loan-account-number");
  const disbursement = fixtureToken(sourceId, "disbursement");
  const payment = fixtureToken(sourceId, "payment");
  const counterpart = fixtureToken(sourceId, "deposit-counterpart");
  const counterpartAccountKey = fixtureToken(sourceId, "deposit-account-key");
  const counterpartSubjectDigest = fixtureToken(sourceId, "deposit-subject");
  const counterpartAccountNo = fixtureToken(sourceId, "deposit-account-number");
  const relationId = fixtureToken(sourceId, "transfer-relation");
  return {
    captureId: fixtureToken(sourceId, "capture"),
    sourceId,
    authorityRoute: expectedAuthority(sourceId),
    contractVersion,
    identity: {
      sourceConnectionKey: fixtureToken(sourceId, "connection"),
      identityEpochKey: fixtureToken(sourceId, "epoch"),
      accountKey,
      subjectDigest,
      accountType: "loan",
      accountNo,
      stream: "loan",
      recordKind: expectedRecordKind(sourceId),
      currency: "TWD",
    },
    observedAt: "2026-02-02T02:00:00.000Z",
    scope: {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      completeness: "complete-range",
      completenessBasis: "source-declared-terminal-range",
      completenessRuleVersion: contractVersion,
      pageCount: 1,
      terminal: true,
    },
    semantics: {
      status: "posted",
      effectiveTimeBasis: "source-reported",
      effectiveTimeRuleVersion: contractVersion,
      timeZone: "Asia/Taipei",
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: 2,
        proofKind: "source-declared-terminal-range",
      },
    ],
    records: [
      {
        sourceRecordKey: disbursement,
        occurrenceIndex: 1,
        effectiveOn: "2026-01-05",
        sourceTime: {
          localTime: "00:00:00",
          precision: "date",
          timeOrigin: "defaulted_local_midnight",
        },
        postingStatus: "posted",
        eventKind: "disbursement",
        eventEvidence: {
          kind: "source-coded-loan-event",
          sourceRecordKey: disbursement,
          sourceCode: "LOAN-DISBURSEMENT",
          contractVersion,
        },
        direction: "outflow",
        amount: { coefficient: "100000", scale: 2 },
        currency: "TWD",
        description: "sanitized loan disbursement",
      },
      {
        sourceRecordKey: payment,
        occurrenceIndex: 2,
        effectiveOn: "2026-01-31",
        sourceTime: {
          localTime: "00:00:00",
          precision: "date",
          timeOrigin: "defaulted_local_midnight",
        },
        postingStatus: "posted",
        eventKind: "payment",
        eventEvidence: {
          kind: "source-coded-loan-event",
          sourceRecordKey: payment,
          sourceCode: "LOAN-PAYMENT",
          contractVersion,
        },
        direction: "inflow",
        amount: { coefficient: "12500", scale: 2 },
        currency: "TWD",
        description: "sanitized loan payment",
        balanceSourceEvidence: [
          {
            kind: "source-reported-balance",
            balanceKind: "loan_outstanding",
            balanceField: "statement-balance",
            balance: { coefficient: "87500", scale: 2 },
            effectiveAtField: "statement-as-of",
            effectiveAt: "2026-01-31T23:59:59+08:00",
            contractVersion,
          },
        ],
      },
    ],
    counterpartTransactions: [
      {
        captureId: fixtureToken(sourceId, "counterpart-capture"),
        sourceRecordKey: counterpart,
        occurrenceIndex: 1,
        sourceConnectionKey: fixtureToken(sourceId, "connection"),
        identityEpochKey: fixtureToken(sourceId, "epoch"),
        accountKey: counterpartAccountKey,
        subjectDigest: counterpartSubjectDigest,
        accountNo: counterpartAccountNo,
        accountType: "depository",
        stream: "domestic-deposit",
        recordKind: expectedCounterpartRecordKind(sourceId),
        authorityRoute: expectedCounterpartAuthority(sourceId),
        contractVersion: expectedCounterpartContract(sourceId),
        effectiveOn: "2026-01-05",
        sourceTime: {
          localTime: "00:00:00",
          precision: "date",
          timeOrigin: "defaulted_local_midnight",
        },
        postingStatus: "posted",
        direction: "inflow",
        amount: { coefficient: "100000", scale: 2 },
        currency: "TWD",
        description: "sanitized deposit-side counterpart",
        sourceEvidence: {
          kind: "source-linked-counterpart",
          sourceRecordKey: counterpart,
          relationId,
          contractVersion: expectedCounterpartContract(sourceId),
        },
      },
    ],
    balanceObservations: [
      {
        observationKey: fixtureToken(sourceId, "balance"),
        sourceRecordKey: payment,
        balanceKind: "loan_outstanding",
        balance: { coefficient: "87500", scale: 2 },
        currency: "TWD",
        effectiveAt: "2026-01-31T23:59:59+08:00",
        effectiveTimeBasis: "source-reported",
        effectiveTimeRuleVersion: contractVersion,
        effectiveTimeEvidence: {
          kind: "source-reported-balance-effective-time",
          sourceRecordKey: payment,
          sourceField: "statement-as-of",
          value: "2026-01-31T23:59:59+08:00",
          contractVersion,
        },
      },
    ],
    relations: [
      {
        kind: "transfer_counterpart",
        fromSourceRecordKey: disbursement,
        toSourceRecordKey: counterpart,
        fromAccountKey: accountKey,
        toAccountKey: counterpartAccountKey,
        fromDirection: "outflow",
        toDirection: "inflow",
        evidence: {
          kind: "explicit-source-linkage",
          sourceRecordKey: disbursement,
          relationId,
          contractVersion,
        },
      },
    ],
  };
}

export const LOAN_CONTRACT_FIXTURES: Readonly<
  Record<LoanSourceId, LoanCaptureInput>
> = Object.freeze({
  fubon: fixture("fubon"),
  yuanta: fixture("yuanta"),
});

export function advertisedLoanSourceIds(
  registry: Record<
    string,
    { id: string; statementTypes: readonly { id: string }[] }
  >,
): LoanSourceId[] {
  const ids = Object.values(registry)
    .filter((group) => group.statementTypes.some((type) => type.id === "loan"))
    .map((group) => group.id);
  if (ids.some((id) => id !== "fubon" && id !== "yuanta"))
    throw new Error(
      `Advertised loan source is not contract-supported: ${ids.join(", ")}`,
    );
  return ids as LoanSourceId[];
}
