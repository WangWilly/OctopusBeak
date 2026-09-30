import assert from "node:assert/strict";
import test from "node:test";
import { strictSourceText } from "./source-text.ts";
import { createWorkflowExecutor, type WorkflowExecutorPorts } from "./workflow-executor.ts";
import { createExchangeRateWorkflow } from "./exchange-rate-workflow.ts";

test("exchange-rate workflow passes its executor signal to the injected service", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const workflow = createExchangeRateWorkflow(async ({ signal }: { signal: AbortSignal }) => {
    receivedSignal = signal;
    return { written: 0 };
  }, {
    emitProgress: () => {},
  });
  const ports: WorkflowExecutorPorts = {
    browser: { withPage: async () => { throw new Error("No browser expected."); } },
    text: strictSourceText,
    humanAssistance: { request: async () => { throw new Error("No assistance expected."); } },
    events: { append: async () => {} },
    now: () => "2026-09-26T00:00:00.000Z",
  };

  await createWorkflowExecutor([workflow], ports).run(
    "exchange-rates",
    "exchange-run",
    undefined,
    controller.signal,
  );
  assert.equal(receivedSignal, controller.signal);
});

test("exchange-rate progress reaches both the App callback and structured event port", async () => {
  const progress: unknown[] = [];
  const events: unknown[][] = [];
  const workflow = createExchangeRateWorkflow(async ({ emitProgress }) => {
    emitProgress?.({ phaseCode: "sync", completed: 1, total: 3, percent: 33 });
    return { written: 1 };
  }, {
    emitProgress: (event) => progress.push(event),
  });
  const context = {
    signal: new AbortController().signal,
    event: async (...event: unknown[]) => { events.push(event); },
  } as Parameters<typeof workflow.run>[0];

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
    signal: new AbortController().signal,
    event: async (...event: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push(event);
    },
  } as Parameters<typeof workflow.run>[0];

  await assert.rejects(workflow.run(context, undefined), (error: Error) => {
    assert.equal(error.message, "rate source unavailable");
    assert.deepEqual(events, [["collection", "progress-update"]]);
    return true;
  });
});
