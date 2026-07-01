import assert from "node:assert/strict";
import { retryableStage } from "./retryable-stage.ts";

const retryCalls: string[] = [];
let retryRuns = 0;
const retryResult = await retryableStage({
  name: "domestic",
  session: "ses-test",
  run: async () => {
    retryCalls.push("run");
    retryRuns += 1;
    if (retryRuns === 1) throw new Error("transient");
    return "ok";
  },
  reset: async () => {
    retryCalls.push("reset");
  },
  pauseForHuman: async () => {
    retryCalls.push("pause");
  },
});

assert.equal(retryResult, "ok");
assert.deepEqual(retryCalls, ["run", "reset", "run"]);

const humanCalls: string[] = [];
let humanRuns = 0;
const humanResult = await retryableStage({
  name: "foreign",
  session: "ses-human",
  run: async () => {
    humanCalls.push("run");
    humanRuns += 1;
    if (humanRuns <= 2) throw new Error(`broken-${humanRuns}`);
    return "fixed";
  },
  reset: async () => {
    humanCalls.push("reset");
  },
  pauseForHuman: async () => {
    humanCalls.push("pause");
  },
});

assert.equal(humanResult, "fixed");
assert.deepEqual(humanCalls, ["run", "reset", "run", "pause", "run"]);

const resetFailureCalls: string[] = [];
let resetFailureRuns = 0;
const resetFailureResult = await retryableStage({
  name: "reset-failure",
  session: "ses-reset",
  run: async () => {
    resetFailureCalls.push("run");
    resetFailureRuns += 1;
    if (resetFailureRuns === 1) throw new Error("transient");
    return "reset-fixed";
  },
  reset: async () => {
    resetFailureCalls.push("reset");
    throw new Error("stale session");
  },
  pauseForHuman: async () => {
    resetFailureCalls.push("pause");
  },
});

assert.equal(resetFailureResult, "reset-fixed");
assert.deepEqual(resetFailureCalls, ["run", "reset", "pause", "run"]);

const finalFailureCalls: string[] = [];
let finalFailureRuns = 0;
await assert.rejects(
  () =>
    retryableStage({
      name: "final-failure",
      session: "ses-final",
      run: async () => {
        finalFailureCalls.push("run");
        finalFailureRuns += 1;
        throw new Error(`still-broken-${finalFailureRuns}`);
      },
      reset: async () => {
        finalFailureCalls.push("reset");
      },
      pauseForHuman: async () => {
        finalFailureCalls.push("pause");
      },
    }),
  /still-broken-3/,
);
assert.deepEqual(finalFailureCalls, ["run", "reset", "run", "pause", "run"]);
