import { loadOverview } from "../lib/overview/server/load-overview.ts";
import { requiredExchangeRateCurrencies } from "./exchange-rates.ts";

export type ExchangeRateRequirement = {
  component: string;
  requiredFrom: string | null;
  currencies: string[];
};

export type ExchangeRateRequest = {
  requiredFrom: string | null;
  currencies: string[];
};

type ExchangeRateRequirementProvider = (
  ledgerDir: string,
) => Promise<ExchangeRateRequirement>;

export function aggregateExchangeRateRequirements(
  requirements: ExchangeRateRequirement[],
): ExchangeRateRequest {
  return {
    requiredFrom: requirements
      .flatMap((requirement) => requirement.requiredFrom ?? [])
      .sort()[0] ?? null,
    currencies: [...new Set(requirements
      .flatMap((requirement) => requirement.currencies))]
      .filter((currency) => currency !== "TWD" && currency !== "UNKNOWN")
      .sort(),
  };
}

export async function overviewDailyAssetChangesRequirement(
  ledgerDir: string,
): Promise<ExchangeRateRequirement> {
  const { dailyHistory } = await loadOverview(ledgerDir);
  return {
    component: "overview-daily-asset-changes",
    requiredFrom: dailyHistory.map((row) => row.date).sort()[0] ?? null,
    currencies: requiredExchangeRateCurrencies(dailyHistory),
  };
}

export const exchangeRateRequirementProviders: ExchangeRateRequirementProvider[] = [
  overviewDailyAssetChangesRequirement,
];

export async function loadExchangeRateRequest(
  ledgerDir: string,
): Promise<ExchangeRateRequest> {
  return aggregateExchangeRateRequirements(await Promise.all(
    exchangeRateRequirementProviders.map((provider) => provider(ledgerDir)),
  ));
}
