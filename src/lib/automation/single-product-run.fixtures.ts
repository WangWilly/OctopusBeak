import assert from "node:assert/strict";
import { ProductCollectionInterruptedError, type CollectionProductTypeId } from "./product-collection.ts";
import type { WorkflowFinancialCommitPort } from "./workflow-executor.ts";
import type { TypedWorkflowErrorCode } from "./workflow-failures.ts";

/** A returned commit result that stops the run, and the code the run must name. */
export const STOPPED_COMMITS = [
  { stop: "refused", errorCode: "collection-scope-changed" },
  { stop: "cancelled", errorCode: "cancelled" },
] as const;

export type CommitStop = typeof STOPPED_COMMITS[number]["stop"];

/** Returns a refused result (every item refused) or a cancelled one, committing nothing. */
export function stoppedCommitPort(stop: CommitStop): WorkflowFinancialCommitPort {
  return {
    async execute(items) {
      return {
        status: stop === "refused" ? "failed" : "cancelled",
        items: stop === "refused"
          ? items.map((item) => ({
              itemKey: item.itemKey, provider: item.provider, product: item.product,
              status: "failed" as const, failureKind: "refused" as const, diagnostics: [],
            }))
          : [],
        diagnostics: [],
        committedCount: 0,
        failedCount: stop === "refused" ? items.length : 0,
      };
    },
  };
}

/** Asserts a single-product run stopped with the commit's code before any receipt. */
export function assertStoppedRun(
  typeId: CollectionProductTypeId,
  itemCount: number,
  errorCode: typeof STOPPED_COMMITS[number]["errorCode"],
): (error: unknown) => true {
  return (error) => {
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, errorCode);
    assert.deepEqual(error.summary.products, [
      { typeId, status: "failed", itemCount, committedCount: 0, errorCode },
    ]);
    return true;
  };
}

/** Asserts the run named the product's failure and kept the collector's error as its cause. */
export function assertProductFailure(
  errorCode: TypedWorkflowErrorCode,
  cause: RegExp | (abstract new (...args: never[]) => Error),
): (error: unknown) => true {
  return (error) => {
    assert.ok(error instanceof ProductCollectionInterruptedError);
    assert.equal(error.errorCode, errorCode);
    const original = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof RegExp) assert.match(String(original), cause);
    else assert.ok(original instanceof cause);
    return true;
  };
}
