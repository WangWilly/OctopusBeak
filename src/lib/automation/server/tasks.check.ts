import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AUTOMATION_CREDENTIAL_GROUPS,
  AUTOMATION_NON_SECRET_KEYS,
  enabledAutomationTasks,
  taskById,
} from "./tasks.ts";

const task = taskById("exchange-rates");

assert.ok(task);
assert.equal(task.kind, "sync");
assert.equal(task.credentialGroupId, undefined);
assert.deepEqual(task.credentialKeys, []);
assert.deepEqual(task.command, [
  "node",
  "--no-warnings",
  "--experimental-strip-types",
  "src/ledger/sync-exchange-rates.ts",
]);
assert.deepEqual(
  AUTOMATION_CREDENTIAL_GROUPS.find((group) => group.id === "fubon")?.statementTypes,
  [{ id: "deposit" }, { id: "credit_card" }, { id: "loan" }],
);
assert.equal(
  AUTOMATION_NON_SECRET_KEYS.includes("LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES"),
  true,
);
assert.equal(
  enabledAutomationTasks(Object.fromEntries([
    "fubon",
    "esun",
    "yuanta",
    "yuanta-trade",
    "cathay",
    "hncb",
    "ctbc",
    "post",
    "sinopac",
    "linebank",
    "einvoice",
    "maicoin",
  ].map((id) => [id, false]))).some(({ id }) => id === task.id),
  true,
);

const maicoinTask = taskById("sync-maicoin");
assert.ok(maicoinTask);
assert.equal(maicoinTask.command.includes("--env-file-if-exists=.env"), false);

const packageJson = JSON.parse(
  readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
assert.doesNotMatch(packageJson.scripts["run:sync-maicoin"], /--env-file/);
