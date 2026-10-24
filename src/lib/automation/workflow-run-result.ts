import {
  sanitizeCollectionProductOutcomes,
  type CollectionProductOutcome,
  type ProductCollectionRunSummary,
} from "./product-collection.ts";
import {
  tdccSummaryMatchesEvidence,
  TDCC_EXCLUSION_COUNT_NAMES,
  TDCC_MAX_SUMMARY_COUNT,
} from "./tdcc-collection-summary.ts";

export const WORKFLOW_RUN_STATUSES = [
  "financial-admitted",
  "source-only",
  "no-data",
  "completed",
  "partial",
  "failed",
] as const;
export type WorkflowRunStatus = typeof WORKFLOW_RUN_STATUSES[number];

export const WORKFLOW_RUN_COUNT_NAMES = [
  "accountCount",
  "canonicalCaptureCount",
  "committedCount",
  "count",
  "financialItemCount",
  "holdingGridCount",
  "holdingPageCount",
  "holdingRowCount",
  "invoiceCount",
  "itemCount",
  "rowCount",
  "skippedAccountCount",
  "skippedProductCount",
  "sourceCaptureCount",
  "statementRowCount",
  "tradeGridCount",
  "tradePageCount",
  "tradeRowCount",
  ...TDCC_EXCLUSION_COUNT_NAMES,
] as const;
export type WorkflowRunCountName = typeof WORKFLOW_RUN_COUNT_NAMES[number];
export type WorkflowRunCounts = Readonly<Partial<Record<WorkflowRunCountName, number>>>;

/**
 * What a workflow returns and the host records: aggregate counts and product
 * outcomes only, never provider data. The worker refuses any other shape.
 */
export type WorkflowRunResult = Readonly<{
  status?: WorkflowRunStatus;
  counts: WorkflowRunCounts;
  products?: readonly CollectionProductOutcome[];
}>;

const STATUSES: ReadonlySet<string> = new Set(WORKFLOW_RUN_STATUSES);
const COUNT_NAMES: ReadonlySet<string> = new Set(WORKFLOW_RUN_COUNT_NAMES);
const MAX_RESULT_BYTES = 4_096;

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= TDCC_MAX_SUMMARY_COUNT;
}

/** Whether a value is exactly a run result, as both sides of the worker seam require. */
export function isWorkflowRunResult(value: unknown): value is WorkflowRunResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !["status", "counts", "products"].includes(key))) return false;
  if (!candidate.counts || typeof candidate.counts !== "object" || Array.isArray(candidate.counts)) return false;
  const counts = candidate.counts as Record<string, unknown>;
  if (Object.entries(counts).some(([name, count]) => !COUNT_NAMES.has(name) || !isSafeCount(count))) return false;
  if (candidate.status !== undefined && (typeof candidate.status !== "string" || !STATUSES.has(candidate.status))) {
    return false;
  }
  let products: readonly CollectionProductOutcome[] | undefined;
  if (candidate.products !== undefined) {
    const sanitized = sanitizeCollectionProductOutcomes(candidate.products);
    if (!sanitized) return false;
    products = sanitized;
  }
  const status = candidate.status as WorkflowRunStatus | undefined;
  if (!tdccSummaryMatchesEvidence({ products, counts: counts as WorkflowRunCounts, status })) return false;
  return Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_RESULT_BYTES;
}

/** A run result a workflow builds itself; an invalid one is a workflow defect. */
export function workflowRunResult(result: WorkflowRunResult): WorkflowRunResult {
  if (!isWorkflowRunResult(result)) throw new Error("Workflow run result is invalid.");
  return Object.freeze({ ...result, counts: Object.freeze({ ...result.counts }) });
}

/** The run result of a Product collection run, which always carries its product outcomes. */
export type ProductRunResult = WorkflowRunResult & Readonly<{ products: readonly CollectionProductOutcome[] }>;

export type ProductRunResultOptions = Readonly<{
  /** Counts only this provider reports, or a provider-scoped value of a run count. */
  counts?: WorkflowRunCounts;
  /** Every committed item was a source assertion without financial facts. */
  sourceOnly?: boolean;
  /** Preview Financial Data is never admitted, so a completed run stays `completed`. */
  preview?: boolean;
}>;

/**
 * The run result of a Product collection run. A completed run with verified
 * receipts is `financial-admitted` or `source-only`. Without them it is
 * `no-data` when products were attempted and every one reported absence, and
 * `completed` otherwise, including a run whose only writes were Preview
 * Financial Data.
 */
export function productRunResult(
  summary: ProductCollectionRunSummary,
  options: ProductRunResultOptions = {},
): ProductRunResult {
  return workflowRunResult({
    status: productRunStatusLabel(summary, options),
    counts: {
      sourceCaptureCount: summary.sourceCaptureCount,
      rowCount: summary.rowCount,
      itemCount: summary.itemCount,
      committedCount: summary.committedCount,
      ...options.counts,
    },
    products: summary.products,
  }) as ProductRunResult;
}

function productRunStatusLabel(summary: ProductCollectionRunSummary, options: ProductRunResultOptions): WorkflowRunStatus {
  if (summary.status !== "completed" || options.preview) return summary.status;
  if ((summary.verifiedCommittedCount ?? summary.committedCount) > 0) {
    return options.sourceOnly ? "source-only" : "financial-admitted";
  }
  const attempted = summary.products.filter((product) => product.status !== "skipped");
  return attempted.length > 0 && attempted.every((product) => product.status === "no_data" || product.status === "not_held")
    ? "no-data"
    : "completed";
}

