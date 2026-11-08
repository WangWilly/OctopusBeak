import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOMATION_CREDENTIALS_FORMAT,
  AUTOMATION_CREDENTIALS_FILE,
  AUTOMATION_SETTINGS_FILE,
  CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY,
  FUBON_CARD_IDENTITY_FINGERPRINT_SECRET_KEY,
  TDCC_HOST_KEYS,
  automationConfigEnv,
  createAutomationCredentialStore,
  createAutomationSettingsStore,
  credentialStatusFromValues,
  ensureAutomationManagedSecrets,
  migrateAutomationCredentialsFileEncryption,
  migrateAutomationEnvFile,
  migrateStatementSelectionIds,
  readAutomationCredentialsFile,
  readAutomationSettingsFile,
  settingsToEnv,
  splitAutomationUpdates,
  writeAutomationCredentialsFile,
  writeAutomationSettingsFile,
} from "./config-files.ts";

const dir = mkdtempSync(join(tmpdir(), "octopusbeak-config-"));
const fubonPasswordKey = "LIBRETTO_CLOUD_FUBON" + "_PASSWORD";
const fubonPanFingerprintKey =
  "LIBRETTO_CLOUD_FUBON_CARD_IDENTITY_FINGERPRINT_KEY";
const maxSecretKey = "MAX_SECRET" + "_KEY";
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
  }, null);

  assert.deepEqual(readAutomationSettingsFile(settingsPath), {
    SYSTEM_TIMEZONE: "Asia/Taipei",
    EXCHANGE_RATE_UPDATE_TIME: "06:00",
    LIBRETTO_CLOUD_FUBON_ENABLED: false,
    MAX_SUB_ACCOUNT: "main",
  });
  assert.deepEqual(readAutomationCredentialsFile(credentialsPath, null), {
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
    [fubonPanFingerprintKey]: "synthetic-pan-fingerprint-key",
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

  const credentials = createAutomationCredentialStore(credentialsPath, fakeCodec);
  migrateAutomationEnvFile({ envPath, settings: createAutomationSettingsStore(settingsPath), credentials });
  assert.deepEqual(readAutomationSettingsFile(settingsPath), {
    SYSTEM_TIMEZONE: "Asia/Taipei",
    EXCHANGE_RATE_UPDATE_TIME: "06:00",
    LIBRETTO_CLOUD_FUBON_ENABLED: false,
    MAX_SUB_ACCOUNT: "main",
  });
  assert.deepEqual(credentials.read(), {
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

  const tdccSecrets = Object.fromEntries(TDCC_HOST_KEYS.map((key) => [key, `${key}-value`]));
  const tdccCredentialsPath = join(dir, "tdcc-credentials.json");
  writeAutomationCredentialsFile(tdccCredentialsPath, { ...tdccSecrets, [fubonPasswordKey]: "pw" }, null);
  assert.deepEqual(
    readAutomationCredentialsFile(tdccCredentialsPath, null),
    { ...tdccSecrets, [fubonPasswordKey]: "pw" },
    "TDCC secrets survive a credentials rewrite",
  );
  const workflowEnv = automationConfigEnv({ baseEnv: {}, settings: {}, credentials: tdccSecrets });
  for (const key of TDCC_HOST_KEYS) {
    assert.equal(workflowEnv[key], undefined, `${key} stays out of child workflow environments`);
  }

  const legacyGmailPath = join(dir, "legacy-gmail-credentials.json");
  const legacyGmailSettingsPath = join(dir, "legacy-gmail-settings.json");
  writeFileSync(legacyGmailPath, JSON.stringify({
    CATHAY_GMAIL_REFRESH_TOKEN: "legacy-refresh-token",
    CATHAY_GMAIL_CONNECTED_EMAIL: "person@example.test",
    [fubonPasswordKey]: "pw",
  }));
  writeFileSync(legacyGmailSettingsPath, JSON.stringify({ CATHAY_GMAIL_OTP_ENABLED: true }));
  const legacyCredentials = readAutomationCredentialsFile(legacyGmailPath, null);
  assert.deepEqual(legacyCredentials, { [fubonPasswordKey]: "pw" }, "stored Gmail grants are no longer read");
  assert.deepEqual(readAutomationSettingsFile(legacyGmailSettingsPath), {});
  writeAutomationCredentialsFile(legacyGmailPath, legacyCredentials, null);
  assert.equal(readFileSync(legacyGmailPath, "utf8").includes("legacy-refresh-token"), false, "the next credential write drops the Gmail grant");

  assert.equal(AUTOMATION_SETTINGS_FILE, "settings.json");
  assert.equal(AUTOMATION_CREDENTIALS_FILE, "credentials.json");
  assert.equal(
    CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY,
    FUBON_CARD_IDENTITY_FINGERPRINT_SECRET_KEY,
  );

  {
    const store = createAutomationSettingsStore(join(dir, "store-settings.json"));
    const other = createAutomationSettingsStore(join(dir, "other-settings.json"));
    const heard: unknown[] = [];
    const otherHeard: unknown[] = [];
    const unsubscribe = store.subscribe((settings) => heard.push(settings));
    other.subscribe((settings) => otherHeard.push(settings));
    store.write({ MAX_SUB_ACCOUNT: "runtime" });
    assert.deepEqual(readAutomationSettingsFile(join(dir, "store-settings.json")), { MAX_SUB_ACCOUNT: "runtime" });
    assert.deepEqual(heard, [{ MAX_SUB_ACCOUNT: "runtime" }], "a write announces to the store's subscribers");
    assert.deepEqual(otherHeard, [], "another store hears none of its writes");
    assert.equal(existsSync(join(process.cwd(), "store-settings.json")), false, "the store never writes relative to the cwd");
    writeAutomationSettingsFile(store.path, { LIBRETTO_CLOUD_LINEBANK_STATEMENT_TYPES: "accounts" });
    const before = readFileSync(store.path, "utf8");
    const heardBefore = heard.length;
    assert.deepEqual(
      store.read(),
      { LIBRETTO_CLOUD_LINEBANK_STATEMENT_TYPES: "accounts" },
      "a read returns the file as it is; main migrates renamed ids once at startup",
    );
    assert.equal(readFileSync(store.path, "utf8"), before, "a read never writes, so the PGlite worker is no second writer");
    assert.equal(heard.length, heardBefore, "a read announces nothing");
    unsubscribe();
    store.write({});
    assert.equal(heard.length, heardBefore, "an unsubscribed listener hears no later write");
  }

  const encryptedCredentialsPath = join(dir, "encrypted-credentials.json");
  const managedSecret = "a".repeat(43);
  const encryptedCredentials = createAutomationCredentialStore(encryptedCredentialsPath, fakeCodec);
  encryptedCredentials.write({
    [fubonPanFingerprintKey]: managedSecret,
  });
  const encryptedText = readFileSync(encryptedCredentialsPath, "utf8");
  const encryptedRecord = JSON.parse(encryptedText) as { format?: unknown; data?: unknown };
  assert.equal(encryptedRecord.format, AUTOMATION_CREDENTIALS_FORMAT);
  assert.equal(typeof encryptedRecord.data, "string");
  assert.equal(encryptedText.includes(managedSecret), false);
  assert.deepEqual(encryptedCredentials.read(), {
    [fubonPanFingerprintKey]: managedSecret,
  });

  const generatedCredentialsPath = join(dir, "generated-credentials.json");
  assert.deepEqual(
    ensureAutomationManagedSecrets({
      credentialsPath: generatedCredentialsPath,
      generateFingerprintSecret: () => managedSecret,
      codec: fakeCodec,
    }),
    { created: true },
  );
  assert.equal(
    readFileSync(generatedCredentialsPath, "utf8").includes(managedSecret),
    false,
  );
  assert.equal(
    readAutomationCredentialsFile(generatedCredentialsPath, fakeCodec)[
      FUBON_CARD_IDENTITY_FINGERPRINT_SECRET_KEY
    ],
    managedSecret,
  );
  assert.deepEqual(
    ensureAutomationManagedSecrets({
      credentialsPath: generatedCredentialsPath,
      generateFingerprintSecret: () => {
        throw new Error("must not rotate an existing managed secret");
      },
      codec: fakeCodec,
    }),
    { created: false },
  );

  assert.throws(
    () => readAutomationCredentialsFile(encryptedCredentialsPath, null),
    /Credential encryption is not configured/,
  );
  assert.throws(
    () =>
      ensureAutomationManagedSecrets({
        credentialsPath: join(dir, "unencrypted-managed-secret.json"),
        codec: null,
      }),
    /Credential encryption is not configured/,
  );

  const legacyCredentialsPath = join(dir, "legacy-credentials.json");
  writeFileSync(legacyCredentialsPath, `${JSON.stringify({
    [maxSecretKey]: "legacy-secret",
  }, null, 2)}\n`);
  assert.equal(migrateAutomationCredentialsFileEncryption(legacyCredentialsPath, fakeCodec), true);
  assert.deepEqual(readAutomationCredentialsFile(legacyCredentialsPath, fakeCodec), {
    [maxSecretKey]: "legacy-secret",
  });
  assert.equal(readFileSync(legacyCredentialsPath, "utf8").includes("legacy-secret"), false);
  assert.equal(migrateAutomationCredentialsFileEncryption(legacyCredentialsPath, fakeCodec), false);
  {
    const settingsPath = join(dir, "renamed-selection-settings.json");
    writeAutomationSettingsFile(settingsPath, {
      LIBRETTO_CLOUD_SINOPAC_STATEMENT_TYPES: "accounts,credit_card",
      LIBRETTO_CLOUD_LINEBANK_STATEMENT_TYPES: "accounts",
      LIBRETTO_CLOUD_YUANTA_TRADE_STATEMENT_TYPES: "brokerage",
      LIBRETTO_CLOUD_CTBC_STATEMENT_TYPES: "deposit",
    });
    migrateStatementSelectionIds(settingsPath);
    const migrated = {
      LIBRETTO_CLOUD_SINOPAC_STATEMENT_TYPES: "deposit,credit_card",
      LIBRETTO_CLOUD_LINEBANK_STATEMENT_TYPES: "deposit",
      LIBRETTO_CLOUD_YUANTA_TRADE_STATEMENT_TYPES: "securities",
      LIBRETTO_CLOUD_CTBC_STATEMENT_TYPES: "deposit",
    };
    assert.deepEqual(readAutomationSettingsFile(settingsPath), migrated, "renamed ids keep order and attached ids");
    const written = readFileSync(settingsPath, "utf8");
    migrateStatementSelectionIds(settingsPath);
    assert.equal(readFileSync(settingsPath, "utf8"), written, "a migrated file is left unchanged");
    writeAutomationSettingsFile(settingsPath, { LIBRETTO_CLOUD_SINOPAC_STATEMENT_TYPES: "deposit,accounts" });
    migrateStatementSelectionIds(settingsPath);
    assert.deepEqual(readAutomationSettingsFile(settingsPath), { LIBRETTO_CLOUD_SINOPAC_STATEMENT_TYPES: "deposit" });
    migrateStatementSelectionIds(join(dir, "missing-settings.json"));
    assert.equal(existsSync(join(dir, "missing-settings.json")), false, "no settings file is created");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

