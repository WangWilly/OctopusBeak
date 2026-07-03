import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "automation-desktop-api-"));
const originalCwd = process.cwd();
const credentialPrefix = "LIBRETTO_CLOUD_" + "FUBON_";
const enabledKey = `${credentialPrefix}ENABLED`;
const userIdKey = `${credentialPrefix}USER_ID`;
const accountKey = `${credentialPrefix}ACCOUNT`;
const passwordKey = `${credentialPrefix}PASSWORD`;
let resetCredentialCodec: (() => void) | null = null;

try {
  process.chdir(dir);
  writeFileSync("settings.json", JSON.stringify({
    AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
    [enabledKey]: true,
  }, null, 2));
  writeFileSync("credentials.json", JSON.stringify({
    [userIdKey]: "user",
    [accountKey]: "acct",
    [passwordKey]: "pw",
  }, null, 2));

  const configFiles = await import("./config-files.ts");
  resetCredentialCodec = () => configFiles.setAutomationCredentialCodec(null);
  const api = await import("./desktop-api.ts");
  const { openLedgerDatabase } = await import("../../../ledger/db/client.ts");
  const { createTaskRun } = await import("./store.ts");
  const db = openLedgerDatabase(dir);
  try {
    createTaskRun(db, {
      taskId: "fubon-all-statements",
      script: "run:fubon-all-statements",
      kind: "crawler",
      status: "completed",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      logPath: "data/automation/logs/fubon.log",
      logTail: "ok",
    });
  } finally {
    db.close();
  }

  const model = api.loadAutomationDesktopModel(dir);
  assert.equal(model.credentialGroups.find((group) => group.id === "fubon")?.enabled, true);
  assert.equal(model.automation.credentials[passwordKey], true);
  assert.equal(Object.hasOwn(model.automation, "runHistory"), false);
  assert.equal(model.automation.tasks.find((task) => task.id === "fubon-all-statements")?.ranToday, true);
  assert.equal(api.automationRunHistory(dir)[0]?.taskId, "fubon-all-statements");

  assert.throws(
    () => api.assertAutomationTaskCanStart("import-downloads-csv", dir),
    /Import is locked/,
  );

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
  configFiles.setAutomationCredentialCodec(fakeCodec);

  const saveResult = api.automationSaveCredentials({
    [enabledKey]: "false",
    [accountKey]: "next-acct",
  });
  assert.deepEqual(saveResult, { saved: true });

  const settings = JSON.parse(readFileSync("settings.json", "utf8"));
  const rawCredentialsText = readFileSync("credentials.json", "utf8");
  const rawCredentials = JSON.parse(rawCredentialsText) as { format?: unknown };
  const credentials = configFiles.readAutomationCredentialsFile("credentials.json");
  assert.equal(settings[enabledKey], false);
  assert.equal(Object.hasOwn(settings, accountKey), false);
  assert.equal(rawCredentials.format, configFiles.AUTOMATION_CREDENTIALS_FORMAT);
  assert.equal(rawCredentialsText.includes("next-acct"), false);
  assert.equal(credentials[accountKey], "next-acct");
  assert.equal(Object.hasOwn(credentials, enabledKey), false);
  resetCredentialCodec();
  assert.throws(
    () => configFiles.readAutomationCredentialsFile("credentials.json"),
    /Credential encryption is not configured/,
  );
} finally {
  resetCredentialCodec?.();
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
}
