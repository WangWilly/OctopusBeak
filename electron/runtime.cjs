const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const defaultAutomationSettings = {
  AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
  LIBRETTO_CLOUD_FUBON_ENABLED: true,
  LIBRETTO_CLOUD_ESUN_ENABLED: true,
  LIBRETTO_CLOUD_YUANTA_ENABLED: true,
  LIBRETTO_CLOUD_YUANTA_TRADE_ENABLED: true,
  LIBRETTO_CLOUD_CATHAY_ENABLED: true,
  LIBRETTO_CLOUD_HNCB_ENABLED: true,
  MAX_ENABLED: true,
  MAX_SUB_ACCOUNT: "main",
};

function ensureDataRoot(userData) {
  fs.mkdirSync(path.join(userData, ".libretto"), { recursive: true });
  fs.mkdirSync(path.join(userData, "downloads"), { recursive: true });
  fs.mkdirSync(path.join(userData, "data", "ledger"), { recursive: true });
  fs.mkdirSync(path.join(userData, "data", "automation", "logs"), { recursive: true });

  const settingsPath = path.join(userData, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, `${JSON.stringify(defaultAutomationSettings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

function buildDesktopEnv({ userData, appRoot, port, electronPath = process.execPath }) {
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    ORIGIN: `http://127.0.0.1:${port}`,
    NODE_ENV: "production",
    LEDGER_DIR: path.join(userData, "data", "ledger"),
    OCTOPUSBEAK_DESKTOP: "1",
    OCTOPUSBEAK_APP_ROOT: appRoot,
    OCTOPUSBEAK_USER_DATA: userData,
    OCTOPUSBEAK_NODE_PATH: electronPath,
  };
  const playwrightBrowsersPath = path.join(appRoot, "node_modules", "playwright-core", ".local-browsers");
  if (fs.existsSync(playwrightBrowsersPath)) env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath;
  return env;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
          return;
        }
        reject(new Error("Could not allocate a local port."));
      });
    });
  });
}

function listenWithHandler(handler, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

module.exports = {
  buildDesktopEnv,
  ensureDataRoot,
  findFreePort,
  listenWithHandler,
};
