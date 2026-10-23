import assert from "node:assert/strict";
import test from "node:test";
import { collectionFailures, runStageTrack } from "./run-stage-track.ts";
import type { WorkflowStage } from "./workflow-executor.ts";
import type { RunEventOutcome, WorkflowRunEvent } from "./run-event.ts";

function event(stage: WorkflowStage, outcome: RunEventOutcome, code: string): WorkflowRunEvent {
  return { runId: "run-1", stage, outcome, code, occurredAt: "2026-10-05T09:02:00Z" };
}

const states = (track: ReturnType<typeof runStageTrack>) => track.map((stage) => stage.state);

test("a completed run marks every reached stage done and the rest pending", () => {
  const track = runStageTrack(
    [event("preparation", "started", "run-started"), event("authentication", "completed", "authentication-completed"), event("finalization", "completed", "run-completed")],
    "completed",
    null,
  );
  assert.deepEqual(states(track), ["done", "done", "pending", "pending", "pending", "pending", "done"]);
  assert.equal(track[1].lastEvent?.code, "authentication-completed");
});

test("a running run marks the stage of its latest event active", () => {
  const track = runStageTrack(
    [event("preparation", "started", "run-started"), event("authentication", "started", "authentication-started")],
    "running",
    null,
  );
  assert.deepEqual(states(track).slice(0, 3), ["done", "active", "pending"]);
});

test("a failed product fails collection, warns on the partial commit, and fails the finish", () => {
  const track = runStageTrack(
    [
      event("preparation", "started", "run-started"),
      event("authentication", "completed", "authentication-completed"),
      event("collection", "completed", "source-collected"),
      event("decoding", "completed", "source-decoding-completed"),
      event("validation", "completed", "source-validated"),
      event("commit", "completed", "canonical-commit-completed"),
      event("finalization", "failed", "workflow-failed"),
    ],
    "failed",
    {
      errorCode: "workflow-failed",
      summary: {
        counts: {},
        products: [{ typeId: "credit_card", status: "failed", itemCount: 32, committedCount: 32 }],
      },
    },
  );
  assert.deepEqual(states(track), ["done", "done", "failed", "done", "done", "warning", "failed"]);
});

test("a run that stopped mid-way fails the stage it stopped in", () => {
  const track = runStageTrack(
    [event("preparation", "started", "run-started"), event("authentication", "failed", "verification-solver-exhausted")],
    "failed",
    null,
  );
  assert.deepEqual(states(track).slice(0, 3), ["done", "failed", "pending"]);
  const silent = runStageTrack([event("preparation", "started", "run-started"), event("authentication", "started", "login-started")], "interrupted", null);
  assert.deepEqual(states(silent).slice(0, 3), ["done", "failed", "pending"]);
});

test("collection failures count failed products out of the ones the run tried", () => {
  const product = (typeId: string, status: "success" | "failed" | "skipped" | "not_held") =>
    ({ typeId, status, itemCount: 0, committedCount: 0 }) as const;
  const outcome = (products: ReturnType<typeof product>[]) =>
    ({ errorCode: null, summary: { counts: {}, products } }) as Parameters<typeof collectionFailures>[0];
  assert.deepEqual(
    collectionFailures(outcome([
      product("deposit", "success"),
      product("credit_card", "failed"),
      product("foreign_currency", "skipped"),
      product("fund", "not_held"),
    ])),
    { typeIds: ["credit_card"], attempted: 3 },
  );
  assert.equal(collectionFailures(outcome([product("deposit", "success")])), null);
  assert.equal(collectionFailures(null), null);
});

test("a retried run judges each stage by its latest attempt", () => {
  const track = runStageTrack(
    [
      event("preparation", "started", "run-started"),
      event("authentication", "failed", "human-assistance-failed"),
      event("finalization", "failed", "run-failed"),
      event("preparation", "started", "run-started"),
      event("authentication", "completed", "authentication-completed"),
      event("collection", "started", "collection-started"),
      event("finalization", "completed", "run-completed"),
    ],
    "completed",
    null,
  );
  assert.deepEqual(states(track), ["done", "done", "done", "pending", "pending", "pending", "done"]);
  assert.equal(track[1].lastEvent?.code, "authentication-completed");
});

test("a run that failed or was cancelled marks the stage it stopped in, not just finalization", () => {
  const stopped = [
    event("preparation", "started", "run-started"),
    event("authentication", "completed", "authentication-completed"),
    event("collection", "started", "collection-started"),
  ];
  const failed = runStageTrack([...stopped, event("finalization", "failed", "run-failed")], "failed", null);
  assert.deepEqual(states(failed), ["done", "done", "failed", "pending", "pending", "pending", "failed"]);
  const cancelled = runStageTrack([...stopped, event("finalization", "failed", "run-cancelled")], "cancelled", null);
  assert.deepEqual(states(cancelled), ["done", "done", "failed", "pending", "pending", "pending", "warning"]);
});

test("stages before the first kept event count as done when older events were dropped", () => {
  const track = runStageTrack(
    [event("collection", "completed", "account-collected"), event("commit", "completed", "canonical-commit-completed"), event("finalization", "completed", "run-completed")],
    "completed",
    null,
  );
  assert.deepEqual(states(track), ["done", "done", "done", "pending", "pending", "done", "done"]);
  assert.equal(track[0].lastEvent, null);
});
