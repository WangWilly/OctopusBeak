import type {
  AccountRowDto,
  DailyHistoryRowDto,
  ExchangeRateDto,
  SummaryMetricDto,
} from "$lib/shared-ledger/types.ts";

/**
 * Implied unit price (valuation / quantity) of one currently held position,
 * taken from the user's own holding observations. At most the two most recent
 * observation dates are kept, oldest first.
 */
export type OverviewHoldingPriceDto = {
  accountId: string;
  symbol: string;
  name: string;
  kind: "fund" | "brokerage" | "crypto";
  /** Fiat cash held inside an investment account; its price never moves. */
  cash: boolean;
  currency: string;
  observations: { date: string; price: number }[];
};

export type OverviewPageDto = {
  availability: "empty" | "awaiting" | "available" | "unavailable";
  /** Whether all displayed totals have a typed current value. */
  coverage: "complete" | "partial" | "unavailable";
  historyAvailability: "available" | "unavailable";
  sourceGaps: OverviewSourceGapDto[];
  importedAt: string | null;
  summary: SummaryMetricDto[];
  dailyHistory: DailyHistoryRowDto[];
  /** Native rows on the dates each account changed; carry forward between dates. */
  dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>;
  accounts: AccountRowDto[];
  holdingPrices: OverviewHoldingPriceDto[];
  exchangeRates: ExchangeRateDto[];
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
