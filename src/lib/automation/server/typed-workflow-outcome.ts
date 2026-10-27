import {
  ProductCollectionInterruptedError,
  sanitizeCollectionProductOutcomes,
  type CollectionProductOutcome,
} from "../product-collection.ts";
import { aggregateTdccExclusionCounts, TDCC_MAX_SUMMARY_COUNT } from "../tdcc-collection-summary.ts";
import {
  isWorkflowRunResult,
  WORKFLOW_RUN_COUNT_NAMES,
  WORKFLOW_RUN_STATUSES,
  type WorkflowRunCountName,
  type WorkflowRunResult,
  type WorkflowRunStatus,
} from "../workflow-run-result.ts";
import {
  TYPED_WORKFLOW_ERROR_CODES,
  type TypedWorkflowErrorCode,
} from "../workflow-failures.ts";

export type { TypedWorkflowErrorCode } from "../workflow-failures.ts";

export type TypedWorkflowOutcome = Readonly<{
  errorCode: TypedWorkflowErrorCode | null;
  summary: WorkflowRunResult | null;
}>;

const ERROR_CODES = new Set<TypedWorkflowErrorCode>(TYPED_WORKFLOW_ERROR_CODES);
const STATUSES: ReadonlySet<string> = new Set(WORKFLOW_RUN_STATUSES);

/**
 * A run result rebuilt from loose fields, keeping only known counts. Stored
 * outcomes and interrupted runs predate or bypass the workflow's own result.
 */
function looseRunResult(
  status: unknown,
  counts: Readonly<Record<string, unknown>>,
  products: unknown,
): WorkflowRunResult | null {
  const known: Partial<Record<WorkflowRunCountName, number>> = {};
  for (const name of WORKFLOW_RUN_COUNT_NAMES) {
    const value = counts[name];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= TDCC_MAX_SUMMARY_COUNT) {
      known[name] = value;
    }
  }
  let sanitized: readonly CollectionProductOutcome[] | undefined;
  if (products !== undefined) {
    const outcomes = sanitizeCollectionProductOutcomes(products);
    if (!outcomes) return null;
    sanitized = outcomes;
  }
  const knownStatus = typeof status === "string" && STATUSES.has(status) ? status as WorkflowRunStatus : undefined;
  if (knownStatus === undefined && Object.keys(known).length === 0 && sanitized === undefined) return null;
  const result: WorkflowRunResult = {
    ...(knownStatus === undefined ? {} : { status: knownStatus }),
    counts: known,
    ...(sanitized === undefined ? {} : { products: sanitized }),
  };
  return isWorkflowRunResult(result) ? result : null;
}

/** Keep committed product outcomes when a fatal stop interrupts the workflow. */
export function summarizeInterruptedProductCollection(
  error: unknown,
): WorkflowRunResult | null {
  if (!(error instanceof ProductCollectionInterruptedError)) return null;
  const { summary } = error;
  const tdccEvidence = summary.products.flatMap((product) =>
    product.collection ? [product.collection.exclusionCounts] : []);
  const exclusionCounts = tdccEvidence.length > 0
    ? aggregateTdccExclusionCounts(tdccEvidence)
    : {};
  return looseRunResult(summary.status, {
    sourceCaptureCount: summary.sourceCaptureCount,
    rowCount: summary.rowCount,
    itemCount: summary.itemCount,
    committedCount: summary.committedCount,
    ...exclusionCounts,
  }, summary.products);
}

/** Normalize persisted outcome metadata to the same strict allow-list. */
export function sanitizeTypedWorkflowOutcome(value: unknown): TypedWorkflowOutcome | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const errorCode = candidate.errorCode === null
    ? null
    : typeof candidate.errorCode === "string" && ERROR_CODES.has(candidate.errorCode as TypedWorkflowErrorCode)
    ? candidate.errorCode as TypedWorkflowErrorCode
    : "workflow-failed";
  let summary: WorkflowRunResult | null = null;
  if (candidate.summary && typeof candidate.summary === "object" && !Array.isArray(candidate.summary)) {
    const source = candidate.summary as Record<string, unknown>;
    const counts = source.counts && typeof source.counts === "object" && !Array.isArray(source.counts)
      ? source.counts as Record<string, unknown>
      : {};
    summary = looseRunResult(source.status, counts, source.products);
  }
  return { errorCode, summary };
}
