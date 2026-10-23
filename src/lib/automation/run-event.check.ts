import assert from "node:assert/strict";
import test from "node:test";
import {
  hasValidRunEventMeaning,
  legacyRunEventOutcome,
  RUN_EVENT_SIGNALS,
  signalRunEvent,
  upgradeStoredRunEvent,
  type RunEventSignal,
} from "./run-event.ts";

const detail = { runId: "run-1", occurredAt: "2026-10-23T00:00:00.000Z" };

test("a stored code takes the outcome the old suffix patterns gave it, failure first", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["source-decoding-failed", "failed"],
    ["source-validation-rejected", "failed"],
    ["source-response-malformed", "failed"],
    ["servisign-unavailable", "failed"],
    ["run-cancelled", "failed"],
    ["collection-failed", "failed"],
    ["authentication-completed", "completed"],
    ["account-collected", "completed"],
    ["account-no-data", "completed"],
    ["input-validated", "completed"],
    ["canonical-admission-completed", "completed"],
    ["authentication-started", "started"],
    ["progress-update", "advanced"],
    ["device-registration-required", "advanced"],
  ];
  for (const [code, outcome] of cases) assert.equal(legacyRunEventOutcome(code), outcome, code);
});

test("a stored signal code becomes its signal only at the signal's stage", () => {
  assert.deepEqual(
    upgradeStoredRunEvent({ ...detail, stage: "authentication", code: "verification-solver-exhausted" }),
    { ...detail, stage: "authentication", code: "verification-solver-exhausted", outcome: "failed", signal: "verification-solver-exhausted" },
  );
  const misplaced = { ...detail, stage: "collection", code: "verification-solver-exhausted" };
  assert.equal(upgradeStoredRunEvent(misplaced), misplaced);
  assert.equal(hasValidRunEventMeaning(misplaced), false);
});

test("an event that already states its outcome is not reinterpreted", () => {
  const event = { ...detail, stage: "collection", outcome: "advanced", code: "account-collected" };
  assert.equal(upgradeStoredRunEvent(event), event);
});

test("every signal event fixes its stage, outcome and code", () => {
  for (const signal of Object.keys(RUN_EVENT_SIGNALS) as RunEventSignal[]) {
    const event = signalRunEvent(signal, detail);
    assert.equal(event.stage, RUN_EVENT_SIGNALS[signal].stage);
    assert.equal(event.outcome, RUN_EVENT_SIGNALS[signal].outcome);
    assert.equal(event.code, signal);
    assert.equal(hasValidRunEventMeaning(event), true, signal);
  }
});

test("a boundary rejects an outcome outside the closed set and a signal that disagrees", () => {
  const plain = { ...detail, stage: "collection", outcome: "completed", code: "collection-completed" };
  assert.equal(hasValidRunEventMeaning(plain), true);
  assert.equal(hasValidRunEventMeaning({ ...plain, outcome: "rejected" }), false);
  assert.equal(hasValidRunEventMeaning({ ...plain, outcome: undefined }), false);
  assert.equal(hasValidRunEventMeaning({ ...plain, signal: "not-a-signal" }), false);
  const exhausted = signalRunEvent("verification-solver-exhausted", detail);
  assert.equal(hasValidRunEventMeaning({ ...exhausted, outcome: "completed" }), false);
  assert.equal(hasValidRunEventMeaning({ ...exhausted, code: "other-code" }), false);
  assert.equal(hasValidRunEventMeaning({ ...exhausted, signal: undefined }), false);
});
