import assert from "node:assert/strict";
import test from "node:test";
import {
  TYPED_WORKFLOW_ERROR_CODES,
  userActionForFailure,
  type TypedWorkflowErrorCode,
  type UserAction,
} from "../workflow-failures.ts";
import { buildAutomationPageModel } from "./page-model.ts";
import type { AutomationRuntime } from "./automation-runtime.ts";
import { collectionNotification, runAndSummarize, type CollectionResult } from "./collection-summary.ts";
import { scheduledCollectionTaskIds, startScheduledCollection } from "./scheduled-collection.ts";
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
  "external-prerequisite-unavailable": null,
  "source-collection-failed": null,
  "canonical-commit-failed": null,
  "canonical-reset-required": "delete-financial-data",
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
    events: [],
    recordJson: "{}",
    humanAssistanceContract: null,
    scheduledAtUtc: "2026-07-14T23:00:00.000Z",
    ...overrides,
  };
}

const completed = (taskId: string): CollectionResult => ({
  taskId,
  run: run({ taskId, status: "completed", appWorkflowOutcome: null }),
});
const failed = (taskId: string, errorCode: TypedWorkflowErrorCode): CollectionResult => ({
  taskId,
  run: run({ taskId, appWorkflowOutcome: { errorCode, summary: null } }),
});

test("an occurrence where every source synced says so and opens the overview", () => {
  const results = [completed("sync-tdcc"), completed("fubon-all-statements")];
  assert.deepEqual(collectionNotification(results, "scheduled", "en"), {
    title: "Automatic sync finished",
    body: "Synced 2 sources.",
    target: { route: "overview" },
  });
  assert.equal(collectionNotification([completed("sync-tdcc")], "scheduled", "en")?.body, "Synced 1 source.");
  assert.deepEqual(collectionNotification(results, "scheduled", "zh-TW"), {
    title: "自動同步完成",
    body: "已同步 2 個來源。",
    target: { route: "overview" },
  });
});

test("transient failures are named in the summary and open the run history", () => {
  const results = [
    completed("sync-tdcc"),
    failed("fubon-all-statements", "source-unavailable"),
    { taskId: "sinopac-statements", run: null },
  ];
  assert.deepEqual(collectionNotification(results, "scheduled", "en"), {
    title: "Automatic sync finished; 2 sources did not sync",
    body: "Taipei Fubon Bank, Bank SinoPac did not sync. The next automatic sync tries again. 1 other source synced.",
    target: { route: "automation", credentialGroupId: null },
  });
  assert.deepEqual(collectionNotification(results, "scheduled", "zh-TW"), {
    title: "自動同步完成，2 個來源沒有同步成功",
    body: "台北富邦銀行（Taipei Fubon Bank）、永豐銀行（Bank SinoPac）沒有同步成功，下次自動同步會再試。其他 1 個來源已同步。",
    target: { route: "automation", credentialGroupId: null },
  });
  assert.equal(
    collectionNotification([run({ status: "partial", appWorkflowOutcome: null })].map((partial) => ({
      taskId: "sync-tdcc",
      run: partial,
    })), "scheduled", "en")?.title,
    "Automatic sync finished; 1 source did not sync",
    "a partial run did not finish syncing",
  );
});

test("a lone source that needs the person names its action and opens its sign-in settings", () => {
  const results = [completed("fubon-all-statements"), failed("sync-tdcc", "device-registration-required")];
  assert.deepEqual(collectionNotification(results, "scheduled", "en"), {
    title: "Automatic sync needs you",
    body: "TDCC e-Passbook: This source no longer trusts this device. Register the device again in sign-in settings.",
    target: { route: "automation", credentialGroupId: "tdcc" },
  });
  assert.equal(
    collectionNotification(results, "scheduled", "zh-TW")?.body,
    "集保e手掌握（TDCC e-Passbook）：這個來源不再信任這台裝置。請到登入設定重新註冊裝置。",
  );
  assert.deepEqual(
    collectionNotification([failed("fubon-all-statements", "canonical-reset-required")], "scheduled", "en")?.target,
    { route: "settings", focus: "financial-data-deletion" },
    "deleting financial data happens in Settings",
  );
});

test("several sources that need the person outrank transient failures, which are still counted", () => {
  const results = [
    failed("sync-tdcc", "authentication-failed"),
    failed("fubon-all-statements", "provider-protocol-outdated"),
    failed("sinopac-statements", "source-unavailable"),
  ];
  assert.deepEqual(collectionNotification(results, "scheduled", "en"), {
    title: "Automatic sync needs you",
    body: "TDCC e-Passbook, Taipei Fubon Bank need your attention. 1 more source did not sync.",
    target: { route: "automation", credentialGroupId: null },
  });
  assert.equal(
    collectionNotification(results, "scheduled", "zh-TW")?.body,
    "集保e手掌握（TDCC e-Passbook）、台北富邦銀行（Taipei Fubon Bank）需要你處理。另有 1 個來源沒有同步成功。",
  );
});

test("a long list names three sources and counts the rest", () => {
  const taskIds = ["sync-tdcc", "fubon-all-statements", "sinopac-statements", "sync-maicoin", "linebank-statements"];
  const results = taskIds.map((taskId) => failed(taskId, "source-unavailable"));
  assert.match(
    collectionNotification(results, "scheduled", "en")!.body,
    /^TDCC e-Passbook, Taipei Fubon Bank, Bank SinoPac and 2 more did not sync\./,
  );
  assert.match(collectionNotification(results, "scheduled", "zh-TW")!.body, /永豐銀行（Bank SinoPac） 等 5 個來源沒有同步成功/);
  assert.equal(collectionNotification([], "scheduled", "en"), null, "an occurrence with nothing due sends nothing");
});

test("scheduled collection reports once, after every started source ends", async () => {
  const settledLater: (() => void)[] = [];
  const reports: CollectionResult[][] = [];
  const runtime = {
    provider: {
      automation: {
        hasOccurrenceBeenAttempted: async (taskId: string) => taskId === "sync-maicoin",
        hasSuccessfulTaskRunSince: async () => false,
      },
    },
    desktopModel: async () => ({
      automation: {
        parallelRunnableTaskIds: [
          "sync-tdcc", "fubon-all-statements", "sinopac-statements", "sync-maicoin", "linebank-statements", "exchange-rates",
        ],
      },
    }),
    runMany: async (
      taskIds: string[],
      options: { scheduledAtUtc?: string; onSettled?: (taskId: string, run: AutomationTaskRun | null) => void },
    ) => {
      assert.deepEqual(taskIds, ["sync-tdcc", "fubon-all-statements", "sinopac-statements", "linebank-statements"]);
      assert.equal(options.scheduledAtUtc, "2026-07-14T23:00:00.000Z");
      // One source ends before runMany returns; another ends later.
      options.onSettled!("sync-tdcc", run({ status: "completed", appWorkflowOutcome: null }));
      settledLater.push(() => options.onSettled!("fubon-all-statements", null));
      return {
        started: ["sync-tdcc", "fubon-all-statements"],
        results: {
          "sync-tdcc": { status: "started" as const, runId: "a" },
          "fubon-all-statements": { status: "started" as const, runId: "b" },
          "sinopac-statements": { status: "already_running" as const, runId: "c" },
          "linebank-statements": { status: "error" as const, error: "could not start" },
        },
      };
    },
  } as unknown as AutomationRuntime;

  await startScheduledCollection(runtime, "2026-07-14T23:00:00.000Z", (results) => reports.push(results));
  assert.equal(reports.length, 0, "waits for the source still running");
  settledLater.forEach((settle) => settle());
  assert.deepEqual(reports.map((results) => results.map(({ taskId, run }) => [taskId, run?.status ?? null])), [[
    ["sync-tdcc", "completed"],
    ["fubon-all-statements", null],
    ["linebank-statements", null],
  ]], "a manual run already in progress is not part of the occurrence");
});

test("a manual sync uses the same summary without promising an automatic retry", () => {
  assert.deepEqual(collectionNotification([completed("sync-tdcc")], "manual", "en"), {
    title: "Sync finished",
    body: "Synced 1 source.",
    target: { route: "overview" },
  });
  const transient = [completed("sync-tdcc"), failed("fubon-all-statements", "source-unavailable")];
  assert.deepEqual(collectionNotification(transient, "manual", "zh-TW"), {
    title: "同步完成，1 個來源沒有同步成功",
    body: "台北富邦銀行（Taipei Fubon Bank）沒有同步成功，原因可到執行紀錄查看。其他 1 個來源已同步。",
    target: { route: "automation", credentialGroupId: null },
  });
  assert.equal(
    collectionNotification(transient, "manual", "en")?.body,
    "Taipei Fubon Bank did not sync. Run history shows why. 1 other source synced.",
  );
  assert.equal(
    collectionNotification([failed("sync-tdcc", "authentication-failed")], "manual", "zh-TW")?.title,
    "同步需要你處理",
  );
});

test("runs the person cancelled or the App stopped are left out of the summary", () => {
  const stopped = (taskId: string, status: "cancelled" | "interrupted") => ({
    taskId,
    run: run({ taskId, status, appWorkflowOutcome: { errorCode: "cancelled", summary: null } }),
  });
  assert.equal(
    collectionNotification([stopped("sync-tdcc", "interrupted"), stopped("sinopac-statements", "cancelled")], "scheduled", "en"),
    null,
    "quitting or erasing data mid-sync sends nothing",
  );
  assert.equal(
    collectionNotification([completed("fubon-all-statements"), stopped("sync-tdcc", "interrupted")], "manual", "en")?.body,
    "Synced 1 source.",
  );
});

test("a batch leaves out exchange rates and tasks it did not start", async () => {
  const reports: CollectionResult[][] = [];
  const runtime = {
    runMany: async (
      taskIds: string[],
      options: { onSettled?: (taskId: string, run: AutomationTaskRun | null) => void },
    ) => {
      assert.deepEqual(taskIds, ["exchange-rates", "sync-tdcc"]);
      options.onSettled!("exchange-rates", run({ taskId: "exchange-rates", status: "completed" }));
      options.onSettled!("sync-tdcc", run({ status: "completed", appWorkflowOutcome: null }));
      return {
        started: ["exchange-rates", "sync-tdcc"],
        results: {
          "exchange-rates": { status: "started" as const, runId: "x" },
          "sync-tdcc": { status: "started" as const, runId: "a" },
        },
      };
    },
  };
  await runAndSummarize(runtime, ["exchange-rates", "sync-tdcc"], {}, (results) => reports.push(results));
  assert.deepEqual(reports.map((results) => results.map(({ taskId }) => taskId)), [["sync-tdcc"]]);

  const none = { runMany: async () => ({ started: [], results: {} }) };
  await runAndSummarize(none, ["exchange-rates"], {}, (results) => reports.push(results));
  assert.equal(reports.length, 1, "a batch without a source reports nothing");
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

test("a source the store refuses until a Canonical Reset notifies once, then scheduled collection skips it until the reset", () => {
  const credentials = Object.fromEntries(
    AUTOMATION_TASKS.flatMap((task) => task.credentialKeys).map((key) => [key, true]),
  );
  const refused = run({
    taskId: "fubon-all-statements",
    status: "partial",
    appWorkflowOutcome: { errorCode: "canonical-reset-required", summary: null },
  });
  const notice = collectionNotification([{ taskId: refused.taskId, run: refused }], "scheduled", "en");
  assert.deepEqual(notice?.target, { route: "settings", focus: "financial-data-deletion" });
  assert.match(notice!.body, /^Taipei Fubon Bank: The data format was updated/);

  const model = (resetRequired: readonly string[]) => buildAutomationPageModel({
    tasks: enabledAutomationTasks(Object.fromEntries(
      AUTOMATION_CREDENTIAL_GROUPS.map((group) => [group.id, group.id === "fubon" || group.id === "tdcc"]),
    )),
    latestRuns: { "fubon-all-statements": refused },
    credentials,
    canonicalResetRequiredNamespaces: new Set(resetRequired),
    active: false,
    businessDate: "2026-07-15",
  });
  assert.deepEqual(scheduledCollectionTaskIds(model(["fubon"])), ["sync-tdcc"], "skipped while the store refuses");
  assert.deepEqual(
    scheduledCollectionTaskIds(model([])),
    ["fubon-all-statements", "sync-tdcc"],
    "collected again once a Canonical Reset removed the old data",
  );
});
