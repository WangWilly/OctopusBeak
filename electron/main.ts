import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { app, autoUpdater, BrowserWindow, dialog, Notification, protocol, shell } from "electron";
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
import { deleteAllFinancialData } from "../src/lib/settings/data-erasure.ts";
import { deleteAllPreviewData } from "../src/lib/preview-sources/delete-preview-data.ts";
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
import { createAppWorkflowBrowserPort } from "../src/lib/automation/server/app-browser-host.ts";
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

function handleAutomationRuntimeFatal(details: {
  code: string;
  stage: string;
  sessionId?: string;
  revision?: number;
  taskId?: string;
  runId?: string | null;
}) {
  if (automationRuntimeFatalHandled) return;
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
    locale: app.getLocale().startsWith("zh") ? ("zh-TW" as const) : ("en" as const),
  };
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
  const notice = collectionNotification(results, trigger, app.getLocale().startsWith("zh") ? "zh-TW" : "en");
  if (!notice || !Notification.isSupported()) return;
  showNotification(notice, notice.target);
}

/** ADR 0083: one notification once an update has downloaded; the App never restarts by itself. */
function notifyUpdateReady(version: string) {
  if (appQuitting || !Notification.isSupported()) return;
  showNotification(
    appUpdateNotification(version, app.getLocale().startsWith("zh") ? "zh-TW" : "en"),
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
  const credentials = openSafeStorageCredentialStore(path.join(userData, AUTOMATION_CREDENTIALS_FILE));
  const automationSettings = createAutomationSettingsStore(path.join(userData, AUTOMATION_SETTINGS_FILE));
  migrateAutomationEnvFile({ envPath: path.join(userData, ".env"), settings: automationSettings, credentials });
  migrateStatementSelectionIds(automationSettings.path);
  const operationalRuntime = createPGliteOperationalRuntime({
    dataDir: path.join(userData, "data", "pglite"),
    activeRun: (taskRunId) => automationRuntime?.activeRun(taskRunId) ?? null,
    credentials,
    settings: automationSettings,
  });
  pgliteOperationalRuntime = operationalRuntime;
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
      runtime.recover()
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
  void automationRuntimeReady.catch((error) => {
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
    collection,
    credentials,
    settings: automationSettings,
    deviceRegistration: createDeviceRegistrationHost({
      tdcc: createTdccRegistrationService({
        store: createTdccSecretStore(credentials),
        ...(cdpTdccFixture ? { fetch: createTdccRegistrationFixtureFetch() } : {}),
      }),
      cathay: createCathayRegistrationService({
        store: createCathaySecretStore(credentials),
        withCathayTaskPage: (signal, run) => createAppWorkflowBrowserPort({
          taskId: DEVICE_REGISTRATION_TASK_IDS.cathay,
          taskRunId: `device-registration-${randomUUID()}`,
          signal,
          userDataDirectory: userData,
          credentialCodec: credentials.codec,
          browserProfile: "cathay-login",
        }).withPage(run),
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
    locale: () => app.getLocale().startsWith("zh") ? "zh-TW" : "en",
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
  const settings = createSettingsDesktopService({
    settingsFile: automationSettings,
    onSystemSettingsChanged: (settings) => services.settingsChanged(settings),
    usagePing: usagePinger,
    dataVersions: dataVersionStore,
    collection,
    preview: operationalRuntime.provider.preview,
    financial: { reset: () => operationalRuntime.worker.financial.request("financial.canonical.reset", []) },
    deleteAllPreviewData,
    deleteAllFinancialData,
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
app.whenReady().then(start).catch(showStartupError);

app.on("activate", () => {
  if (automationRuntimeFatalHandled) return;
  if (BrowserWindow.getAllWindows().length === 0 && currentRendererUrl && currentPreloadPath) {
    void createWindow(currentRendererUrl, currentPreloadPath).catch(showStartupError);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
