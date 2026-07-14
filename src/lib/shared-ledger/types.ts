export type CurrencyAmountDto = {
  currency: string;
  value: number;
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
  transactionCount: number;
  assetPositionCount: number;
  lastUpdated: string | null;
};

export type TransactionRowDto = {
  date: string;
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
  value: number;
  currency: string;
  change: string;
  metricLabel?: string;
  returnCategory?: ReturnCategoryDto;
  returnCostTwd?: number;
};
