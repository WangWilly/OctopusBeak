import {
  ProductCollectionInterruptedError,
  type ProductCollectionRunSummary,
} from "../automation/product-collection.ts";
import { previewRunSummary, type PreviewProductRun } from "./product-collection.ts";

/** Provider-owned evidence from completed verified collection, before attached results are combined. */
export type VerifiedProductResults = Pick<ProductCollectionRunSummary, "products" | "sourceCaptureCount" | "rowCount"> &
  Readonly<{
    /** Original verified error to preserve when no product has durable receipts. */
    firstFailure?: unknown;
  }>;

/**
 * Owns whole-run result policy for Attached Preview Products (ADR 0051).
 * Counts retain their units: preview accounts are commit items, never Source
 * Captures; provider account/row counts stay in the provider's output adapter.
 * Fatal interruption/cancellation carry this same snapshot, without changing
 * the host's terminal failure precedence (ADR 0036).
 */
export function finishAttachedProductRun(
  verified: VerifiedProductResults,
  attached: PreviewProductRun | null,
  signal?: AbortSignal,
): ProductCollectionRunSummary {
  const preview = attached ? previewRunSummary(attached) : null;
  const products = Object.freeze([...verified.products, ...(preview?.products ?? [])]);
  const committedCount = products.reduce((total, product) => total + product.committedCount, 0);
  const failed = products.find((product) => product.status === "failed");
  const summary: ProductCollectionRunSummary = Object.freeze({
    products,
    sourceCaptureCount: verified.sourceCaptureCount,
    rowCount: verified.rowCount + (preview?.rowCount ?? 0),
    itemCount: products.reduce((total, product) => total + product.itemCount, 0),
    committedCount,
    status: failed ? committedCount > 0 ? "partial" : "failed" : "completed",
  });
  // An uncertain commit remains a failure even when cancellation also wins.
  const interruption = attached?.interrupted;
  if (interruption && (interruption.errorCode === "commit-outcome-unknown" || !signal?.aborted)) {
    throw withCause(new ProductCollectionInterruptedError(interruption.errorCode, summary), interruption.error);
  }
  if (signal?.aborted || interruption) {
    throw withCause(new ProductCollectionInterruptedError("cancelled", summary), signal?.reason ?? interruption?.error);
  }
  if (summary.status === "failed") {
    if (verified.firstFailure !== null && verified.firstFailure !== undefined) throw verified.firstFailure;
    const attempted = products.filter((product) => product.status !== "skipped");
    const firstFailure = attached?.firstFailure;
    if (attempted.length === 1 && firstFailure !== null && firstFailure !== undefined) throw firstFailure;
    throw withCause(new ProductCollectionInterruptedError(failed!.errorCode ?? "source-collection-failed", summary), firstFailure);
  }
  return summary;
}

function withCause(error: ProductCollectionInterruptedError, cause: unknown): ProductCollectionInterruptedError {
  if (cause !== null && cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}
