import assert from "node:assert/strict";
import { humanSessionFromRun } from "./human-session.ts";

assert.equal(
  humanSessionFromRun({
    status: "waiting_for_human",
    logTail: "Workflow paused. run `npx libretto resume --session ses-1p4q`.",
  }, "demo-task"),
  "ses-1p4q",
);

assert.throws(
  () => humanSessionFromRun({ status: "completed", logTail: "" }, "demo-task"),
  /not waiting for human input/,
);

assert.throws(
  () => humanSessionFromRun({ status: "waiting_for_human", logTail: "paused" }, "demo-task"),
  /Missing Libretto resume session/,
);
