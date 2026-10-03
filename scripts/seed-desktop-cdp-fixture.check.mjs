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
} finally {
  removeDesktopCdpFixture(root);
}
