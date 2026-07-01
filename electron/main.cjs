const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, dialog } = require("electron");
const {
  buildDesktopEnv,
  ensureDataRoot,
  findFreePort,
  listenWithHandler,
} = require("./runtime.cjs");

let server = null;
let mainWindow = null;

function projectRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, "app");
  return path.join(__dirname, "..");
}

async function startServer({ appRoot, userData }) {
  const port = await findFreePort();
  const env = buildDesktopEnv({
    userData,
    appRoot,
    port,
    electronPath: process.execPath,
  });
  Object.assign(process.env, env);
  process.chdir(userData);

  const handlerUrl = pathToFileURL(path.join(appRoot, "build", "handler.js")).href;
  const { handler } = await import(handlerUrl);
  server = await listenWithHandler(handler, port);
  return env.ORIGIN;
}

async function createWindow(origin) {
  mainWindow = new BrowserWindow({
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

  await mainWindow.loadURL(`${origin}/overview`);
}

async function start() {
  const userData = app.getPath("userData");
  const appRoot = projectRoot();
  ensureDataRoot(userData);
  const origin = await startServer({ appRoot, userData });
  await createWindow(origin);
}

app.whenReady().then(start).catch((error) => {
  dialog.showErrorBox(
    "OctopusBeak failed to start",
    error instanceof Error ? error.stack || error.message : String(error),
  );
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && process.env.ORIGIN) {
    void createWindow(process.env.ORIGIN);
  }
});

app.on("before-quit", () => {
  if (server) server.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
