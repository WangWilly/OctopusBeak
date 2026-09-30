const { existsSync, lstatSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { app } = require("electron");

// Playwright reads this value while its module loads. Always prefer the browser
// shipped beside the App, even when the launching environment names a global cache.
const appRoot = join(__dirname, "..");
const playwrightRoot = join(appRoot, "node_modules", "playwright-core");
const bundledBrowsers = join(playwrightRoot, ".local-browsers");
let bundledShell;
try {
  const manifest = JSON.parse(readFileSync(join(playwrightRoot, "browsers.json"), "utf8"));
  const revision = manifest.browsers?.find((browser) => browser.name === "chromium-headless-shell")?.revision;
  if (typeof revision === "string" && /^\d+$/u.test(revision)) {
    bundledShell = join(bundledBrowsers, `chromium_headless_shell-${revision}`);
  }
} catch {
  bundledShell = undefined;
}
let hasBundledShell = false;
if (bundledShell && existsSync(bundledShell)) {
  try {
    const shellInfo = lstatSync(bundledShell);
    hasBundledShell = shellInfo.isDirectory() && !shellInfo.isSymbolicLink();
  } catch {
    hasBundledShell = false;
  }
}

if (hasBundledShell) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;
} else if (app.isPackaged) {
  throw new Error("Packaged Chromium headless-shell payload is unavailable.");
}
require("../build-electron/main.cjs");
