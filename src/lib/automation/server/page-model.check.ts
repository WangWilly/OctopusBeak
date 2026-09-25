import assert from "node:assert/strict";
import { statementRunSummaryLine } from "../statement-run-summary.ts";
import { buildAutomationPageModel } from "./page-model.ts";
import { AUTOMATION_TASKS } from "./tasks.ts";
import type { AutomationTaskRun } from "./store.ts";

const completedRun: AutomationTaskRun = {
  taskRunId: "run-1",
  taskId: "fubon-all-statements",
  script: "run:fubon-all-statements",
  kind: "crawler",
  status: "completed",
  attempt: 1,
  maxAttempts: 2,
  startedAt: "2026-06-30T01:00:00.000Z",
  finishedAt: "2026-06-30T01:01:00.000Z",
  exitCode: 0,
  signal: null,
  errorMessage: null,
  logPath: "data/automation/logs/run-1.log",
  logTail: "ok",
  events: [],
  recordJson: "{}",
  humanAssistanceContract: null,
};

const credentials = {
  LIBRETTO_CLOUD_FUBON_USER_ID: true,
  LIBRETTO_CLOUD_FUBON_ACCOUNT: true,
  LIBRETTO_CLOUD_FUBON_PASSWORD: true,
  MAX_ACCESS_KEY: false,
};

const model = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: { "fubon-all-statements": completedRun },
  todayRunTaskIds: ["fubon-all-statements"],
  credentials,
  active: false,
  businessDate: "2026-06-30",
});

assert.equal(model.tasks.length, AUTOMATION_TASKS.length);

const fubonRow = model.tasks.find((task) => task.id === "fubon-all-statements");
assert.equal(fubonRow?.status, "completed");
assert.equal(fubonRow?.primaryAction, "Run");
assert.equal(fubonRow?.ranToday, true);
assert.equal(fubonRow?.logTail, "ok");
assert.equal(Object.hasOwn(model, "runHistory"), false);
assert.equal(model.parallelRunnableTaskIds.includes("fubon-all-statements"), true);
assert.equal(model.parallelRunnableTaskIds.includes("esun-credit-card-statements"), false);

const typedTask = AUTOMATION_TASKS.find((task) => task.workflowId);
assert.ok(typedTask, "at least one task should expose the typed workflow contract");
const typedRunId = "typed-run";
const typedRowModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {
    [typedTask.id]: {
      ...completedRun,
      taskRunId: typedRunId,
      taskId: typedTask.id,
      script: typedTask.script,
      events: [
        {
          runId: typedRunId,
          stage: "authentication",
          code: "authentication-completed",
          occurredAt: "2026-06-30T01:00:01.000Z",
        },
        {
          runId: typedRunId,
          stage: "collection",
          code: "source-collected",
          occurredAt: "2026-06-30T01:00:02.000Z",
          completed: 2,
          total: 2,
          accountNumber: "must-not-cross-renderer-boundary",
        } as AutomationTaskRun["events"][number],
      ],
    },
  },
  credentials: {},
  active: false,
  businessDate: "2026-06-30",
});
const typedRow = typedRowModel.tasks.find((task) => task.id === typedTask.id);
assert.equal(typedRow?.eventDisplayMode, "structured");
assert.deepEqual(typedRow?.events, [
  {
    runId: typedRunId,
    stage: "authentication",
    code: "authentication-completed",
    occurredAt: "2026-06-30T01:00:01.000Z",
  },
  {
    runId: typedRunId,
    stage: "collection",
    code: "source-collected",
    occurredAt: "2026-06-30T01:00:02.000Z",
    completed: 2,
    total: 2,
  },
]);
assert.equal(typedRow?.events[0]?.code, "authentication-completed");
assert.equal(typedRow?.events[1]?.code, "source-collected");
assert.equal(
  Object.hasOwn(typedRow?.events[1] ?? {}, "accountNumber"),
  false,
  "only the typed event fields may cross into the renderer model",
);
const typedNoRecentEvents = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {
    [typedTask.id]: {
      ...completedRun,
      taskRunId: "typed-run-after-retention",
      taskId: typedTask.id,
      script: typedTask.script,
      logPath: "",
      logTail: "",
      events: [],
    },
  },
  credentials: {},
  active: false,
  businessDate: "2026-06-30",
});
const typedNoRecentEventsRow = typedNoRecentEvents.tasks.find(
  (task) => task.id === typedTask.id,
);
assert.equal(typedNoRecentEventsRow?.eventDisplayMode, "structured");
assert.deepEqual(typedNoRecentEventsRow?.events, []);
const boundedEventsModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {
    [typedTask.id]: {
      ...completedRun,
      taskRunId: "typed-run-bounded",
      taskId: typedTask.id,
      script: typedTask.script,
      events: Array.from({ length: 205 }, (_, index) => ({
        runId: "typed-run-bounded",
        stage: "collection" as const,
        code: `source-${index}`,
        occurredAt: `2026-06-30T01:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      })),
    },
  },
  credentials: {},
  active: false,
  businessDate: "2026-06-30",
});
const boundedEventsRow = boundedEventsModel.tasks.find(
  (task) => task.id === typedTask.id,
);
assert.equal(boundedEventsRow?.events.length, 200);
assert.equal(boundedEventsRow?.events[0]?.code, "source-5");
assert.equal(boundedEventsRow?.events.at(-1)?.code, "source-204");

for (const credentialState of ["loading", "missing", "read_failed"] as const) {
  const blockedModel = buildAutomationPageModel({
    tasks: AUTOMATION_TASKS,
    latestRuns: {},
    credentials: Object.fromEntries(
      AUTOMATION_TASKS.find((task) => task.id === "fubon-all-statements")!.credentialKeys
        .map((key) => [key, true]),
    ),
    credentialStates: Object.fromEntries(
      AUTOMATION_TASKS.find((task) => task.id === "fubon-all-statements")!.credentialKeys
        .map((key) => [key, credentialState]),
    ),
    active: false,
    businessDate: "2026-06-30",
  });
  assert.equal(
    blockedModel.tasks.find((task) => task.id === "fubon-all-statements")?.canRun,
    false,
    `${credentialState} credentials must disable Run`,
  );
}

const readyModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {},
  credentials: Object.fromEntries(
    AUTOMATION_TASKS.find((task) => task.id === "fubon-all-statements")!.credentialKeys
      .map((key) => [key, true]),
  ),
  credentialStates: Object.fromEntries(
    AUTOMATION_TASKS.find((task) => task.id === "fubon-all-statements")!.credentialKeys
      .map((key) => [key, "ready"]),
  ),
  active: false,
  businessDate: "2026-06-30",
});
assert.equal(
  readyModel.tasks.find((task) => task.id === "fubon-all-statements")?.canRun,
  true,
);

const setupRequiredModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {},
  credentials: {},
  setupRequiredGroupIds: new Set(["fubon"]),
  active: false,
  businessDate: "2026-06-30",
});
const setupRequiredFubon = setupRequiredModel.tasks.find(
  (task) => task.id === "fubon-all-statements",
);
assert.equal(setupRequiredFubon?.status, "needs_setup");
assert.equal(setupRequiredFubon?.progressText, "Needs setup");
assert.equal(setupRequiredFubon?.primaryAction, "Configure");
assert.equal(setupRequiredModel.parallelRunnableTaskIds.includes("fubon-all-statements"), false);

const activeModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {
    "fubon-all-statements": {
      ...completedRun,
      taskRunId: "run-active",
      status: "running",
      finishedAt: null,
      logTail: "automation-progress: 42\nCollecting and writing canonical data",
    },
  },
  activeTaskIds: ["fubon-all-statements"],
  todayRunTaskIds: ["fubon-all-statements", "esun-credit-card-statements"],
  credentials: {},
  active: true,
  businessDate: "2026-06-30",
});
const activeFubonRow = activeModel.tasks.find((task) => task.id === "fubon-all-statements");
assert.equal(activeModel.activeTaskCount, 1);
assert.equal(activeFubonRow?.isActive, true);
assert.equal(activeFubonRow?.canRun, true);
assert.equal(activeFubonRow?.primaryAction, "Cancel");
assert.equal(activeFubonRow?.progressPercent, null);
assert.equal(activeFubonRow?.progressText, "Running attempt 1/2");
assert.equal(activeModel.parallelRunnableTaskIds.includes("fubon-all-statements"), false);

const legacyWaitingTask = AUTOMATION_TASKS.find((task) => task.workflowId);
assert.ok(legacyWaitingTask, "a migrated task is needed to cover an old waiting run");
const waitingModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {
    [legacyWaitingTask.id]: {
      ...completedRun,
      taskRunId: "run-legacy-waiting",
      taskId: legacyWaitingTask.id,
      script: legacyWaitingTask.script,
      status: "waiting_for_human",
      finishedAt: null,
      logTail: 'Resume requested for session "ses-help".',
    },
  },
  todayRunTaskIds: [legacyWaitingTask.id],
  credentials: {},
  active: true,
  businessDate: "2026-06-30",
});
const waitingRow = waitingModel.tasks.find((task) => task.id === legacyWaitingTask.id);
assert.equal(waitingRow?.status, "waiting_for_human");
assert.equal(waitingRow?.primaryAction, "Cancel");
assert.equal(waitingRow?.humanSession, null);

const typedWaitingModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {
    [typedTask.id]: {
      ...completedRun,
      taskRunId: typedRunId,
      taskId: typedTask.id,
      script: typedTask.script,
      status: "waiting_for_human",
      finishedAt: null,
      logTail: 'Resume requested for session "ses-legacy-log".',
      events: [
        {
          runId: typedRunId,
          stage: "authentication",
          code: "human-assistance-requested",
          occurredAt: "2026-06-30T01:00:01.000Z",
        },
      ],
    },
  },
  credentials: {},
  active: true,
  businessDate: "2026-06-30",
});
const typedWaitingRow = typedWaitingModel.tasks.find((task) => task.id === typedTask.id);
assert.equal(typedWaitingRow?.status, "waiting_for_human");
assert.equal(typedWaitingRow?.humanSession, typedRunId);

const failedModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {
    "hncb-statements": {
      ...completedRun,
      taskRunId: "run-failed",
      taskId: "hncb-statements",
      script: "run:hncb-statements",
      status: "failed",
      exitCode: 1,
      errorMessage: "Task exited with code 1",
    },
  },
  credentials: {},
  active: false,
  businessDate: "2026-06-30",
});
const failedRow = failedModel.tasks.find((task) => task.id === "hncb-statements");
assert.equal(failedRow?.status, "failed");
assert.equal(failedRow?.primaryAction, "Run again");
assert.equal(failedRow?.canRun, false);

const partialModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {
    "fubon-all-statements": {
      ...completedRun,
      status: "partial",
      logTail: `canonical write partial\n${statementRunSummaryLine([
        { typeId: "deposit", status: "success" },
        { typeId: "loan", status: "failed", error: "no account" },
        { typeId: "fund", status: "skipped" },
      ])}`,
    },
  },
  credentials: {},
  active: false,
  businessDate: "2026-06-30",
});
const partialRow = partialModel.tasks.find((task) => task.id === "fubon-all-statements");
assert.equal(partialRow?.status, "partial");
assert.equal(partialRow?.primaryAction, "Run");
assert.equal(partialRow?.progressText, "Partial");
assert.deepEqual(partialRow?.statementFailures, [{ typeId: "loan", error: "no account" }]);
