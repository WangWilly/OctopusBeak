import assert from "node:assert/strict";
import test from "node:test";
import { humanSessionFromRun } from "./human-session.ts";

test("typed human assistance uses the App task-run ID as its viewer key", () => {
  assert.equal(
    humanSessionFromRun({
      status: "waiting_for_human",
      taskRunId: "typed-run-42",
    }, "hncb-statements"),
    "typed-run-42",
  );
});
test("typed human assistance requires a persisted App run ID", () => {
  assert.throws(
    () => humanSessionFromRun({
      status: "waiting_for_human",
    }, "hncb-statements"),
    /Missing App workflow run ID/u,
  );
});

test("nonbrowser jobs cannot open a human viewer", () => {
  for (const taskId of ["exchange-rates", "sync-maicoin"]) {
    assert.throws(
      () => humanSessionFromRun({ status: "waiting_for_human", taskRunId: "sync-run" }, taskId),
      /requires an App browser workflow/u,
    );
  }
});

test("non-waiting runs cannot open the human viewer", () => {
  assert.throws(
    () => humanSessionFromRun({ status: "completed", taskRunId: "typed-run-42" }, "hncb-statements"),
    /not waiting for human input/u,
  );
});
