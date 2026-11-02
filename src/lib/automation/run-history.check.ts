import assert from "node:assert/strict";
import test from "node:test";
import {
  filterHistoryToCurrentTasks,
  formatDuration,
  historyCounts,
  historyStatusGroup,
  historyTaskLabel,
  visibleHistoryRows,
} from "./run-history.ts";
import type { AutomationTaskHistoryRow } from "./types.ts";

const tasks = [
  { id: "cathay", displayName: { en: "Cathay United Bank", "zh-TW": "國泰世華" }, credentialGroupId: "cathay" },
  { id: "esun", displayName: { en: "E.SUN Bank", "zh-TW": "玉山銀行" } },
];

function run(taskId: string, status: AutomationTaskHistoryRow["status"], taskRunId = `${taskId}-${status}`): AutomationTaskHistoryRow {
  return {
    taskRunId,
    taskId,
    kind: "crawler",
    status,
    startedAt: "2026-10-05T08:00:00.000Z",
    finishedAt: "2026-10-05T08:01:05.000Z",
    appWorkflowOutcome: null,
  };
}

test("a run of a task the catalog no longer offers leaves the history", () => {
  const rows = [run("cathay", "completed"), run("retired-source", "failed")];
  assert.deepEqual(filterHistoryToCurrentTasks(rows, tasks).map((row) => row.taskId), ["cathay"]);
});

test("statuses fold into running, completed, and failed groups", () => {
  assert.equal(historyStatusGroup("completed"), "completed");
  assert.equal(historyStatusGroup("partial"), "completed");
  assert.equal(historyStatusGroup("failed"), "failed");
  assert.equal(historyStatusGroup("locked"), "failed");
  assert.equal(historyStatusGroup("queued"), "running");
  assert.equal(historyStatusGroup("waiting_for_human"), "running");
});

test("counts group every row once", () => {
  const rows = [run("cathay", "completed"), run("cathay", "partial", "p"), run("esun", "failed"), run("esun", "running")];
  assert.deepEqual(historyCounts(rows), { running: 1, completed: 2, failed: 1 });
  assert.deepEqual(historyCounts([]), { running: 0, completed: 0, failed: 0 });
});

test("the visible rows match the status filter and the task label in the current language", () => {
  const rows = [run("cathay", "completed"), run("esun", "failed"), run("esun", "completed", "e2")];
  const ids = (filter: Parameters<typeof visibleHistoryRows>[2], search: string, language: "en" | "zh-TW" = "en") =>
    visibleHistoryRows(rows, tasks, filter, search, language).map((row) => row.taskRunId);
  assert.deepEqual(ids("all", ""), ["cathay-completed", "esun-failed", "e2"]);
  assert.deepEqual(ids("completed", ""), ["cathay-completed", "e2"]);
  assert.deepEqual(ids("failed", ""), ["esun-failed"]);
  assert.deepEqual(ids("all", "  e.sun "), ["esun-failed", "e2"], "search ignores case and surrounding space");
  assert.deepEqual(ids("completed", "e.sun"), ["e2"], "filter and search combine");
  assert.deepEqual(ids("all", "國泰", "zh-TW"), ["cathay-completed"]);
  assert.deepEqual(ids("all", "國泰"), [], "search reads the label shown, not another language's");
});

test("a task missing from the catalog is labelled by its id", () => {
  assert.equal(historyTaskLabel(tasks, "cathay", "zh-TW"), "國泰世華");
  assert.equal(historyTaskLabel(tasks, "retired-source", "en"), "retired-source");
});

test("duration reads minutes and seconds, measured to now while the run is going", () => {
  assert.equal(formatDuration({ startedAt: "2026-10-05T08:00:00.000Z", finishedAt: "2026-10-05T08:01:05.900Z" }), "01:05");
  assert.equal(
    formatDuration({ startedAt: "2026-10-05T08:00:00.000Z", finishedAt: null }, new Date("2026-10-05T08:12:03.000Z")),
    "12:03",
  );
  assert.equal(formatDuration({ startedAt: "2026-10-05T08:00:10.000Z", finishedAt: "2026-10-05T08:00:00.000Z" }), "00:00");
  assert.equal(formatDuration({ startedAt: "not a time", finishedAt: null }), "--");
});
