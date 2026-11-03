import type {
  AccountRowDto,
  CurrentProjectionStateDto,
  DailyHistoryRowDto,
  ExchangeRateDto,
  TransactionRowDto,
} from "$lib/shared-ledger/types.ts";

export type LiabilitiesPageDto = CurrentProjectionStateDto & {
  accounts: AccountRowDto[];
  marginAccounts: AccountRowDto[];
  transactionsByAccount: Record<string, TransactionRowDto[]>;
  dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>;
  dailyHistory: DailyHistoryRowDto[];
  /** Rates for every currency held or in history, for converted totals. */
  exchangeRates: ExchangeRateDto[];
  /** The one date every current figure on the page is valued at, decided by the ledger. */
  valuationDate: string;
};
