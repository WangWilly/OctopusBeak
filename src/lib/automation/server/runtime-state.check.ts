import assert from "node:assert/strict";
import test from "node:test";
import { createAutomationRuntimeState, sanitizeAutomationLogTail } from "./runtime-state.ts";

test("runtime state broadcasts monotonic full snapshots and bounds logs", () => {
  const state = createAutomationRuntimeState("session-test");
  const events: number[] = [];
  state.subscribe((snapshot) => events.push(snapshot.revision));
  const snapshot = state.upsert({
    taskId: "esun-credit-card-statements",
    runId: "run-1",
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    progress: { phaseCode: "download", completed: 1, total: 2, percent: 50, attempt: 1 },
    logTail: `${"x".repeat(70_000)}\n${"y".repeat(70_000)}`,
    errorMessage: null,
    updatedAt: new Date().toISOString(),
  });
  assert.equal(snapshot.sessionId, "session-test");
  assert.equal(snapshot.revision, 1);
  assert.deepEqual(events, [1]);
  assert.ok(Buffer.byteLength(snapshot.tasks[0]!.logTail, "utf8") <= 64 * 1024);
  assert.equal(state.snapshot().tasks[0]?.runId, "run-1");
});

test("log sanitizer redacts secret-like fields", () => {
  assert.match(sanitizeAutomationLogTail("password=top-secret token:abc"), /password=\[REDACTED\]/);
  assert.doesNotMatch(sanitizeAutomationLogTail("password=top-secret"), /top-secret/);
});
