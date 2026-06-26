import type { AccountRowDto, DailyHistoryRowDto, SummaryMetricDto } from "$lib/shared-ledger/types.ts";

export type OverviewPageDto = {
  importedAt: string | null;
  summary: SummaryMetricDto[];
  dailyHistory: DailyHistoryRowDto[];
  accounts: AccountRowDto[];
};
