import assert from "node:assert/strict";
import test from "node:test";
import {
  TYPED_WORKFLOW_ERROR_CODES,
  userActionForFailure,
  type TypedWorkflowErrorCode,
  type UserAction,
} from "../workflow-failures.ts";
import { buildAutomationPageModel } from "./page-model.ts";
import { scheduledCollectionTaskIds, scheduledRunNotification } from "./scheduled-collection.ts";
import type { AutomationTaskRun } from "./store.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, AUTOMATION_TASKS, enabledAutomationTasks } from "./tasks.ts";

const expectedUserActions: Record<TypedWorkflowErrorCode, UserAction | null> = {
  "captcha-provider-rejected": null,
  cancelled: null,
  "source-integrity-failed": null,
  "source-validation-failed": null,
  "source-access-challenged": null,
  "source-unavailable": null,
  "browser-runtime-config-failed": null,
  "verification-configuration-failed": "check-verification-settings",
  "authentication-timeout": null,
  "authentication-dialog-interrupted": null,
  "authentication-failed": "check-sign-in-details",
  "verification-failed": null,
  "device-registration-required": "register-device",
  "provider-protocol-outdated": "update-app",
  "source-collection-failed": null,
  "canonical-commit-failed": null,
  "commit-outcome-unknown": null,
  "collection-scope-changed": null,
  "workflow-failed": null,
};

test("only failures the person must resolve are user-action failures", () => {
  for (const code of TYPED_WORKFLOW_ERROR_CODES) {
    assert.equal(userActionForFailure(code), expectedUserActions[code], code);
  }
  assert.equal(userActionForFailure("not-a-code"), null);
  assert.equal(userActionForFailure(undefined), null);
});

function run(overrides: Partial<AutomationTaskRun>): AutomationTaskRun {
  return {
    taskRunId: "run-1",
    taskId: "sync-tdcc",
    kind: "sync",
    status: "failed",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-07-14T23:00:01.000Z",
    finishedAt: "2026-07-14T23:00:30.000Z",
    exitCode: 1,
    signal: null,
    events: [],
    recordJson: "{}",
    humanAssistanceContract: null,
    scheduledAtUtc: "2026-07-14T23:00:00.000Z",
    ...overrides,
  };
}

test("a scheduled user-action failure names the source and the action", () => {
  const failed = run({ appWorkflowOutcome: { errorCode: "device-registration-required", summary: null } });
  assert.deepEqual(scheduledRunNotification(failed, "en"), {
    credentialGroupId: "tdcc",
    title: "TDCC e-Passbook",
    body: "This source no longer trusts this device. Register the device again in sign-in settings.",
  });
  assert.equal(scheduledRunNotification(failed, "zh-TW")?.title, "集保e手掌握（TDCC e-Passbook）");
});

test("transient, manual, and source-less outcomes send no notification", () => {
  for (const errorCode of ["source-unavailable", "collection-scope-changed", "cancelled"] as const) {
    assert.equal(scheduledRunNotification(run({ appWorkflowOutcome: { errorCode, summary: null } }), "en"), null, errorCode);
  }
  assert.equal(scheduledRunNotification(run({ status: "completed", appWorkflowOutcome: null }), "en"), null);
  assert.equal(
    scheduledRunNotification(run({
      scheduledAtUtc: undefined,
      appWorkflowOutcome: { errorCode: "device-registration-required", summary: null },
    }), "en"),
    null,
    "a manual or Sync all run never notifies",
  );
  assert.equal(
    scheduledRunNotification(run({
      taskId: "exchange-rates",
      appWorkflowOutcome: { errorCode: "provider-protocol-outdated", summary: null },
    }), "en"),
    null,
    "exchange rates have their own schedule and no sign-in settings",
  );
});

test("scheduled collection takes enabled, ready, idle sources from the Sync all selection", () => {
  const enabledGroupIds = new Set(["fubon", "sinopac", "tdcc"]);
  const enabledGroups = Object.fromEntries(
    AUTOMATION_CREDENTIAL_GROUPS.map((group) => [group.id, enabledGroupIds.has(group.id)]),
  );
  const credentials = Object.fromEntries(
    AUTOMATION_TASKS.flatMap((task) => task.credentialKeys).map((key) => [key, true]),
  );
  const model = buildAutomationPageModel({
    tasks: enabledAutomationTasks(enabledGroups),
    latestRuns: {},
    activeTaskIds: ["sinopac-statements"],
    credentials,
    active: true,
    businessDate: "2026-07-15",
  });
  assert.deepEqual(scheduledCollectionTaskIds(model), ["fubon-all-statements", "sync-tdcc"]);
});
