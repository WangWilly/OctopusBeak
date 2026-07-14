import type {
  AccountRowDto,
  DailyHistoryRowDto,
  ExchangeRateDto,
  SummaryMetricDto,
} from "$lib/shared-ledger/types.ts";

export type OverviewPageDto = {
  importedAt: string | null;
  summary: SummaryMetricDto[];
  dailyHistory: DailyHistoryRowDto[];
  accounts: AccountRowDto[];
  exchangeRates: ExchangeRateDto[];
  latestExchangeRateDate: string | null;
};
