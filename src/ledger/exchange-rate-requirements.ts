import { requiredExchangeRateCurrencies } from "./exchange-rates.ts";
import type { OverviewPageDto } from "../lib/overview/types.ts";

export type ExchangeRateRequest = {
  requiredFrom: string | null;
  currencies: string[];
};

/** Derive the App's exchange-rate request from its injected financial overview. */
export function exchangeRateRequestFromOverview(
  overview: Pick<OverviewPageDto, "dailyHistory">,
): ExchangeRateRequest {
  const dailyHistory = overview.dailyHistory;
  return {
    requiredFrom: dailyHistory.map((row) => row.date).sort()[0] ?? null,
    currencies: requiredExchangeRateCurrencies(dailyHistory),
  };
}
