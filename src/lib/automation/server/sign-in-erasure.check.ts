import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";
import { commitCathay } from "../../../ledger/pglite/direct-source-precedence-fixture.ts";
import { createPgliteOperationalProvider } from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import {
  AUTOMATION_CREDENTIALS_FILE,
  AUTOMATION_SETTINGS_FILE,
  CATHAY_TRUSTED_DEVICE_USER_ID_KEY,
  FUBON_CARD_IDENTITY_FINGERPRINT_SECRET_KEY,
  TDCC_DEVICE_IDENTITY_KEY,
  TDCC_PASSWORD_KEY,
  TDCC_SESSION_KEY,
  TDCC_USER_ID_KEY,
  createAutomationCredentialStore,
  readAutomationSettingsFile,
  writeAutomationSettingsFile,
  type AutomationCredentialCodec,
} from "./config-files.ts";
import { loadAutomationDesktopModel } from "./automation-desktop-model.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import { eraseSignInDetails } from "./sign-in-erasure.ts";

const codec: AutomationCredentialCodec = {
  encrypt: (text) => Buffer.from(text, "utf8").toString("base64"),
  decrypt: (payload) => Buffer.from(payload, "base64").toString("utf8"),
};
const idleRuns = () => ({ snapshot: createAutomationRuntimeState().snapshot(), activeTaskIds: [] });
const fingerprintSecret = "a".repeat(43);

test("Sign-in Erasure removes sign-in details and source sessions and keeps settings, app secrets and financial data", async () => {
  const root = await mkdtemp(join(tmpdir(), "sign-in-erasure-"));
  const store = new PGliteStore(await createTestPGlite("ledger+operational"));
  const settingsPath = join(root, AUTOMATION_SETTINGS_FILE);
  try {
    const credentials = createAutomationCredentialStore(join(root, AUTOMATION_CREDENTIALS_FILE), codec);
    writeAutomationSettingsFile(settingsPath, {
      LIBRETTO_CLOUD_CATHAY_ENABLED: true,
      LIBRETTO_CLOUD_TDCC_ENABLED: true,
      SCHEDULED_COLLECTION_ENABLED: true,
      SCHEDULED_COLLECTION_TIME: "07:00",
    });
    credentials.write({
      LIBRETTO_CLOUD_CATHAY_USER_ID: "example-user",
      LIBRETTO_CLOUD_CATHAY_ACCOUNT: "example-code",
      LIBRETTO_CLOUD_CATHAY_PASSWORD: "example-password",
      [CATHAY_TRUSTED_DEVICE_USER_ID_KEY]: "example-user",
      [TDCC_USER_ID_KEY]: "example-user",
      [TDCC_PASSWORD_KEY]: "synthetic-password",
      [TDCC_DEVICE_IDENTITY_KEY]: "{\"deviceId\":\"synthetic\"}",
      [TDCC_SESSION_KEY]: "{\"issuedAt\":\"2026-10-09T00:00:00.000Z\"}",
      [FUBON_CARD_IDENTITY_FINGERPRINT_SECRET_KEY]: fingerprintSecret,
    });
    const cookieJar = join(root, "data", "automation", "browser-state", "cathay-all-statements", "authentication");
    const profile = join(root, "data", "automation", "browser-runtime", "cathay-all-statements", "run-1");
    mkdirSync(cookieJar, { recursive: true });
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(cookieJar, "cookies.safeStorage.json"), "{}");
    writeFileSync(join(profile, "Cookies"), "");
    await commitCathay(store);
    const provider = createPgliteOperationalProvider(store);
    const sourceRows = async () => (await loadAutomationDesktopModel(provider, idleRuns(), credentials, readAutomationSettingsFile(settingsPath))).automation.tasks
      .filter((task) => task.credentialKeys.length > 0);
    assert.ok((await sourceRows()).some((task) => task.credentialsReady), "a source was set up before the erasure");
    const settingsBefore = readFileSync(settingsPath, "utf8");
    const accountsBefore = (await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_accounts")).rows[0]!.count;

    eraseSignInDetails({ credentials, userDataDirectory: root });
    eraseSignInDetails({ credentials, userDataDirectory: root });

    assert.deepEqual(credentials.read(), {
      [FUBON_CARD_IDENTITY_FINGERPRINT_SECRET_KEY]: fingerprintSecret,
    });
    assert.equal(existsSync(join(root, "data", "automation", "browser-state")), false, "retained cookies are gone");
    assert.equal(existsSync(join(root, "data", "automation", "browser-runtime")), false, "browser profiles are gone");
    assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore, "enabled sources and schedules are unchanged");
    const rows = await sourceRows();
    assert.ok(rows.length > 0);
    for (const task of rows) assert.equal(task.credentialsReady, false, `${task.id} needs setup`);
    assert.equal(
      (await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_accounts")).rows[0]!.count,
      accountsBefore,
      "financial data is untouched",
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
