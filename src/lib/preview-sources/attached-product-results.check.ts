import assert from "node:assert/strict";
import test from "node:test";
import { ProductCollectionInterruptedError, interruptedProductCollectionFromOutput } from "../automation/product-collection.ts";
import { finishAttachedProductRun, type VerifiedProductResults } from "./attached-product-results.ts";
import type { PreviewProductRun } from "./product-collection.ts";

const verified: VerifiedProductResults = {
  products: [{ typeId: "domestic", status: "success", itemCount: 4, committedCount: 4 }],
  sourceCaptureCount: 2,
  rowCount: 17,
};
const failed: PreviewProductRun = {
  products: [{ typeId: "credit_card", status: "failed", itemCount: 0, committedCount: 0, errorCode: "source-validation-failed" }],
  receipts: [],
  interrupted: null,
  firstFailure: new Error("synthetic invalid card source"),
};
const empty: VerifiedProductResults = { products: [], sourceCaptureCount: 0, rowCount: 0 };

test("attached results retain distinct Source Capture, row and durable item counts", () => {
  const summary = finishAttachedProductRun(verified, {
    products: [{ typeId: "credit_card", status: "success", itemCount: 2, committedCount: 2 }],
    receipts: [{ accounts: 2, transactions: 9, balances: 2, statements: 2, closedAccounts: 0 }],
    interrupted: null,
    firstFailure: null,
  });
  assert.equal(summary.status, "completed");
  assert.equal(summary.sourceCaptureCount, 2);
  assert.equal(summary.rowCount, 26);
  assert.equal(summary.itemCount, 6);
  assert.equal(summary.committedCount, 6);
  assert.deepEqual(summary.products.map((p) => p.typeId), ["domestic", "credit_card"]);
  assert.equal(interruptedProductCollectionFromOutput(summary)?.summary.committedCount, 6,
    "late cancellation can reconstruct the same durable evidence");
});

test("ordinary attached failure is partial and cannot change a completed verified product", () => {
  const summary = finishAttachedProductRun(verified, failed);
  assert.equal(summary.status, "partial");
  assert.deepEqual(summary.products, [...verified.products, ...failed.products]);
  assert.equal(summary.committedCount, 4);
});

test("a failed verified product can coexist with successful attached writes", () => {
  const summary = finishAttachedProductRun({ ...empty, products: failed.products, firstFailure: failed.firstFailure }, {
    products: [{ typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 }],
    receipts: [], interrupted: null, firstFailure: null,
  });
  assert.equal(summary.status, "partial");
  assert.equal(summary.committedCount, 1);
  assert.equal(summary.products[0]?.status, "failed");
});

test("session loss preserves the combined evidence and the fatal error code and cause", () => {
  const cause = new Error("synthetic session ended");
  assert.throws(() => finishAttachedProductRun(verified, {
    ...failed, interrupted: { errorCode: "authentication-failed", error: cause },
  }), (error: unknown) => {
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, "authentication-failed");
    assert.equal(error.cause, cause);
    assert.equal(error.summary.status, "partial");
    assert.equal(error.summary.sourceCaptureCount, 2);
    assert.equal(error.summary.rowCount, 17);
    assert.equal(error.summary.committedCount, 4);
    assert.deepEqual(error.summary.products, [...verified.products, ...failed.products]);
    return true;
  });
});

test("cooperative cancellation retains completed evidence even before attached collection", () => {
  const controller = new AbortController();
  controller.abort(new Error("synthetic cancellation"));
  assert.throws(() => finishAttachedProductRun(verified, null, controller.signal), (error: unknown) => {
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, "cancelled");
    assert.deepEqual(error.summary.products, verified.products);
    assert.equal(error.summary.committedCount, 4);
    assert.equal(error.cause, controller.signal.reason);
    return true;
  });
});

test("cancellation wins over session loss, but never over an uncertain commit", () => {
  const controller = new AbortController();
  controller.abort();
  for (const code of ["authentication-failed", "commit-outcome-unknown"] as const) {
    assert.throws(() => finishAttachedProductRun(verified, {
      ...failed, interrupted: { errorCode: code, error: new Error(code) },
    }, controller.signal), (error: unknown) => {
      assert.ok(error instanceof ProductCollectionInterruptedError);
      assert.equal(error.errorCode, code === "commit-outcome-unknown" ? code : "cancelled");
      assert.equal(error.summary.committedCount, 4);
      return true;
    });
  }
});

test("an attached-only sole failure keeps its original classified error", () => {
  assert.throws(() => finishAttachedProductRun(empty, failed), (error: unknown) => error === failed.firstFailure);
});

test("multiple failures without a retained verified error keep every product outcome", () => {
  assert.throws(() => finishAttachedProductRun({
    ...empty,
    products: [{ typeId: "deposit", status: "failed", itemCount: 0, committedCount: 0, errorCode: "source-collection-failed" }],
  }, failed), (error: unknown) => {
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.summary.status, "failed");
    assert.equal(error.summary.committedCount, 0);
    assert.deepEqual(error.summary.products.map((p) => p.typeId), ["deposit", "credit_card"]);
    return true;
  });
});

for (const status of ["failed", "no_data", "not_held"] as const) {
  test(`the verified collection's original error survives an attached ${status} result without durable writes`, () => {
    const original = new Error("synthetic incomplete verified source");
    const attached: PreviewProductRun = status === "failed" ? failed : {
      products: [{ typeId: "credit_card", status, itemCount: 0, committedCount: 0 }],
      receipts: [], interrupted: null, firstFailure: null,
    };
    assert.throws(() => finishAttachedProductRun({
      ...empty,
      products: [{ typeId: "deposit", status: "failed", itemCount: 0, committedCount: 0, errorCode: "source-collection-failed" }],
      firstFailure: original,
    }, attached), (error: unknown) => error === original);
  });
}

test("explicit absence and unselected products complete without inventing receipts", () => {
  const summary = finishAttachedProductRun({
    ...empty, products: [{ typeId: "deposit", status: "no_data", itemCount: 0, committedCount: 0 }],
  }, {
    products: [
      { typeId: "credit_card", status: "not_held", itemCount: 0, committedCount: 0 },
      { typeId: "time_deposit", status: "skipped", itemCount: 0, committedCount: 0, skipReason: "not_selected" },
    ], receipts: [], interrupted: null, firstFailure: null,
  });
  assert.equal(summary.status, "completed");
  assert.equal(summary.committedCount, 0);
  assert.equal(summary.products.length, 3);
});

test("late cancellation uses the common snapshot rather than provider-owned row fields", () => {
  const summary = finishAttachedProductRun(verified, null);
  const output = { ...summary, rowCount: 99, productCollectionSummary: summary };
  assert.deepEqual(interruptedProductCollectionFromOutput(output)?.summary, summary);
  assert.equal(interruptedProductCollectionFromOutput({
    ...output,
    productCollectionSummary: { ...summary, products: [{ ...summary.products[0], accountNumber: "synthetic-private-value" }] },
  }), undefined, "an invalid explicit snapshot cannot bypass the bounded product contract");
});
