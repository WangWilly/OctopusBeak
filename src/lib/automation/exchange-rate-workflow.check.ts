import assert from "node:assert/strict";
import test from "node:test";
import { createExchangeRateWorkflow } from "./exchange-rate-workflow.ts";
import type { WorkflowContext } from "./workflow-executor.ts";

test("exchange-rate progress reaches both the App callback and structured event port", async () => {
  const progress: unknown[] = [];
  const events: unknown[][] = [];
  const workflow = createExchangeRateWorkflow(async ({ emitProgress }) => {
    emitProgress?.({ phaseCode: "sync", completed: 1, total: 3, percent: 33 });
  }, {
    emitProgress: (event) => progress.push(event),
  });
  const context = {
    event: async (...event: unknown[]) => { events.push(event); },
  } as unknown as WorkflowContext;

  await workflow.run(context, undefined);

  assert.deepEqual(progress, [{ phaseCode: "sync", completed: 1, total: 3, percent: 33 }]);
  assert.deepEqual(events, [["collection", "progress-update"]]);
});

test("exchange-rate progress event is persisted before a sync failure escapes", async () => {
  const events: unknown[][] = [];
  const workflow = createExchangeRateWorkflow(async ({ emitProgress }) => {
    emitProgress?.({ phaseCode: "sync", completed: 1, total: 3, percent: 33 });
    throw new Error("rate source unavailable");
  }, {
    emitProgress: () => undefined,
  });
  const context = {
    event: async (...event: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push(event);
    },
  } as unknown as WorkflowContext;

  await assert.rejects(workflow.run(context, undefined), (error: Error) => {
    assert.equal(error.message, "rate source unavailable");
    assert.deepEqual(events, [["collection", "progress-update"]]);
    return true;
  });
});
