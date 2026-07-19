import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog } from "electron";
import {
  activeAutomationTaskIds,
  prepareLibrettoRunCdpPatch,
  recoverAbandonedAutomationSessions,
  shutdownAutomationSessions,
  startAutomationTask,
} from "../src/lib/automation/server/runner.ts";
import { readAutomationSettings } from "../src/lib/automation/server/settings.ts";
import { hasSuccessfulTaskRunSince } from "../src/lib/automation/server/store.ts";
import { systemSettings } from "../src/lib/settings/system-settings.ts";
import { openLedgerDatabase } from "../src/ledger/db/client.ts";
import { createBeforeQuitHandler } from "./automation-shutdown.ts";
import { registerAutomationCredentialSafeStorage } from "./credential-codec.ts";
import { createExchangeRateScheduler } from "./exchange-rate-scheduler.ts";
import { registerOctopusBeakIpc } from "./ipc.ts";
import { migrateLedgerBeforeWindow } from "./startup-ledger.ts";
import { integratedTitleBarOptions } from "./window-options.ts";
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

const devRemoteDebuggingPort = 9222;

if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", String(devRemoteDebuggingPort));
  console.info(`Electron remote debugging listening on port ${devRemoteDebuggingPort}`);
}

let mainWindow: BrowserWindow | null = null;
let createWindowPromise: Promise<BrowserWindow> | null = null;
let currentRendererUrl: string | null = null;
let currentPreloadPath: string | null = null;
let scheduler: ReturnType<typeof createExchangeRateScheduler> | null = null;

app.setName("OctopusBeak");
app.setPath("userData", process.env.OCTOPUSBEAK_USER_DATA || path.join(app.getPath("appData"), "OctopusBeak"));
const handleBeforeQuit = createBeforeQuitHandler({
  cleanup: () => {
    scheduler?.stop();
    return shutdownAutomationSessions();
  },
  quit: () => app.quit(),
  timeoutMs: 5_000,
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
  ensureDataRoot(userData);
  Object.assign(process.env, buildDesktopEnv({
    userData,
    appRoot,
    electronPath: process.execPath,
  }));
  process.chdir(userData);
  prepareLibrettoRunCdpPatch();
  migrateLedgerBeforeWindow();
  await recoverAbandonedAutomationSessions().catch((error) => {
    console.warn("automation-session-startup-recovery-failed", error);
  });
  registerAutomationCredentialSafeStorage();
  const ledgerDir = process.env.LEDGER_DIR ?? "data/ledger";
  scheduler = createExchangeRateScheduler({
    now: () => new Date(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
    readSettings: () => systemSettings(readAutomationSettings()),
    hasSuccessSince: (occurrenceUtc) => {
      const db = openLedgerDatabase(ledgerDir, { readOnly: true });
      try {
        return hasSuccessfulTaskRunSince(db, "exchange-rates", occurrenceUtc);
      } finally {
        db.close();
      }
    },
    isTaskActive: () => activeAutomationTaskIds().includes("exchange-rates"),
    startTask: (scheduledAtUtc) => {
      startAutomationTask("exchange-rates", ledgerDir, { scheduledAtUtc });
    },
    reportError: (error) => console.error("exchange-rate-scheduler-error", error),
  });
  registerOctopusBeakIpc({ onSystemSettingsChanged: scheduler.reschedule });
  scheduler.start();
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
