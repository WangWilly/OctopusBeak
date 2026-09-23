import { Worker } from "node:worker_threads";
import { createPGliteViewWorkerClient } from "../../../electron/pglite-view-worker-client.ts";
import type { OverviewPageDto } from "../../lib/overview/types.ts";
import type { ExchangeRatePersistencePort } from "../exchange-rates.ts";

export type ExchangeRateCliPGliteWorkerClient = Readonly<{
  ready: Promise<void>;
  exchangeRates: ExchangeRatePersistencePort;
  overviewCurrent(): Promise<OverviewPageDto>;
  close(): Promise<number>;
}>;

/** Start the existing worker-owned PGlite runtime for standalone rate syncs. */
export function createExchangeRateCliPGliteWorkerClient(
  dataDir: string,
): ExchangeRateCliPGliteWorkerClient {
  if (!dataDir) throw new TypeError("Exchange-rate PGlite worker requires a data directory.");

  const worker = createPGliteViewWorkerClient(
    new Worker(new URL("../../../electron/pglite-view-worker.ts", import.meta.url), {
      workerData: { dataDir },
    }),
  );
  const ready = worker
    .subscribe("system.health", {}, () => undefined)
    .then((stop) => stop())
    .then(() => undefined);
  void ready.catch(() => undefined);

  let closePromise: Promise<number> | undefined;
  return Object.freeze({
    ready,
    exchangeRates: worker.operationalProvider.exchangeRates,
    overviewCurrent: () => worker.financial.registry.overviewCurrent(),
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await ready.catch(() => undefined);
        return worker.close();
      })();
      return closePromise;
    },
  });
}
