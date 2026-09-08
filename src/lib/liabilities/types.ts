import type {
  AccountRowDto,
  CurrentProjectionStateDto,
  DailyHistoryRowDto,
  TransactionRowDto,
} from "$lib/shared-ledger/types.ts";

export type LiabilitiesPageDto = CurrentProjectionStateDto & {
  accounts: AccountRowDto[];
  marginAccounts: AccountRowDto[];
  transactionsByAccount: Record<string, TransactionRowDto[]>;
  dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>;
  dailyHistory: DailyHistoryRowDto[];
};
