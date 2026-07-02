const fs = require("node:fs");
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

function buildDesktopEnv({ userData, appRoot, electronPath = process.execPath }) {
  const env = {
    ...process.env,
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

module.exports = {
  buildDesktopEnv,
  ensureDataRoot,
};
