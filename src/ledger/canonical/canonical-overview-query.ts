import type { CanonicalOverviewExactAmount } from "../pglite/overview-amount.ts";

export type { CanonicalOverviewExactAmount };

export type CanonicalOverviewAvailability =
  | "empty"
  | "awaiting"
  | "available"
  | "unavailable";

export type CanonicalOverviewAmountTrace = Readonly<{
  kind:
    | "loan-balance-observation"
    | "depository-balance-observation"
    | "credit-card-used-credit-estimate"
    | "investment-holding-observation"
    | "investment-margin-observation";
  accountId: string;
  observationId?: string;
  revisionId?: string;
  securityId?: string;
  /** Provider basis retained when a depository value is available-only. */
  balanceKind?: "ledger" | "available";
  /** Exact provider field admitted for the balance observation. */
  sourceField?: string;
  estimateKind?: "estimate";
  estimateBasis?: "provider-used-credit" | "credit-limit-minus-available";
  estimateFormula?: string;
  componentLimit?: CanonicalOverviewExactAmount;
  componentAvailable?: CanonicalOverviewExactAmount;
  effectiveAt: string;
  observedAt: string;
  knowledgePoint: number;
}>;

export type CanonicalOverviewAmount = Readonly<{
  currency: string;
  exact: CanonicalOverviewExactAmount;
  traces: readonly CanonicalOverviewAmountTrace[];
}>;

export type CanonicalOverviewPosition = Readonly<{
  id: string;
  accountId: string;
  label: string;
  symbol: string;
  name: string;
  kind: "fund" | "brokerage" | "crypto";
  group: "asset";
  typeLabel: string;
  currency: string;
  amount: CanonicalOverviewAmount | null;
  units: CanonicalOverviewExactAmount | null;
}>;

export type CanonicalOverviewTransaction = Readonly<{
  id: string;
  accountId: string;
  amount: CanonicalOverviewExactAmount;
  currency: string;
  direction: string;
  postingStatus: string;
  effectiveOn: string;
  description: string | null;
}>;

export type CanonicalOverviewCreditCardStatement = Readonly<{
  statementId: string;
  statementRevisionId: string;
  statementKey: string;
  revisionNumber: number;
  cycleStart: string;
  cycleEnd: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  statementBalance: CanonicalOverviewExactAmount;
  minimumPayment: CanonicalOverviewExactAmount | null;
  memberships: readonly {
    transactionId: string;
    transactionRevisionId: string;
    sourceRecordId: string;
  }[];
}>;

export type CanonicalOverviewCreditCard = Readonly<{
  statements: readonly CanonicalOverviewCreditCardStatement[];
  currentUsedCredit?: CanonicalOverviewCreditCardBalance;
}>;

export type CanonicalOverviewCreditCardBalance = Readonly<{
  balanceKind: "credit_used";
  estimateKind: "estimate";
  estimateBasis: "provider-used-credit" | "credit-limit-minus-available";
  estimateFormula: string;
  amount: CanonicalOverviewExactAmount;
  currency: string;
  componentLimit: CanonicalOverviewExactAmount | null;
  componentAvailable: CanonicalOverviewExactAmount | null;
  effectiveAt: string;
  observedAt: string;
  projectionCommitId: string | null;
  revisionCommitId: string | null;
}>;

export type CanonicalOverviewAccount = Readonly<{
  id: string;
  sourceConnectionKey: string;
  integrationNamespace: string;
  sourceAccountKey: string;
  accountNo: string | null;
  stream: string;
  accountType: "depository" | "credit" | "loan" | "investment" | "other";
  currency: string | null;
  label: string;
  institution: string;
  product: string;
  group: "asset" | "liability" | "investment";
  kind:
    | "bank"
    | "foreign"
    | "fund"
    | "brokerage"
    | "crypto"
    | "credit-card"
    | "loan"
    | "other";
  typeLabel: string;
  amounts: readonly CanonicalOverviewAmount[];
  marginAmounts: readonly CanonicalOverviewAmount[];
  positions: readonly CanonicalOverviewPosition[];
  creditCard?: CanonicalOverviewCreditCard;
  transactionCount: number;
  observedAt: string | null;
  availability: "available" | "awaiting" | "unavailable";
}>;

export type CanonicalOverviewSourceGap = Readonly<{
  accountId: string;
  sourceConnectionKey: string;
  sourceAccountKey?: string;
  accountNo: string | null;
  integrationNamespace?: string;
  stream?: string;
  label?: string;
  reason:
    | "current-value-not-observed"
    | "source-not-collected"
    | "canonical-read-unavailable";
}>;

/**
 * Non-financial configuration may advertise a source before its first
 * canonical capture. The Overview query consumes that expectation as input;
 * it never reads settings or source-specific tables itself.
 */
export type CanonicalOverviewExpectedSource = Readonly<{
  sourceId: string;
  integrationNamespace: string;
  label: string;
  stream?: string;
}>;

export type CanonicalOverviewProjection = Readonly<{
  availability: CanonicalOverviewAvailability;
  accounts: readonly CanonicalOverviewAccount[];
  positions: readonly CanonicalOverviewPosition[];
  transactions: readonly CanonicalOverviewTransaction[];
  sourceGaps: readonly CanonicalOverviewSourceGap[];
  importedAt: string | null;
  knowledgePoint: number;
}>;

export type CanonicalOverviewCurrentQueryResult = Readonly<{
  status: "ok";
  kind: "current";
  product: "overview";
  projection: CanonicalOverviewProjection;
}>;
