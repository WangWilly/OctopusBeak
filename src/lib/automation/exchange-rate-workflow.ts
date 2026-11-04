import { exchangeRateRequestFromOverview } from "../../ledger/exchange-rate-requirements.ts";
import { syncExchangeRates, type ExchangeRateSyncOptions } from "../../ledger/exchange-rates.ts";
import { defineWorkflow } from "./workflow-executor.ts";

const SYNC_STEPS = 3;

/**
 * The nonbrowser exchange-rate sync: reads which currencies the current
 * history needs, then fetches and stores their rates. Its progress is the
 * run's own events, one per step.
 */
export function createExchangeRateWorkflow(
  dependencies: Pick<ExchangeRateSyncOptions, "fetchImpl" | "now"> = {},
) {
  return defineWorkflow({
    id: "exchange-rates",
    requiresFinancialCommit: false,
    requiresExchangeRates: true,
  }, async (context) => {
    const step = (completed: number) =>
      context.event("collection", "advanced", "progress-update", { completed, total: SYNC_STEPS });
    context.signal.throwIfAborted();
    await step(0);
    const request = exchangeRateRequestFromOverview(await context.exchangeRates.overviewCurrent());
    context.signal.throwIfAborted();
    await step(1);
    await syncExchangeRates(context.exchangeRates.persistence, request, { ...dependencies, signal: context.signal });
    context.signal.throwIfAborted();
    await step(SYNC_STEPS);
  });
}
