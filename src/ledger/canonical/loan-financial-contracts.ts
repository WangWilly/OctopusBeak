import type { CanonicalSourceAccountNumber } from "./canonical-source-evidence.ts";
import type {
  CanonicalOccurrenceGroup,
  CanonicalOccurrenceGroupCoverage,
} from "./occurrence-groups.ts";

export type LoanSourceId = "fubon" | "yuanta";

export type LoanExactAmount = {
  coefficient: string;
  scale: number;
};

export type LoanEventKind = "disbursement" | "payment" | "interest" | "fee";

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

export type LoanBalanceSourceEvidence = {
  kind: "source-reported-balance";
  balanceKind:
    "loan_outstanding" | "outstanding_principal" | "outstanding_total";
  /** This is a source-reported balance-after-transaction field. */
  balanceField: "balance-after-transaction";
  balance: LoanExactAmount;
  /** The source date field, independent of the legacy storage column name. */
  effectiveAtField: "transaction-date" | "accounting-date";
  effectiveAt: string;
  effectiveAtPrecision: "date";
  effectiveAtTimeOrigin: "source_reported";
  storageAnchor: "effective-at-date-only";
  contractVersion: string;
  correctionOfObservationKey?: string;
};

export type LoanTransactionInput = {
  sourceRecordKey: string;
  /** Group-local ordinal; never a capture-wide collection position. */
  occurrenceIndex: number;
  /** Capture position retained as source lineage, not part of durable identity. */
  sourceSequenceIndex: number;
  occurrenceGroup: CanonicalOccurrenceGroup;
  occurrenceCollisionKey: string;
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
  /**
   * The provider's original display label. This is retained in compact
   * source evidence when the canonical description is derived from a
   * standardized event code.
   */
  sourceDescription?: string;
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
  /** The v9 table's compatibility slot; never a claim that a statement
   * or end-of-day timestamp was supplied by the provider. */
  sourceField: "statement-as-of";
  sourceFieldRole: "transaction-date" | "accounting-date";
  value: string;
  precision: "date";
  timeOrigin: "source_reported";
  storageAnchor: "effective-at-date-only";
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
  effectiveAtPrecision: "date";
  effectiveAtTimeOrigin: "source_reported";
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
    /** Optional provider-supported account number evidence. */
    accountNumber?: CanonicalSourceAccountNumber | null;
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
  /** Exact, source-proven complete inventory of comparable loan group scopes. */
  occurrenceGroupCoverage: readonly CanonicalOccurrenceGroupCoverage[];
  records: readonly LoanTransactionInput[];
  counterpartTransactions: readonly LoanCounterpartTransactionInput[];
  balanceObservations: readonly LoanBalanceObservationInput[];
  relations: readonly LoanTransferRelationInput[];
  /**
   * A loan statement may contain no source evidence for the deposit side.
   * Keep that state explicit so an empty linkage list can never be mistaken
   * for a complete transfer-relation assertion.
   */
  relationCoverage?: "not-asserted" | "source-linked-complete";
};

export type LoanCapturePage = {
  pageOrdinal: number;
  responseCode: "200";
  terminal: boolean;
  rowCount: number;
  proofKind: "source-declared-terminal-range";
};

export type LoanSourceCompletenessEvidence = {
  pageCount: number;
  terminal: true;
  proofKind: "source-declared-terminal-range";
};

export type CanonicalLoanStatementRow = {
  sourceRecordKey: string;
  occurrenceIndex: number;
  sourceSequenceIndex: number;
  occurrenceGroup: CanonicalOccurrenceGroup;
  occurrenceCollisionKey: string;
  effectiveOn: string;
  sourceTime: LoanTransactionInput["sourceTime"];
  sourceCode: string;
  eventKind: LoanEventKind;
  direction: "inflow" | "outflow";
  amount: LoanExactAmount;
  description?: string;
  sourceDescription?: string;
  balance?: {
    observationKey: string;
    balance: LoanExactAmount;
    effectiveAt: string;
    effectiveAtPrecision: "date";
    effectiveAtTimeOrigin: "source_reported";
    effectiveAtField: "transaction-date" | "accounting-date";
  };
};

export type CanonicalLoanIdentityInput = {
  sourceConnectionKey: string;
  identityEpochKey: string;
  accountKey: string;
  subjectDigest: string;
  accountNo: string;
  accountNumber?: CanonicalSourceAccountNumber | null;
};

export type CanonicalLoanCaptureBuildInput = {
  captureId: string;
  sourceId: LoanSourceId;
  identity: CanonicalLoanIdentityInput;
  observedAt: string;
  startDate: string;
  endDate: string;
  /** Scope, page and linkage evidence must come from the source workflow. */
  scope: LoanCaptureInput["scope"];
  pages: readonly LoanCapturePage[];
  counterpartTransactions: readonly LoanCounterpartTransactionInput[];
  relations: readonly LoanTransferRelationInput[];
  relationCoverage?: LoanCaptureInput["relationCoverage"];
  rows: readonly CanonicalLoanStatementRow[];
};

export type LoanValidatedCapture = LoanCaptureInput & {
  readonly __runtimeValidatedCanonicalLoanCapture: true;
};
