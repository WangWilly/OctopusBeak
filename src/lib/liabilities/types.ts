import type { AccountRowDto, DailyHistoryRowDto, TransactionRowDto } from "$lib/shared-ledger/types.ts";

export type LiabilitiesPageDto = {
  accounts: AccountRowDto[];
  transactionsByAccount: Record<string, TransactionRowDto[]>;
  dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>;
  dailyHistory: DailyHistoryRowDto[];
};
