import assert from "node:assert/strict";
import { statementRunSummaryLine } from "../statement-run-summary.ts";
import { buildAutomationPageModel } from "./page-model.ts";
import { AUTOMATION_TASKS } from "./tasks.ts";
import type { AutomationTaskRun } from "./store.ts";

const latestRuns: Record<string, AutomationTaskRun> = {
  "fubon-all-statements": {
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
    recordJson: "{}",
  },
};

const model = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns,
  activeTaskIds: [],
  todayRunTaskIds: ["fubon-all-statements"],
  credentials: {
    LIBRETTO_CLOUD_FUBON_USER_ID: true,
    LIBRETTO_CLOUD_FUBON_ACCOUNT: true,
    LIBRETTO_CLOUD_FUBON_PASSWORD: true,
    MAX_ACCESS_KEY: false,
  },
  importGate: {
    locked: true,
    missingTaskIds: ["esun-credit-card-statements"],
    warnings: [],
  },
  active: false,
  businessDate: "2026-06-30",
});

const importRow = model.tasks.find((task) => task.id === "import-downloads-csv");
assert.equal(importRow?.status, "locked");
assert.equal(importRow?.primaryAction, "Locked");
assert.equal(importRow?.canRun, false);

const fubonRow = model.tasks.find((task) => task.id === "fubon-all-statements");
assert.equal(fubonRow?.status, "completed");
assert.equal(fubonRow?.primaryAction, "Run");
assert.equal(fubonRow?.ranToday, true);
assert.equal(fubonRow?.logTail, "ok");
assert.equal(Object.hasOwn(model, "runHistory"), false);
assert.equal(model.parallelRunnableTaskIds.includes("fubon-all-statements"), true);
assert.equal(model.parallelRunnableTaskIds.includes("esun-credit-card-statements"), false);
assert.equal(model.parallelRunnableTaskIds.includes("import-downloads-csv"), false);

const setupRequiredModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns,
  activeTaskIds: [],
  todayRunTaskIds: [],
  credentials: {},
  importGate: { locked: false, missingTaskIds: [], warnings: [] },
  setupRequiredGroupIds: new Set(["fubon"]),
  active: false,
  businessDate: "2026-06-30",
});
const setupRequiredFubon = setupRequiredModel.tasks.find((task) => task.id === "fubon-all-statements");
assert.equal(setupRequiredFubon?.status, "needs_setup");
assert.equal(setupRequiredFubon?.primaryAction, "Configure");
assert.equal(setupRequiredFubon?.canRun, true);
assert.equal(setupRequiredModel.parallelRunnableTaskIds.includes("fubon-all-statements"), false);

const activeSetupRequiredModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {
    "fubon-all-statements": {
      ...latestRuns["fubon-all-statements"],
      status: "running",
      finishedAt: null,
    },
  },
  activeTaskIds: ["fubon-all-statements"],
  todayRunTaskIds: [],
  credentials: {},
  importGate: { locked: false, missingTaskIds: [], warnings: [] },
  setupRequiredGroupIds: new Set(["fubon"]),
  active: true,
  businessDate: "2026-06-30",
});
const activeSetupRequiredRow = activeSetupRequiredModel.tasks.find(
  (task) => task.id === "fubon-all-statements",
);
assert.equal(activeSetupRequiredRow?.status, "running");
assert.equal(activeSetupRequiredRow?.primaryAction, "Cancel");

const waitingSetupRequiredModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {
    "fubon-all-statements": {
      ...latestRuns["fubon-all-statements"],
      status: "waiting_for_human",
      finishedAt: null,
      logTail: "Workflow paused. Run `npx libretto resume --session ses-repair`.",
    },
  },
  activeTaskIds: [],
  todayRunTaskIds: [],
  credentials: {},
  importGate: { locked: false, missingTaskIds: [], warnings: [] },
  setupRequiredGroupIds: new Set(["fubon"]),
  active: true,
  businessDate: "2026-06-30",
});
const waitingSetupRequiredRow = waitingSetupRequiredModel.tasks.find(
  (task) => task.id === "fubon-all-statements",
);
assert.equal(waitingSetupRequiredRow?.status, "waiting_for_human");
assert.equal(waitingSetupRequiredRow?.humanSession, "ses-repair");

const unlockedImportModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns,
  activeTaskIds: [],
  todayRunTaskIds: ["fubon-all-statements"],
  credentials: {},
  importGate: {
    locked: false,
    missingTaskIds: [],
    warnings: [],
  },
  active: false,
  businessDate: "2026-06-30",
});
assert.equal(unlockedImportModel.parallelRunnableTaskIds.includes("import-downloads-csv"), true);

const failedModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {
    "hncb-statements": {
      ...latestRuns["fubon-all-statements"],
      taskRunId: "run-2",
      taskId: "hncb-statements",
      script: "run:hncb-statements",
      status: "failed",
      exitCode: 1,
      errorMessage: "Task exited with code 1",
    },
  },
  activeTaskIds: [],
  todayRunTaskIds: ["fubon-all-statements"],
  credentials: {},
  importGate: {
    locked: true,
    missingTaskIds: [],
    warnings: [],
  },
  active: false,
  businessDate: "2026-06-30",
});

const failedRow = failedModel.tasks.find((task) => task.id === "hncb-statements");
assert.equal(failedRow?.primaryAction, "Run again");
assert.equal(failedRow?.canRun, true);

const activeModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {
    "fubon-all-statements": {
      ...latestRuns["fubon-all-statements"],
      taskRunId: "run-3",
      status: "running",
      finishedAt: null,
      logTail: "automation-progress: 42\nDownloading statements",
    },
  },
  activeTaskIds: ["fubon-all-statements"],
  todayRunTaskIds: ["fubon-all-statements", "esun-credit-card-statements"],
  credentials: {},
  importGate: {
    locked: true,
    missingTaskIds: [],
    warnings: [],
  },
  active: true,
  businessDate: "2026-06-30",
});

const activeFubonRow = activeModel.tasks.find((task) => task.id === "fubon-all-statements");
const activeEsunRow = activeModel.tasks.find((task) => task.id === "esun-credit-card-statements");
assert.equal(activeModel.activeTaskCount, 1);
assert.equal(activeFubonRow?.isActive, true);
assert.equal(activeFubonRow?.canRun, true);
assert.equal(activeFubonRow?.primaryAction, "Cancel");
assert.equal(activeFubonRow?.ranToday, true);
assert.equal(activeFubonRow?.progressPercent, 42);
assert.equal(activeFubonRow?.progressText, "42%");
assert.equal(activeEsunRow?.canRun, true);
assert.equal(activeEsunRow?.ranToday, true);
assert.equal(activeModel.parallelRunnableTaskIds.includes("fubon-all-statements"), false);
assert.equal(activeModel.parallelRunnableTaskIds.includes("esun-credit-card-statements"), false);

const waitingModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {
    "fubon-all-statements": {
      ...latestRuns["fubon-all-statements"],
      taskRunId: "run-waiting",
      status: "waiting_for_human",
      finishedAt: null,
      logTail: 'Workflow paused. Resume with session "ses-help".',
    },
  },
  activeTaskIds: [],
  todayRunTaskIds: ["fubon-all-statements"],
  credentials: {},
  importGate: {
    locked: true,
    missingTaskIds: [],
    warnings: [],
  },
  active: true,
  businessDate: "2026-06-30",
});

const waitingRow = waitingModel.tasks.find((task) => task.id === "fubon-all-statements");
assert.equal(waitingRow?.status, "waiting_for_human");
assert.equal(waitingRow?.primaryAction, "Cancel");
assert.equal(waitingRow?.canRun, true);
assert.equal(waitingModel.parallelRunnableTaskIds.includes("fubon-all-statements"), false);

const staleRunningModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {
    "yuanta-all-statements": {
      ...latestRuns["fubon-all-statements"],
      taskRunId: "run-stale",
      taskId: "yuanta-all-statements",
      script: "npx libretto resume --session ses-xuzf",
      status: "running",
      finishedAt: null,
      exitCode: null,
      logTail: 'Resume requested for session "ses-xuzf".',
    },
  },
  activeTaskIds: [],
  todayRunTaskIds: ["fubon-all-statements"],
  credentials: {},
  importGate: {
    locked: true,
    missingTaskIds: [],
    warnings: [],
  },
  active: false,
  businessDate: "2026-06-30",
});

const staleRunningRow = staleRunningModel.tasks.find(
  (task) => task.id === "yuanta-all-statements",
);
assert.equal(staleRunningRow?.status, "failed");
assert.equal(staleRunningRow?.primaryAction, "Run again");

const failedResumeModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {
    "yuanta-all-statements": {
      ...latestRuns["fubon-all-statements"],
      taskRunId: "run-4",
      taskId: "yuanta-all-statements",
      script: "npx libretto resume --session ses-1p4q",
      status: "running",
      finishedAt: null,
      exitCode: null,
      logTail:
        'Workflow failed after resume: Could not find selector "input[name=\\"qry_option\\"]".',
    },
  },
  activeTaskIds: [],
  todayRunTaskIds: ["fubon-all-statements"],
  credentials: {},
  importGate: {
    locked: true,
    missingTaskIds: [],
    warnings: [],
  },
  active: false,
  businessDate: "2026-06-30",
});

const failedResumeRow = failedResumeModel.tasks.find(
  (task) => task.id === "yuanta-all-statements",
);
assert.equal(failedResumeRow?.status, "failed");
assert.equal(failedResumeRow?.primaryAction, "Run again");
assert.equal(failedResumeRow?.progressText, "Failed");

const partialModel = buildAutomationPageModel({
  tasks: AUTOMATION_TASKS,
  latestRuns: {
    "fubon-all-statements": {
      ...latestRuns["fubon-all-statements"],
      status: "partial",
      logTail: `download finished\n${statementRunSummaryLine([
        { typeId: "deposit", status: "success" },
        { typeId: "loan", status: "failed", error: "no account" },
        { typeId: "fund", status: "skipped" },
      ])}`,
    },
  },
  activeTaskIds: [],
  todayRunTaskIds: ["fubon-all-statements"],
  credentials: {},
  importGate: { locked: false, missingTaskIds: [], warnings: [] },
  active: false,
  businessDate: "2026-06-30",
});

const partialRow = partialModel.tasks.find((task) => task.id === "fubon-all-statements");
assert.equal(partialRow?.status, "partial");
assert.equal(partialRow?.primaryAction, "Run");
assert.equal(partialRow?.progressText, "Partial");
assert.deepEqual(partialRow?.statementFailures, [{ typeId: "loan", error: "no account" }]);
