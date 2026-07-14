import assert from "node:assert/strict";
import test from "node:test";
import { createBeforeQuitHandler } from "./automation-shutdown.ts";

test("before quit waits for cleanup and retries quit once", async () => {
  let prevented = 0;
  let quitCalls = 0;
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  const handler = createBeforeQuitHandler({
    cleanup: () => cleanup,
    quit: () => { quitCalls += 1; },
    timeoutMs: 5_000,
  });

  handler({ preventDefault() { prevented += 1; } });
  handler({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 2);
  assert.equal(quitCalls, 0);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quitCalls, 1);

  handler({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 2);
});

test("before quit stops waiting at the deadline", async () => {
  let fireDeadline!: () => void;
  let quitCalls = 0;
  const handler = createBeforeQuitHandler({
    cleanup: () => new Promise<void>(() => {}),
    quit: () => { quitCalls += 1; },
    timeoutMs: 5_000,
  }, {
    setTimer(callback, ms) {
      assert.equal(ms, 5_000);
      fireDeadline = callback;
      return 1;
    },
    clearTimer() {},
  });

  handler({ preventDefault() {} });
  fireDeadline();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quitCalls, 1);
});

test("before quit consumes cleanup rejection and retries quit once", async () => {
  let prevented = 0;
  let cleanupCalls = 0;
  let quitCalls = 0;
  const handler = createBeforeQuitHandler({
    cleanup: async () => {
      cleanupCalls += 1;
      throw new Error("cleanup failed");
    },
    quit: () => { quitCalls += 1; },
    timeoutMs: 5_000,
  });

  handler({ preventDefault() { prevented += 1; } });
  handler({ preventDefault() { prevented += 1; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupCalls, 1);
  assert.equal(prevented, 2);
  assert.equal(quitCalls, 1);

  handler({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 2);
});
