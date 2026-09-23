import { requiredExchangeRateCurrencies } from "./exchange-rates.ts";
import type { OverviewPageDto } from "../lib/overview/types.ts";
import { createExchangeRateCliPGliteWorkerClient } from "./pglite/exchange-rate-cli-worker.ts";

export type ExchangeRateRequirement = {
  component: string;
  requiredFrom: string | null;
  currencies: string[];
};

export type ExchangeRateRequest = {
  requiredFrom: string | null;
  currencies: string[];
};

export function exchangeRateRequestFromOverview(
  overview: Pick<OverviewPageDto, "dailyHistory">,
): ExchangeRateRequest {
  const dailyHistory = overview.dailyHistory;
  return {
    requiredFrom: dailyHistory.map((row) => row.date).sort()[0] ?? null,
    currencies: requiredExchangeRateCurrencies(dailyHistory),
  };
}

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
  const worker = createExchangeRateCliPGliteWorkerClient(ledgerDir);
  try {
    await worker.ready;
    return {
      component: "overview-daily-asset-changes",
      ...exchangeRateRequestFromOverview(await worker.overviewCurrent()),
    };
  } finally {
    await worker.close();
  }
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
