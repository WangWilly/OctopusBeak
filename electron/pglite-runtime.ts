import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { AutomationPersistenceProvider } from "../src/lib/automation/server/store.ts";
import type { ExchangeRatePersistencePort } from "../src/ledger/exchange-rates.ts";
import type { PGliteMaicoinPersistencePort } from "../src/ledger/pglite/maicoin-operational.ts";
import type { PGliteFinancialRegistry } from "./pglite-financial-registry.ts";
import {
  createPGliteChildRpcServer,
  type PGliteChildRpcServer,
} from "./pglite-child-rpc.ts";
import {
  createPGliteViewWorkerClient,
  type PGliteViewWorkerClient,
} from "./pglite-view-worker-client.ts";

export type PGliteOperationalProvider = AutomationPersistenceProvider & {
  exchangeRates: ExchangeRatePersistencePort;
  maicoin: PGliteMaicoinPersistencePort;
  /** Same-worker overview query used to derive exchange-rate coverage. */
  financial: Pick<PGliteFinancialRegistry, "overviewCurrent">;
  /** Child workflows must use the authenticated parent endpoint. */
  pgliteWorkflow: Readonly<{
    required: true;
    env: PGliteChildRpcServer["env"];
  }>;
};

export type PGliteOperationalRuntime = Readonly<{
  dataDir: string;
  worker: PGliteViewWorkerClient;
  provider: PGliteOperationalProvider;
  childRpc: PGliteChildRpcServer;
  close(): Promise<number>;
}>;

export type PGliteOperationalRuntimeOptions = {
  dataDir: string;
  workerPath?: string;
  /** Protocol-test seam; production creates exactly one worker client. */
  worker?: PGliteViewWorkerClient;
};

/**
 * Create the single worker-owned operational provider used by the desktop.
 * PGlite is the only supported runtime store.
 */
export function createPGliteOperationalRuntime(
  options: PGliteOperationalRuntimeOptions,
): PGliteOperationalRuntime {
  if (!options.dataDir || typeof options.dataDir !== "string") {
    throw new TypeError("PGlite operational runtime requires an explicit data directory.");
  }
  const worker = options.worker ?? createPGliteViewWorkerClient(
    new Worker(options.workerPath ?? join(__dirname, "pglite-view-worker.cjs"), {
      workerData: { dataDir: options.dataDir },
    }),
  );
  const childRpc = createPGliteChildRpcServer({
    provider: {
      operational: worker.operationalProvider,
      financial: worker.financial.registry,
    },
  });
  const providerWithWorkflow: PGliteOperationalProvider = Object.freeze({
    ...worker.operationalProvider,
    financial: worker.financial.registry,
    pgliteWorkflow: Object.freeze({ required: true, env: childRpc.env }),
  });
  return Object.freeze({
    dataDir: options.dataDir,
    worker,
    provider: providerWithWorkflow,
    childRpc,
    close: async () => {
      await childRpc.close();
      return worker.close();
    },
  });
}
