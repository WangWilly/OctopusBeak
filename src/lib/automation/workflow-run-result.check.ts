import assert from "node:assert/strict";
import test from "node:test";
import type { CollectionProductOutcome, ProductCollectionRunSummary } from "./product-collection.ts";
import { productRunStatus } from "./product-run-status.ts";
import { isWorkflowRunResult, productRunResult, workflowRunResult } from "./workflow-run-result.ts";

function summary(
  products: readonly CollectionProductOutcome[],
  extra: Partial<ProductCollectionRunSummary> = {},
): ProductCollectionRunSummary {
  const committedCount = products.reduce((total, product) => total + product.committedCount, 0);
  return {
    products,
    sourceCaptureCount: 1,
    rowCount: 3,
    itemCount: products.reduce((total, product) => total + product.itemCount, 0),
    committedCount,
    status: productRunStatus(products, committedCount),
    ...extra,
  };
}

const success = { typeId: "deposit", status: "success", itemCount: 2, committedCount: 2 } as const;
const noData = { typeId: "deposit", status: "no_data", itemCount: 0, committedCount: 0 } as const;
const notHeld = { typeId: "loan", status: "not_held", itemCount: 0, committedCount: 0 } as const;
const failed = { typeId: "loan", status: "failed", itemCount: 0, committedCount: 0, errorCode: "source-collection-failed" } as const;
const attachedWrite = { typeId: "credit_card", status: "success", itemCount: 1, committedCount: 1 } as const;
const skipped = { typeId: "deposit", status: "skipped", itemCount: 0, committedCount: 0, skipReason: "not_selected" } as const;

test("a product run's status follows its verified receipts and reported absence", () => {
  const cases: readonly [string, ProductCollectionRunSummary, Parameters<typeof productRunResult>[1], string][] = [
    ["verified receipts", summary([success]), {}, "financial-admitted"],
    ["source-only receipts", summary([success]), { sourceOnly: true }, "source-only"],
    ["every product absent", summary([noData, notHeld]), {}, "no-data"],
    ["a recoverable failure beside receipts", summary([success, failed]), {}, "partial"],
    ["only preview writes", summary([skipped, attachedWrite], { verifiedCommittedCount: 0 }), {}, "completed"],
    ["verified and preview writes", summary([success, attachedWrite], { verifiedCommittedCount: 2 }), {}, "financial-admitted"],
    ["a preview source", summary([attachedWrite]), { preview: true }, "completed"],
  ];
  for (const [name, run, options, status] of cases) {
    assert.equal(productRunResult(run, options).status, status, name);
  }
});

test("a product run result carries the run counts, overridden by provider-scoped counts", () => {
  assert.deepEqual(productRunResult(summary([success]), { counts: { accountCount: 1, rowCount: 2 } }).counts, {
    sourceCaptureCount: 1,
    rowCount: 2,
    itemCount: 2,
    committedCount: 2,
    accountCount: 1,
  });
});

test("a hand-built run result is checked before it leaves the workflow", () => {
  assert.equal(isWorkflowRunResult(workflowRunResult({ status: "completed", counts: { invoiceCount: 3 } })), true);
  assert.throws(() => workflowRunResult({ counts: { invoiceNumber: 3 } } as never), /run result is invalid/u);
  assert.throws(() => workflowRunResult({ status: "done", counts: {} } as never), /run result is invalid/u);
});
