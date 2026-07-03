import assert from "node:assert/strict";
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
  runHistory: [],
  credentials: {
    LIBRETTO_CLOUD_FUBON_USER_ID: true,
    MAX_ACCESS_KEY: false,
  },
  importGate: {
    locked: true,
    missingTaskIds: ["esun-credit-card-statements"],
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
  runHistory: [],
  credentials: {},
  importGate: {
    locked: true,
    missingTaskIds: [],
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
  runHistory: [{
    taskRunId: "run-3",
    taskId: "fubon-all-statements",
    script: "run:fubon-all-statements",
    kind: "crawler",
    status: "running",
    startedAt: "2026-06-30T01:00:00.000Z",
    finishedAt: null,
    exitCode: null,
    signal: null,
    errorMessage: null,
    logPath: "data/automation/logs/run-3.log",
  }],
  credentials: {},
  importGate: {
    locked: true,
    missingTaskIds: [],
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
assert.equal(activeModel.runHistory.length, 1);
assert.equal(activeModel.runHistory[0]?.taskId, "fubon-all-statements");

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
  runHistory: [],
  credentials: {},
  importGate: {
    locked: true,
    missingTaskIds: [],
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
  runHistory: [],
  credentials: {},
  importGate: {
    locked: true,
    missingTaskIds: [],
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
