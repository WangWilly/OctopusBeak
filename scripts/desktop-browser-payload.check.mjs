import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptsRoot);
const require = createRequire(import.meta.url);
const {
  PLAYWRIGHT_BROWSER_ROOT,
  packagedBrowserArtifactIgnore,
  packagedHeadlessShellExecutable,
  readRequiredBrowserDirectories,
  pruneLocalBrowserPayload,
} = require(join(scriptsRoot, "desktop-browser-payload.cjs"));

test("required payload follows the installed Playwright manifest", () => {
  const required = readRequiredBrowserDirectories(projectRoot);
  assert.equal(required.length, 2);
  assert.match(required[0], /^chromium_headless_shell-\d+$/u);
  assert.match(required[1], /^ffmpeg-\d+$/u);
  assert.equal(packagedBrowserArtifactIgnore.test(`/node_modules/playwright-core/.local-browsers/${required[0]}/shell`), false);
  assert.equal(packagedBrowserArtifactIgnore.test(`/node_modules/playwright-core/.local-browsers/${required[1]}/ffmpeg`), false);
});

test("headless-shell executable resolution stays in the manifest payload on supported platforms", () => {
  const project = mkdtempSync(join(tmpdir(), "octopusbeak-shell-executable-"));
  try {
    const coreRoot = join(project, "node_modules", "playwright-core");
    mkdirSync(coreRoot, { recursive: true });
    writeFileSync(join(coreRoot, "package.json"), JSON.stringify({ name: "playwright-core", main: "index.js" }));
    writeFileSync(join(coreRoot, "index.js"), "module.exports = {};\n");
    writeFileSync(join(coreRoot, "browsers.json"), JSON.stringify({ browsers: [
      { name: "chromium-headless-shell", revision: "1234" },
      { name: "ffmpeg", revision: "1011" },
    ] }));

    const expected = [
      ["darwin", "x64", ["chrome-headless-shell-mac-x64", "chrome-headless-shell"]],
      ["darwin", "arm64", ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"]],
      ["linux", "x64", ["chrome-headless-shell-linux64", "chrome-headless-shell"]],
      ["linux", "arm64", ["chrome-linux", "headless_shell"]],
      ["win32", "x64", ["chrome-headless-shell-win64", "chrome-headless-shell.exe"]],
    ];
    for (const [platform, arch, executableParts] of expected) {
      assert.equal(
        packagedHeadlessShellExecutable(project, platform, arch),
        join(project, PLAYWRIGHT_BROWSER_ROOT, "chromium_headless_shell-1234", ...executableParts),
      );
    }
    assert.throws(() => packagedHeadlessShellExecutable(project, "win32", "arm64"), /unsupported/u);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("payload pruning removes local full engines and stale entries while keeping shell support", () => {
  const project = mkdtempSync(join(tmpdir(), "octopusbeak-browser-payload-"));
  try {
    const coreRoot = join(project, "node_modules", "playwright-core");
    const browserRoot = join(project, PLAYWRIGHT_BROWSER_ROOT);
    const developerCache = join(project, "developer-default-browser-cache");
    mkdirSync(coreRoot, { recursive: true });
    writeFileSync(join(coreRoot, "package.json"), JSON.stringify({ name: "playwright-core", main: "index.js" }));
    writeFileSync(join(coreRoot, "index.js"), "module.exports = {};\n");
    writeFileSync(join(coreRoot, "browsers.json"), JSON.stringify({ browsers: [
      { name: "chromium", revision: "1234" },
      { name: "chromium-headless-shell", revision: "1234" },
      { name: "ffmpeg", revision: "1011" },
      { name: "firefox", revision: "1538" },
      { name: "webkit", revision: "2336" },
    ] }));

    const expected = ["chromium_headless_shell-1234", "ffmpeg-1011"];
    const stale = ["chromium-1234", "firefox-1538", "webkit-2336", "chromium_headless_shell-9999", ".links"];
    for (const name of [...expected, ...stale]) {
      const directory = join(browserRoot, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "fixture-marker"), name);
    }
    mkdirSync(join(developerCache, "firefox-1538"), { recursive: true });
    writeFileSync(join(developerCache, "firefox-1538", "developer-cache-marker"), "keep");

    assert.deepEqual(pruneLocalBrowserPayload(project), expected);
    assert.deepEqual(readdirSync(browserRoot).sort(), expected);
    for (const name of expected) {
      assert.equal(readFileSync(join(browserRoot, name, "fixture-marker"), "utf8"), name);
    }
    for (const name of stale) assert.equal(readdirSync(browserRoot).includes(name), false);
    assert.equal(
      readFileSync(join(developerCache, "firefox-1538", "developer-cache-marker"), "utf8"),
      "keep",
      "pruning the project-local payload must not delete the developer default cache",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("payload pruning refuses to follow a project-local browser-root symlink", (context) => {
  const project = mkdtempSync(join(tmpdir(), "octopusbeak-browser-payload-link-"));
  try {
    const externalCache = join(project, "developer-default-browser-cache");
    const linkedRoot = join(project, PLAYWRIGHT_BROWSER_ROOT);
    mkdirSync(externalCache, { recursive: true });
    mkdirSync(dirname(linkedRoot), { recursive: true });
    writeFileSync(join(externalCache, "developer-cache-marker"), "keep");
    try {
      symlinkSync(externalCache, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        context.skip(`directory symlinks are unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(() => pruneLocalBrowserPayload(project), /must be a real directory/u);
    assert.equal(readFileSync(join(externalCache, "developer-cache-marker"), "utf8"), "keep");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
