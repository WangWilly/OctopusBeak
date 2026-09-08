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
  breakdown: string[];
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
  product: string;
  group: AccountGroup;
  kind: AccountKind;
  typeLabel: string;
  amountLines: CurrencyAmountDto[];
  marginAmountLines?: CurrencyAmountDto[];
  transactionCount: number;
  assetPositionCount: number;
  lastUpdated: string | null;
  valueAvailability: "available" | "awaiting" | "unavailable";
  dataIssueId?: string;
  canonicalAccountId?: string;
  creditCard?: CreditCardAccountDto;
};

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

export type CreditCardAccountDto = {
  statements: CreditCardStatementDto[];
};

export type ProductSourceGapDto = {
  accountId: string;
  sourceConnectionKey: string;
  accountNo: string;
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
  currency: string;
  note: string | null;
};

export type ReturnCategoryDto = "trade" | "deposit" | "reward";

export type AssetPositionDto = {
  symbol: string;
  name: string;
  units: string;
  value: number | null;
  valueAvailability?: "available" | "awaiting";
  currency: string;
  change: string;
  metricLabel?: string;
  returnCategory?: ReturnCategoryDto;
  returnCostTwd?: number;
};
