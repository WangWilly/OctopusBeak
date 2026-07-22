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
};

export type OverviewSankeyGraphDto = {
  nodes: OverviewSankeyNodeDto[];
  links: OverviewSankeyLinkDto[];
};

export type OverviewPageDto = {
  importedAt: string | null;
  summary: SummaryMetricDto[];
  dailyHistory: DailyHistoryRowDto[];
  accounts: AccountRowDto[];
  sankey: OverviewSankeyGraphDto | null;
  exchangeRates: ExchangeRateDto[];
  latestExchangeRateDate: string | null;
};
