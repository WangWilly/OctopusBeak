import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  automationConfigEnv,
  credentialStatusFromValues,
  migrateAutomationEnvFile,
  readAutomationCredentialsFile,
  readAutomationSettingsFile,
  settingsToEnv,
  splitAutomationUpdates,
  writeAutomationCredentialsFile,
  writeAutomationSettingsFile,
} from "./config-files.ts";

const dir = mkdtempSync(join(tmpdir(), "octopusbeak-config-"));
const fubonPasswordKey = "LIBRETTO_CLOUD_FUBON" + "_PASSWORD";
const maxSecretKey = "MAX_SECRET" + "_KEY";

try {
  const settingsPath = join(dir, "settings.json");
  const credentialsPath = join(dir, "credentials.json");
  const envPath = join(dir, ".env");
  const envLocalPath = join(dir, ".env.local");

  writeAutomationSettingsFile(settingsPath, {
    AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
    LIBRETTO_CLOUD_FUBON_ENABLED: false,
    MAX_SUB_ACCOUNT: "main",
  });
  writeAutomationCredentialsFile(credentialsPath, {
    [fubonPasswordKey]: "secret",
    [maxSecretKey]: "max-secret",
  });

  assert.deepEqual(readAutomationSettingsFile(settingsPath), {
    AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
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
    LIBRETTO_CLOUD_FUBON_ENABLED: "true",
    [fubonPasswordKey]: "pw",
    MAX_SUB_ACCOUNT: "main",
  }), {
    settings: {
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
    AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
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
} finally {
  rmSync(dir, { recursive: true, force: true });
}
