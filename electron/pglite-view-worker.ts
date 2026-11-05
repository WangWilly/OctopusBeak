import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
import { createViewPortServer, type ViewSource } from "../src/lib/data-views/server/view-port.ts";
import {
  createPgliteOperationalProvider,
} from "../src/ledger/pglite/operational.ts";
import { installFinancialStore } from "../src/ledger/pglite/store-layout.ts";
import type { PGliteStore } from "../src/ledger/pglite/transaction.ts";
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
import { applyPGliteSpendingPageAction } from "../src/ledger/pglite/spending-command.ts";
import { createSpendingPageActions, type SpendingPageActions } from "../src/ledger/pglite/spending-page-actions.ts";
import { configuredOverviewSources } from "../src/lib/overview/server/expected-sources.ts";
import { automationBusinessTimezone, currentPreviewVisibility } from "../src/lib/automation/server/settings.ts";
import { dateInTimeZone } from "../src/lib/shared-ledger/twd-valuation.ts";

export type PGliteWorkerViewContext = Readonly<{
  db: PGliteWithLive;
  registry: ReturnType<typeof createPGliteFinancialRegistry>;
  /** The Spending page actions the registry runs, whose results the Spending view publishes. */
  pageActions: SpendingPageActions;
  clock: LocalDateClock;
  scheduler: PGliteWorkScheduler;
}>;

/** Builds the worker's only named-view source from the database it opened. */
export type PGliteWorkerViewSourceFactory = (context: PGliteWorkerViewContext) => ViewSource;

export const financialWorkerViewSource: PGliteWorkerViewSourceFactory = ({ db, registry, pageActions, clock, scheduler }) =>
  createPGliteFinancialLiveViews(
    { registry, pageActions },
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
  let database: PGliteStore;
  try {
    db = await PGlite.create(ownedDataDir, { extensions: { live } }) as PGliteWithLive;
    database = await installFinancialStore(db as unknown as import("@electric-sql/pglite").PGlite);
  } catch (error) {
    await db?.close().catch(() => undefined);
    if (ownsDataDir) await rm(ownedDataDir, { recursive: true, force: true });
    throw error;
  }
  const operationalProvider = createPgliteOperationalProvider(database);
  const clock = createLocalDateClock(() => dateInTimeZone(new Date(), automationBusinessTimezone()));
  const pageActions = createSpendingPageActions((request) => applyPGliteSpendingPageAction(database, request));
  const financialRegistry = createPGliteFinancialRegistry(database, () => currentPreviewVisibility(), {
    today: clock.today,
    spendingPageActions: pageActions,
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
  const source = createViewSource({ db, registry: financialRegistry, pageActions, clock, scheduler });
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
