import assert from "node:assert/strict";
import type {
  PGliteWorkflowItemResult,
  PGliteWorkflowRunItem,
  PGliteWorkflowRunResult,
} from "../../ledger/pglite/workflow-run.ts";
import { PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND } from "../../ledger/pglite/workflow-client.ts";
import {
  collectSelectedProducts,
  ProductCollectionFatalError,
  ProductCollectionInterruptedError,
  StatementComponentAbsentError,
} from "./product-collection.ts";

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

function failed(itemValue: PGliteWorkflowRunItem): PGliteWorkflowItemResult<unknown> {
  return {
    provider: itemValue.provider,
    product: itemValue.product,
    itemKey: itemValue.itemKey,
    status: "failed",
    failureKind: "fatal",
    diagnostics: [],
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
  });
  assert.deepEqual(committedProducts, ["deposit", "loan"]);
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
  const summary = await collectSelectedProducts({
    productIds: ["deposit", "credit_card", "loan"],
    selectedIds: ["deposit", "credit_card", "loan"],
    signal: controller.signal,
    collect: async (typeId) => {
      const disposition = dispositions[["deposit", "credit_card", "loan"].indexOf(typeId)]!;
      throw new StatementComponentAbsentError("no source record", disposition);
    },
    commit: async () => { throw new Error("empty outcomes must not commit"); },
  });
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
        if (typeId === "deposit") return result("completed", staged.map(committed));
        return result("completed", staged.map(committed));
      },
      event: async (stage, code) => {
        if (stage === "commit" && code === "deposit-canonical-commit-completed") controller.abort();
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
        const wrong = item(typeId, "different-product-item");
        return result("failed", [committed(wrong)], [{
          provider: "fubon", product: typeId, itemKey: wrong.itemKey,
          stage: "run", errorCode: "worker-failure", message: "safe",
        }]);
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
      commit: async (_typeId, staged) => result("failed", [committed(staged[0]!), failed(staged[1]!)], [{
        provider: "fubon", product: "domestic", itemKey: staged[1]!.itemKey,
        stage: "run", errorCode: "worker-failure", message: "safe",
      }]),
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

console.log("product-collection checks passed");
