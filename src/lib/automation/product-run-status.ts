import type { CollectionProductOutcome, ProductCollectionRunSummary } from "./product-collection.ts";

/**
 * The whole-run status rule. A failed product, or one whose source coverage is
 * incomplete, leaves the run partial once anything committed and failed otherwise.
 */
export function productRunStatus(
  products: readonly CollectionProductOutcome[],
  committedCount: number,
): ProductCollectionRunSummary["status"] {
  const unfinished = products.some((product) =>
    product.status === "failed" || product.collection?.status === "incomplete");
  if (!unfinished) return "completed";
  return committedCount > 0 ? "partial" : "failed";
}
