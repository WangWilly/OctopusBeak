const fs = require("node:fs");
const path = require("node:path");

const PLAYWRIGHT_BROWSER_ROOT = path.join(
  "node_modules",
  "playwright-core",
  ".local-browsers",
);
const HEADLESS_SHELL_EXECUTABLES = Object.freeze({
  "darwin-x64": ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
  "darwin-arm64": ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
  "linux-x64": ["chrome-headless-shell-linux64", "chrome-headless-shell"],
  "linux-arm64": ["chrome-linux", "headless_shell"],
  "win32-x64": ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
});

function playwrightBrowserRoot(projectRoot) {
  return path.join(path.resolve(projectRoot), PLAYWRIGHT_BROWSER_ROOT);
}

function readRequiredBrowserDirectories(projectRoot) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const playwrightCoreEntry = require.resolve("playwright-core", {
    paths: [resolvedProjectRoot],
  });
  const manifestPath = path.join(path.dirname(playwrightCoreEntry), "browsers.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const descriptors = Array.isArray(manifest.browsers) ? manifest.browsers : [];

  const revisionFor = (name) => {
    const revision = descriptors.find((browser) => browser?.name === name)?.revision;
    if (typeof revision !== "string" || !/^\d+$/u.test(revision)) {
      throw new Error(`Playwright browser payload descriptor is missing: ${name}`);
    }
    return revision;
  };

  return [
    `chromium_headless_shell-${revisionFor("chromium-headless-shell")}`,
    `ffmpeg-${revisionFor("ffmpeg")}`,
  ];
}

function packagedHeadlessShellExecutable(projectRoot, platform = process.platform, arch = process.arch) {
  const pathParts = HEADLESS_SHELL_EXECUTABLES[`${platform}-${arch}`];
  if (!pathParts) {
    throw new Error(`Packaged Chromium headless-shell path is unsupported for ${platform}-${arch}.`);
  }
  const shellDirectory = readRequiredBrowserDirectories(projectRoot)
    .find((name) => name.startsWith("chromium_headless_shell-"));
  if (!shellDirectory) throw new Error("Packaged Chromium headless-shell payload is missing.");
  return path.join(playwrightBrowserRoot(projectRoot), shellDirectory, ...pathParts);
}

function createPackagedBrowserArtifactIgnore(projectRoot) {
  // Limit the installer to the exact payload revision paired with this
  // Playwright package, not merely any directory bearing a shell-like name.
  const allowedNames = readRequiredBrowserDirectories(projectRoot)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  return new RegExp(
    `^[/\\\\]node_modules[/\\\\]playwright-core[/\\\\]\\.local-browsers[/\\\\](?!(?:${allowedNames})(?:[/\\\\]|$))[^/\\\\]+(?:[/\\\\]|$)`,
    "u",
  );
}

// Keep the packager's source tree deterministic even when a developer's
// project-local browser cache contains engines left by older installs.
const packagedBrowserArtifactIgnore = createPackagedBrowserArtifactIgnore(path.resolve(__dirname, ".."));

function pruneLocalBrowserPayload(projectRoot) {
  const root = playwrightBrowserRoot(projectRoot);
  if (!fs.existsSync(root)) {
    throw new Error("Playwright project-local browser payload directory is missing.");
  }
  const rootInfo = fs.lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Playwright project-local browser payload must be a real directory.");
  }

  const required = new Set(readRequiredBrowserDirectories(projectRoot));
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (required.has(entry.name) && entry.isDirectory() && !entry.isSymbolicLink()) continue;
    fs.rmSync(fullPath, { recursive: true, force: true });
  }

  for (const name of required) {
    const fullPath = path.join(root, name);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
      throw new Error(`Required Playwright browser payload directory is missing: ${name}`);
    }
  }

  const remaining = fs.readdirSync(root).sort();
  if (remaining.length !== required.size || remaining.some((name) => !required.has(name))) {
    throw new Error("Playwright browser payload contains unexpected entries after pruning.");
  }
  return remaining;
}

module.exports = {
  PLAYWRIGHT_BROWSER_ROOT,
  packagedBrowserArtifactIgnore,
  createPackagedBrowserArtifactIgnore,
  playwrightBrowserRoot,
  readRequiredBrowserDirectories,
  packagedHeadlessShellExecutable,
  pruneLocalBrowserPayload,
};
