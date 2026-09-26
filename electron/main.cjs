const { existsSync } = require("node:fs");
const { join } = require("node:path");

// Playwright resolves its browser registry while the bundled main module loads.
// Point the App at the browsers shipped inside the desktop package first.
const bundledBrowsers = join(__dirname, "..", "node_modules", "playwright-core", ".local-browsers");
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(bundledBrowsers)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;
}
require("../build-electron/main.cjs");
