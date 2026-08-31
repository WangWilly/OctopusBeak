import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const generator = resolve(root, "scripts/create-google-oauth-config.mjs");
const releaseWorkflow = readFileSync(resolve(root, ".github/workflows/release-electron.yml"), "utf8");

test("release workflow requires and materializes both Google OAuth secrets", () => {
  assert.match(releaseWorkflow, /GOOGLE_OAUTH_DESKTOP_CLIENT_ID:\s*\$\{\{\s*secrets\.GOOGLE_OAUTH_DESKTOP_CLIENT_ID\s*\}\}/);
  assert.match(releaseWorkflow, /GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET:\s*\$\{\{\s*secrets\.GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET\s*\}\}/);
  assert.match(releaseWorkflow, /missing\+=\(GOOGLE_OAUTH_DESKTOP_CLIENT_ID\)/);
  assert.match(releaseWorkflow, /missing\+=\(GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET\)/);
  assert.match(releaseWorkflow, /node scripts\/create-google-oauth-config\.mjs/);
  assert.match(releaseWorkflow, /npm run desktop:make:signed[\s\S]*?Remove temporary Google OAuth client config/);
  assert.match(releaseWorkflow, /Remove temporary Google OAuth client config\n\s+if:\s+always\(\)/);
  assert.match(releaseWorkflow, /rm -f -- data\/google-oauth\/google-oauth-desktop-client\.json/);
  const generatedIndex = releaseWorkflow.indexOf("node scripts/create-google-oauth-config.mjs");
  const buildIndex = releaseWorkflow.indexOf("npm run desktop:make:signed");
  const cleanupIndex = releaseWorkflow.indexOf("- name: Remove temporary Google OAuth client config");
  assert.ok(generatedIndex >= 0 && generatedIndex < buildIndex, "OAuth config must be generated before packaging");
  assert.ok(buildIndex < cleanupIndex, "OAuth config cleanup must follow packaging");
});

test("OAuth config generator writes the minimal installed client with owner-only permissions", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "octopusbeak-google-oauth-config-"));
  const output = join(fixtureRoot, "nested", "google-oauth-desktop-client.json");
  const clientId = "test-desktop-client-id";
  const clientSecret = "test-desktop-client-secret[1]";
  try {
    const child = spawnSync(process.execPath, [generator, "--output", output], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GOOGLE_OAUTH_DESKTOP_CLIENT_ID: clientId,
        GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET: clientSecret,
      },
    });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.equal(child.stdout.includes(clientId), false);
    assert.equal(child.stdout.includes(clientSecret), false);
    assert.equal(child.stderr.includes(clientId), false);
    assert.equal(child.stderr.includes(clientSecret), false);

    const config = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(config, {
      installed: {
        client_id: clientId,
        client_secret: clientSecret,
        auth_uri: "https://accounts.google.com/o/oauth2/v2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        redirect_uris: ["http://127.0.0.1"],
      },
    });
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("OAuth config generator rejects missing or malformed secret inputs without creating a file", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "octopusbeak-google-oauth-invalid-"));
  const output = join(fixtureRoot, "google-oauth-desktop-client.json");
  try {
    const missing = spawnSync(process.execPath, [generator, "--output", output], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GOOGLE_OAUTH_DESKTOP_CLIENT_ID: "", GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET: "secret" },
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /GOOGLE_OAUTH_DESKTOP_CLIENT_ID is required/);
    assert.equal(missing.stderr.includes("secret"), false);

    const malformed = spawnSync(process.execPath, [generator, "--output", output], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GOOGLE_OAUTH_DESKTOP_CLIENT_ID: "client\nwith-newline",
        GOOGLE_OAUTH_DESKTOP_CLIENT_SECRET: "secret",
      },
    });
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /GOOGLE_OAUTH_DESKTOP_CLIENT_ID must not contain control characters/);
    assert.equal(malformed.stderr.includes("secret"), false);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
