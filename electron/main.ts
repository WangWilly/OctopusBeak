import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog } from "electron";
import {
  activeAutomationTaskIds,
  hydrateAutomationRuntimeState,
  recoverInterruptedAutomationRuns,
  shutdownAppAutomationWorkflows,
  startAutomationTask,
  abortActiveAppWorkflowExecutions,
} from "../src/lib/automation/server/runner.ts";
import { readAutomationSettings } from "../src/lib/automation/server/settings.ts";
import { startBrowserStateCleanup } from "../src/lib/automation/browser-state-retention.ts";
import { startWorkflowRunEventCleanup } from "../src/lib/automation/workflow-run-events.ts";
import { systemSettings } from "../src/lib/settings/system-settings.ts";
import { createBeforeQuitHandler } from "./automation-shutdown.ts";
import { registerAutomationCredentialSafeStorage } from "./credential-codec.ts";
import { createExchangeRateScheduler } from "./exchange-rate-scheduler.ts";
import { registerCathayGmailOtpElectronRuntime } from "./gmail-oauth.ts";
import { registerOctopusBeakIpc } from "./ipc.ts";
import { integratedTitleBarOptions } from "./window-options.ts";
import { automationRuntimeState } from "../src/lib/automation/server/runtime-state.ts";
import { AutomationRuntimeInvariantError } from "../src/lib/automation/runtime-invariants.ts";
import {
  createPGliteOperationalRuntime,
  type PGliteOperationalRuntime,
} from "./pglite-runtime.ts";
import {
  createPGliteFinancialPageClient,
} from "./pglite-financial-registry.ts";
import { configuredOverviewSources } from "../src/lib/overview/server/expected-sources.ts";
import {
  PACKAGED_BROWSER_FIXTURE_RESULT_PREFIX,
  packagedBrowserFixtureEnabled,
} from "../src/lib/automation/server/packaged-browser-fixture.ts";
import { runPackagedBrowserWorkerFixture } from "./packaged-browser-worker-fixture.ts";
// @ts-expect-error runtime.cjs is bundled by Vite; keeping it CJS avoids changing the packaged entry.
import runtime from "./runtime.cjs";

const { buildDesktopEnv, ensureDataRoot } = runtime as {
  buildDesktopEnv: (options: {
    userData: string;
    appRoot: string;
    electronPath?: string;
  }) => NodeJS.ProcessEnv;
  ensureDataRoot: (userData: string) => void;
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
let scheduler: ReturnType<typeof createExchangeRateScheduler> | null = null;
let stopBrowserStateCleanup: (() => void) | null = null;
let stopWorkflowRunEventCleanup: (() => void) | null = null;
let ipcRegistration: ReturnType<typeof registerOctopusBeakIpc> | null = null;
let pgliteOperationalRuntime: PGliteOperationalRuntime | null = null;
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
  abortActiveAppWorkflowExecutions();
  // A fatal invariant must retain exit status 1 without waiting for normal
  // before-quit cleanup or a CDP connection to finish closing.
  app.removeListener("before-quit", handleBeforeQuit);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  app.exit(1);
}

app.setName("OctopusBeak");
app.setPath("userData", process.env.OCTOPUSBEAK_USER_DATA || path.join(app.getPath("appData"), "OctopusBeak"));
process.env.OCTOPUSBEAK_SPEECH_MODEL_DIR = path.join(
  projectRoot(),
  "src",
  "lib",
  "automation",
  "server",
  "models",
  "sherpa-onnx-paraformer-zh-small",
);
const handleBeforeQuit = createBeforeQuitHandler({
  cleanup: async () => {
    scheduler?.stop();
    stopBrowserStateCleanup?.();
    stopWorkflowRunEventCleanup?.();
    await ipcRegistration?.close();
    if (activeAutomationTaskIds().length > 0) {
      if (!pgliteOperationalRuntime) {
        throw new Error("PGlite automation provider is unavailable during shutdown.");
      }
      await shutdownAppAutomationWorkflows(pgliteOperationalRuntime.provider);
    }
    await pgliteOperationalRuntime?.close();
  },
  quit: () => app.quit(),
});
app.on("before-quit", handleBeforeQuit);

function projectRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, "app");
  return path.join(__dirname, "..");
}

function rendererEntry(appRoot: string) {
  return pathToFileURL(path.join(appRoot, "build", "index.html")).href;
}

function isAllowedNavigation(targetUrl: string, rendererUrl: string) {
  try {
    const target = new URL(targetUrl);
    const renderer = new URL(rendererUrl);
    return target.origin === renderer.origin && target.pathname === renderer.pathname;
  } catch {
    return false;
  }
}

function guardWindowNavigation(window: BrowserWindow, rendererUrl: string) {
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedNavigation(targetUrl, rendererUrl)) event.preventDefault();
  });

  window.webContents.on("will-redirect", (event, targetUrl) => {
    if (!isAllowedNavigation(targetUrl, rendererUrl)) event.preventDefault();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url, rendererUrl)) {
      void window.loadURL(url).catch(showStartupError);
    }
    return { action: "deny" };
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

async function start() {
  const userData = app.getPath("userData");
  const appRoot = projectRoot();
  const cdpFixture = process.env.OCTOPUSBEAK_CDP_FIXTURE === "171";
  ensureDataRoot(userData);
  stopBrowserStateCleanup = startBrowserStateCleanup({
    directory: path.join(userData, "data", "automation", "browser-state"),
    isActive: (name) => activeAutomationTaskIds().includes(name),
    onError: () => console.error("browser-state-cleanup-failed"),
  });
  Object.assign(process.env, buildDesktopEnv({
    userData,
    appRoot,
    electronPath: process.execPath,
  }));
  process.chdir(userData);
  const operationalRuntime = createPGliteOperationalRuntime({
    dataDir: path.join(userData, "data", "pglite"),
  });
  pgliteOperationalRuntime = operationalRuntime;
  registerAutomationCredentialSafeStorage();
  registerCathayGmailOtpElectronRuntime(appRoot);
  // Reconcile abandoned execution rows off the shell's critical path. The
  // first authoritative automation snapshot awaits this same promise, so a
  // schema/recovery failure cannot be hidden by a partially hydrated UI.
  const automationRuntimeReady = new Promise<void>((resolve, reject) => {
    setImmediate(() => {
      recoverInterruptedAutomationRuns(operationalRuntime.provider)
        .then(() => hydrateAutomationRuntimeState(operationalRuntime.provider))
        .then(() => {
          // This is an isolated Electron regression seam. It is only active
          // for the disposable CDP fixture and lets the fatal invariant be
          // exercised without seeding or touching a user's ledger.
          if (
            cdpFixture
            && unknownActiveRuntimeFixture
          ) {
            automationRuntimeState.upsert({
              taskId: "unknown-cdp-active-task",
              runId: "unknown-cdp-run",
              status: "running",
              attempt: 1,
              maxAttempts: 1,
              progress: {
                phaseCode: "fixture",
                completed: 0,
                total: 1,
                percent: 0,
                attempt: 1,
              },
              appWorkflowOutcome: null,
              updatedAt: new Date().toISOString(),
            });
          }
        })
        .then(() => resolve())
        .catch(reject);
    });
  });
  void automationRuntimeReady.catch((error) => {
    const invariant = error instanceof AutomationRuntimeInvariantError
      ? error.details
      : null;
    handleAutomationRuntimeFatal({
      code: invariant?.code ?? "automation-runtime-snapshot-failed",
      stage: "startup-reconcile",
      ...(invariant
        ? {
          sessionId: invariant.sessionId,
          revision: invariant.revision,
          taskId: invariant.taskId,
          runId: invariant.runId,
        }
        : {}),
    });
  });
  if (!cdpFixture && !packagedBrowserFixture) {
    scheduler = createExchangeRateScheduler({
      now: () => new Date(),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
      readSettings: () => systemSettings(readAutomationSettings()),
      hasOccurrenceBeenAttempted: (occurrenceUtc) =>
        operationalRuntime.provider.automation.hasOccurrenceBeenAttempted(
          "exchange-rates",
          occurrenceUtc,
        ),
      hasSuccessSince: (occurrenceUtc) => operationalRuntime.provider.automation.hasSuccessfulTaskRunSince(
        "exchange-rates",
        occurrenceUtc,
      ),
      isTaskActive: () => activeAutomationTaskIds().includes("exchange-rates"),
      startTask: (scheduledAtUtc) => {
        return startAutomationTask(
          "exchange-rates",
          operationalRuntime.provider,
          { scheduledAtUtc },
        ).then(() => undefined);
      },
      reportError: (error) => console.error("exchange-rate-scheduler-error", error),
    });
  }
  ipcRegistration = registerOctopusBeakIpc({
    onSystemSettingsChanged: () => scheduler?.reschedule(),
    onAutomationRuntimeFatal: handleAutomationRuntimeFatal,
    onAutomationRuntimeReady: () => automationRuntimeReady,
    pgliteViews: {
      dataDir: operationalRuntime.dataDir,
    },
    pgliteOperational: {
      provider: operationalRuntime.provider,
      worker: operationalRuntime.worker,
      dataDir: operationalRuntime.dataDir,
    },
    pgliteFinancial: createPGliteFinancialPageClient(
      operationalRuntime.worker.financial,
      operationalRuntime.worker.subscribe,
      configuredOverviewSources,
    ),
  });
  // Recovery owns the persisted active-run boundary.  Do not let the
  // scheduler claim a new run until that boundary has been reconciled; the
  // shell and IPC registration still proceed while recovery is in flight.
  void automationRuntimeReady.then(() => {
    stopWorkflowRunEventCleanup = startWorkflowRunEventCleanup(
      operationalRuntime.provider.automation,
      { onError: () => console.error("workflow-run-event-cleanup-failed") },
    );
    scheduler?.start();
  }).catch(() => {
    // The shared readiness rejection already reports the fatal runtime error.
  });
  if (packagedBrowserFixture) {
    void automationRuntimeReady
      .then(async () => await runPackagedBrowserWorkerFixture(
        operationalRuntime.provider,
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
  currentRendererUrl = rendererEntry(appRoot);
  currentPreloadPath = path.join(__dirname, "preload.cjs");
  if (automationRuntimeFatalHandled) return;
  await createWindow(currentRendererUrl, currentPreloadPath);
}

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
