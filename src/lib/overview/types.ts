import type {
  AccountRowDto,
  DailyHistoryRowDto,
  ExchangeRateDto,
  SummaryMetricDto,
} from "$lib/shared-ledger/types.ts";

export type OverviewSankeyNodeDto = {
  id: string;
  label: string;
  level: 0 | 1 | 2 | 3;
  tone: "asset" | "liability";
};

export type OverviewSankeyLinkDto = {
  source: string;
  target: string;
  value: number;
  tone: "asset" | "liability";
  currency?: string;
  exact?: { coefficient: string; scale: number };
  /** Exact TWD geometry value retained before chart-number approximation. */
  convertedExact?: { coefficient: string; scale: number };
  conversion?: {
    fromCurrency: string;
    toCurrency: string;
    rateDate: string;
    twdPerUnit: number;
    targetRateDate?: string;
    targetTwdPerUnit?: number;
    convertedExact?: { coefficient: string; scale: number };
  };
};

export type OverviewSankeyGraphDto = {
  nodes: OverviewSankeyNodeDto[];
  links: OverviewSankeyLinkDto[];
};

export type OverviewPageDto = {
  availability: "empty" | "awaiting" | "available" | "unavailable";
  /** Whether all displayed totals have a typed current value. */
  coverage: "complete" | "partial" | "unavailable";
  historyAvailability: "unavailable";
  sourceGaps: OverviewSourceGapDto[];
  importedAt: string | null;
  summary: SummaryMetricDto[];
  dailyHistory: DailyHistoryRowDto[];
  accounts: AccountRowDto[];
  sankey: OverviewSankeyGraphDto | null;
  sankeyExchangeRates: ExchangeRateDto[];
  sankeyLatestExchangeRateDate: string | null;
  exchangeRates: ExchangeRateDto[];
  latestExchangeRateDate: string | null;
};

export type OverviewSourceGapDto = {
  accountId: string;
  sourceConnectionKey: string;
  sourceAccountKey?: string;
  accountNo: string | null;
  integrationNamespace?: string;
  stream?: string;
  label?: string;
  reason: "current-value-not-observed" | "source-not-collected" | "canonical-read-unavailable";
};
