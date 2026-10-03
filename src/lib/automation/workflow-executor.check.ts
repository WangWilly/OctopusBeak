import assert from "node:assert/strict";
import { test } from "node:test";
import { strictSourceText } from "./source-text.ts";
import { ProductCollectionInterruptedError } from "./product-collection.ts";
import {
  createWorkflowExecutor,
  type WorkflowExecutorPorts,
  type WorkflowRunEvent,
} from "./workflow-executor.ts";

function ports(events: WorkflowRunEvent[]): WorkflowExecutorPorts {
  return {
    browser: { withPage: async () => { throw new Error("Unexpected browser use."); } },
    text: strictSourceText,
    humanAssistance: { request: async () => { throw new Error("Unexpected assistance."); } },
    financialCommit: { execute: async () => ({
      status: "completed", items: [], diagnostics: [], committedCount: 0, failedCount: 0,
    }) },
    events: { append: async (event) => { events.push(event); } },
    now: () => "2026-09-25T00:00:00.000Z",
  };
}

test("executor injects the financial port and records typed stage events", async () => {
  const events: WorkflowRunEvent[] = [];
  const injected = ports(events);
  const executor = createWorkflowExecutor([{
    id: "financial-example",
    requiresFinancialCommit: true,
    async run(context, input) {
      assert.equal(context.financialCommit, injected.financialCommit);
      assert.equal(context.text, injected.text);
      await context.event("collection", "source-complete", { completed: 2, total: 2 });
      return input;
    },
  }], injected);
  assert.equal(await executor.run("financial-example", "run-1", 42, new AbortController().signal), 42);
  assert.deepEqual(events.map((event) => event.code), [
    "run-started", "source-complete", "run-completed",
  ]);
  assert.equal(events[1]?.runId, "run-1");
  assert.equal(events[1]?.completed, 2);
});

test("financial workflow fails closed before running without a commit port", async () => {
  const events: WorkflowRunEvent[] = [];
  const { financialCommit: _financialCommit, ...withoutCommit } = ports(events);
  let called = false;
  const executor = createWorkflowExecutor([{
    id: "financial-example",
    requiresFinancialCommit: true,
    async run() { called = true; },
  }], withoutCommit);
  await assert.rejects(
    executor.run("financial-example", "run-2", null, new AbortController().signal),
    /Canonical Financial Commit port is unavailable/,
  );
  assert.equal(called, false);
  assert.equal(events.length, 0);
});

test("an event write failure after work starts does not relabel the outcome", async () => {
  const events: WorkflowRunEvent[] = [];
  const failures: string[] = [];
  const base = ports(events);
  const executor = createWorkflowExecutor([{
    id: "event-failure-example",
    requiresFinancialCommit: false,
    async run(context) {
      await context.event("commit", "commit-finished");
      return "committed";
    },
  }], {
    ...base,
    events: {
      async append(event) {
        if (event.code === "run-started") events.push(event);
        else throw new Error("operational store unavailable");
      },
    },
    onEventFailure: (code) => failures.push(code),
  });
  assert.equal(
    await executor.run("event-failure-example", "run-3", null, new AbortController().signal),
    "committed",
  );
  assert.deepEqual(failures, ["event-persistence-failed", "event-persistence-failed"]);
});

test("abort after a product workflow returns retains its committed product summary", async () => {
  const events: WorkflowRunEvent[] = [];
  const controller = new AbortController();
  const executor = createWorkflowExecutor([{
    id: "product-collection-example",
    requiresFinancialCommit: true,
    async run() {
      controller.abort();
      return {
        sourceCaptureCount: 1,
        rowCount: 2,
        itemCount: 1,
        committedCount: 1,
        skippedProductCount: 0,
        products: [
          { typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 },
          { typeId: "credit_card", status: "skipped", itemCount: 0, committedCount: 0, skipReason: "not_selected" },
        ],
        status: "financial-admitted",
      };
    },
  }], ports(events));

  await assert.rejects(
    executor.run("product-collection-example", "run-products", null, controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof ProductCollectionInterruptedError);
      assert.equal(error.errorCode, "cancelled");
      assert.equal(error.summary.committedCount, 1);
      assert.equal(error.summary.products[0]?.status, "success");
      assert.equal(error.summary.products[0]?.committedCount, 1);
      return true;
    },
  );
  assert.deepEqual(events.map(({ code }) => code), ["run-started", "run-cancelled"]);
});

test("abort during finalization still converts only a product result to interruption", async () => {
  const events: WorkflowRunEvent[] = [];
  const controller = new AbortController();
  const base = ports(events);
  const executor = createWorkflowExecutor([{
    id: "product-finalization-example",
    requiresFinancialCommit: true,
    async run() {
      return {
        sourceCaptureCount: 0,
        rowCount: 0,
        itemCount: 0,
        committedCount: 0,
        skippedProductCount: 0,
        products: [{ typeId: "deposit", status: "no_data", itemCount: 0, committedCount: 0 }],
        status: "no-data",
      };
    },
  }], {
    ...base,
    events: {
      append: async (event) => {
        events.push(event);
        if (event.stage === "finalization" && event.code === "run-completed") controller.abort();
      },
    },
  });
  await assert.rejects(
    executor.run("product-finalization-example", "run-product-finalization", null, controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof ProductCollectionInterruptedError);
      assert.equal(error.errorCode, "cancelled");
      assert.equal(error.summary.products[0]?.status, "no_data");
      return true;
    },
  );
  assert.deepEqual(events.map(({ code }) => code), ["run-started", "run-completed", "run-cancelled"]);
});
