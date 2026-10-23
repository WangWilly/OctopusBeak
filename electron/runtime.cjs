const fs = require("node:fs");
const path = require("node:path");

function ensureDataRoot(userData, defaultSettings) {
  fs.mkdirSync(path.join(userData, "data"), { recursive: true });
  const settingsPath = path.join(userData, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify(defaultSettings, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
  }
}

function buildDesktopEnv({
  userData,
  appRoot,
  electronPath = process.execPath,
}) {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    OCTOPUSBEAK_DESKTOP: "1",
    OCTOPUSBEAK_APP_ROOT: appRoot,
    OCTOPUSBEAK_USER_DATA: userData,
    OCTOPUSBEAK_NODE_PATH: electronPath,
  };
  const playwrightBrowsersPath = path.join(
    appRoot,
    "node_modules",
    "playwright-core",
    ".local-browsers",
  );
  if (fs.existsSync(playwrightBrowsersPath))
    env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath;
  return env;
}

module.exports = {
  buildDesktopEnv,
  ensureDataRoot,
};
