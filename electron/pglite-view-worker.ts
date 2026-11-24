import { mkdtemp, rm, statfs, writeFile } from "node:fs/promises";
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
import { repairCorruptIndexes, type IndexRepair } from "../src/ledger/pglite/catalog-repair.ts";
import { isLedgerUnusable, LEDGER_UNUSABLE_CODE, LedgerUnusableError } from "./ledger-unusable.ts";
import { installFinancialStore } from "../src/ledger/pglite/store-layout.ts";
import type { PGliteStore } from "../src/ledger/pglite/transaction.ts";
import { startPgliteVacuums } from "../src/ledger/pglite/vacuum.ts";
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
import { readCardIdentityVerifier } from "../src/lib/automation/server/card-identity-verifier.ts";
import type { CardIdentitySecret } from "../src/lib/shared-identity/card-identity-secret.ts";

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

/** Written beside the data directory once the database closed cleanly; removed when it opens. */
export function cleanShutdownMarkerPath(dataDir: string): string {
  return `${dataDir}.clean-shutdown`;
}

/**
 * Whether the last close of `dataDir` was clean, consuming the record of it
 * so that a crash from here on leaves none. A data directory never closed
 * since this record existed counts as unclean, so it is checked once.
 */
async function consumeCleanShutdown(dataDir: string): Promise<boolean> {
  try {
    await rm(cleanShutdownMarkerPath(dataDir));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Checks the indexes of a store that did not close cleanly. A store whose
 * corruption is unknown or could not be repaired does not open: commits would
 * look up identities through the broken index and admit duplicates.
 */
async function assertIndexesUsable(db: PGlite): Promise<void> {
  const repair: IndexRepair = await repairCorruptIndexes(db);
  if (repair.status === "intact") return;
  if (repair.status === "repaired") {
    console.error("pglite-indexes-reindexed", repair.corrupt.join(", "));
    return;
  }
  const detail = repair.status === "repair-failed"
    ? `corrupt indexes ${repair.corrupt.join(", ")} could not be rebuilt: ${messageOf(repair.error)}`
    : `its indexes could not be checked: ${messageOf(repair.error)}`;
  console.error("pglite-index-check-refused", detail);
  throw new LedgerUnusableError(`The local ledger did not open because ${detail}`);
}

export async function startPGliteViewWorker(
  port: MessagePort,
  createViewSource: PGliteWorkerViewSourceFactory,
  { readSettings, dataDir, cardIdentitySecret }: Readonly<{
    readSettings: () => AutomationSettingsFile;
    dataDir?: string;
    cardIdentitySecret?: () => CardIdentitySecret | undefined;
  }>,
): Promise<PGliteViewWorkerRuntime> {
  const ownsDataDir = dataDir === undefined;
  const ownedDataDir = dataDir ?? await mkdtemp(join(tmpdir(), "octopus-beak-pglite-"));
  let db: PGliteWithLive | undefined;
  let database: PGliteStore;
  try {
    const closedCleanly = ownsDataDir || await consumeCleanShutdown(ownedDataDir);
    db = await PGlite.create(ownedDataDir, { extensions: { live, amcheck } }) as PGliteWithLive;
    if (!closedCleanly) await assertIndexesUsable(db as unknown as PGlite);
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
    cardIdentitySecret,
    freeDiskBytes: async () => {
      const disk = await statfs(ownedDataDir);
      return disk.bavail * disk.bsize;
    },
  });
  const walCheckpoints = startPgliteWalCheckpoints(database, {
    run: (task) => host.scheduler.schedule("background", task),
    onError: (error) => console.error(
      "pglite-wal-checkpoint-failed",
      error instanceof Error ? error.message : String(error),
    ),
  });
  const vacuums = startPgliteVacuums(database, {
    run: (task) => host.scheduler.schedule("background", task),
    onError: (error, table) => console.error(
      "pglite-vacuum-failed",
      ...(table === undefined ? [] : [table]),
      error instanceof Error ? error.message : String(error),
    ),
  });
  const source = createViewSource(host);
  const financialServer = createPGliteFinancialRpcServer(port, createPGliteFinancialLocalPort(host.registry), { scheduler: host.scheduler });
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
              await vacuums.stop();
              await walCheckpoints.stop();
              await database.close();
              if (!ownsDataDir) await writeFile(cleanShutdownMarkerPath(ownedDataDir), "");
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
    cardIdentityVerifierPath?: unknown;
  };
  const configuredDataDir = typeof given.dataDir === "string" ? given.dataDir : undefined;
  const runtime = Promise.resolve().then(() => {
    if (typeof given.settingsPath !== "string" || !given.settingsPath) {
      throw new TypeError("PGlite view worker requires an explicit settings path.");
    }
    const settingsPath = given.settingsPath;
    const verifierPath = typeof given.cardIdentityVerifierPath === "string" ? given.cardIdentityVerifierPath : undefined;
    return startPGliteViewWorker(port, financialWorkerViewSource, {
      readSettings: () => readAutomationSettingsFile(settingsPath),
      dataDir: configuredDataDir,
      cardIdentitySecret: verifierPath ? () => readCardIdentityVerifier(verifierPath) : undefined,
    });
  }).catch((error: unknown) => {
    try {
      port.postMessage({
        kind: "worker-start-failed",
        message: error instanceof Error ? error.message : String(error),
        ...(isLedgerUnusable(error) ? { code: LEDGER_UNUSABLE_CODE } : {}),
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
