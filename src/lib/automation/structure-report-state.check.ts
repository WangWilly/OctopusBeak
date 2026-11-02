import assert from "node:assert/strict";
import test from "node:test";
import {
  NO_STRUCTURE_REPORT,
  closeStructureReport,
  openStructureReport,
  selectStructureReportRun,
  structureReportKey,
  structureReportLoaded,
} from "./structure-report-state.ts";

const firstRun = { id: "taishin", latestFinishedAt: "2026-10-05T08:00:00.000Z" };
const secondRun = { id: "taishin", latestFinishedAt: "2026-10-05T09:00:00.000Z" };
const report = (text: string) => ({ taskId: "taishin", text });

function opened() {
  const key = structureReportKey(firstRun)!;
  return openStructureReport(structureReportLoaded(selectStructureReportRun(NO_STRUCTURE_REPORT, key), key, report("first")));
}

test("each finished run of a task has its own report", () => {
  assert.notEqual(structureReportKey(firstRun), structureReportKey(secondRun));
  assert.equal(structureReportKey(null), null);
});

test("the dialog opens only once a report has loaded", () => {
  const key = structureReportKey(firstRun)!;
  const selected = selectStructureReportRun(NO_STRUCTURE_REPORT, key);
  assert.equal(openStructureReport(selected).open, false);
  assert.equal(structureReportLoaded(selected, key, null), selected, "a run without a report keeps the button hidden");
  assert.deepEqual(opened(), { key, report: report("first"), open: true });
});

test("a report that resets closes its dialog, and the next report does not reopen it", () => {
  const nextKey = structureReportKey(secondRun)!;
  const reset = selectStructureReportRun(opened(), nextKey);
  assert.deepEqual(reset, { key: nextKey, report: null, open: false });
  const reloaded = structureReportLoaded(reset, nextKey, report("second"));
  assert.equal(reloaded.open, false);
  assert.deepEqual(reloaded.report, report("second"));
  assert.equal(selectStructureReportRun(opened(), null).open, false, "closing run details closes the dialog too");
});

test("the same run keeps its open dialog, and a late report for another run is dropped", () => {
  const state = opened();
  assert.equal(selectStructureReportRun(state, state.key), state);
  const moved = selectStructureReportRun(state, structureReportKey(secondRun));
  assert.equal(structureReportLoaded(moved, structureReportKey(firstRun)!, report("late")), moved);
});

test("closing keeps the report so its button stays", () => {
  const closed = closeStructureReport(opened());
  assert.equal(closed.open, false);
  assert.deepEqual(closed.report, report("first"));
});
