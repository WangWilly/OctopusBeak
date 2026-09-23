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
    SELECT task_id, status, error_message, log_tail
    FROM automation_task_runs
    ORDER BY task_id
  `)).rows.map((row) => ({ ...row }));
  await db.close();
  assert.deepEqual(rows, [
    {
      task_id: "esun-credit-card-statements",
      status: "failed",
      error_message: "Mock fixture: E.SUN sign-in failed after the source was selected.",
      log_tail: "automation-progress: 42\nMock fixture: E.SUN sign-in failed after the source was selected.",
    },
    {
      task_id: "fubon-all-statements",
      status: "completed",
      error_message: null,
      log_tail: "automation-progress: 100",
    },
  ]);
} finally {
  removeDesktopCdpFixture(root);
}
