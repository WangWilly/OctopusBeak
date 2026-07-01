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
