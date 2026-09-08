import type {
  AccountRowDto,
  AssetPositionDto,
  DailyHistoryRowDto,
  TransactionRowDto,
  CurrentProjectionStateDto,
} from "$lib/shared-ledger/types.ts";

export type AssetsPageDto = CurrentProjectionStateDto & {
  accounts: AccountRowDto[];
  positionsByAccount: Record<string, AssetPositionDto[]>;
  transactionsByAccount: Record<string, TransactionRowDto[]>;
  dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>;
  dailyHistory: DailyHistoryRowDto[];
};
