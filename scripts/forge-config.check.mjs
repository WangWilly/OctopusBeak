import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsRoot);
const require = createRequire(import.meta.url);
const forgeConfig = require(join(repoRoot, "forge.config.cjs"));
const { populateIgnoredPaths, userPathFilter } = require("@electron/packager/dist/copy-filter.js");

function isIgnored(path) {
  const normalized = `/${path.replaceAll("\\", "/").replace(/^\/+/, "")}`;
  return forgeConfig.packagerConfig.ignore.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(normalized) : normalized.includes(pattern),
  );
}

test("Forge leaves local app data out of the installer", () => {
  for (const path of ["/data", "/data/ledger/ledger.sqlite"]) {
    assert.equal(isIgnored(path), true, `${path} must not enter the installer`);
  }
});

test("Forge leaves the development probes and local reports out of the installer", () => {
  for (const path of [
    "/scripts/tdcc-probe.mjs",
    "/scripts/esun-deposit-probe.ts",
    "/scripts/esun-deposit-probe",
    "/scripts/esun-deposit-probe/probe.ts",
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
