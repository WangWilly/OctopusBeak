import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const playwrightCli = join(projectRoot, "node_modules", "playwright", "cli.js");

const installEnvironment = Object.fromEntries([
  "PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "SYSTEMROOT", "WINDIR",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "CI",
].flatMap((name) => typeof process.env[name] === "string" ? [[name, process.env[name]]] : []));

if (!existsSync(playwrightCli)) {
  throw new Error("Install npm dependencies before preparing the desktop browser payload.");
}

const result = spawnSync(
  process.execPath,
  [playwrightCli, "install", "chromium", "--only-shell"],
  {
    cwd: projectRoot,
    env: { ...installEnvironment, PLAYWRIGHT_BROWSERS_PATH: "0" },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Playwright headless-shell installation failed with status ${result.status ?? "unknown"}.`);
}

const { pruneLocalBrowserPayload, readRequiredBrowserDirectories } = require(
  join(projectRoot, "scripts", "desktop-browser-payload.cjs"),
);
const payload = pruneLocalBrowserPayload(projectRoot);
const required = readRequiredBrowserDirectories(projectRoot);
if (payload.length !== required.length || payload.some((name, index) => name !== required[index])) {
  throw new Error("Prepared browser payload differs from the installed Playwright runtime.");
}

console.log("Prepared production browser payload: Chromium headless shell and FFmpeg support only.");
