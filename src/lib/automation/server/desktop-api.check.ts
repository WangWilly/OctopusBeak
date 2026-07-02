import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "automation-desktop-api-"));
const originalCwd = process.cwd();
const credentialPrefix = "LIBRETTO_CLOUD_" + "FUBON_";
const enabledKey = `${credentialPrefix}ENABLED`;
const userIdKey = `${credentialPrefix}USER_ID`;
const accountKey = `${credentialPrefix}ACCOUNT`;
const passwordKey = `${credentialPrefix}PASSWORD`;

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

  const api = await import("./desktop-api.ts");

  const model = api.loadAutomationDesktopModel(dir);
  assert.equal(model.credentialGroups.find((group) => group.id === "fubon")?.enabled, true);
  assert.equal(model.automation.credentials[passwordKey], true);

  assert.throws(
    () => api.assertAutomationTaskCanStart("import-downloads-csv", dir),
    /Import is locked/,
  );

  assert.deepEqual(api.automationSaveCredentials({
    [enabledKey]: "false",
    [accountKey]: "next-acct",
  }), { saved: true });
} finally {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
}
