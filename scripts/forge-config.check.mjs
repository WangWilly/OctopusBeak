import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const mainSource = readFileSync(join(repoRoot, "electron/main.ts"), "utf8");

function isIgnored(path) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
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

test("Forge prePackage fails fast when the Desktop OAuth file is missing", () => {
  const temp = mkdtempSync(join(tmpdir(), "octopusbeak-forge-config-"));
  try {
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
