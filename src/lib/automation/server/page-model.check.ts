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
  credentials: {},
  importGate: {
    locked: true,
    missingTaskIds: [],
  },
  active: false,
  businessDate: "2026-06-30",
});

const failedRow = failedModel.tasks.find((task) => task.id === "hncb-statements");
assert.equal(failedRow?.primaryAction, "Retry");
assert.equal(failedRow?.canRun, true);
