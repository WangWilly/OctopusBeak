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
  beforeHumanPause: async () => {
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
  isHumanRepairable: () => true,
  run: async () => {
    humanCalls.push("run");
    humanRuns += 1;
    if (humanRuns <= 2) throw new Error(`broken-${humanRuns}`);
    return "fixed";
  },
  reset: async () => {
    humanCalls.push("reset");
  },
  pause: async () => {
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
  isHumanRepairable: () => true,
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
  pause: async () => {
    resetFailureCalls.push("pause");
  },
});

assert.equal(resetFailureResult, "reset-fixed");
assert.deepEqual(resetFailureCalls, ["run", "reset", "pause", "run"]);

const repeatedFailureCalls: string[] = [];
let repeatedFailureRuns = 0;
const repeatedFailureResult = await retryableStage({
  name: "repeated-failure",
  session: "ses-repeated",
  isHumanRepairable: () => true,
  run: async () => {
    repeatedFailureCalls.push("run");
    repeatedFailureRuns += 1;
    if (repeatedFailureRuns <= 3) {
      throw new Error(`still-broken-${repeatedFailureRuns}`);
    }
    return "fixed-after-second-pause";
  },
  reset: async () => {
    repeatedFailureCalls.push("reset");
  },
  pause: async () => {
    repeatedFailureCalls.push("pause");
  },
});
assert.equal(repeatedFailureResult, "fixed-after-second-pause");
assert.deepEqual(repeatedFailureCalls, [
  "run",
  "reset",
  "run",
  "pause",
  "run",
  "pause",
  "run",
]);

const terminalFailureCalls: string[] = [];
let terminalFailureRuns = 0;
await assert.rejects(
  () =>
    retryableStage({
      name: "terminal-provider-error",
      session: "ses-terminal",
      isHumanRepairable: () => false,
      run: async () => {
        terminalFailureCalls.push("run");
        terminalFailureRuns += 1;
        throw new Error(`terminal-provider-error-${terminalFailureRuns}`);
      },
      reset: async () => {
        terminalFailureCalls.push("reset");
      },
      pause: async () => {
        terminalFailureCalls.push("pause");
        throw new Error("unexpected human pause");
      },
    }),
  /terminal-provider-error-2/,
);
assert.deepEqual(terminalFailureCalls, ["run", "reset", "run"]);
