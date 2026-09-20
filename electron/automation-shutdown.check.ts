import assert from "node:assert/strict";
import test from "node:test";
import { createBeforeQuitHandler } from "./automation-shutdown.ts";

test("before quit starts cleanup without blocking the close", async () => {
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
  assert.equal(prevented, 1);
  assert.equal(quitCalls, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quitCalls, 1);

  handler({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1);
});

test("before quit does not install a cleanup deadline", async () => {
  let quitCalls = 0;
  const handler = createBeforeQuitHandler({
    cleanup: () => new Promise<void>(() => {}),
    quit: () => { quitCalls += 1; },
    timeoutMs: 5_000,
  });

  handler({ preventDefault() {} });
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
  assert.equal(cleanupCalls, 1);
  assert.equal(prevented, 1);
  assert.equal(quitCalls, 1);

  handler({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1);
});
