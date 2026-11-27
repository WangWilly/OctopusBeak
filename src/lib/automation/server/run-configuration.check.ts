import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appWorkflowRegistration } from "./app-workflow-registry.ts";
import {
  CATHAY_TRUSTED_DEVICE_USER_ID_KEY,
  runConfiguration,
  TDCC_HOST_KEYS,
  type RunConfiguration,
} from "./config-files.ts";
import { planForCheck, runnerHostForCheck } from "./task-run-check-support.ts";
import { taskRunConfiguration } from "./task-run-plan.ts";
import {
  AUTOMATION_CREDENTIAL_GROUPS,
  AUTOMATION_SECRET_KEYS,
  AUTOMATION_TASKS,
  automationCredentialKeyIsSecret,
} from "./tasks.ts";

const HOST_ONLY_KEYS = new Set<string>([...TDCC_HOST_KEYS, CATHAY_TRUSTED_DEVICE_USER_ID_KEY]);
const EVERY_SECRET = Object.fromEntries(
  [...AUTOMATION_SECRET_KEYS, ...HOST_ONLY_KEYS].map((key) => [key, `stored-${key}`]),
);
/** Every group enabled, every product selected, Preview features on. */
const EVERY_SELECTION: Readonly<Record<string, string>> = Object.fromEntries([
  ["PREVIEW_FEATURES_ENABLED", "true"],
  ...AUTOMATION_CREDENTIAL_GROUPS.flatMap((group) => [
    [group.enabledKey, "true"],
    ...group.statementSelectionKey && group.statementTypes?.length
      ? [[group.statementSelectionKey, group.statementTypes.map(({ id }) => id).join(",")]]
      : [],
  ]),
]);

const runnableTasks = AUTOMATION_TASKS.filter((task) => appWorkflowRegistration(task.workflowId));

test("a run's configuration holds its own declared credentials and no other source's or host-only key", () => {
  const directory = mkdtempSync(join(tmpdir(), "run-configuration-"));
  try {
    const host = runnerHostForCheck(directory);
    host.settings.write(EVERY_SELECTION);
    host.credentials.write(EVERY_SECRET);
    assert.ok(runnableTasks.length > 10);
    for (const task of runnableTasks) {
      const declared = appWorkflowRegistration(task.workflowId)!.credentialKeys;
      const { launchConfiguration } = planForCheck(task, host);
      const held = Object.keys(launchConfiguration.credentials).sort();
      assert.deepEqual(
        held,
        declared.filter((key) => !HOST_ONLY_KEYS.has(key) && Object.hasOwn(EVERY_SECRET, key)).sort(),
        `${task.id} holds exactly the stored credentials it declares`,
      );
      assert.ok(held.every((key) => !HOST_ONLY_KEYS.has(key)), `${task.id} holds no host-only key`);
      assert.deepEqual(
        taskRunConfiguration(task.id, host.settings.read(), host.credentials.read()),
        launchConfiguration,
        `${task.id}: write admission builds the configuration the run launched with`,
      );
    }

    const fubon = planForCheck(runnableTasks.find((task) => task.id === "fubon-all-statements")!, host);
    assert.equal(fubon.launchConfiguration.credentials.LIBRETTO_CLOUD_FUBON_PASSWORD, "stored-LIBRETTO_CLOUD_FUBON_PASSWORD");
    assert.equal(fubon.launchConfiguration.credentials.LIBRETTO_CLOUD_CATHAY_PASSWORD, undefined, "a Fubon run never holds Cathay's password");
    assert.deepEqual(
      planForCheck(runnableTasks.find((task) => task.id === "sync-tdcc")!, host).launchConfiguration.credentials,
      {},
      "TDCC's sign-in details stay with its host-owned session port",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every workflow's declared credential keys cover every credential its input reads", () => {
  for (const task of runnableTasks) {
    const registration = appWorkflowRegistration(task.workflowId)!;
    const read = new Set<string>();
    const recording = new Proxy({ ...EVERY_SECRET }, {
      get(target, key, receiver) {
        if (typeof key === "string") read.add(key);
        return Reflect.get(target, key, receiver);
      },
    });
    const full: RunConfiguration = { settings: EVERY_SELECTION, credentials: recording };
    const input = registration.inputFromConfiguration(full);
    const undeclared = [...read].filter((key) => !registration.credentialKeys.includes(key));
    assert.deepEqual(undeclared, [], `${task.id} reads only credentials it declares`);
    assert.deepEqual(
      registration.inputFromConfiguration(runConfiguration(EVERY_SELECTION, EVERY_SECRET, registration.credentialKeys)),
      input,
      `${task.id} receives the same input from its own credentials as from every stored one`,
    );
  }
});

test("the text sign-in fields the Collection scope fingerprint reads are among the task's declared credentials", () => {
  for (const task of runnableTasks) {
    const group = AUTOMATION_CREDENTIAL_GROUPS.find((candidate) => candidate.id === task.credentialGroupId);
    if (!group) continue;
    const declared = appWorkflowRegistration(task.workflowId)!.credentialKeys;
    const missing = group.credentialFields
      .filter((field) => field.input === "text" && automationCredentialKeyIsSecret(field.key) && !HOST_ONLY_KEYS.has(field.key))
      .map((field) => field.key)
      .filter((key) => !declared.includes(key));
    assert.deepEqual(missing, [], `${task.id} declares every text sign-in field of its group`);
  }
});
