import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AUTOMATION_CREDENTIALS_FORMAT,
  AUTOMATION_CREDENTIALS_PATH,
  AUTOMATION_SETTINGS_PATH,
  automationConfigEnv,
  credentialStatusFromValues,
  migrateAutomationCredentialsFileEncryption,
  migrateAutomationEnvFile,
  readAutomationCredentialsFile,
  readAutomationSettingsFile,
  setAutomationCredentialCodec,
  settingsToEnv,
  splitAutomationUpdates,
  writeAutomationCredentialsFile,
  writeAutomationSettingsFile,
} from "./config-files.ts";
import { AUTOMATION_ENV_PATH } from "./settings.ts";

const dir = mkdtempSync(join(tmpdir(), "octopusbeak-config-"));
const fubonPasswordKey = "LIBRETTO_CLOUD_FUBON" + "_PASSWORD";
const maxSecretKey = "MAX_SECRET" + "_KEY";

try {
  const settingsPath = join(dir, "settings.json");
  const credentialsPath = join(dir, "credentials.json");
  const envPath = join(dir, ".env");
  const envLocalPath = join(dir, ".env.local");

  writeAutomationSettingsFile(settingsPath, {
    SYSTEM_TIMEZONE: "Asia/Taipei",
    EXCHANGE_RATE_UPDATE_TIME: "06:00",
    LIBRETTO_CLOUD_FUBON_ENABLED: false,
    MAX_SUB_ACCOUNT: "main",
  });
  writeAutomationCredentialsFile(credentialsPath, {
    [fubonPasswordKey]: "secret",
    [maxSecretKey]: "max-secret",
  });

  assert.deepEqual(readAutomationSettingsFile(settingsPath), {
    SYSTEM_TIMEZONE: "Asia/Taipei",
    EXCHANGE_RATE_UPDATE_TIME: "06:00",
    LIBRETTO_CLOUD_FUBON_ENABLED: false,
    MAX_SUB_ACCOUNT: "main",
  });
  assert.deepEqual(readAutomationCredentialsFile(credentialsPath), {
    [fubonPasswordKey]: "secret",
    [maxSecretKey]: "max-secret",
  });
  assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);

  assert.deepEqual(settingsToEnv({
    LIBRETTO_CLOUD_FUBON_ENABLED: false,
    MAX_SUB_ACCOUNT: "main",
  }), {
    LIBRETTO_CLOUD_FUBON_ENABLED: "false",
    MAX_SUB_ACCOUNT: "main",
  });

  assert.deepEqual(splitAutomationUpdates({
    SYSTEM_TIMEZONE: "Asia/Tokyo",
    EXCHANGE_RATE_UPDATE_TIME: "07:30",
    LIBRETTO_CLOUD_FUBON_ENABLED: "true",
    [fubonPasswordKey]: "pw",
    MAX_SUB_ACCOUNT: "main",
  }), {
    settings: {
      SYSTEM_TIMEZONE: "Asia/Tokyo",
      EXCHANGE_RATE_UPDATE_TIME: "07:30",
      LIBRETTO_CLOUD_FUBON_ENABLED: true,
      MAX_SUB_ACCOUNT: "main",
    },
    credentials: {
      [fubonPasswordKey]: "pw",
    },
  });

  assert.deepEqual(
    credentialStatusFromValues(
      { [fubonPasswordKey]: "pw" },
      [fubonPasswordKey, maxSecretKey],
    ),
    {
      [fubonPasswordKey]: true,
      [maxSecretKey]: false,
    },
  );

  writeFileSync(envPath, [
    "# keep",
    "LIBRETTO_CLOUD_FUBON_ENABLED=false",
    `${fubonPasswordKey}=legacy-pw`,
    "MAX_SUB_ACCOUNT=sub",
    "UNKNOWN=value",
    "",
  ].join("\n"));
  writeFileSync(envLocalPath, `${fubonPasswordKey}=dev-only\n`);

  migrateAutomationEnvFile({ envPath, settingsPath, credentialsPath });
  assert.deepEqual(readAutomationSettingsFile(settingsPath), {
    SYSTEM_TIMEZONE: "Asia/Taipei",
    EXCHANGE_RATE_UPDATE_TIME: "06:00",
    LIBRETTO_CLOUD_FUBON_ENABLED: false,
    MAX_SUB_ACCOUNT: "main",
  });
  assert.deepEqual(readAutomationCredentialsFile(credentialsPath), {
    [fubonPasswordKey]: "secret",
    [maxSecretKey]: "max-secret",
  });
  assert.equal(readFileSync(envPath, "utf8"), "# keep\nUNKNOWN=value\n");
  assert.equal(readFileSync(envLocalPath, "utf8"), `${fubonPasswordKey}=dev-only\n`);

  assert.deepEqual(automationConfigEnv({
    baseEnv: { KEEP_ME: "yes", NODE_ENV: "production" },
    settings: { LIBRETTO_CLOUD_FUBON_ENABLED: true },
    credentials: { [fubonPasswordKey]: "pw" },
  }), {
    KEEP_ME: "yes",
    NODE_ENV: "development",
    LIBRETTO_CLOUD_FUBON_ENABLED: "true",
    [fubonPasswordKey]: "pw",
  });

  assert.equal(AUTOMATION_SETTINGS_PATH, "settings.json");
  assert.equal(AUTOMATION_CREDENTIALS_PATH, "credentials.json");
  assert.equal(AUTOMATION_ENV_PATH, ".env");

  const importCwd = join(dir, "import-cwd");
  const runtimeCwd = join(dir, "runtime-cwd");
  mkdirSync(importCwd);
  mkdirSync(runtimeCwd);
  const configModuleUrl = pathToFileURL(join(process.cwd(), "src/lib/automation/server/config-files.ts")).href;
  const child = spawnSync(process.execPath, [
    "--no-warnings",
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `
      const mod = await import(${JSON.stringify(configModuleUrl)});
      process.chdir(${JSON.stringify(runtimeCwd)});
      const passwordKey = "LIBRETTO_CLOUD_FUBON" + "_PASSWORD";
      mod.writeAutomationSettings({ MAX_SUB_ACCOUNT: "runtime" });
      mod.writeAutomationCredentials({ [passwordKey]: "runtime-pw" });
    `,
  ], {
    cwd: importCwd,
    encoding: "utf8",
  });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.deepEqual(readAutomationSettingsFile(join(runtimeCwd, "settings.json")), {
    MAX_SUB_ACCOUNT: "runtime",
  });
  assert.deepEqual(readAutomationCredentialsFile(join(runtimeCwd, "credentials.json")), {
    [fubonPasswordKey]: "runtime-pw",
  });
  assert.equal(existsSync(join(importCwd, "settings.json")), false);
  assert.equal(existsSync(join(importCwd, "credentials.json")), false);

  const fakeCodec = {
    encrypt(text: string) {
      return Buffer.from(`safe:${text}`, "utf8").toString("base64");
    },
    decrypt(payload: string) {
      const text = Buffer.from(payload, "base64").toString("utf8");
      if (!text.startsWith("safe:")) throw new Error("bad fake credential payload");
      return text.slice("safe:".length);
    },
  };

  const encryptedCredentialsPath = join(dir, "encrypted-credentials.json");
  setAutomationCredentialCodec(fakeCodec);
  writeAutomationCredentialsFile(encryptedCredentialsPath, {
    [fubonPasswordKey]: "encrypted-secret",
  });
  const encryptedText = readFileSync(encryptedCredentialsPath, "utf8");
  const encryptedRecord = JSON.parse(encryptedText) as { format?: unknown; data?: unknown };
  assert.equal(encryptedRecord.format, AUTOMATION_CREDENTIALS_FORMAT);
  assert.equal(typeof encryptedRecord.data, "string");
  assert.equal(encryptedText.includes("encrypted-secret"), false);
  assert.deepEqual(readAutomationCredentialsFile(encryptedCredentialsPath), {
    [fubonPasswordKey]: "encrypted-secret",
  });

  setAutomationCredentialCodec(null);
  assert.throws(
    () => readAutomationCredentialsFile(encryptedCredentialsPath),
    /Credential encryption is not configured/,
  );

  const legacyCredentialsPath = join(dir, "legacy-credentials.json");
  writeFileSync(legacyCredentialsPath, `${JSON.stringify({
    [maxSecretKey]: "legacy-secret",
  }, null, 2)}\n`);
  setAutomationCredentialCodec(fakeCodec);
  assert.equal(migrateAutomationCredentialsFileEncryption(legacyCredentialsPath), true);
  assert.deepEqual(readAutomationCredentialsFile(legacyCredentialsPath), {
    [maxSecretKey]: "legacy-secret",
  });
  assert.equal(readFileSync(legacyCredentialsPath, "utf8").includes("legacy-secret"), false);
  assert.equal(migrateAutomationCredentialsFileEncryption(legacyCredentialsPath), false);
  setAutomationCredentialCodec(null);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
