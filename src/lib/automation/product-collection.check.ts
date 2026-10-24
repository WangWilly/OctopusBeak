import { CommitOutcomeUnknownError } from "./commit-attempt.ts";
import assert from "node:assert/strict";
import type {
  PGliteWorkflowItemResult,
  PGliteWorkflowRunItem,
  PGliteWorkflowRunResult,
} from "../../ledger/pglite/workflow-run.ts";
import { PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND } from "../../ledger/pglite/workflow-client.ts";
import type { WorkflowProductFailure } from "./workflow-executor.ts";
import {
  collectSelectedProducts,
  interruptedProductCollectionFromOutput,
  ProductCollectionFatalError,
  ProductCollectionInterruptedError,
  StatementComponentAbsentError,
  type CollectionProductOutcome,
} from "./product-collection.ts";
import { productRunStatus } from "./product-run-status.ts";
import { SourceUnavailableError } from "./source-access.ts";
import type { PreviewProductRun } from "../preview-sources/product-collection.ts";
import { productRunResult } from "./workflow-run-result.ts";

function item(product: string, itemKey: string): PGliteWorkflowRunItem {
  return {
    provider: "fubon",
    product,
    itemKey,
    command: {
      kind: PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
      request: {} as never,
    },
  };
}

function committed(itemValue: PGliteWorkflowRunItem): PGliteWorkflowItemResult<unknown> {
  return {
    provider: itemValue.provider,
    product: itemValue.product,
    itemKey: itemValue.itemKey,
    status: "committed",
    admissionSummaries: [{ captureId: `capture-${itemValue.itemKey}`, commitSequence: 1 }],
    value: null,
    relationWarnings: [],
  };
}

function result(
  status: PGliteWorkflowRunResult<unknown>["status"],
  items: readonly PGliteWorkflowItemResult<unknown>[],
  diagnostics: PGliteWorkflowRunResult<unknown>["diagnostics"] = [],
): PGliteWorkflowRunResult<unknown> {
  return {
    status,
    items,
    diagnostics,
    committedCount: items.filter((entry) => entry.status === "committed").length,
    failedCount: items.filter((entry) => entry.status === "failed").length,
  };
}

const signal = () => new AbortController();

/** A run in which nothing produced durable data throws its summary with the failed product's code. */
async function failedRunSummary(run: Promise<unknown>, errorCode: string) {
  const error = await run.then(() => null, (rejection: unknown) => rejection);
  assert.ok(error instanceof ProductCollectionInterruptedError, "a failed run throws its summary");
  assert.equal(error.errorCode, errorCode);
  assert.equal(error.summary.status, "failed");
  return error.summary;
}

{
  const controller = signal();
  const collected: string[] = [];
  const commits: string[][] = [];
  const summary = await collectSelectedProducts({
    productIds: ["deposit", "credit_card", "loan"],
    selectedIds: ["credit_card"],
    signal: controller.signal,
    collect: async (typeId, staged) => {
      collected.push(typeId);
      staged.push(item(typeId, `${typeId}-1`));
      return { sourceCaptureCount: 1, rowCount: 1, itemCount: 1 };
    },
    commit: async (_typeId, staged) => {
      commits.push(staged.map(({ itemKey }) => itemKey));
      return result("completed", staged.map(committed));
    },
  });
  assert.deepEqual(collected, ["credit_card"], "an unselected product is never invoked");
  assert.deepEqual(commits, [["credit_card-1"]]);
  assert.deepEqual(summary.products.map(({ typeId, status, skipReason }) => [typeId, status, skipReason]), [
    ["deposit", "skipped", "not_selected"],
    ["credit_card", "success", undefined],
    ["loan", "skipped", "not_selected"],
  ]);
}

{
  const controller = signal();
  const committedProducts: string[] = [];
  const productFailures: WorkflowProductFailure[] = [];
  const summary = await collectSelectedProducts({
    productIds: ["deposit", "credit_card", "loan"],
    selectedIds: ["deposit", "credit_card", "loan"],
    signal: controller.signal,
    collect: async (typeId, staged) => {
      staged.push(item(typeId, `${typeId}-staged`));
      if (typeId === "credit_card") throw new Error("product decoder failed after staging");
      return { sourceCaptureCount: 1, rowCount: 1, itemCount: 1 };
    },
    commit: async (typeId, staged) => {
      committedProducts.push(typeId);
      return result("completed", staged.map(committed));
    },
    productFailure: async (failure) => { productFailures.push(failure); },
  });
  assert.deepEqual(committedProducts, ["deposit", "loan"]);
  assert.deepEqual(
    productFailures.map(({ stage, statementType, errorCode, error }) => [stage, statementType, errorCode, (error as Error).message]),
    [["collection", "credit_card", "source-collection-failed", "product decoder failed after staging"]],
    "a collector error reaches the diagnostics port once, with the stage it failed in and the error itself",
  );
  assert.deepEqual(summary.products.map(({ typeId, status, itemCount, committedCount }) => [typeId, status, itemCount, committedCount]), [
    ["deposit", "success", 1, 1],
    ["credit_card", "failed", 0, 0],
    ["loan", "success", 1, 1],
  ], "items staged before a collector failure are discarded and do not leak into another product");
  assert.equal(summary.status, "partial");
  assert.equal(summary.committedCount, 2);
}

{
  const controller = signal();
  const dispositions: Array<"no_data" | "not_held" | undefined> = ["no_data", "not_held", undefined];
  const absentFailures: string[] = [];
  const summary = await failedRunSummary(collectSelectedProducts({
    productIds: ["deposit", "credit_card", "loan"],
    selectedIds: ["deposit", "credit_card", "loan"],
    signal: controller.signal,
    collect: async (typeId) => {
      const disposition = dispositions[["deposit", "credit_card", "loan"].indexOf(typeId)]!;
      throw new StatementComponentAbsentError("no source record", disposition);
    },
    commit: async () => { throw new Error("empty outcomes must not commit"); },
    productFailure: async (failure) => { absentFailures.push(failure.statementType); },
  }), "source-collection-failed");
  assert.deepEqual(absentFailures, ["loan"], "explicit absence evidence is not a failure diagnostic");
  assert.deepEqual(summary.products.map(({ typeId, status, errorCode }) => [typeId, status, errorCode]), [
    ["deposit", "no_data", undefined],
    ["credit_card", "not_held", undefined],
    ["loan", "failed", "source-collection-failed"],
  ], "only explicit source evidence can produce no_data or not_held");
}

{
  const controller = signal();
  await assert.rejects(
    collectSelectedProducts({
      productIds: ["deposit", "credit_card", "loan"],
      selectedIds: ["deposit", "credit_card", "loan"],
      signal: controller.signal,
      collect: async (typeId, staged) => {
        staged.push(item(typeId, `${typeId}-1`));
        return { sourceCaptureCount: 1, rowCount: 1, itemCount: 1 };
      },
      commit: async (typeId, staged) => {
        if (typeId === "deposit") controller.abort();
        return result("completed", staged.map(committed));
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProductCollectionInterruptedError);
      assert.equal(error.errorCode, "cancelled");
      assert.equal(error.summary.products.find(({ typeId }) => typeId === "deposit")?.status, "success");
      assert.equal(error.summary.products.find(({ typeId }) => typeId === "deposit")?.committedCount, 1);
      assert.equal(error.summary.products.find(({ typeId }) => typeId === "credit_card")?.status, "skipped");
      assert.equal(error.summary.products.find(({ typeId }) => typeId === "credit_card")?.skipReason, "not_attempted");
      return true;
    },
  );
}

{
  const controller = signal();
  await assert.rejects(
    collectSelectedProducts({
      productIds: ["deposit", "credit_card", "loan"],
      selectedIds: ["deposit", "credit_card", "loan"],
      signal: controller.signal,
      collect: async (typeId, staged) => {
        staged.push(item(typeId, `${typeId}-1`));
        return { sourceCaptureCount: 1, rowCount: 1, itemCount: 1 };
      },
      commit: async (_typeId, staged) => result("completed", staged.map(committed)),
      prepare: async (typeId) => {
        if (typeId === "credit_card") throw new ProductCollectionFatalError("authentication-failed");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProductCollectionInterruptedError);
      assert.equal(error.errorCode, "authentication-failed");
      assert.equal(error.summary.products.find(({ typeId }) => typeId === "deposit")?.committedCount, 1);
      assert.deepEqual(error.summary.products.map(({ typeId, status, skipReason }) => [typeId, status, skipReason]), [
        ["deposit", "success", undefined],
        ["credit_card", "failed", undefined],
        ["loan", "skipped", "not_attempted"],
      ]);
      return true;
    },
  );
}

{
  const controller = signal();
  const commits: string[] = [];
  await assert.rejects(
    collectSelectedProducts({
      productIds: ["deposit", "credit_card", "loan"],
      selectedIds: ["deposit", "credit_card", "loan"],
      signal: controller.signal,
      collect: async (typeId, staged) => {
        staged.push(item(typeId, `${typeId}-1`));
        return { sourceCaptureCount: 1, rowCount: 1, itemCount: 1 };
      },
      commit: async (typeId, staged) => {
        commits.push(typeId);
        if (typeId === "deposit") return result("completed", staged.map(committed));
        return result("failed", staged.map((entry) => ({
          provider: entry.provider,
          product: entry.product,
          itemKey: entry.itemKey,
          status: "failed" as const,
          failureKind: "refused" as const,
          diagnostics: [],
        })));
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProductCollectionInterruptedError);
      assert.equal(error.errorCode, "collection-scope-changed");
      assert.deepEqual(commits, ["deposit", "credit_card"], "no product commits after a refusal");
      assert.deepEqual(error.summary.products.map(({ typeId, status, errorCode }) => [typeId, status, errorCode]).slice(0, 2), [
        ["deposit", "success", undefined],
        ["credit_card", "failed", "collection-scope-changed"],
      ]);
      return true;
    },
  );
}

{
  const controller = signal();
  await assert.rejects(
    collectSelectedProducts({
      productIds: ["deposit", "credit_card"],
      selectedIds: ["deposit", "credit_card"],
      signal: controller.signal,
      collect: async (typeId, staged) => {
        staged.push(item(typeId, `${typeId}-1`));
        return { sourceCaptureCount: 1, rowCount: 1, itemCount: 1 };
      },
      commit: async (typeId, staged) => {
        if (typeId === "deposit") return result("completed", staged.map(committed));
        // The commit port verified the receipts and found none that answers its item.
        throw new CommitOutcomeUnknownError(0);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProductCollectionInterruptedError);
      assert.equal(error.errorCode, "commit-outcome-unknown");
      assert.equal(error.summary.committedCount, 1, "previous verified product receipts remain in the summary");
      assert.deepEqual(error.summary.products.map(({ typeId, status, committedCount, errorCode }) => [typeId, status, committedCount, errorCode]), [
        ["deposit", "success", 1, undefined],
        ["credit_card", "failed", 0, "commit-outcome-unknown"],
      ]);
      return true;
    },
  );
}

{
  const controller = signal();
  await assert.rejects(
    collectSelectedProducts({
      productIds: ["deposit"],
      selectedIds: ["deposit"],
      signal: controller.signal,
      collect: async (_typeId, staged) => {
        staged.push(item("domestic", "duplicate-key"), item("domestic", "duplicate-key"));
        return { sourceCaptureCount: 1, rowCount: 2, itemCount: 2 };
      },
      commit: async () => { throw new Error("duplicate staged identities must fail before commit"); },
    }),
    (error: unknown) => error instanceof ProductCollectionInterruptedError
      && error.errorCode === "workflow-failed",
  );
}

{
  const controller = signal();
  await assert.rejects(
    collectSelectedProducts({
      productIds: ["deposit"],
      selectedIds: ["deposit"],
      signal: controller.signal,
      collect: async (_typeId, staged) => {
        staged.push(item("domestic", "deposit-1"), item("domestic", "deposit-2"));
        return { sourceCaptureCount: 2, rowCount: 2, itemCount: 2 };
      },
      commit: async () => { throw new CommitOutcomeUnknownError(1); },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProductCollectionInterruptedError);
      assert.equal(error.errorCode, "commit-outcome-unknown");
      assert.equal(error.summary.products[0]?.status, "failed");
      assert.equal(error.summary.products[0]?.itemCount, 2);
      assert.equal(error.summary.products[0]?.committedCount, 1, "the validated receipt prefix is preserved");
      return true;
    },
  );
}

{
  // A cancellation raised before the commit request records no attempt and commits nothing.
  const controller = signal();
  await assert.rejects(
    collectSelectedProducts({
      productIds: ["deposit"],
      selectedIds: ["deposit"],
      signal: controller.signal,
      collect: async (_typeId, staged) => {
        staged.push(item("deposit", "deposit-1"));
        return { sourceCaptureCount: 1, rowCount: 1, itemCount: 1 };
      },
      commit: async () => {
        controller.abort();
        controller.signal.throwIfAborted();
        throw new Error("unreachable");
      },
    }),
    (error: unknown) => error instanceof ProductCollectionInterruptedError && error.errorCode === "cancelled",
  );
}

{
  // An unrecorded start commits nothing and stops the run instead of failing each product's source.
  const controller = signal();
  let commits = 0;
  await assert.rejects(
    collectSelectedProducts({
      productIds: ["deposit", "loan"],
      selectedIds: ["deposit", "loan"],
      signal: controller.signal,
      collect: async (typeId, staged) => {
        staged.push(item(typeId, `${typeId}-1`));
        return { sourceCaptureCount: 1, rowCount: 1, itemCount: 1 };
      },
      commit: async () => {
        commits += 1;
        throw new Error("event-persistence-failed");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProductCollectionInterruptedError);
      assert.equal(error.errorCode, "workflow-failed");
      assert.deepEqual(error.summary.products.map(({ typeId, status, errorCode, skipReason }) => [typeId, status, errorCode ?? skipReason]), [
        ["deposit", "failed", "workflow-failed"],
        ["loan", "skipped", "not_attempted"],
      ]);
      return true;
    },
  );
  assert.equal(commits, 1, "no later product attempts a commit");
}

console.log("product-collection checks passed");

{
  const outcome = (
    status: CollectionProductOutcome["status"],
    collection?: CollectionProductOutcome["collection"],
  ): CollectionProductOutcome => ({
    typeId: "securities",
    status,
    itemCount: 0,
    committedCount: 0,
    ...(status === "failed" ? { errorCode: "source-collection-failed" as const } : {}),
    ...(collection ? { collection } : {}),
  });
  const incomplete = { status: "incomplete" as const, exclusionCounts: {} };
  const complete = { status: "complete" as const, exclusionCounts: {} };

  assert.equal(productRunStatus([outcome("success", complete), outcome("no_data"), outcome("skipped")], 3), "completed");
  assert.equal(productRunStatus([outcome("success"), outcome("failed")], 2), "partial");
  assert.equal(productRunStatus([outcome("failed")], 0), "failed");
  assert.equal(productRunStatus([outcome("success", incomplete)], 1), "partial", "incomplete coverage with receipts is partial");
  assert.equal(productRunStatus([outcome("no_data", incomplete)], 0), "failed", "incomplete coverage without receipts fails");
}

const previewRun = (overrides: Partial<PreviewProductRun> = {}): PreviewProductRun => ({
  products: [{ typeId: "credit_card", status: "success", itemCount: 2, committedCount: 2 }],
  receipts: [{ accounts: 2, transactions: 9, balances: 2, statements: 2, closedAccounts: 0 }],
  interrupted: null,
  firstFailure: null,
  ...overrides,
});
const failedPreview = previewRun({
  products: [{ typeId: "credit_card", status: "failed", itemCount: 0, committedCount: 0, errorCode: "source-validation-failed" }],
  receipts: [],
  firstFailure: new Error("synthetic invalid card source"),
});

function depositRun(
  attached: (() => Promise<PreviewProductRun>) | undefined,
  options: Readonly<{ controller?: AbortController; collect?: "commit" | "fail" | "no_data"; commit?: PGliteWorkflowRunResult<unknown>["status"] | "refused" }> = {},
) {
  const controller = options.controller ?? signal();
  return collectSelectedProducts({
    productIds: ["deposit"],
    selectedIds: ["deposit"],
    signal: controller.signal,
    collect: async (typeId, staged) => {
      if (options.collect === "fail") throw new Error("synthetic incomplete verified source");
      if (options.collect === "no_data") return { sourceCaptureCount: 2, rowCount: 0, itemCount: 0, noDataEvidence: true };
      staged.push(item(typeId, `${typeId}-1`), item(typeId, `${typeId}-2`));
      return { sourceCaptureCount: 2, rowCount: 17, itemCount: 2 };
    },
    commit: async (_typeId, staged) => options.commit === "refused"
      ? result("failed", staged.map((entry) => ({ ...committed(entry), status: "failed", failureKind: "refused" }) as never))
      : result(options.commit ?? "completed", staged.map(committed)),
    ...(attached ? { attached } : {}),
  });
}

{
  const summary = await depositRun(async () => previewRun());
  assert.equal(summary.status, "completed");
  assert.equal(summary.sourceCaptureCount, 2, "preview accounts are never Source Captures");
  assert.equal(summary.rowCount, 26);
  assert.equal(summary.itemCount, 4);
  assert.equal(summary.committedCount, 4);
  assert.deepEqual(summary.products.map((product) => product.typeId), ["deposit", "credit_card"]);
}

{
  const summary = await depositRun(async () => failedPreview);
  assert.equal(summary.status, "partial", "an attached failure cannot fail a committed verified product");
  assert.equal(summary.committedCount, 2);
}

{
  let attachedRan = false;
  const summary = await depositRun(async () => {
    attachedRan = true;
    return previewRun({ products: [{ typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 }] });
  }, { collect: "fail" });
  assert.ok(attachedRan, "a recoverable verified failure still runs the attached products");
  assert.equal(summary.status, "partial");
  assert.equal(summary.products[0]?.status, "failed");
}

for (const commit of ["refused", "cancelled"] as const) {
  let attachedRan = false;
  await assert.rejects(depositRun(async () => {
    attachedRan = true;
    return previewRun();
  }, { commit }), (error: unknown) => {
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, commit === "refused" ? "collection-scope-changed" : "cancelled");
    return true;
  });
  assert.equal(attachedRan, false, `a ${commit} verified commit stops the attached products (ADR 0058)`);
}

{
  const cause = new Error("synthetic session ended");
  await assert.rejects(depositRun(async () => ({
    ...failedPreview, interrupted: { errorCode: "authentication-failed", error: cause },
  })), (error: unknown) => {
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, "authentication-failed");
    assert.equal(error.cause, cause);
    assert.equal(error.summary.committedCount, 2);
    assert.deepEqual(error.summary.products.map((product) => product.typeId), ["deposit", "credit_card"]);
    return true;
  });
}

for (const code of ["authentication-failed", "commit-outcome-unknown"] as const) {
  const controller = signal();
  await assert.rejects(depositRun(async () => {
    controller.abort();
    return { ...failedPreview, interrupted: { errorCode: code, error: new Error(code) } };
  }, { controller }), (error: unknown) => {
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, code === "commit-outcome-unknown" ? code : "cancelled",
      "cancellation wins over session loss, but never over an uncertain commit");
    return true;
  });
}

{
  const collected = previewRun({
    products: [{ typeId: "credit_card", status: "failed", itemCount: 0, committedCount: 0, errorCode: "source-validation-failed" }],
    receipts: [],
    firstFailure: new Error("synthetic invalid card source"),
  });
  await assert.rejects(collectSelectedProducts({
    productIds: ["deposit"],
    selectedIds: [],
    signal: signal().signal,
    collect: async () => { throw new Error("an unselected verified product must not collect"); },
    commit: async () => { throw new Error("an unselected verified product must not commit"); },
    attached: async () => collected,
  }), (error: unknown) => error === collected.firstFailure, "an attached-only sole failure keeps its original error");
}

for (const attached of [failedPreview, previewRun({ products: [{ typeId: "credit_card", status: "not_held", itemCount: 0, committedCount: 0 }], receipts: [] })]) {
  const summary = await failedRunSummary(depositRun(async () => attached, { collect: "fail" }), "source-collection-failed");
  assert.deepEqual(summary.products.map((product) => product.typeId), ["deposit", "credit_card"]);
}

{
  const summary = await depositRun(async () => previewRun({
    products: [
      { typeId: "credit_card", status: "not_held", itemCount: 0, committedCount: 0 },
      { typeId: "time_deposit", status: "skipped", itemCount: 0, committedCount: 0, skipReason: "not_selected" },
    ],
    receipts: [],
  }), { collect: "no_data" });
  assert.equal(summary.status, "completed", "explicit absence completes without inventing receipts");
  assert.equal(summary.committedCount, 0);
  assert.equal(summary.products.length, 3);
}

{
  const summary = await depositRun(undefined);
  const output = productRunResult(summary);
  assert.deepEqual(interruptedProductCollectionFromOutput(output)?.summary, summary,
    "late cancellation rebuilds the run's products and counts from its run result");
  assert.equal(interruptedProductCollectionFromOutput({
    ...output,
    products: [{ ...summary.products[0], accountNumber: "synthetic-private-value" }],
  }), undefined, "an invalid product outcome cannot bypass the bounded product contract");
}

for (const [stage, expected] of [["validation", "source-validation-failed"], ["decoding", "source-integrity-failed"], [null, "source-collection-failed"]] as const) {
  const forwarded: string[] = [];
  const summary = await failedRunSummary(collectSelectedProducts({
    productIds: ["deposit"],
    selectedIds: ["deposit"],
    signal: signal().signal,
    event: async (_stage, _outcome, code) => { forwarded.push(code); },
    collect: async (_typeId, _staged, _reportActivity, event) => {
      if (stage) await event(stage, "failed", "source-rejected");
      throw new Error("synthetic untyped collector failure");
    },
    commit: async () => { throw new Error("a failed product must not commit"); },
  }), expected);
  assert.equal(summary.products[0]?.errorCode, expected, `a reported ${stage ?? "no"} failure names the product`);
  if (stage) assert.ok(forwarded.includes("source-rejected"), "collector events still reach the run");
}

{
  const summary = await failedRunSummary(collectSelectedProducts({
    productIds: ["deposit"],
    selectedIds: ["deposit"],
    signal: signal().signal,
    collect: async (_typeId, _staged, _reportActivity, event) => {
      await event("validation", "failed", "source-rejected");
      throw new SourceUnavailableError();
    },
    commit: async () => { throw new Error("a failed product must not commit"); },
  }), "source-unavailable");
  assert.equal(summary.products[0]?.errorCode, "source-unavailable", "a typed error outranks a reported stage");
}
