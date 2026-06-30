import assert from "node:assert/strict";
import {
  nextAttemptStatus,
  shouldAutoRunImport,
  shouldMarkWaitingForHuman,
} from "./runner.ts";

assert.equal(shouldMarkWaitingForHuman("libretto paused. resume --session abc"), true);
assert.equal(shouldMarkWaitingForHuman("Please enter OTP in browser"), true);
assert.equal(shouldMarkWaitingForHuman("download completed"), false);

assert.equal(
  nextAttemptStatus({
    kind: "crawler",
    attempt: 1,
    maxAttempts: 2,
    exitCode: 0,
    waitingForHuman: true,
  }),
  "waiting_for_human",
);
assert.equal(
  nextAttemptStatus({ kind: "crawler", attempt: 1, maxAttempts: 2, exitCode: 1 }),
  "retrying",
);
assert.equal(
  nextAttemptStatus({ kind: "crawler", attempt: 2, maxAttempts: 2, exitCode: 1 }),
  "failed",
);
assert.equal(
  nextAttemptStatus({ kind: "sync", attempt: 1, maxAttempts: 1, exitCode: 1 }),
  "failed",
);
assert.equal(
  nextAttemptStatus({ kind: "crawler", attempt: 1, maxAttempts: 2, exitCode: 0 }),
  "completed",
);

assert.equal(
  shouldAutoRunImport({ kind: "crawler", status: "completed", importLocked: false }),
  true,
);
assert.equal(
  shouldAutoRunImport({ kind: "crawler", status: "failed", importLocked: false }),
  false,
);
assert.equal(
  shouldAutoRunImport({ kind: "sync", status: "completed", importLocked: false }),
  false,
);
assert.equal(
  shouldAutoRunImport({ kind: "crawler", status: "completed", importLocked: true }),
  false,
);
