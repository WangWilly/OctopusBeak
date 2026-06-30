import type {
  AccountRowDto,
  AssetPositionDto,
  DailyHistoryRowDto,
  TransactionRowDto,
} from "$lib/shared-ledger/types.ts";

export type AssetsPageDto = {
  accounts: AccountRowDto[];
  positionsByAccount: Record<string, AssetPositionDto[]>;
  transactionsByAccount: Record<string, TransactionRowDto[]>;
  dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>;
  dailyHistory: DailyHistoryRowDto[];
};
