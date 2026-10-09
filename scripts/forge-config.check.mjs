import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CATHAY_GMAIL_OAUTH_CONFIG_RELATIVE_PATH } from "../src/lib/automation/server/gmail-otp-service.ts";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsRoot);
const require = createRequire(import.meta.url);
const forgeConfig = require(join(repoRoot, "forge.config.cjs"));
const { populateIgnoredPaths, userPathFilter } = require("@electron/packager/dist/copy-filter.js");
const mainSource = readFileSync(join(repoRoot, "electron/main.ts"), "utf8");

function isIgnored(path) {
  const normalized = `/${path.replaceAll("\\", "/").replace(/^\/+/, "")}`;
  return forgeConfig.packagerConfig.ignore.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(normalized) : normalized.includes(pattern),
  );
}

test("Forge keeps only the exact Desktop OAuth file under packaged app/data", () => {
  assert.equal(CATHAY_GMAIL_OAUTH_CONFIG_RELATIVE_PATH, "data/google-oauth/google-oauth-desktop-client.json");
  assert.equal(join("app", CATHAY_GMAIL_OAUTH_CONFIG_RELATIVE_PATH), "app/data/google-oauth/google-oauth-desktop-client.json");
  assert.equal(typeof forgeConfig.hooks?.prePackage, "function");
  assert.equal(isIgnored("/data/google-oauth/google-oauth-desktop-client.json"), false);
  assert.equal(isIgnored("/data/google-oauth/other-client.json"), true);
  assert.equal(isIgnored("/data/ledger/ledger.sqlite"), true);
  assert.equal(isIgnored("/data"), false);
  assert.equal(isIgnored("/data/google-oauth"), false);
  assert.ok(
    mainSource.indexOf("registerAutomationCredentialSafeStorage();") <
      mainSource.indexOf("registerCathayGmailOtpElectronRuntime(appRoot);"),
    "safeStorage must be registered before Gmail service configuration",
  );
});

test("Forge leaves the development TDCC probe and local reports out of the installer", () => {
  for (const path of [
    "/scripts/tdcc-probe.mjs",
    "/scripts/tdcc-probe",
    "/scripts/tdcc-probe/probe.ts",
    "/reports",
    "/reports/tdcc-probe/session-log.jsonl",
  ]) {
    assert.equal(isIgnored(path), true, `${path} must not enter the installer`);
  }
  assert.equal(isIgnored("/scripts/desktop-browser-payload.cjs"), false);
  assert.equal(isIgnored("/src/workflows/tdcc-epassbook-client.ts"), false);
});

test("Forge keeps only Chromium headless-shell and FFmpeg payload directories", () => {
  const localBrowserRoot = "/node_modules/playwright-core/.local-browsers";
  for (const relativePath of [
    `${localBrowserRoot}/chromium-1234/chrome-mac/Chromium.app`,
    `${localBrowserRoot}/firefox-1538/firefox/firefox`,
    `${localBrowserRoot}/webkit-2336/pw_run.sh`,
    `${localBrowserRoot}/chromium_headless_shell-9999/stale-shell`,
    `${localBrowserRoot}/.links`,
  ]) {
    assert.equal(isIgnored(relativePath), true, `${relativePath} must not enter the installer`);
  }
  assert.equal(isIgnored(`${localBrowserRoot}/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64`), false);
  assert.equal(isIgnored(`${localBrowserRoot}/ffmpeg-1011/ffmpeg-mac`), false);
  assert.equal(isIgnored(localBrowserRoot), false, "Forge must still descend into the local browser root");
  const windowsPath = "\\node_modules\\playwright-core\\.local-browsers\\firefox-1538\\firefox.exe";
  assert.ok(
    forgeConfig.packagerConfig.ignore.some((pattern) => pattern instanceof RegExp && pattern.test(windowsPath)),
    "Windows path separators must not bypass the exclusion",
  );
});

test("Electron Packager's copy filter keeps the exact shell payload from a residue fixture", async () => {
  const temp = mkdtempSync(join(tmpdir(), "octopusbeak-packager-browser-fixture-"));
  try {
    const appRoot = join(temp, "source");
    const browserRoot = join(appRoot, "node_modules", "playwright-core", ".local-browsers");
    const kept = ["chromium_headless_shell-1234", "ffmpeg-1011"];
    const excluded = ["chromium-1234", "firefox-1538", "webkit-2336", "chromium_headless_shell-9999", ".links"];
    for (const name of [...kept, ...excluded]) {
      const directory = join(browserRoot, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "fixture-file"), name);
    }

    const options = {
      dir: appRoot,
      out: join(temp, "out"),
      name: "OctopusBeak",
      platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux",
      arch: process.arch === "arm64" ? "arm64" : "x64",
      ignore: forgeConfig.packagerConfig.ignore,
      prune: false,
      junk: false,
    };
    populateIgnoredPaths(options);
    const include = await userPathFilter(options);
    assert.equal(await include(browserRoot), true, "Packager must descend into the browser root");
    for (const name of kept) {
      assert.equal(await include(join(browserRoot, name)), true, `${name} directory should be packaged`);
      assert.equal(await include(join(browserRoot, name, "fixture-file")), true, `${name} runtime asset should be packaged`);
    }
    for (const name of excluded) {
      assert.equal(await include(join(browserRoot, name)), false, `${name} residue must be excluded`);
      assert.equal(await include(join(browserRoot, name, "fixture-file")), false, `${name} contents must be excluded`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Forge prePackage fails fast when the Desktop OAuth file is missing", () => {
  const temp = mkdtempSync(join(tmpdir(), "octopusbeak-forge-config-"));
  try {
    mkdirSync(join(temp, "scripts"), { recursive: true });
    copyFileSync(
      join(repoRoot, "scripts", "desktop-browser-payload.cjs"),
      join(temp, "scripts", "desktop-browser-payload.cjs"),
    );
    const fakeCore = join(temp, "node_modules", "playwright-core");
    mkdirSync(fakeCore, { recursive: true });
    copyFileSync(join(repoRoot, "node_modules", "playwright-core", "package.json"), join(fakeCore, "package.json"));
    copyFileSync(join(repoRoot, "node_modules", "playwright-core", "browsers.json"), join(fakeCore, "browsers.json"));
    writeFileSync(join(fakeCore, "index.js"), "module.exports = {};\n");
    const configPath = join(temp, "forge.config.cjs");
    writeFileSync(configPath, readFileSync(join(repoRoot, "forge.config.cjs")));
    const child = spawnSync(process.execPath, [
      "-e",
      `const config = require(${JSON.stringify(configPath)}); config.hooks.prePackage(config, "darwin", "arm64");`,
    ], { encoding: "utf8" });
    assert.notEqual(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stderr, /Desktop Google OAuth client config is required for packaging/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Forge DMG uses the OctopusBeak volume icon and branded drag-to-install window", () => {
  const dmg = forgeConfig.makers.find((maker) => maker.name === "@electron-forge/maker-dmg").config;
  assert.equal(dmg.icon, forgeConfig.packagerConfig.icon + ".icns");
  for (const asset of [dmg.icon, dmg.background, dmg.background.replace(/\.png$/, "@2x.png")]) {
    assert.ok(statSync(join(repoRoot, asset)).isFile(), `${asset} must exist`);
  }
  const contents = dmg.contents({ appPath: "/tmp/OctopusBeak.app" });
  assert.deepEqual(contents.map(({ type, path }) => [type, path]), [
    ["file", "/tmp/OctopusBeak.app"],
    ["link", "/Applications"],
    ["position", ".background"],
    ["position", ".VolumeIcon.icns"],
  ]);
});
