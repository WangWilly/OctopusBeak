import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { app, autoUpdater, BrowserWindow, dialog, Notification, powerMonitor, protocol, shell } from "electron";
import {
  createAutomationRuntime,
  type AutomationRuntime,
} from "../src/lib/automation/server/automation-runtime.ts";
import {
  AUTOMATION_CREDENTIALS_FILE,
  AUTOMATION_SETTINGS_FILE,
  createAutomationSettingsStore,
  migrateAutomationEnvFile,
  migrateStatementSelectionIds,
} from "../src/lib/automation/server/config-files.ts";
import { DEFAULT_AUTOMATION_SETTINGS } from "../src/lib/automation/server/tasks.ts";
import { startBrowserStateCleanup } from "../src/lib/automation/browser-state-retention.ts";
import { startWorkflowRunEventCleanup } from "../src/lib/automation/workflow-run-events.ts";
import { systemSettings } from "../src/lib/settings/system-settings.ts";
import { dateInTimeZone } from "../src/lib/shared-ledger/twd-valuation.ts";
import { createUsagePinger, postUsagePing, USAGE_PING_URL, usageOsVersion, type UsageFailureBook } from "../src/lib/settings/usage-statistics.ts";
import {
  appUpdateNotification,
  appUpdatesAutoDownload,
  appUpdatesEnabled,
  appUpdateSupport,
  createAppUpdater,
  type AppUpdateView,
} from "../src/lib/settings/app-updates.ts";
import {
  downloadAppRelease,
  fetchAppRelease,
  pruneAppUpdates,
  rehearseSquirrelHandoff,
  startSquirrelHandoff,
  verifiedZipPath,
} from "./app-update-io.ts";
import { onTaskRunFinished, runFailures } from "../src/lib/automation/server/task-run-finished.ts";
import {
  buildErrorReport,
  errorReportUrl,
  forgetStaleFailureDiagnostic,
  InvalidErrorReport,
  sendErrorReport,
} from "../src/lib/automation/server/error-report.ts";
import type { ErrorReportInput } from "../src/lib/automation/error-report-contract.ts";
import { createBeforeQuitHandler, quitOnTerminationSignals } from "./automation-shutdown.ts";
import { applyOctopusBeakAppIdentity } from "./app-identity.ts";
import { openSafeStorageCredentialStore } from "./credential-codec.ts";
import { askAboutStuckRestore, recoverUnusableLedger } from "./ledger-recovery.ts";
import { isLedgerUnusable } from "./ledger-unusable.ts";
import { readLedgerCleanupBackup, removeLedgerBackup } from "../src/ledger/pglite/data-dir-backup.ts";
import { damagedLedgerSummary, deleteDamagedLedgers } from "./damaged-ledgers.ts";
import { LEDGER_BASELINE_VERSIONS } from "../src/ledger/pglite/baseline-versions.ts";
import {
  ledgerRestoreRequested,
  requestLedgerRestore,
  resumeLedgerRestore,
  takeFailedRestoreBackup,
  takeLedgerRestoreOutcome,
  type LedgerRestoreLaunch,
} from "./ledger-restore.ts";
import { CARD_IDENTITY_VERIFIER_FILE } from "../src/lib/automation/server/card-identity-verifier.ts";
import { createExchangeRateScheduler, createScheduledCollectionScheduler } from "./daily-scheduler.ts";
import { requestNotificationTarget, takeNotificationTarget } from "./notification-target.ts";
import type { NotificationTarget } from "../src/lib/desktop/api.ts";
import { startScheduledCollection } from "../src/lib/automation/server/scheduled-collection.ts";
import {
  collectionNotification,
  type CollectionResult,
  type CollectionTrigger,
} from "../src/lib/automation/server/collection-summary.ts";
import { registerOctopusBeakIpc } from "./ipc.ts";
import { createSettingsDesktopService } from "../src/lib/settings/server/settings-desktop-service.ts";
import { createSpendingDesktopService } from "../src/lib/spending/server/spending-desktop-service.ts";
import { broadcast } from "./broadcast.ts";
import {
  createAutomationDesktopService,
  type AutomationDesktopService,
} from "../src/lib/automation/server/automation-desktop-service.ts";
import { createDeviceRegistrationHost } from "../src/lib/automation/server/device-registration-host.ts";
import { eraseSignInDetails } from "../src/lib/automation/server/sign-in-erasure.ts";
import { previewStructureReports } from "../src/lib/preview-sources/structure-report.ts";
import { dataVersionStore } from "../src/lib/shared-shell/data-version.ts";
import { integratedTitleBarOptions } from "./window-options.ts";
import { isRendererDocument } from "./ipc-sender.ts";
import {
  APP_SCHEME_PRIVILEGES,
  RENDERER_URL,
  serveRenderer,
  STORAGE_MIGRATION_URL,
} from "./app-protocol.ts";
import { migrateRendererStorage } from "./renderer-storage-migration.ts";
import { automationRuntimeFatalDetails } from "../src/lib/automation/runtime-invariants.ts";
import {
  createPGliteOperationalRuntime,
  type PGliteOperationalRuntime,
} from "./pglite-runtime.ts";
import { PGLITE_WORKER_SHUTDOWN_TIMEOUT_MS } from "./pglite-view-worker-client.ts";
import {
  PACKAGED_BROWSER_FIXTURE_RESULT_PREFIX,
  packagedBrowserFixtureEnabled,
} from "../src/lib/automation/server/packaged-browser-fixture.ts";
import { runPackagedBrowserWorkerFixture } from "./packaged-browser-worker-fixture.ts";
import { createSquirrelHandoff } from "./squirrel-update-handoff.ts";
import { createHostServices, type HostServices } from "./host-services.ts";
import { seedCdpRuntimeFixture } from "./cdp-runtime-fixture.ts";
import { createTdccRegistrationFixtureFetch } from "../src/lib/automation/server/tdcc-registration-fixture.ts";
import { createTdccRegistrationService } from "../src/lib/automation/server/tdcc-registration-service.ts";
import {
  createCathayRegistrationService,
  createCathaySecretStore,
} from "../src/lib/automation/server/cathay-registration-service.ts";
import { createTdccSecretStore } from "../src/lib/automation/server/tdcc-secret-store.ts";
import { withAppWorkflowHostPage } from "../src/lib/automation/server/app-browser-host.ts";
import { DEVICE_REGISTRATION_TASK_IDS } from "../src/lib/automation/server/source-device-lock.ts";
// @ts-expect-error runtime.cjs is bundled by Vite; keeping it CJS avoids changing the packaged entry.
import runtime from "./runtime.cjs";

const { buildDesktopEnv, ensureDataRoot } = runtime as {
  buildDesktopEnv: (options: {
    userData: string;
    appRoot: string;
  }) => NodeJS.ProcessEnv;
  ensureDataRoot: (userData: string, defaultSettings: Readonly<Record<string, unknown>>) => void;
};

const requestedDevRemoteDebuggingPort = Number(process.env.OCTOPUSBEAK_CDP_PORT ?? "9222");
const devRemoteDebuggingPort = Number.isInteger(requestedDevRemoteDebuggingPort)
  && requestedDevRemoteDebuggingPort > 0
  && requestedDevRemoteDebuggingPort < 65_536
  ? requestedDevRemoteDebuggingPort
  : 9222;

const unknownActiveRuntimeFixture =
  process.env.OCTOPUSBEAK_CDP_FATAL_FIXTURE === "unknown-active";
const packagedBrowserFixture = packagedBrowserFixtureEnabled(process.env);

if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", String(devRemoteDebuggingPort));
  console.info(`Electron remote debugging listening on port ${devRemoteDebuggingPort}`);
}

let mainWindow: BrowserWindow | null = null;
let createWindowPromise: Promise<BrowserWindow> | null = null;
let currentRendererUrl: string | null = null;
let currentPreloadPath: string | null = null;
let hostServices: HostServices | null = null;
let ipcRegistration: ReturnType<typeof registerOctopusBeakIpc> | null = null;
let automationDesktopService: AutomationDesktopService<BrowserWindow | null> | null = null;
let pgliteOperationalRuntime: PGliteOperationalRuntime | null = null;
let automationRuntime: AutomationRuntime | null = null;
let automationRuntimeFatalHandled = false;
/** The ledger refused to open and the person is choosing what to do; nothing else ends the App meanwhile. */
let ledgerRecoveryPending = false;
/** A Cleanup Restore whose backup the worker is opening; cleared once the worker is ready or has failed (ADR 0157). */
let ledgerRestoreOpening: Extract<LedgerRestoreLaunch, { kind: "opening" }> | null = null;
/** The restored backup did not open, and the App is starting again to swap back; nothing else ends the App meanwhile. */
let ledgerRestoreSwappingBack = false;

function handleAutomationRuntimeFatal(details: {
  code: string;
  stage: string;
  sessionId?: string;
  revision?: number;
  taskId?: string;
  runId?: string | null;
}) {
  if (automationRuntimeFatalHandled || ledgerRecoveryPending || ledgerRestoreSwappingBack) return;
  automationRuntimeFatalHandled = true;
  console.error("automation-runtime-fatal", details);
  automationRuntime?.abortAll();
  // A fatal invariant must retain exit status 1 without waiting for normal
  // before-quit cleanup or a CDP connection to finish closing.
  app.removeListener("before-quit", handleBeforeQuit);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  app.exit(1);
}

applyOctopusBeakAppIdentity(app);
// The PGlite store and credentials.json in userData have no cross-process
// lock of their own, so a second process on the same userData hands over to
// the first and quits before it opens either.
const ownsUserData = app.requestSingleInstanceLock();
if (!ownsUserData) app.quit();
process.env.OCTOPUSBEAK_SPEECH_MODEL_DIR = path.join(
  projectRoot(),
  "src",
  "lib",
  "automation",
  "server",
  "models",
  "sherpa-onnx-paraformer-zh-small",
);
// Automation shutdown records each run's outcome through the ledger, so the
// ledger close waits for it this long before going ahead.
/** What an Error report says about this install (ADR 0081): the same fields as the usage ping. */
function errorReportContext() {
  return {
    appVersion: app.getVersion(),
    osVersion: usageOsVersion(process.getSystemVersion()),
    locale: systemLocale(),
  };
}

/** The language of every text the main process shows: Traditional Chinese for a Chinese system, English otherwise. */
function systemLocale(): "zh-TW" | "en" {
  return app.getLocale().startsWith("zh") ? "zh-TW" : "en";
}

/** ADR 0078: unsent failure counts, kept only while usage statistics are on. */
const USAGE_FAILURES_FILE = "usage-failures.json";
const QUIT_CLEANUP_WAIT_MS = 2_000;
const handleBeforeQuit = createBeforeQuitHandler({
  cleanup: async () => {
    hostServices?.stop();
    try {
      await ipcRegistration?.close();
    } finally {
      // Stop runtime broadcasts even when closing the IPC views fails.
      automationDesktopService?.close();
    }
    if (automationRuntime?.hasActive()) await automationRuntime.shutdown();
  },
  cleanupWaitMs: QUIT_CLEANUP_WAIT_MS,
  closeDatabase: async () => {
    await pgliteOperationalRuntime?.close();
  },
  closeDatabaseDeadlineMs: QUIT_CLEANUP_WAIT_MS + PGLITE_WORKER_SHUTDOWN_TIMEOUT_MS + 1_000,
  quit: () => app.quit(),
});
app.on("before-quit", handleBeforeQuit);
quitOnTerminationSignals(process, () => app.quit());

let appQuitting = false;
app.on("before-quit", () => { appQuitting = true; });

/** Shows a notification whose click opens the App at its target. */
function showNotification(notice: { title: string; body: string }, target: NotificationTarget) {
  const notification = new Notification({ title: notice.title, body: notice.body });
  notification.on("click", () => {
    requestNotificationTarget(target);
    if (!currentRendererUrl || !currentPreloadPath) return;
    void createWindow(currentRendererUrl, currentPreloadPath)
      .then((window) => {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      })
      .catch(showStartupError);
  });
  notification.show();
}

function notifyCollection(trigger: CollectionTrigger, results: CollectionResult[]) {
  if (appQuitting) return;
  // A person watching the App already sees how their own sync ended.
  if (trigger === "manual" && BrowserWindow.getFocusedWindow()) return;
  const notice = collectionNotification(results, trigger, systemLocale());
  if (!notice || !Notification.isSupported()) return;
  showNotification(notice, notice.target);
}

/** ADR 0083: one notification once an update has downloaded; the App never restarts by itself. */
function notifyUpdateReady(version: string) {
  if (appQuitting || !Notification.isSupported()) return;
  showNotification(
    appUpdateNotification(version, systemLocale()),
    { route: "settings", focus: "app-updates" },
  );
}

function projectRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, "app");
  return path.join(__dirname, "..");
}

function guardWindowNavigation(window: BrowserWindow, rendererUrl: string) {
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isRendererDocument(targetUrl, rendererUrl)) event.preventDefault();
  });

  window.webContents.on("will-redirect", (event, targetUrl) => {
    if (!isRendererDocument(targetUrl, rendererUrl)) event.preventDefault();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isRendererDocument(url, rendererUrl)) {
      void window.loadURL(url).catch(showStartupError);
    }
    return { action: "deny" };
  });
}

/** `executeJavaScript` never settles once its window is gone, so the window's end rejects it. */
function evaluateUntilGone<T>(window: BrowserWindow, script: string): Promise<T> {
  if (window.isDestroyed()) return Promise.reject(new Error("The window is gone."));
  const { webContents } = window;
  return new Promise<T>((resolve, reject) => {
    const gone = () => reject(new Error("The window went away during storage migration."));
    window.once("closed", gone);
    webContents.once("render-process-gone", gone);
    webContents.executeJavaScript(script).then(resolve, reject).finally(() => {
      window.removeListener("closed", gone);
      if (!webContents.isDestroyed()) webContents.removeListener("render-process-gone", gone);
    });
  });
}

async function createWindow(rendererUrl: string, preloadPath: string) {
  if (automationRuntimeFatalHandled) throw new Error("Automation runtime is unavailable.");
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return mainWindow;
  }

  if (createWindowPromise) return createWindowPromise;

  createWindowPromise = (async () => {
    const window = new BrowserWindow({
      width: 1280,
      height: 900,
      minWidth: 980,
      minHeight: 700,
      title: "OctopusBeak",
      // Shown once storage migration has finished, so it cannot be closed mid-migration.
      show: false,
      ...integratedTitleBarOptions(),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: preloadPath,
      },
    });

    mainWindow = window;
    window.on("closed", () => {
      if (mainWindow === window) mainWindow = null;
    });
    guardWindowNavigation(window, rendererUrl);

    try {
      await migrateRendererStorage({
        userData: app.getPath("userData"),
        appOriginPageUrl: STORAGE_MIGRATION_URL,
        page: {
          load: (url) => window.loadURL(url),
          evaluate: (script) => evaluateUntilGone(window, script),
        },
      }).catch((error: unknown) => console.error("renderer-storage-migration-failed", error));
      if (window.isDestroyed()) throw new Error("The window closed before the renderer loaded.");
      window.show();
      await window.loadURL(`${rendererUrl}#/overview`);
      if (automationRuntimeFatalHandled) {
        window.destroy();
        throw new Error("Automation runtime is unavailable.");
      }
      return window;
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  })();

  try {
    return await createWindowPromise;
  } finally {
    createWindowPromise = null;
  }
}

function showStartupError(error: unknown) {
  if (automationRuntimeFatalHandled) return;
  dialog.showErrorBox(
    "OctopusBeak failed to start",
    error instanceof Error ? error.stack || error.message : String(error),
  );
  app.quit();
}

function assertDisposableVerificationFixtureRoot(userData: string) {
  let root: string;
  try {
    root = realpathSync(userData);
  } catch {
    throw new Error("Verification fixture user-data must already exist in a temporary directory.");
  }
  const temporaryRoots = [tmpdir(), "/tmp"].map((directory) => realpathSync(directory));
  const isBelowTemporaryRoot = temporaryRoots.some((temporaryRoot) => {
    const relative = path.relative(temporaryRoot, root);
    return relative.length > 0
      && relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative);
  });
  if (!isBelowTemporaryRoot) {
    throw new Error("Verification fixture user-data must be inside a disposable temporary directory.");
  }
}

async function start() {
  const userData = app.getPath("userData");
  const appRoot = projectRoot();
  const cdpFixture = process.env.OCTOPUSBEAK_CDP_FIXTURE === "171";
  const cdpVerificationFixture = !app.isPackaged
    && cdpFixture
    && process.env.OCTOPUSBEAK_CDP_VERIFICATION_FIXTURE === "1";
  if (cdpVerificationFixture) assertDisposableVerificationFixtureRoot(userData);
  const cdpTdccFixture = !app.isPackaged
    && cdpFixture
    && process.env.OCTOPUSBEAK_CDP_TDCC_FIXTURE === "1";
  if (cdpTdccFixture) assertDisposableVerificationFixtureRoot(userData);
  ensureDataRoot(userData, DEFAULT_AUTOMATION_SETTINGS);
  const stopBrowserStateCleanup = startBrowserStateCleanup({
    directory: path.join(userData, "data", "automation", "browser-state"),
    isActive: (name) => automationRuntime?.activeTaskIds().includes(name) ?? false,
    onError: () => console.error("browser-state-cleanup-failed"),
  });
  Object.assign(process.env, buildDesktopEnv({
    userData,
    appRoot,
  }));
  const cardIdentityVerifierPath = path.join(userData, CARD_IDENTITY_VERIFIER_FILE);
  const credentials = openSafeStorageCredentialStore(
    path.join(userData, AUTOMATION_CREDENTIALS_FILE),
    cardIdentityVerifierPath,
  );
  const automationSettings = createAutomationSettingsStore(path.join(userData, AUTOMATION_SETTINGS_FILE));
  migrateAutomationEnvFile({ envPath: path.join(userData, ".env"), settings: automationSettings, credentials });
  migrateStatementSelectionIds(automationSettings.path);
  const ledgerDataDir = path.join(userData, "data", "pglite");
  /** A day as Settings writes it, in its time zone; the dialogs fall back to the system clock's day. */
  const ledgerDateFormat = (): { formatDate?: (value: Date) => string } => {
    try {
      const timeZone = systemSettings(automationSettings.read()).systemTimezone;
      return { formatDate: (value) => dateInTimeZone(value, timeZone).replaceAll("-", "/") };
    } catch {
      return {};
    }
  };
  // Before anything opens the folder: a restore asked for last session swaps it now, or one a crash cut short goes on.
  // A launch step that could not put the ledger back throws, and the App does not start on a missing ledger.
  const ledgerRestore = await resumeLedgerRestore(ledgerDataDir, {
    current: LEDGER_BASELINE_VERSIONS,
    // Before the worker exists: a backup several launches could not finish opening is the person's call.
    askStuck: ({ takenAt, from }) => askAboutStuckRestore({
      locale: systemLocale(),
      takenAt,
      from,
      ask: async (options) => (await dialog.showMessageBox(options)).response,
      ...ledgerDateFormat(),
    }),
    log: (code, detail) => console.error(code, ...(detail === undefined ? [] : [detail])),
  });
  if (ledgerRestore.kind === "quit") {
    app.quit();
    return;
  }
  if (ledgerRestore.kind === "opening") ledgerRestoreOpening = ledgerRestore;
  const operationalRuntime = createPGliteOperationalRuntime({
    dataDir: ledgerDataDir,
    cardIdentityVerifierPath,
    activeRun: (taskRunId) => automationRuntime?.activeRun(taskRunId) ?? null,
    credentials,
    settings: automationSettings,
  });
  pgliteOperationalRuntime = operationalRuntime;
  // Registered first, so the restore is settled before any other reader of readiness acts.
  void operationalRuntime.worker.ready.then(() => {
    const restore = ledgerRestoreOpening;
    ledgerRestoreOpening = null;
    if (restore) void restore.opened().then(() => console.error("pglite-ledger-restored"));
  }, () => undefined);
  const runtime = createAutomationRuntime(operationalRuntime.provider, {
    credentials,
    settings: automationSettings,
    userDataDirectory: userData,
  });
  automationRuntime = runtime;
  // Reconcile abandoned execution rows off the shell's critical path. The
  // first authoritative automation snapshot awaits this same promise, so a
  // schema/recovery failure cannot be hidden by a partially hydrated UI.
  const automationRuntimeReady = new Promise<void>((resolve, reject) => {
    setImmediate(() => {
      // A ledger that refuses to open fails here, before recovery reads it.
      operationalRuntime.worker.ready
        .then(() => runtime.recover())
        .then(async () => {
          if (cdpFixture) {
            await seedCdpRuntimeFixture(runtime, operationalRuntime.provider, {
              verification: cdpVerificationFixture,
              unknownActiveTask: unknownActiveRuntimeFixture,
            });
          }
        })
        .then(() => resolve())
        .catch(reject);
    });
  });
  const exitForLedgerRecovery = (code: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    app.exit(code);
  };
  /**
   * The worker could not open a restored backup, for any reason. From
   * Settings, the App records the swap back and starts again, and the next
   * launch puts the replaced ledger back; a second failure there is handled
   * as without a restore. Returns whether the failure is handled here.
   */
  const failLedgerRestore = (error: unknown): boolean => {
    const restore = ledgerRestoreOpening;
    if (ledgerRestoreSwappingBack) return true;
    if (!restore) return false;
    ledgerRestoreOpening = null;
    // A code only: an open failure's message may carry the ledger's path.
    console.error("pglite-ledger-restore-failed", isLedgerUnusable(error) ? "ledger-indexes-unrepairable" : "open-failed");
    if (!restore.canSwapBack) {
      // From the unusable-ledger dialog there is nothing to go back to: the failure is handled as any other.
      void restore.failed().catch(() => console.error("pglite-ledger-restore-abandon-failed"));
      return false;
    }
    ledgerRestoreSwappingBack = true;
    hostServices?.stop();
    automationRuntime?.abortAll();
    void restore.failed().then(
      () => {
        app.relaunch();
        exitForLedgerRecovery(0);
      },
      // Unrecorded, the App does not start itself again, so a disk that refuses every write cannot loop it;
      // the next launch opens the backup once more and swaps back when that fails too.
      () => {
        console.error("pglite-ledger-restore-swap-back-failed");
        exitForLedgerRecovery(1);
      },
    );
    return true;
  };
  /** Asks the person what to do with a ledger that refused to open; only the first refusal asks. */
  const recoverLedger = (error: unknown) => {
    if (ledgerRecoveryPending || automationRuntimeFatalHandled || ledgerRestoreSwappingBack) return;
    ledgerRecoveryPending = true;
    console.error("pglite-ledger-unusable", error instanceof Error ? error.message : String(error));
    // Schedules would only fail against the refused ledger while the person decides.
    hostServices?.stop();
    automationRuntime?.abortAll();
    void (async () => {
      // Read by the main process itself: the worker refused the ledger (ADR 0157).
      const backup = await readLedgerCleanupBackup(ledgerDataDir, LEDGER_BASELINE_VERSIONS).catch(() => null);
      // A backup a swap back just gave back did not open; it is not offered again.
      const failed = await takeFailedRestoreBackup(ledgerDataDir).catch(() => null);
      return recoverUnusableLedger(ledgerDataDir, {
        restore: backup?.restorable && backup.path !== failed
          ? {
            takenAt: new Date(backup.takenAt),
            // Replaces a request from Settings not yet carried out, so this ledger goes aside as damaged and stays.
            request: (aside) => requestLedgerRestore(ledgerDataDir, backup.path, {
              from: "unusable",
              aside,
              replace: true,
              current: LEDGER_BASELINE_VERSIONS,
              appVersion: app.getVersion(),
            }),
          }
          : null,
        ...ledgerDateFormat(),
        locale: systemLocale(),
        ask: async (options) => {
          const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
          if (owner?.isMinimized()) owner.restore();
          owner?.show();
          return (await (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options))).response;
        },
        showError: (title, message) => dialog.showErrorBox(title, message),
        relaunch: () => app.relaunch(),
        exit: exitForLedgerRecovery,
        now: () => new Date(),
      });
    })().then(
      (choice) => console.error("pglite-ledger-recovery", choice),
      (failure: unknown) => {
        console.error("pglite-ledger-recovery-failed", failure instanceof Error ? failure.message : String(failure));
        exitForLedgerRecovery(1);
      },
    );
  };
  // A worker restarted mid-session after a crash checks the ledger again and may refuse it too.
  operationalRuntime.worker.onError((error) => {
    if (failLedgerRestore(error)) return;
    if (isLedgerUnusable(error)) recoverLedger(error);
  });
  void automationRuntimeReady.catch((error) => {
    // Registered before any other reader of this promise, so the flag is set before they report it as fatal.
    if (failLedgerRestore(error)) return;
    if (isLedgerUnusable(error)) {
      recoverLedger(error);
      return;
    }
    handleAutomationRuntimeFatal(automationRuntimeFatalDetails("startup-reconcile", error));
  });
  const exchangeRates = createExchangeRateScheduler({
    now: () => new Date(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
    readSettings: () => systemSettings(automationSettings.read()),
    hasOccurrenceBeenAttempted: (occurrenceUtc) =>
      operationalRuntime.provider.automation.hasOccurrenceBeenAttempted(
        "exchange-rates",
        occurrenceUtc,
      ),
    hasSuccessSince: (occurrenceUtc) => operationalRuntime.provider.automation.hasSuccessfulTaskRunSince(
      "exchange-rates",
      occurrenceUtc,
    ),
    isTaskActive: () => runtime.activeTaskIds().includes("exchange-rates"),
    startTask: async (scheduledAtUtc) => {
      const [result] = await runtime.start(["exchange-rates"], { scheduledAtUtc });
      if (result?.status === "error") throw result.error;
    },
    reportError: (error) => console.error("exchange-rate-scheduler-error", error),
  });
  const collectionSchedule = createScheduledCollectionScheduler({
    now: () => new Date(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
    readSettings: () => systemSettings(automationSettings.read()),
    startCollection: (occurrenceUtc) =>
      startScheduledCollection(runtime, occurrenceUtc, (results) => notifyCollection("scheduled", results))
        .then(() => undefined),
    reportError: (error) => console.error("scheduled-collection-scheduler-error", error),
  });
  const collection = {
    pauseSchedules: () => services.pauseSchedules(),
    whileStopped: <T>(work: () => Promise<T>) => runtime.whileStopped(work),
  };
  const automation = createAutomationDesktopService<BrowserWindow | null>({
    runtime,
    provider: operationalRuntime.provider,
    dataVersions: dataVersionStore,
    credentials,
    settings: automationSettings,
    deviceRegistration: createDeviceRegistrationHost({
      tdcc: createTdccRegistrationService({
        store: createTdccSecretStore(credentials),
        ...(cdpTdccFixture ? { fetch: createTdccRegistrationFixtureFetch() } : {}),
      }),
      cathay: createCathayRegistrationService({
        store: createCathaySecretStore(credentials),
        withCathayTaskPage: (signal, run) => withAppWorkflowHostPage({
          taskId: DEVICE_REGISTRATION_TASK_IDS.cathay,
          taskRunId: `device-registration-${randomUUID()}`,
          signal,
          userDataDirectory: userData,
          credentialCodec: credentials.codec,
          browserProfile: "cathay-login",
        }, ({ page }) => run(page)),
      }),
    }),
    structureReports: previewStructureReports,
    notificationTarget: { take: takeNotificationTarget },
    onManualCollectionFinished: (results) => notifyCollection("manual", results),
    eraseSignInDetails,
    userDataDirectory: userData,
    chooseFile: (owner, options) => owner
      ? dialog.showOpenDialog(owner, options)
      : dialog.showOpenDialog(options),
    openExternal: (url) => shell.openExternal(url),
    appVersion: () => app.getVersion(),
    publishRuntimeChanged: (snapshot) => broadcast("automation:runtime-changed", snapshot),
    onAutomationRuntimeFatal: handleAutomationRuntimeFatal,
    onAutomationRuntimeReady: () => automationRuntimeReady,
  });
  automationDesktopService = automation;
  const usagePinger = createUsagePinger({
    url: USAGE_PING_URL,
    // Lets a developer see the one-time question again; packaged apps ignore it.
    forceAsk: !app.isPackaged && process.env.OCTOPUSBEAK_ASK_USAGE_STATISTICS === "1",
    now: () => new Date(),
    readSettings: automationSettings.read,
    writeSettings: (patch) => automationSettings.write({ ...automationSettings.read(), ...patch }),
    appVersion: () => app.getVersion(),
    systemVersion: () => process.getSystemVersion(),
    locale: systemLocale,
    firstLaunch: () => statSync(userData).birthtime,
    readFailures: () => {
      try {
        const value: unknown = JSON.parse(readFileSync(path.join(userData, USAGE_FAILURES_FILE), "utf8"));
        return value && typeof value === "object" && !Array.isArray(value) ? (value as UsageFailureBook) : {};
      } catch {
        return {};
      }
    },
    writeFailures: (book) => writeFileSync(path.join(userData, USAGE_FAILURES_FILE), JSON.stringify(book), { mode: 0o600 }),
    send: postUsagePing,
    setInterval: (callback, ms) => setInterval(callback, ms).unref(),
    clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
    reportError: (message) => console.error(message),
  });
  // Development builds and fixtures never check, so a test run cannot replace the app it tests.
  const appUpdatesSupport = appUpdateSupport({
    packaged: app.isPackaged,
    testFixture: cdpFixture || packagedBrowserFixture,
    inApplicationsFolder: app.isPackaged && app.isInApplicationsFolder(),
    feedFixtureUrl: process.env.OCTOPUSBEAK_UPDATE_FEED_FIXTURE,
  });
  const updatesDirectory = path.join(userData, "updates");
  const updatesPruned = appUpdatesSupport.supported
    ? pruneAppUpdates(updatesDirectory, app.getVersion()).catch(() => console.error("app-update-prune-failed"))
    : Promise.resolve();
  const squirrelHandoff = createSquirrelHandoff({
    support: appUpdatesSupport,
    autoUpdater,
    zipPath: (release) => verifiedZipPath(updatesDirectory, release.version),
    start: startSquirrelHandoff,
    rehearse: rehearseSquirrelHandoff,
    receive: (signal) => appUpdater.receive(signal),
    reportError: (code) => console.error(code),
  });
  const appUpdateView = (): AppUpdateView => ({
    currentVersion: app.getVersion(),
    state: appUpdater.state(),
  });
  const appUpdater = createAppUpdater({
    support: appUpdatesSupport,
    currentVersion: app.getVersion(),
    enabled: () => appUpdatesEnabled(automationSettings.read()),
    autoDownload: () => appUpdatesAutoDownload(automationSettings.read()),
    now: () => new Date(),
    fetchRelease: () => appUpdatesSupport.supported
      ? fetchAppRelease(appUpdatesSupport)
      : Promise.reject(new Error("unsupported")),
    download: async (release, onProgress) => {
      await updatesPruned;
      return downloadAppRelease({ directory: updatesDirectory, release, onProgress });
    },
    install: squirrelHandoff.install,
    quitAndInstall: squirrelHandoff.quitAndInstall,
    hasActiveRun: () => runtime.hasActive(),
    onChange: () => broadcast("appUpdates:changed", appUpdateView()),
    onReady: notifyUpdateReady,
    setInterval: (callback, ms) => setInterval(callback, ms).unref(),
    clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
    reportError: (code) => console.error(code),
  });
  const services = createHostServices({
    exchangeRates,
    collection: collectionSchedule,
    usagePing: usagePinger,
    appUpdates: appUpdater,
    // Development builds and fixtures never ping, so they cannot count as users; fixtures run no schedules.
    run: {
      schedules: !cdpFixture && !packagedBrowserFixture,
      usagePing: app.isPackaged && !cdpFixture && !packagedBrowserFixture,
    },
    startAfterReady: [() => startWorkflowRunEventCleanup(
      operationalRuntime.provider.automation,
      { onError: () => console.error("workflow-run-event-cleanup-failed") },
    )],
    stopOnQuit: [stopBrowserStateCleanup],
  });
  hostServices = services;
  onTaskRunFinished((run) => {
    forgetStaleFailureDiagnostic(run.taskId, run.taskRunId);
    usagePinger.recordFailures(runFailures(run));
  });
  /** Codes only: an error's message may carry a path. */
  const logCode = (code: string, detail?: string) => console.error(code, ...(detail === undefined ? [] : [detail]));
  const settings = createSettingsDesktopService({
    settingsFile: automationSettings,
    onSystemSettingsChanged: (settings) => services.settingsChanged(settings),
    usagePing: usagePinger,
    dataVersions: dataVersionStore,
    collection,
    ledgerReset: {
      financial: () => operationalRuntime.worker.financial.request("financial.canonical.reset", []),
      preview: () => operationalRuntime.provider.preview.deleteAll(),
      damaged: () => deleteDamagedLedgers(ledgerDataDir, logCode),
      manual: async () => {
        const result = await operationalRuntime.worker.financial.request("financial.manualAssets.apply", [{ kind: "deleteAllManualAssets" }]);
        if (!result.ok) throw new Error(`Manual assets were not deleted: ${result.code}`);
      },
      "sign-in": () => automation.eraseSignInData(),
    },
    ledgerCleanup: {
      estimate: () => operationalRuntime.worker.financial.request("financial.ledger.cleanupEstimate", []),
      run: (request) => operationalRuntime.worker.financial.request("financial.canonical.compact", [request]),
      status: () => operationalRuntime.worker.financial.request("financial.canonical.compactionStatus", []),
      stop: () => operationalRuntime.worker.financial.request("financial.canonical.compactionStop", []),
    },
    // The main process reads the backup itself, so a restore checks what Settings showed; the renderer never sees where it is.
    cleanupBackup: {
      newest: () => readLedgerCleanupBackup(ledgerDataDir, LEDGER_BASELINE_VERSIONS),
      reveal: (backup) => shell.showItemInFolder(backup),
      remove: removeLedgerBackup,
    },
    // Counted, measured and checked against the restore files here; the renderer gets no path or name.
    damagedLedgerSummary: () => damagedLedgerSummary(ledgerDataDir),
    log: logCode,
    cleanupRestore: {
      requested: () => ledgerRestoreRequested(ledgerDataDir),
      request: (backup) => requestLedgerRestore(ledgerDataDir, backup, {
        from: "settings",
        current: LEDGER_BASELINE_VERSIONS,
        appVersion: app.getVersion(),
      }),
      // The ordinary quit closes the ledger cleanly before the App starts again.
      restart: () => {
        app.relaunch();
        app.quit();
      },
      takeOutcome: () => takeLedgerRestoreOutcome(ledgerDataDir),
    },
  });
  const rendererUrl = RENDERER_URL;
  serveRenderer(protocol, path.join(appRoot, "build"));
  ipcRegistration = registerOctopusBeakIpc({
    automation,
    settings,
    spending: createSpendingDesktopService({ financial: operationalRuntime.worker.financial }),
    appUpdates: {
      view: appUpdateView,
      check: () => void appUpdater.check(),
      download: () => void appUpdater.download(),
      restart: () => appUpdater.restart(),
    },
    errorReports: {
      available: () => Boolean(errorReportUrl(USAGE_PING_URL)),
      preview: (input) => buildErrorReport(input, errorReportContext()),
      send: async (input: ErrorReportInput) => {
        try {
          return await sendErrorReport(errorReportUrl(USAGE_PING_URL), buildErrorReport(input, errorReportContext()));
        } catch (error) {
          if (error instanceof InvalidErrorReport) return { ok: false, reason: "invalid" } as const;
          throw error;
        }
      },
    },
    pgliteWorker: operationalRuntime.worker,
    pgliteFinancial: operationalRuntime.worker.financial,
    automationSettings,
    rendererUrl,
  });
  // Recovery owns the persisted active-run boundary: no schedule claims a run
  // until it is reconciled, while the shell and IPC go ahead meanwhile.
  services.startWhenReady(automationRuntimeReady);
  // Timers do not count time the Mac sleeps; read the clock again whenever it wakes.
  powerMonitor.on("resume", () => services.wake());
  powerMonitor.on("unlock-screen", () => services.wake());
  if (packagedBrowserFixture) {
    void automationRuntimeReady
      .then(async () => await runPackagedBrowserWorkerFixture(
        runtime,
        userData,
        process.env,
      ))
      .then((result) => {
        process.stdout.write(`${PACKAGED_BROWSER_FIXTURE_RESULT_PREFIX}${JSON.stringify(result)}\n`);
        app.quit();
      })
      .catch(() => {
        process.stdout.write(`${PACKAGED_BROWSER_FIXTURE_RESULT_PREFIX}{"status":"failed"}\n`);
        app.exit(1);
      });
    return;
  }
  currentRendererUrl = rendererUrl;
  currentPreloadPath = path.join(__dirname, "preload.cjs");
  if (automationRuntimeFatalHandled) return;
  await createWindow(currentRendererUrl, currentPreloadPath);
}

protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);
if (ownsUserData) app.whenReady().then(start).catch(showStartupError);

app.on("second-instance", () => {
  if (appQuitting || automationRuntimeFatalHandled || !currentRendererUrl || !currentPreloadPath) return;
  void createWindow(currentRendererUrl, currentPreloadPath)
    .then((window) => {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    })
    .catch(showStartupError);
});

app.on("activate", () => {
  if (automationRuntimeFatalHandled) return;
  if (BrowserWindow.getAllWindows().length === 0 && currentRendererUrl && currentPreloadPath) {
    void createWindow(currentRendererUrl, currentPreloadPath).catch(showStartupError);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
