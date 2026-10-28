import type { InstitutionKey, InstitutionProduct, IntermediarySourceLogoKey } from "../institutions/institutions.ts";

export type CurrencyAmountDto = {
  currency: string;
  value: number;
  /** Exact canonical value retained beside the presentation number. */
  exact?: {
    coefficient: string;
    scale: number;
  };
  /** Canonical observation lineage for authoritative amounts. */
  traces?: readonly {
    kind: string;
    accountId: string;
    observationId?: string;
    revisionId?: string;
    securityId?: string;
    balanceKind?: "ledger" | "available";
    sourceField?: string;
    estimateKind?: "estimate";
    estimateBasis?: "provider-used-credit" | "credit-limit-minus-available";
    estimateFormula?: string;
    componentLimit?: { coefficient: string; scale: number };
    componentAvailable?: { coefficient: string; scale: number };
    effectiveAt?: string;
    observedAt?: string;
    knowledgePoint?: number;
  }[];
  /** FX evidence used when a display total is converted. */
  conversion?: {
    fromCurrency: string;
    rateDate: string;
    twdPerUnit: number;
  };
};

export type ExchangeRateDto = {
  rateDate: string;
  currency: string;
  twdPerUnit: number;
};

export type SummaryMetricDto = {
  label: string;
  amounts: CurrencyAmountDto[];
  includesPreview?: boolean;
  /** A visible preview credit account's used credit is unknown, so this total is not a figure. */
  incomplete?: boolean;
};

export type DailyHistoryRowDto = {
  date: string;
  pointAt?: string;
  captureId?: string;
  netAssets: CurrencyAmountDto[];
  dailyChange: CurrencyAmountDto[];
  assets: CurrencyAmountDto[];
  liabilities: CurrencyAmountDto[];
  exchangeRateDates?: string[];
  exchangeRateMissing?: boolean;
  accountChanges: string[];
  positionCount: number;
  includesPreview?: boolean;
};

export function historyPointKey(row: Pick<DailyHistoryRowDto, "date" | "pointAt" | "captureId">) {
  return row.pointAt ? `${row.pointAt}|${row.captureId ?? ""}` : row.date;
}

export type AccountGroup = "asset" | "liability" | "investment";

export type AccountKind =
  | "bank"
  | "foreign"
  | "fund"
  | "brokerage"
  | "crypto"
  | "credit-card"
  | "loan"
  | "other";

export type AccountRowDto = {
  id: string;
  label: string;
  institution: string;
  /** The Institution that maintains the account, e.g. "cathay" or "bank-812". */
  institutionKey?: InstitutionKey;
  /** The Intermediary source that reports this account; absent for a direct source. */
  viaSource?: IntermediarySourceLogoKey;
  product: string;
  /** The ordinal behind the "Account N" fallback when no identifier is displayable, localized by `localizeAccount`. */
  unidentifiedOrdinal?: number;
  group: AccountGroup;
  kind: AccountKind;
  typeLabel: string;
  amountLines: CurrencyAmountDto[];
  marginAmountLines?: CurrencyAmountDto[];
  transactionCount: number;
  assetPositionCount: number;
  lastUpdated: string | null;
  valueAvailability: "available" | "awaiting" | "unavailable";
  canonicalAccountId?: string;
  creditCard?: CreditCardAccountDto;
  /** The direct source that counts this Intermediary-source account, which no total includes. */
  coveredBy?: Readonly<{ namespace: string; institutionKey: string; product: InstitutionProduct }>;
  preview?: PreviewAccountDto;
};

export type PreviewProductDto = "deposit" | "credit_card" | "time_deposit";

export type PreviewAccountDto = Readonly<{
  sourceId: string;
  product: PreviewProductDto;
  lastCollectedAt: string;
  balanceTime: Readonly<{ at: string; source: "reported" | "collection-time" }> | null;
  transactions: readonly PreviewTransactionRowDto[];
  /** Present for a `time_deposit` row; `closedAt` set means the deposit shows as closed and counts toward nothing. */
  timeDeposit?: PreviewTimeDepositDto;
  /** Present for a `credit_card` row. */
  credit?: PreviewCreditDto;
}>;

export type PreviewTimeDepositDto = Readonly<{
  principal: string | null;
  interestRate: string | null;
  maturityDate: string | null;
  closedAt: string | null;
}>;

export type PreviewCreditBasisDto = Readonly<
  | { kind: "provider-used-credit"; usedCredit: string }
  | { kind: "credit-limit-minus-available"; creditLimit: string; availableCredit: string }
  | { kind: "statement-minus-paid-plus-unbilled"; statementAmount: string; paidAmount: string; unbilledAmount: string }
>;

export type PreviewCreditDto = Readonly<{
  creditLimit: string | null;
  /** `null` is an unknown used credit: show 「剩餘應繳金額未取得」, never zero. */
  usedCredit: Readonly<{ amount: string; currency: string; basis: PreviewCreditBasisDto }> | null;
  cards: readonly Readonly<{ sourceCardKey: string; cardMask: string; displayLabel: string | null }>[];
  /** Visible purchases only: paired authorizations and superseded unbilled rows are already hidden. */
  purchases: readonly PreviewPurchaseRowDto[];
  statements: readonly PreviewStatementRowDto[];
}>;

export type PreviewPurchaseRowDto = Readonly<{
  sourceRowKey: string;
  amount: string;
  currency: string;
  direction: "inflow" | "outflow" | "unknown";
  posting: Readonly<{ status: "pending" } | { status: "posted"; billing: "billed" | "unbilled"; postingDate: string | null }>;
  consumedAt: Readonly<{ precision: "day" | "minute" | "second"; value: string }>;
  /** The paired authorization's time on the posted purchase that replaced it. */
  authorizedAt: Readonly<{ precision: "day" | "minute" | "second"; value: string }> | null;
  sourceCardKey: string | null;
  statementKey: string | null;
  description: string | null;
}>;

export type PreviewStatementRowDto = Readonly<{
  statementKey: string;
  billingPeriod: string;
  cycleStart: string | null;
  cycleEnd: string | null;
  closingDate: string | null;
  dueDate: string;
  amount: string;
  currency: string;
  minimumPayment: string | null;
  paidAmount: string | null;
  paid: boolean | null;
  noPaymentNeeded: boolean | null;
}>;

export type PreviewTransactionRowDto = Readonly<{
  amount: string;
  currency: string;
  direction: "inflow" | "outflow" | "unknown";
  postedAt: Readonly<{ precision: "day" | "minute" | "second"; value: string }>;
  description: string | null;
}>;

export type CreditCardStatementMembershipDto = {
  transactionId: string;
  transactionRevisionId: string;
  sourceRecordId: string;
};

export type CreditCardStatementDto = {
  statementId: string;
  statementRevisionId: string;
  statementKey: string;
  revisionNumber: number;
  cycleStart: string;
  cycleEnd: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  statementBalance: CurrencyAmountDto;
  minimumPayment: CurrencyAmountDto | null;
  memberships: CreditCardStatementMembershipDto[];
};

export type CreditCardBalanceDto = {
  balanceKind: "credit_used";
  estimateKind: "estimate";
  estimateBasis: "provider-used-credit" | "credit-limit-minus-available";
  estimateFormula: string;
  amount: CurrencyAmountDto;
  componentLimit: { coefficient: string; scale: number } | null;
  componentAvailable: { coefficient: string; scale: number } | null;
};

export type CreditCardAccountDto = {
  statements: CreditCardStatementDto[];
  currentUsedCredit?: CreditCardBalanceDto;
};

export type ProductSourceGapDto = {
  accountId: string;
  sourceConnectionKey: string;
  sourceAccountKey?: string;
  accountNo: string | null;
  integrationNamespace?: string;
  stream?: string;
  label?: string;
  reason: "current-value-not-observed" | "source-not-collected" | "canonical-read-unavailable";
};

export type CurrentProjectionStateDto = {
  availability: "empty" | "awaiting" | "available" | "unavailable";
  coverage: "complete" | "partial" | "awaiting" | "unavailable";
  sourceGaps: ProductSourceGapDto[];
  importedAt: string | null;
};

export type TransactionRowDto = {
  date: string;
  occurredAtUtc: string | null;
  label: string;
  type: string;
  amount: number;
  /** Exact signed canonical amount retained beside the presentation number. */
  amountExact?: {
    coefficient: string;
    scale: number;
  };
  currency: string;
  note: string | null;
  investment?: {
    securityName: string;
    quantity: { coefficient: string; scale: number };
  };
};

export type AssetPositionDto = {
  symbol: string;
  name: string;
  units: string;
  value: number | null;
  /** Exact canonical valuation retained beside the presentation number. */
  valueExact?: {
    coefficient: string;
    scale: number;
  } | null;
  valueAvailability?: "available" | "awaiting";
  currency: string;
};
