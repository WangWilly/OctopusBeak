import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  desktopCdpFixtureSettings,
  desktopCdpFixtureCredentialGroupIds,
  removeDesktopCdpFixture,
  seedDesktopCdpFixture,
} from "./seed-desktop-cdp-fixture.ts";
import {
  AUTOMATION_CREDENTIAL_GROUPS,
  automationCredentialKeyIsSecret,
} from "../src/lib/automation/server/tasks.ts";

await assert.rejects(
  seedDesktopCdpFixture(process.cwd()),
  /temporary directory/,
);

const root = await mkdtemp(join(tmpdir(), "octopusbeak-desktop-cdp-fixture-"));
try {
  await seedDesktopCdpFixture(root, new Date("2026-09-14T04:00:00.000Z"));

  const settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
  assert.deepEqual(settings, desktopCdpFixtureSettings);
  const credentials = JSON.parse(await readFile(join(root, "credentials.json"), "utf8"));
  const expectedCredentialKeys = desktopCdpFixtureCredentialGroupIds
    .flatMap((groupId) => AUTOMATION_CREDENTIAL_GROUPS
      .find((group) => group.id === groupId)
      .credentialFields
      .filter((credentialField) => automationCredentialKeyIsSecret(credentialField.key))
      .map((credentialField) => credentialField.key))
    .sort();
  assert.deepEqual(Object.keys(credentials).sort(), expectedCredentialKeys);
  for (const key of expectedCredentialKeys) {
    assert.match(credentials[key], /^fixture-cdp-/);
  }

  const db = await PGlite.create({ dataDir: join(root, "data", "pglite") });
  const rows = (await db.query(`
    SELECT task_id, status, record_json
    FROM automation_task_runs
    ORDER BY task_id
  `)).rows.map((row) => {
    const record = JSON.parse(row.record_json);
    assert.equal("script" in record, false);
    assert.equal("logPath" in record, false);
    assert.equal("logTail" in record, false);
    assert.equal("errorMessage" in record, false);
    return {
      task_id: row.task_id,
      status: row.status,
      app_workflow_outcome: record.appWorkflowOutcome ?? null,
    };
  });
  const removedColumns = (await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'automation_task_runs'
      AND column_name IN ('script', 'error_message', 'log_path', 'log_tail')
  `)).rows;
  await db.close();
  assert.deepEqual(removedColumns, []);
  assert.deepEqual(rows, [
    {
      task_id: "esun-credit-card-statements",
      status: "failed",
      app_workflow_outcome: {
        errorCode: "workflow-failed",
        summary: { status: "failed", counts: {} },
      },
    },
    {
      task_id: "fubon-all-statements",
      status: "partial",
      app_workflow_outcome: {
        errorCode: null,
        summary: {
          status: "partial",
          counts: { rowCount: 1 },
          products: [
            { typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 },
            {
              typeId: "credit_card",
              status: "failed",
              itemCount: 2,
              committedCount: 1,
              errorCode: "canonical-commit-failed",
            },
            {
              typeId: "loan",
              status: "skipped",
              itemCount: 0,
              committedCount: 0,
              skipReason: "not_selected",
            },
          ],
        },
      },
    },
  ]);

removeDesktopCdpFixture(root);
await seedDesktopCdpFixture(
  root,
  new Date("2026-09-14T04:00:00.000Z"),
  { includeCathayVerificationFailure: true },
);
const verificationSettings = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
assert.equal(Object.hasOwn(verificationSettings, "LIBRETTO_CLOUD_ESUN_VERIFICATION_ACTOR"), false);
assert.equal(verificationSettings.LIBRETTO_CLOUD_CATHAY_ENABLED, true);
const verificationDb = await PGlite.create({ dataDir: join(root, "data", "pglite") });
const cathayFixture = (await verificationDb.query(`
  SELECT status, record_json
  FROM automation_task_runs
  WHERE task_id = 'cathay-all-statements'
`)).rows[0];
const cathayRecord = JSON.parse(cathayFixture.record_json);
assert.equal(cathayFixture.status, "failed");
assert.deepEqual(cathayRecord.appWorkflowOutcome, {
  errorCode: "verification-configuration-failed",
  summary: { status: "failed", counts: {} },
});
assert.deepEqual(cathayRecord.events.map(({ stage, code, occurredAt }) => ({ stage, code, occurredAt })), [
  {
    stage: "authentication",
    code: "cathay-email-otp-gmail-needs-authorization",
    occurredAt: "2026-09-14T10:01:00.000Z",
  },
]);
assert.equal(JSON.stringify(cathayRecord).includes("otp"), true);
assert.equal(JSON.stringify(cathayRecord).includes("fixture-cdp-"), false);
await verificationDb.close();

removeDesktopCdpFixture(root);
await seedDesktopCdpFixture(root, new Date("2026-09-14T04:00:00.000Z"), { tdccOutcome: "device-registration-required" });
const tdccSettings = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
assert.equal(tdccSettings.LIBRETTO_CLOUD_TDCC_ENABLED, true);
const tdccCredentials = JSON.parse(await readFile(join(root, "credentials.json"), "utf8"));
assert.deepEqual(
  Object.keys(tdccCredentials).filter((key) => key.includes("TDCC")).sort(),
  ["LIBRETTO_CLOUD_TDCC_PASSWORD", "LIBRETTO_CLOUD_TDCC_USER_ID"],
  "the TDCC fixture registers no device",
);
const tdccDb = await PGlite.create({ dataDir: join(root, "data", "pglite") });
const tdccRun = (await tdccDb.query("SELECT status, record_json FROM automation_task_runs WHERE task_id = 'sync-tdcc'")).rows[0];
assert.equal(tdccRun.status, "failed");
assert.equal(JSON.parse(tdccRun.record_json).appWorkflowOutcome.errorCode, "device-registration-required");
const institutions = (await tdccDb.query("SELECT institution_key FROM financial_accounts ORDER BY institution_key")).rows
  .map((row) => row.institution_key);
assert.equal(institutions.length, 5, "Cathay, Yuanta Trade, and three TDCC accounts");
assert.equal(institutions.filter((key) => key === "cathay").length, 2, "a direct Cathay account and the TDCC account it covers");
await tdccDb.close();
} finally {
  removeDesktopCdpFixture(root);
}
