import assert from "node:assert/strict";
import test from "node:test";
import { humanSessionFromRun } from "./human-session.ts";

test("typed human assistance uses the App task-run ID as its viewer key", () => {
  assert.equal(
    humanSessionFromRun({
      status: "waiting_for_human",
      taskRunId: "typed-run-42",
      logTail: "",
    }, "hncb-statements"),
    "typed-run-42",
  );
});
test("typed human assistance never derives a viewer key from output text", () => {
  assert.throws(
    () => humanSessionFromRun({
      status: "waiting_for_human",
      logTail: "Workflow paused. libretto resume --session ses-legacy",
    }, "hncb-statements"),
    /Missing App workflow run ID/u,
  );
});

test("non-waiting runs cannot open the human viewer", () => {
  assert.throws(
    () => humanSessionFromRun({ status: "completed", taskRunId: "typed-run-42", logTail: "" }, "hncb-statements"),
    /not waiting for human input/u,
  );
});
