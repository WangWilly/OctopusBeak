import type {
  AccountRowDto,
  AssetPositionDto,
  DailyHistoryRowDto,
  ExchangeRateDto,
  TransactionRowDto,
  CurrentProjectionStateDto,
} from "$lib/shared-ledger/types.ts";

export type AssetsPageDto = CurrentProjectionStateDto & {
  /** The accounts every total counts. */
  accounts: AccountRowDto[];
  /** Intermediary-source accounts a direct source already counts, listed but in no total. */
  coveredAccounts: AccountRowDto[];
  positionsByAccount: Record<string, AssetPositionDto[]>;
  transactionsByAccount: Record<string, TransactionRowDto[]>;
  dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>;
  dailyHistory: DailyHistoryRowDto[];
  /** Rates for every currency held or in history, for converted totals. */
  exchangeRates: ExchangeRateDto[];
};
