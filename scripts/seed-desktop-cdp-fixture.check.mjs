import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { openLedgerDatabase } from "../src/ledger/db/client.ts";

assert.throws(
  () => seedDesktopCdpFixture(process.cwd()),
  /temporary directory/,
);

const root = await mkdtemp(join(tmpdir(), "octopusbeak-desktop-cdp-fixture-"));
try {
  seedDesktopCdpFixture(root, new Date("2026-09-14T04:00:00.000Z"));

  const marker = JSON.parse(await readFile(join(root, ".libretto", "canonical-reset.json"), "utf8"));
  assert.equal(marker.status, "completed");
  assert.equal(marker.userData, root);

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

  const db = openLedgerDatabase(join(root, "data", "ledger"), { readOnly: true });
  const rows = db.prepare(`
    SELECT task_id, status, error_message, log_tail
    FROM automation_task_runs
    ORDER BY task_id
  `).all().map((row) => ({ ...row }));
  db.close();
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
