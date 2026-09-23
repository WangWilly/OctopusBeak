import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
import {
  createSharedLiveViews,
  defineLiveView,
} from "../src/lib/data-views/server/shared-live-views.ts";
import { createViewPortServer } from "../src/lib/data-views/server/view-port.ts";
import { applyPgliteBaseline } from "../src/ledger/pglite/baseline.ts";
import { applyPgliteMaicoinOperationalSchema } from "../src/ledger/pglite/maicoin-operational.ts";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../src/ledger/pglite/operational.ts";
import { PGliteStore } from "../src/ledger/pglite/transaction.ts";
import { createPGliteOperationalRpcServer } from "./pglite-operational-rpc.ts";
import {
  createPGliteFinancialLiveViews,
  createPGliteFinancialRegistry,
  createPGliteFinancialRpcServer,
} from "./pglite-financial-registry.ts";
import { configuredOverviewSources } from "../src/lib/overview/server/expected-sources.ts";

type HealthRow = { ready: boolean };

/** The first safe view proves the worker/transport seam without opening the ledger. */
export const pgliteWorkerViews = {
  "system.health": defineLiveView<Record<string, never>, HealthRow>(() => ({
    sql: "SELECT TRUE AS ready",
    args: [],
  })),
};

export type PGliteViewWorkerRuntime = {
  dataDir: string;
  close(): Promise<void>;
};

export async function startPGliteViewWorker(
  port: MessagePort,
  dataDir?: string,
): Promise<PGliteViewWorkerRuntime> {
  const ownsDataDir = dataDir === undefined;
  const ownedDataDir = dataDir ?? await mkdtemp(join(tmpdir(), "octopus-beak-pglite-"));
  let db: PGliteWithLive | undefined;
  try {
    db = await PGlite.create(ownedDataDir, { extensions: { live } }) as PGliteWithLive;
    await applyPgliteBaseline(db as unknown as import("@electric-sql/pglite").PGlite);
  } catch (error) {
    await db?.close().catch(() => undefined);
    if (ownsDataDir) await rm(ownedDataDir, { recursive: true, force: true });
    throw error;
  }
  if (!db) throw new Error("PGlite worker database did not initialize.");
  const database = new PGliteStore(db as unknown as import("@electric-sql/pglite").PGlite);
  try {
    await applyPgliteOperationalBaseline(database);
    await applyPgliteMaicoinOperationalSchema(database);
  } catch (error) {
    await database.close().catch(() => undefined);
    if (ownsDataDir) await rm(ownedDataDir, { recursive: true, force: true });
    throw error;
  }
  const views = createSharedLiveViews(db, pgliteWorkerViews);
  const operationalProvider = createPgliteOperationalProvider(database);
  const financialRegistry = createPGliteFinancialRegistry(database, operationalProvider.exchangeRates);
  const financialViews = createPGliteFinancialLiveViews(
    db,
    financialRegistry,
    () => configuredOverviewSources(),
  );
  const source = {
    subscribe(view: string, params: object, onRows: (rows: unknown[]) => void) {
      if (view !== "system.health") {
        return financialViews.subscribe(view, params, onRows);
      }
      return views.subscribe(
        view,
        params as Record<string, never>,
        onRows as (rows: HealthRow[]) => void,
      );
    },
  };
  const financialServer = createPGliteFinancialRpcServer(port, financialRegistry);
  const server = createViewPortServer(port, source);
  const operationalServer = createPGliteOperationalRpcServer(
    port,
    operationalProvider,
  );
  let closePromise: Promise<void> | undefined;
  return {
    dataDir: ownedDataDir,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        try {
          await server.close();
        } finally {
        try {
          await financialServer.close();
        } finally {
          try {
            await operationalServer.close();
          } finally {
            try {
              await database.close();
            } finally {
              if (ownsDataDir) await rm(ownedDataDir, { recursive: true, force: true });
            }
          }
        }
        }
      })();
      return closePromise;
    },
  };
}

if (parentPort) {
  const port = parentPort;
  const configuredDataDir = workerData && typeof workerData === "object"
    && typeof (workerData as { dataDir?: unknown }).dataDir === "string"
    ? (workerData as { dataDir: string }).dataDir
    : undefined;
  const runtime = startPGliteViewWorker(port, configuredDataDir).catch((error: unknown) => {
    try {
      port.postMessage({
        kind: "worker-start-failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // The parent may have terminated the worker while startup was failing.
    }
    throw error;
  });
  void runtime.then(
    () => {
      try {
        port.postMessage({ kind: "worker-ready" });
      } catch {
        // The parent may have terminated the worker after creating the client.
      }
    },
    () => undefined,
  );
  port.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || (message as { kind?: unknown }).kind !== "shutdown") return;
    void runtime.then(
      async (active) => {
        await active.close();
        try {
          port.postMessage({ kind: "worker-stopped" });
        } catch {
          // The parent may have terminated the worker during shutdown.
        } finally {
          port.close();
        }
      },
      () => undefined,
    ).catch(() => undefined);
  });
}
