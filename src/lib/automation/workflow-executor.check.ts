import assert from "node:assert/strict";
import { test } from "node:test";
import { strictSourceText } from "./source-text.ts";
import {
  ProductCollectionInterruptedError,
  type ProductCollectionHandle,
  type ProductCollectionRunSummary,
} from "./product-collection.ts";
import { FailureCodeError } from "./workflow-failures.ts";
import type { PGliteWorkflowRunItem } from "../../ledger/pglite/workflow-run.ts";
import { PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND } from "../../ledger/pglite/workflow-client.ts";
import {
  createWorkflowExecutor,
  type WorkflowExecutorPorts,
} from "./workflow-executor.ts";
import type { WorkflowRunEvent } from "./run-event.ts";

function ports(events: WorkflowRunEvent[]): WorkflowExecutorPorts {
  return {
    browser: { withPage: async () => { throw new Error("Unexpected browser use."); } },
    text: strictSourceText,
    humanAssistance: { request: async () => { throw new Error("Unexpected assistance."); } },
    financialCommit: { execute: async () => ({
      status: "completed", items: [], diagnostics: [], committedCount: 0, failedCount: 0,
    }) },
    commitAttempts: { record: async () => undefined },
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
      assert.ok(context.financialCommit);
      assert.equal(context.text, injected.text);
      await context.event("collection", "completed", "source-complete", { completed: 2, total: 2 });
      return { counts: { itemCount: input as number } };
    },
  }], injected);
  assert.deepEqual(await executor.run("financial-example", "run-1", 42, new AbortController().signal), { counts: { itemCount: 42 } });
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

test("the account identity port reaches only a workflow that requires it, which fails closed without it", async () => {
  const events: WorkflowRunEvent[] = [];
  const accountIdentity = { continuity: async () => ({ status: "unseen" as const }) };
  const seen: Record<string, unknown> = {};
  const executor = createWorkflowExecutor([
    { id: "identity-reader", requiresFinancialCommit: true, requiresAccountIdentity: true, async run(context) { seen.reader = context.accountIdentity; } },
    { id: "plain", requiresFinancialCommit: true, async run(context) { seen.plain = context.accountIdentity; } },
  ], { ...ports(events), accountIdentity });
  await executor.run("identity-reader", "run-identity", null, new AbortController().signal);
  await executor.run("plain", "run-plain", null, new AbortController().signal);
  assert.equal(seen.reader, accountIdentity);
  assert.equal(seen.plain, undefined);

  let called = false;
  const withoutPort = createWorkflowExecutor([
    { id: "identity-reader", requiresFinancialCommit: true, requiresAccountIdentity: true, async run() { called = true; } },
  ], ports([]));
  await assert.rejects(
    withoutPort.run("identity-reader", "run-missing", null, new AbortController().signal),
    /Account identity port is unavailable/,
  );
  assert.equal(called, false);
});

test("an event write failure after work starts does not relabel the outcome", async () => {
  const events: WorkflowRunEvent[] = [];
  const failures: string[] = [];
  const base = ports(events);
  const executor = createWorkflowExecutor([{
    id: "event-failure-example",
    requiresFinancialCommit: false,
    async run(context) {
      await context.event("collection", "advanced", "collection-finished");
      return { counts: { committedCount: 1 } };
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
  assert.deepEqual(
    await executor.run("event-failure-example", "run-3", null, new AbortController().signal),
    { counts: { committedCount: 1 } },
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
        status: "financial-admitted",
        counts: { sourceCaptureCount: 1, rowCount: 2, itemCount: 1, committedCount: 1, skippedProductCount: 0 },
        products: [
          { typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 },
          { typeId: "credit_card", status: "skipped", itemCount: 0, committedCount: 0, skipReason: "not_selected" },
        ],
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
        status: "no-data",
        counts: { sourceCaptureCount: 0, rowCount: 0, itemCount: 0, committedCount: 0, skippedProductCount: 0 },
        products: [{ typeId: "deposit", status: "no_data", itemCount: 0, committedCount: 0 }],
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

test("the preview write port, not the workflow, reports a preview write's commit stage", async () => {
  const events: WorkflowRunEvent[] = [];
  const executor = createWorkflowExecutor([{
    id: "preview-write-example",
    requiresFinancialCommit: false,
    requiresPreviewWrite: true,
    async run(context) {
      await context.previewWrite!.write({ sourceId: "fixture", institution: "esun", product: "credit_card", collection: {} } as never);
      await context.previewWrite!.write({ sourceId: "fixture", institution: "esun", product: "time_deposit", collection: {} } as never);
    },
  }], {
    ...ports(events),
    previewWrite: {
      write: async (input) => ({
        accounts: input.product === "credit_card" ? 2 : 0, balances: 0, transactions: 0, statements: 0, closedAccounts: 0,
      }),
    },
  });
  await executor.run("preview-write-example", "run-preview", null, new AbortController().signal);
  assert.deepEqual(
    events.filter((event) => event.stage === "commit").map(({ code, completed, statementType }) => [code, completed, statementType]),
    [["credit-card-preview-write-completed", 2, "credit_card"]],
  );
});

test("a workflow's Verification stage reaches the host port and its port reports the run's events", async () => {
  const events: WorkflowRunEvent[] = [];
  const controller = new AbortController();
  const requests: Array<{ stageId: string; rect: unknown }> = [];
  const signals: AbortSignal[] = [];
  const executor = createWorkflowExecutor([{
    id: "verification-example",
    requiresFinancialCommit: false,
    async run(context) {
      await context.verification.complete({
        stageId: "example-captcha",
        title: "Enter the CAPTCHA",
        targets: [{
          id: "answer",
          label: "Answer",
          semanticId: "example.answer",
          modes: ["type"],
          locator: { boundingBox: async () => ({ x: 1, y: 2, width: 30, height: 12 }) },
        }],
        contextRegions: [],
        completion: { mode: "inline", targetIds: ["answer"] },
        focus: { targetId: "answer", contextRegionIds: [] },
      });
    },
  }], {
    ...ports(events),
    humanAssistance: {
      request: async (contract, signal) => {
        requests.push({ stageId: contract.stageId, rect: contract.targets[0]?.rect });
        signals.push(signal);
        return "verified";
      },
    },
  });
  await executor.run("verification-example", "run-verification", null, controller.signal);
  assert.deepEqual(requests, [{ stageId: "example-captcha", rect: { x: 1, y: 2, width: 30, height: 12 } }]);
  assert.equal(signals[0], controller.signal);
  assert.deepEqual(
    events.filter((event) => event.stage === "authentication").map(({ runId, outcome, code }) => [runId, outcome, code]),
    [
      ["run-verification", "advanced", "human-assistance-requested"],
      ["run-verification", "advanced", "human-assistance-completed"],
    ],
  );
});

function stagedCommitPorts(staged: PGliteWorkflowRunItem[]): WorkflowExecutorPorts {
  return {
    ...ports([]),
    financialCommit: {
      execute: async (items) => {
        staged.push(...items);
        return {
          status: "completed",
          items: items.map((entry) => ({
            provider: entry.provider,
            product: entry.product,
            itemKey: entry.itemKey,
            status: "committed" as const,
            admissionSummaries: [{ captureId: `capture-${entry.itemKey}`, commitSequence: 1 }],
            value: null,
            relationWarnings: [],
          })),
          diagnostics: [],
          committedCount: items.length,
          failedCount: 0,
        };
      },
    },
  };
}

const PRODUCT_SOURCE = {
  id: "product-source",
  requiresFinancialCommit: true,
  requiresProductCollection: true,
  productCollection: { provider: "fubon", productIds: ["deposit", "credit_card"] },
} as const;

const collectorFor = (product: string, collected: string[]) => async (handle: ProductCollectionHandle) => {
  collected.push(product);
  handle.stage({ product, itemKey: `${product}-1`, command: { kind: PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND, request: {} as never } });
  return { sourceCaptureCount: 1, rowCount: 1 };
};

test("the bound Product collection run stamps the source's provider and collects only the input's selection", async () => {
  const staged: PGliteWorkflowRunItem[] = [];
  const collected: string[] = [];
  let sessionChecks = 0;
  let summary: ProductCollectionRunSummary | undefined;
  const executor = createWorkflowExecutor([{
    ...PRODUCT_SOURCE,
    async run(context) {
      summary = await context.products!.collect({
        deposit: collectorFor("deposit", collected),
        credit_card: collectorFor("credit_card", collected),
      }, { assertSession: async () => { sessionChecks += 1; } });
    },
  }], stagedCommitPorts(staged));
  await executor.run("product-source", "run-products", { statementTypes: ["credit_card"] }, new AbortController().signal);
  assert.deepEqual(collected, ["credit_card"]);
  assert.deepEqual(staged.map(({ provider, product }) => [provider, product]), [["fubon", "credit_card"]]);
  assert.deepEqual(summary?.products.map(({ typeId, status }) => [typeId, status]), [["deposit", "skipped"], ["credit_card", "success"]]);
  assert.ok(sessionChecks > 0, "the workflow's session check reaches the run");
});

test("the bound run refuses collectors or a selection that disagree with the source's products", async () => {
  const run = (input: unknown, collectors: Record<string, ReturnType<typeof collectorFor>>) => createWorkflowExecutor([{
    ...PRODUCT_SOURCE,
    async run(context) { await context.products!.collect(collectors); },
  }], stagedCommitPorts([])).run("product-source", "run-refused", input, new AbortController().signal);
  const refused = (error: unknown) => error instanceof FailureCodeError && error.errorCode === "workflow-failed";
  await assert.rejects(run({ statementTypes: ["deposit"] }, { deposit: collectorFor("deposit", []) }), refused);
  await assert.rejects(run({ statementTypes: ["deposit"] }, {
    deposit: collectorFor("deposit", []), credit_card: collectorFor("credit_card", []), loan: collectorFor("loan", []),
  }), refused);
  await assert.rejects(run({ statementTypes: ["loan"] }, {
    deposit: collectorFor("deposit", []), credit_card: collectorFor("credit_card", []),
  }), refused);
  await assert.rejects(run({ statementTypes: [], attachedPreviewProducts: ["credit_card"] }, {
    deposit: collectorFor("deposit", []), credit_card: collectorFor("credit_card", []),
  }), refused, "an attached selection needs the source's attached products and the workflow's attached collectors");
});

test("only a workflow that requires product collection receives it, and it fails closed without its source facts", async () => {
  const seen: Record<string, unknown> = {};
  const executor = createWorkflowExecutor([
    { ...PRODUCT_SOURCE, async run(context) { seen.products = context.products; } },
    { id: "plain", requiresFinancialCommit: true, async run(context) { seen.plain = context.products; } },
  ], ports([]));
  await executor.run("product-source", "run-a", { statementTypes: ["deposit"] }, new AbortController().signal);
  await executor.run("plain", "run-b", null, new AbortController().signal);
  assert.ok(seen.products);
  assert.equal(seen.plain, undefined);

  let called = false;
  const { productCollection: _facts, ...withoutFacts } = PRODUCT_SOURCE;
  await assert.rejects(
    createWorkflowExecutor([{ ...withoutFacts, async run() { called = true; } }], ports([]))
      .run("product-source", "run-c", { statementTypes: ["deposit"] }, new AbortController().signal),
    /Product collection is unavailable/,
  );
  assert.equal(called, false);
});
