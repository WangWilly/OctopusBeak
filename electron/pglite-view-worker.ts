import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
import { createViewPortServer, type ViewSource } from "../src/lib/data-views/server/view-port.ts";
import { applyPgliteBaseline } from "../src/ledger/pglite/baseline.ts";
import { applyPgliteMaicoinOperationalSchema } from "../src/ledger/pglite/maicoin-operational.ts";
import { applyPgliteManualAssetsSchema } from "../src/ledger/pglite/manual-assets.ts";
import { applyPglitePreviewFinancialDataSchema } from "../src/ledger/pglite/preview-financial-data.ts";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../src/ledger/pglite/operational.ts";
import { PGliteStore } from "../src/ledger/pglite/transaction.ts";
import { startPgliteWalCheckpoints } from "../src/ledger/pglite/wal-checkpoint.ts";
import { createPGliteOperationalRpcServer } from "./pglite-operational-rpc.ts";
import {
  createLocalDateClock,
  createPGliteLiveViewDependencies,
  type LocalDateClock,
} from "./pglite-financial-live-dependencies.ts";
import { createPGliteFinancialLiveViews } from "./pglite-financial-live-views.ts";
import {
  createPGliteFinancialRpcServer,
  createPGliteWorkScheduler,
  type PGliteWorkScheduler,
} from "./pglite-financial-rpc-server.ts";
import {
  createPGliteFinancialRegistry,
  createPGliteFinancialLocalPort,
} from "./pglite-financial-registry.ts";
import { configuredOverviewSources } from "../src/lib/overview/server/expected-sources.ts";
import { automationBusinessTimezone, currentPreviewVisibility } from "../src/lib/automation/server/settings.ts";
import { dateInTimeZone } from "../src/lib/shared-ledger/twd-valuation.ts";

export type PGliteWorkerViewContext = Readonly<{
  db: PGliteWithLive;
  registry: ReturnType<typeof createPGliteFinancialRegistry>;
  clock: LocalDateClock;
  scheduler: PGliteWorkScheduler;
}>;

/** Builds the worker's only named-view source from the database it opened. */
export type PGliteWorkerViewSourceFactory = (context: PGliteWorkerViewContext) => ViewSource;

export const financialWorkerViewSource: PGliteWorkerViewSourceFactory = ({ db, registry, clock, scheduler }) =>
  createPGliteFinancialLiveViews(
    registry,
    createPGliteLiveViewDependencies(db, registry, clock),
    () => configuredOverviewSources(),
    scheduler,
  );

export type PGliteViewWorkerRuntime = {
  dataDir: string;
  close(): Promise<void>;
};

export async function startPGliteViewWorker(
  port: MessagePort,
  createViewSource: PGliteWorkerViewSourceFactory,
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
    await applyPglitePreviewFinancialDataSchema(database);
    await applyPgliteManualAssetsSchema(database);
  } catch (error) {
    await database.close().catch(() => undefined);
    if (ownsDataDir) await rm(ownedDataDir, { recursive: true, force: true });
    throw error;
  }
  const operationalProvider = createPgliteOperationalProvider(database);
  const clock = createLocalDateClock(() => dateInTimeZone(new Date(), automationBusinessTimezone()));
  const financialRegistry = createPGliteFinancialRegistry(database, () => currentPreviewVisibility(), {
    manualAssets: true,
    today: clock.today,
  });
  // Renderer requests and live-view recomputes share the database; one queue
  // lets a Pairing click start before refreshes that are still waiting.
  const scheduler = createPGliteWorkScheduler();
  const walCheckpoints = startPgliteWalCheckpoints(database, {
    run: (task) => scheduler.schedule("background", task),
    onError: (error) => console.error(
      "pglite-wal-checkpoint-failed",
      error instanceof Error ? error.message : String(error),
    ),
  });
  const source = createViewSource({ db, registry: financialRegistry, clock, scheduler });
  const financialServer = createPGliteFinancialRpcServer(port, createPGliteFinancialLocalPort(financialRegistry), undefined, scheduler);
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
              await walCheckpoints.stop();
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
  const runtime = startPGliteViewWorker(port, financialWorkerViewSource, configuredDataDir).catch((error: unknown) => {
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
