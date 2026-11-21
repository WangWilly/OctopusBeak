import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";
import { amcheck } from "@electric-sql/pglite/contrib/amcheck";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
import { createViewPortServer, type ViewSource } from "../src/lib/data-views/server/view-port.ts";
import {
  createPgliteOperationalProvider,
} from "../src/ledger/pglite/operational.ts";
import { repairCorruptCatalogIndexes, type CatalogIndexRepair } from "../src/ledger/pglite/catalog-repair.ts";
import { installFinancialStore } from "../src/ledger/pglite/store-layout.ts";
import type { PGliteStore } from "../src/ledger/pglite/transaction.ts";
import { startPgliteWalCheckpoints } from "../src/ledger/pglite/wal-checkpoint.ts";
import { createPGliteOperationalRpcServer } from "../src/lib/pglite-rpc/pglite-operational-rpc.ts";
import { createLocalDateClock } from "./pglite-financial-live-dependencies.ts";
import { createPGliteFinancialRpcServer } from "./pglite-financial-rpc-server.ts";
import { createPGliteFinancialLocalPort } from "./pglite-financial-registry.ts";
import { createPGliteLedgerHost, type PGliteLedgerHost } from "./pglite-ledger-host.ts";
import { configuredOverviewSources } from "../src/lib/overview/server/expected-sources.ts";
import { automationBusinessTimezone, currentPreviewVisibility } from "../src/lib/automation/server/settings.ts";
import {
  readAutomationSettingsFile,
  type AutomationSettingsFile,
} from "../src/lib/automation/server/config-files.ts";
import { dateInTimeZone } from "../src/lib/shared-ledger/twd-valuation.ts";

/** Picks the worker's only named-view source from the ledger it opened. */
export type PGliteWorkerViewSourceFactory = (host: PGliteLedgerHost) => ViewSource;

export const financialWorkerViewSource: PGliteWorkerViewSourceFactory = (host) => host.views;

export type PGliteViewWorkerRuntime = {
  dataDir: string;
  close(): Promise<void>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logCatalogRepair(repair: CatalogIndexRepair): void {
  if (repair.status === "repaired") {
    console.error("pglite-catalog-reindexed", repair.corrupt.join(", "));
  } else if (repair.status === "repair-failed") {
    console.error("pglite-catalog-reindex-failed", repair.corrupt.join(", "), messageOf(repair.error));
  } else if (repair.status === "check-failed") {
    console.error("pglite-catalog-check-failed", messageOf(repair.error));
  }
}

export async function startPGliteViewWorker(
  port: MessagePort,
  createViewSource: PGliteWorkerViewSourceFactory,
  { readSettings, dataDir }: Readonly<{ readSettings: () => AutomationSettingsFile; dataDir?: string }>,
): Promise<PGliteViewWorkerRuntime> {
  const ownsDataDir = dataDir === undefined;
  const ownedDataDir = dataDir ?? await mkdtemp(join(tmpdir(), "octopus-beak-pglite-"));
  let db: PGliteWithLive | undefined;
  let database: PGliteStore;
  try {
    db = await PGlite.create(ownedDataDir, { extensions: { live, amcheck } }) as PGliteWithLive;
    logCatalogRepair(await repairCorruptCatalogIndexes(db as unknown as PGlite));
    database = await installFinancialStore(db as unknown as import("@electric-sql/pglite").PGlite);
  } catch (error) {
    await db?.close().catch(() => undefined);
    if (ownsDataDir) await rm(ownedDataDir, { recursive: true, force: true });
    throw error;
  }
  const operationalProvider = createPgliteOperationalProvider(database);
  const host = createPGliteLedgerHost(db, database, {
    clock: createLocalDateClock(() => dateInTimeZone(new Date(), automationBusinessTimezone(readSettings()))),
    previewVisibility: () => currentPreviewVisibility(readSettings()),
    expectedSources: () => configuredOverviewSources(readSettings()),
  });
  const walCheckpoints = startPgliteWalCheckpoints(database, {
    run: (task) => host.scheduler.schedule("background", task),
    onError: (error) => console.error(
      "pglite-wal-checkpoint-failed",
      error instanceof Error ? error.message : String(error),
    ),
  });
  const source = createViewSource(host);
  const financialServer = createPGliteFinancialRpcServer(port, createPGliteFinancialLocalPort(host.registry), undefined, host.scheduler);
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
  const given = (workerData && typeof workerData === "object" ? workerData : {}) as {
    dataDir?: unknown;
    settingsPath?: unknown;
  };
  const configuredDataDir = typeof given.dataDir === "string" ? given.dataDir : undefined;
  const runtime = Promise.resolve().then(() => {
    if (typeof given.settingsPath !== "string" || !given.settingsPath) {
      throw new TypeError("PGlite view worker requires an explicit settings path.");
    }
    const settingsPath = given.settingsPath;
    return startPGliteViewWorker(port, financialWorkerViewSource, {
      readSettings: () => readAutomationSettingsFile(settingsPath),
      dataDir: configuredDataDir,
    });
  }).catch((error: unknown) => {
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
