import assert from "node:assert/strict";
import test from "node:test";
import type {
  PreviewCreditCollection,
  PreviewDepositCollection,
  PreviewTimeDepositCollection,
  PreviewWrite,
} from "../../ledger/pglite/preview-financial-data.ts";
import { ProductCollectionInterruptedError } from "../automation/product-collection.ts";
import { createWorkflowExecutor, type WorkflowDefinition } from "../automation/workflow-executor.ts";
import { ATTACHED_PREVIEW_PRODUCTS, collectAttachedPreviewProducts } from "./attached-products.ts";
import {
  collectPreviewProducts,
  previewRunOutput,
  type PreviewProductCollectors,
  type PreviewProductRun,
} from "./product-collection.ts";
import { previewReceipt } from "./preview-source-harness.ts";
import { fail } from "./source-kit.ts";

const AT = "2026-10-15T02:00:00.000Z";

const depositCollection: PreviewDepositCollection = {
  collectedAt: AT,
  accounts: [{
    sourceAccountKey: "a", displayLabel: "Savings", currency: "TWD", type: "depository",
    balances: [{ kind: "current", amount: "10", currency: "TWD", observedAt: { at: AT, source: "collection-time" } }],
    transactions: [],
  }],
};

const creditCollection: PreviewCreditCollection = {
  collectedAt: AT,
  accounts: [{
    sourceAccountKey: "c", displayLabel: "Cards", currency: "TWD", creditLimit: null, cards: [],
    balances: [{ amount: "5", currency: "TWD", observedAt: { at: AT, source: "collection-time" }, basis: { kind: "provider-used-credit", usedCredit: "5" } }],
    purchases: [], statements: [],
  }],
};

const emptyTimeDeposits: PreviewTimeDepositCollection = { collectedAt: AT, completeness: "complete", deposits: [] };

function harness(collectors: PreviewProductCollectors, selected: readonly PreviewWrite["product"][] = ["deposit", "credit_card", "time_deposit"]) {
  const writes: PreviewWrite["product"][] = [];
  const events: string[] = [];
  const run = (signal = new AbortController().signal, assertSession?: () => Promise<void>) => collectPreviewProducts({
    products: ["deposit", "credit_card", "time_deposit"],
    selected,
    collectors,
    write: async (write) => { writes.push(write.product); return previewReceipt({ sourceId: "s", institution: "bank-017", ...write }); },
    signal,
    event: async (_stage, _outcome, code) => { events.push(code); },
    ...(assertSession ? { assertSession } : {}),
  });
  return { writes, events, run };
}

const statuses = (run: PreviewProductRun) => run.products.map((product) => `${product.typeId}:${product.status}${product.errorCode ? `:${product.errorCode}` : ""}${product.skipReason ? `:${product.skipReason}` : ""}`);

test("a product's failure stays with that product, and the others still write", async () => {
  const { writes, events, run } = harness({
    deposit: async () => fail("unexpected-response", "no account list"),
    credit_card: async () => creditCollection,
    time_deposit: async () => emptyTimeDeposits,
  });
  const result = await run();
  assert.deepEqual(statuses(result), [
    "deposit:failed:source-validation-failed",
    "credit_card:success",
    "time_deposit:not_held",
  ]);
  assert.deepEqual(writes, ["credit_card", "time_deposit"], "the complete empty time-deposit list is still written, so it can close deposits");
  assert.equal(result.interrupted, null);
  assert.ok(events.includes("deposit-source-validation-rejected"));
  const output = previewRunOutput(result);
  assert.deepEqual([output.status, output.counts.accountCount], ["partial", 1]);
});

test("a session loss ends the run and leaves later products unattempted and unwritten", async () => {
  let creditCalls = 0;
  const { writes, run } = harness({
    deposit: async () => fail("session-conflict", "signed out"),
    credit_card: async () => { creditCalls += 1; return creditCollection; },
    time_deposit: async () => emptyTimeDeposits,
  });
  const result = await run();
  assert.deepEqual(statuses(result), [
    "deposit:failed:authentication-failed",
    "credit_card:skipped:not_attempted",
    "time_deposit:skipped:not_attempted",
  ]);
  assert.equal(creditCalls, 0);
  assert.deepEqual(writes, []);
  assert.equal(result.interrupted?.errorCode, "authentication-failed");
  const thrown = (() => { try { previewRunOutput(result); return null; } catch (error) { return error; } })();
  assert.ok(thrown instanceof ProductCollectionInterruptedError);
  assert.equal(thrown.summary.status, "failed");
  assert.equal(thrown.summary.products.length, 3);
});

test("an assertSession failure after a product failure also ends the run", async () => {
  const { run } = harness({
    deposit: async () => fail("malformed-amount", "x"),
    credit_card: async () => creditCollection,
  });
  let sessionChecks = 0;
  const result = await run(undefined, async () => { sessionChecks += 1; if (sessionChecks > 1) fail("sign-in-rejected", "session gone"); });
  assert.deepEqual(statuses(result), [
    "deposit:failed:source-validation-failed",
    "credit_card:skipped:not_attempted",
    "time_deposit:skipped:not_attempted",
  ]);
  assert.equal(result.interrupted?.errorCode, "authentication-failed");
});

test("unselected products are skipped, an absent product writes nothing, and a missing collector fails the product", async () => {
  const { writes, run } = harness({
    credit_card: async () => ({ absent: "not_held" }),
  }, ["credit_card", "time_deposit"]);
  const result = await run();
  assert.deepEqual(statuses(result), [
    "deposit:skipped:not_selected",
    "credit_card:not_held",
    "time_deposit:failed:workflow-failed",
  ]);
  assert.deepEqual(writes, []);
});

test("a run in which nothing produced data fails with the sole product's own error, or with every outcome", async () => {
  const failure = new Error("parse failed");
  const single = await harness({ deposit: async () => { throw failure; } }, ["deposit"]).run();
  assert.deepEqual(statuses(single), ["deposit:failed:source-collection-failed", "credit_card:skipped:not_selected", "time_deposit:skipped:not_selected"]);
  assert.throws(() => previewRunOutput(single), (error) => error === failure);

  const both = await harness({
    deposit: async () => { throw failure; },
    credit_card: async () => fail("incomplete-data", "page missing"),
  }, ["deposit", "credit_card"]).run();
  assert.throws(() => previewRunOutput(both), (error) => error instanceof ProductCollectionInterruptedError
    && error.errorCode === "source-collection-failed" && error.cause === failure && error.summary.products.length === 3);

  const nothingSelected = await harness({}, []).run();
  assert.deepEqual(previewRunOutput(nothingSelected).products.map((product) => product.status), ["skipped", "skipped", "skipped"]);
});

test("a cancelled signal stops the run before the next product", async () => {
  const controller = new AbortController();
  const { writes, run } = harness({
    deposit: async () => { controller.abort(); return depositCollection; },
    credit_card: async () => creditCollection,
  }, ["deposit", "credit_card"]);
  const result = await run(controller.signal);
  assert.equal(result.interrupted?.errorCode, "cancelled");
  assert.deepEqual(writes, ["deposit"], "the product collected before the cancellation is kept");
  assert.deepEqual(statuses(result).slice(0, 2), ["deposit:success", "credit_card:skipped:not_attempted"]);
});

test("attached products write only through a writer bound to the verified source", async () => {
  const writes: PreviewWrite[] = [];
  const context = {
    previewWrite: { write: async (input: PreviewWrite) => { writes.push(input); return previewReceipt(input); } },
    signal: new AbortController().signal,
    event: async () => undefined,
  };
  const result = await collectAttachedPreviewProducts({
    context,
    source: ATTACHED_PREVIEW_PRODUCTS.cathay,
    selected: ["credit_card", "deposit"],
    collectors: {
      credit_card: async () => creditCollection,
      deposit: async () => depositCollection,
      time_deposit: async () => emptyTimeDeposits,
    },
  });
  assert.deepEqual(statuses(result), ["credit_card:success", "time_deposit:skipped:not_selected"],
    "a product the source does not declare is never collected, even when selected");
  assert.deepEqual(writes.map((write) => [write.sourceId, write.institution, write.product]), [["cathay", "cathay", "credit_card"]]);

  const withoutPort = await collectAttachedPreviewProducts({
    context: { ...context, previewWrite: undefined },
    source: ATTACHED_PREVIEW_PRODUCTS.hncb,
    selected: ["credit_card"],
    collectors: { credit_card: async () => creditCollection },
  });
  assert.deepEqual(statuses(withoutPort), ["credit_card:failed:workflow-failed"]);
});

test("the executor hands a verified definition with attached products the preview port without requiring it", async () => {
  const seen: boolean[] = [];
  const definition: WorkflowDefinition = {
    id: "verified-with-attached",
    requiresFinancialCommit: false,
    attachedPreviewProducts: ATTACHED_PREVIEW_PRODUCTS.hncb,
    async run(context) { seen.push(context.previewWrite !== undefined); },
  };
  const ports = {
    browser: { withPage: async () => { throw new Error("no page"); } },
    text: {} as never,
    humanAssistance: { request: async () => "failed" as const },
    events: { append: async () => undefined },
    now: () => AT,
  };
  const signal = new AbortController().signal;
  await createWorkflowExecutor([definition], { ...ports, previewWrite: { write: async (input) => previewReceipt(input) } })
    .run(definition.id, "run-a", null, signal);
  await createWorkflowExecutor([definition], ports).run(definition.id, "run-b", null, signal);
  assert.deepEqual(seen, [true, false], "the port is injected when available and its absence does not stop the verified run");
});
