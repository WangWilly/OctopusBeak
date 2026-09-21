import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog } from "electron";
import {
  activeAutomationTaskIds,
  hydrateAutomationRuntimeState,
  prepareLibrettoRunCdpPatch,
  recoverAbandonedAutomationSessions,
  shutdownAutomationSessions,
  startAutomationTask,
  terminateAutomationTaskProcesses,
} from "../src/lib/automation/server/runner.ts";
import { readAutomationSettings } from "../src/lib/automation/server/settings.ts";
import { systemSettings } from "../src/lib/settings/system-settings.ts";
import { createBeforeQuitHandler } from "./automation-shutdown.ts";
import { registerAutomationCredentialSafeStorage } from "./credential-codec.ts";
import { createExchangeRateScheduler } from "./exchange-rate-scheduler.ts";
import { registerCathayGmailOtpElectronRuntime } from "./gmail-oauth.ts";
import { registerOctopusBeakIpc } from "./ipc.ts";
import { initializeCanonicalRuntimeBeforeWindow } from "./startup-ledger.ts";
import { integratedTitleBarOptions } from "./window-options.ts";
import { automationRuntimeState } from "../src/lib/automation/server/runtime-state.ts";
import { AutomationRuntimeInvariantError } from "../src/lib/automation/runtime-invariants.ts";
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

if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", String(devRemoteDebuggingPort));
  console.info(`Electron remote debugging listening on port ${devRemoteDebuggingPort}`);
}

let mainWindow: BrowserWindow | null = null;
let createWindowPromise: Promise<BrowserWindow> | null = null;
let currentRendererUrl: string | null = null;
let currentPreloadPath: string | null = null;
let scheduler: ReturnType<typeof createExchangeRateScheduler> | null = null;
let ipcRegistration: ReturnType<typeof registerOctopusBeakIpc> | null = null;
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
  terminateAutomationTaskProcesses();
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
    await Promise.all([
      ipcRegistration?.close(),
      activeAutomationTaskIds().length > 0
        ? shutdownAutomationSessions()
        : undefined,
    ]);
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
  Object.assign(process.env, buildDesktopEnv({
    userData,
    appRoot,
    electronPath: process.execPath,
  }));
  process.chdir(userData);
  registerAutomationCredentialSafeStorage();
  registerCathayGmailOtpElectronRuntime(appRoot);
  try {
    prepareLibrettoRunCdpPatch();
  } catch (error) {
    console.warn("libretto-run-cdp-patch-failed", error);
  }
  initializeCanonicalRuntimeBeforeWindow(userData);
  const ledgerDir = process.env.LEDGER_DIR ?? "data/ledger";
  // Reconcile abandoned execution rows off the shell's critical path. The
  // first authoritative automation snapshot awaits this same promise, so a
  // schema/recovery failure cannot be hidden by a partially hydrated UI.
  const automationRuntimeReady = new Promise<void>((resolve, reject) => {
    setImmediate(() => {
      recoverAbandonedAutomationSessions(ledgerDir)
        .then(() => hydrateAutomationRuntimeState(ledgerDir))
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
              statementFailures: [],
              logTail: "",
              errorMessage: null,
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
  if (!cdpFixture) {
    scheduler = createExchangeRateScheduler({
      now: () => new Date(),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
      readSettings: () => systemSettings(readAutomationSettings()),
      // Automation run history is financial legacy state. The unified sync
      // runner owns its operational status; until it is available, a scheduled
      // exchange-rate run is never suppressed by the retired ledger.
      hasSuccessSince: () => false,
      isTaskActive: () => activeAutomationTaskIds().includes("exchange-rates"),
      startTask: (scheduledAtUtc) => {
        startAutomationTask("exchange-rates", ledgerDir, { scheduledAtUtc });
      },
      reportError: (error) => console.error("exchange-rate-scheduler-error", error),
    });
  }
  ipcRegistration = registerOctopusBeakIpc({
    onSystemSettingsChanged: () => scheduler?.reschedule(),
    onAutomationRuntimeFatal: handleAutomationRuntimeFatal,
    onAutomationRuntimeReady: () => automationRuntimeReady,
  });
  scheduler?.start();
  currentRendererUrl = rendererEntry(appRoot);
  currentPreloadPath = path.join(__dirname, "preload.cjs");
  await createWindow(currentRendererUrl, currentPreloadPath);
}

app.whenReady().then(start).catch(showStartupError);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && currentRendererUrl && currentPreloadPath) {
    void createWindow(currentRendererUrl, currentPreloadPath).catch(showStartupError);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
