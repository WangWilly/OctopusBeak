import assert from "node:assert/strict";
import test from "node:test";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";
import { createPgliteOperationalProvider } from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { createAutomationRuntime } from "./automation-runtime.ts";

async function withRuntime(check: (runtime: ReturnType<typeof createAutomationRuntime>) => Promise<void>) {
  const store = new PGliteStore(await createTestPGlite("operational"));
  try {
    await check(createAutomationRuntime(createPgliteOperationalProvider(store)));
  } finally {
    await store.close();
  }
}

test("recovery finishes a previous process's runs and publishes them in the runtime snapshot", () => withRuntime(async (runtime) => {
  const { taskRunId } = await runtime.provider.automation.createTaskRun({
    taskId: "exchange-rates", kind: "sync", status: "running", attempt: 1, maxAttempts: 1, startedAt: new Date().toISOString(),
  });
  await runtime.recover();
  assert.equal((await runtime.provider.automation.taskRunById(taskRunId))?.status, "interrupted");
  assert.equal(runtime.snapshot().tasks.find((task) => task.taskId === "exchange-rates")?.status, "interrupted");
  assert.deepEqual(runtime.activeTaskIds(), []);
}));

test("every start path refuses a task the admission check does not know", () => withRuntime(async (runtime) => {
  const many = await runtime.runMany(["not-a-task"]);
  assert.deepEqual(many.started, []);
  assert.equal(many.results["not-a-task"]?.status, "error");
  await assert.rejects(runtime.run("not-a-task"), /Unknown automation task/u);
  assert.equal(runtime.hasActive(), false, "nothing started");
}));
