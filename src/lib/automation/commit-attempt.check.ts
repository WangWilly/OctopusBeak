import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCommitAttemptReport,
  commitAttemptsErrorCode,
  commitAttemptsMayHaveCommitted,
  type CommitAttempt,
  type CommitAttemptOutcome,
} from "./commit-attempt.ts";
import { commitAwareErrorCode } from "./server/typed-workflow-outcome.ts";

function attempt(outcome: CommitAttemptOutcome | null, committedCount = 0): CommitAttempt {
  return { attemptId: `attempt-${outcome}-${committedCount}`, product: null, total: 2, outcome, committedCount };
}

test("an unsettled attempt outranks a failed one, which outranks success", () => {
  for (const [attempts, expected] of [
    [[], null],
    [[attempt("completed", 2)], null],
    [[attempt("cancelled", 1)], null],
    [[attempt("completed", 2), attempt("failed", 1)], "canonical-commit-failed"],
    [[attempt("failed"), attempt(null)], "commit-outcome-unknown"],
    [[attempt(null), attempt("completed", 2)], "commit-outcome-unknown"],
  ] as const) {
    assert.equal(commitAttemptsErrorCode(attempts), expected);
  }
});

test("data may have changed after any committed item or any unsettled attempt", () => {
  assert.equal(commitAttemptsMayHaveCommitted([attempt("failed", 0), attempt("cancelled", 0)]), false);
  assert.equal(commitAttemptsMayHaveCommitted([attempt("failed", 1)]), true);
  assert.equal(commitAttemptsMayHaveCommitted([attempt(null)]), true);
});

test("a settlement needs its own unsettled start and cannot exceed it", () => {
  const started = applyCommitAttemptReport([], { phase: "started", attemptId: "a", product: "deposit", total: 2 });
  assert.deepEqual(started, [{ attemptId: "a", product: "deposit", total: 2, outcome: null, committedCount: 0 }]);
  assert.throws(() => applyCommitAttemptReport(started, { phase: "started", attemptId: "a", product: null, total: 1 }));
  assert.throws(() => applyCommitAttemptReport(started, { phase: "settled", attemptId: "b", outcome: "completed", committedCount: 0 }));
  assert.throws(() => applyCommitAttemptReport(started, { phase: "settled", attemptId: "a", outcome: "completed", committedCount: 3 }));
  const settled = applyCommitAttemptReport(started, { phase: "settled", attemptId: "a", outcome: "completed", committedCount: 2 });
  assert.equal(settled[0]?.outcome, "completed");
  assert.throws(() => applyCommitAttemptReport(settled, { phase: "settled", attemptId: "a", outcome: "failed", committedCount: 0 }));
});

test("the run's attempts decide its commit outcome over what the worker reported", () => {
  const classify = () => "authentication-failed" as const;
  // A completed worker hides only an unknown commit.
  assert.equal(commitAwareErrorCode({ attempts: [attempt(null)], completed: true, reported: null, classify }), "commit-outcome-unknown");
  assert.equal(commitAwareErrorCode({ attempts: [attempt("failed")], completed: true, reported: null, classify }), null);
  // An unknown commit outranks a code the worker proved.
  assert.equal(commitAwareErrorCode({
    attempts: [attempt(null)], completed: false, reported: "source-validation-failed", classify,
  }), "commit-outcome-unknown");
  // A proved code outranks a failed attempt; a failed attempt outranks the event guess.
  assert.equal(commitAwareErrorCode({
    attempts: [attempt("failed")], completed: false, reported: "source-validation-failed", classify,
  }), "source-validation-failed");
  assert.equal(commitAwareErrorCode({ attempts: [attempt("failed")], completed: false, reported: null, classify }), "canonical-commit-failed");
  assert.equal(commitAwareErrorCode({ attempts: [], completed: false, reported: null, classify }), "authentication-failed");
});
