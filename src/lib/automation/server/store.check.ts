import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_TASK_RUN_STATUSES,
  TERMINAL_TASK_RUN_STATUSES,
  isActiveTaskRunStatus,
  isTerminalTaskRunStatus,
  resumeHumanAssistanceContract,
} from "./store.ts";

test("automation store exports provider-neutral run state semantics", () => {
  assert.deepEqual(ACTIVE_TASK_RUN_STATUSES, [
    "queued",
    "preparing",
    "running",
    "retrying",
    "cancelling",
    "waiting_for_human",
  ]);
  assert.deepEqual(TERMINAL_TASK_RUN_STATUSES, [
    "completed",
    "partial",
    "failed",
    "cancelled",
    "interrupted",
  ]);
  assert.equal(isActiveTaskRunStatus("waiting_for_human"), true);
  assert.equal(isActiveTaskRunStatus("completed"), false);
  assert.equal(isTerminalTaskRunStatus("interrupted"), true);
  assert.equal(isTerminalTaskRunStatus("running"), false);
});

test("resuming a run retains only a pending assistance contract", () => {
  const pending = {
    schemaVersion: 1 as const,
    version: 2,
    stageId: "otp",
    title: "Enter OTP",
    targets: [],
    contextRegions: [],
    completion: { mode: "inline" as const, targetIds: [], status: "pending" as const },
    focus: { targetId: "otp", contextRegionIds: [] },
  };
  const entered = {
    ...pending,
    completion: { mode: "inline" as const, targetIds: [], status: "entered" as const },
  };
  assert.equal(resumeHumanAssistanceContract(pending), pending);
  assert.equal(resumeHumanAssistanceContract(entered), null);
  assert.equal(resumeHumanAssistanceContract(undefined), null);
});
