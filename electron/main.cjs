const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, dialog } = require("electron");
const {
  buildDesktopEnv,
  ensureDataRoot,
  listenWithHandler,
} = require("./runtime.cjs");

let server = null;
let mainWindow = null;
let createWindowPromise = null;

function projectRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, "app");
  return path.join(__dirname, "..");
}

async function startServer({ appRoot, userData }) {
  let handler = null;
  server = await listenWithHandler((request, response) => {
    if (handler) return handler(request, response);

    response.statusCode = 503;
    response.end("OctopusBeak is starting");
  }, 0);

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine desktop server port.");
  }

  const env = buildDesktopEnv({
    userData,
    appRoot,
    port: address.port,
    electronPath: process.execPath,
  });
  Object.assign(process.env, env);
  process.chdir(userData);

  const handlerUrl = pathToFileURL(path.join(appRoot, "build", "handler.js")).href;
  const imported = await import(handlerUrl);
  handler = imported.handler;
  return env.ORIGIN;
}

function isAllowedNavigation(targetUrl, origin) {
  try {
    return new URL(targetUrl).origin === origin;
  } catch {
    return false;
  }
}

function showStartupError(error) {
  dialog.showErrorBox(
    "OctopusBeak failed to start",
    error instanceof Error ? error.stack || error.message : String(error),
  );
  app.quit();
}

function guardWindowNavigation(window, origin) {
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedNavigation(targetUrl, origin)) event.preventDefault();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url, origin)) {
      void window.loadURL(url).catch(showStartupError);
    }
    return { action: "deny" };
  });
}

async function createWindow(origin) {
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
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    mainWindow = window;
    window.on("closed", () => {
      if (mainWindow === window) mainWindow = null;
    });
    guardWindowNavigation(window, origin);

    try {
      await window.loadURL(`${origin}/overview`);
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

async function start() {
  const userData = app.getPath("userData");
  const appRoot = projectRoot();
  ensureDataRoot(userData);
  const origin = await startServer({ appRoot, userData });
  await createWindow(origin);
}

app.whenReady().then(start).catch(showStartupError);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && process.env.ORIGIN) {
    void createWindow(process.env.ORIGIN).catch(showStartupError);
  }
});

app.on("before-quit", () => {
  if (server) server.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
