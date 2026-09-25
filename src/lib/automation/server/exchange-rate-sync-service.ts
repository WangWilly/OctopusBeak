import {
  syncExchangeRates,
  type ExchangeRatePersistencePort,
  type ExchangeRateSyncOptions,
  type ExchangeRateSyncResult,
} from "../../../ledger/exchange-rates.ts";
import { exchangeRateRequestFromOverview } from "../../../ledger/exchange-rate-requirements.ts";
import type { OverviewPageDto } from "../../overview/types.ts";
import type { ExchangeRateSyncService } from "../exchange-rate-workflow.ts";

export type ExchangeRateSyncCapabilities = Readonly<{
  exchangeRates: ExchangeRatePersistencePort;
  financial: Readonly<{
    overviewCurrent(): Promise<Pick<OverviewPageDto, "dailyHistory">>;
  }>;
}>;

/** Worker-owned exchange sync built from injected, authenticated typed ports. */
export function createExchangeRateSyncService(
  capabilities: ExchangeRateSyncCapabilities,
  dependencies: Pick<ExchangeRateSyncOptions, "fetchImpl" | "now"> = {},
): (options: Parameters<ExchangeRateSyncService>[0]) => Promise<ExchangeRateSyncResult> {
  return async ({ signal, emitProgress }) => {
    signal.throwIfAborted();
    emitProgress?.({ phaseCode: "load-request", completed: 0, total: 3, percent: 0 });
    const request = exchangeRateRequestFromOverview(await capabilities.financial.overviewCurrent());
    signal.throwIfAborted();
    emitProgress?.({ phaseCode: "sync", completed: 1, total: 3, percent: 33 });
    const result = await syncExchangeRates(capabilities.exchangeRates, request, { ...dependencies, signal });
    signal.throwIfAborted();
    emitProgress?.({ phaseCode: "complete", completed: 3, total: 3, percent: 100 });
    return result;
  };
}
