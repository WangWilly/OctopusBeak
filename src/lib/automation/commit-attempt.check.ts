import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCommitAttemptReport,
  isCommitAttemptReport,
  commitAttemptsErrorCode,
  commitAttemptsMayHaveCommitted,
  type CommitAttempt,
  type CommitAttemptOutcome,
} from "./commit-attempt.ts";
import { COLLECTION_PRODUCT_TYPE_IDS } from "./product-collection.ts";
import { parseAppWorkflowWorkerOutboundFrame } from "./server/app-workflow-worker-protocol.ts";

function attempt(outcome: CommitAttemptOutcome | null, committedCount = 0): CommitAttempt {
  return { attemptId: `attempt-${outcome}-${committedCount}`, product: null, total: 2, outcome, committedCount };
}

test("an unsettled attempt outranks a refused one, which outranks a failed one, which outranks success", () => {
  for (const [attempts, expected] of [
    [[], null],
    [[attempt("completed", 2)], null],
    [[attempt("cancelled", 1)], null],
    [[attempt("completed", 2), attempt("failed", 1)], "canonical-commit-failed"],
    [[attempt("failed", 1), attempt("refused")], "collection-scope-changed"],
    [[attempt("refused"), attempt(null)], "commit-outcome-unknown"],
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

test("every product a workflow commits under is a valid attempt product, through the worker frame", () => {
  // Every product a production workflow passes to financialCommit.execute, plus the shared type ids.
  for (const product of [
    ...COLLECTION_PRODUCT_TYPE_IDS,
    "financial", "personal-invoice", "current-balance", "credit-card", "investment",
  ]) {
    const attempt = { phase: "started", attemptId: "attempt-1", product, total: 1 } as const;
    assert.equal(isCommitAttemptReport(attempt), true, product);
    assert.doesNotThrow(() => parseAppWorkflowWorkerOutboundFrame({
      protocolVersion: 2, kind: "commit-attempt", eventId: "frame-1", attempt,
    }), product);
  }
  assert.equal(isCommitAttemptReport({ phase: "started", attemptId: "attempt-1", product: "Credit Card", total: 1 }), false);
});
