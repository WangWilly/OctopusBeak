import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import {
  forceQuitHumanSessionForTask,
  humanSessionFromRun,
} from "./human-session.ts";

test("waiting human session is derived from the persisted run tail", () => {
  assert.equal(
    humanSessionFromRun({
      status: "waiting_for_human",
      logTail: "Workflow paused. libretto resume --session ses-1p4q",
    }, "demo-task"),
    "ses-1p4q",
  );
  assert.throws(
    () => humanSessionFromRun({ status: "completed", logTail: "" }, "demo-task"),
    /not waiting for human input/u,
  );
  assert.throws(
    () => humanSessionFromRun({ status: "waiting_for_human", logTail: "paused" }, "demo-task"),
    /Missing Libretto resume session/u,
  );
});

test("force quit persists the terminal state before surfacing cleanup failure", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "fubon-all-statements",
      script: "run:fubon-all-statements",
      kind: "crawler",
      status: "waiting_for_human",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      logPath: "/tmp/automation-force-quit.log",
      logTail: "Workflow paused. libretto resume --session ses-force-quit",
    });
    await assert.rejects(
      forceQuitHumanSessionForTask("fubon-all-statements", provider, {
        readSessionState() {
          throw new Error("state unavailable");
        },
      }),
      /state unavailable/u,
    );
    const stored = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(stored?.status, "cancelled");
    assert.equal(stored?.terminationMode, "forced");
    assert.match(stored?.errorMessage ?? "", /^Browser session force quit\./u);
    assert.match(stored?.errorMessage ?? "", /Session cleanup failed: state unavailable/u);
  } finally {
    await store.close();
  }
});
