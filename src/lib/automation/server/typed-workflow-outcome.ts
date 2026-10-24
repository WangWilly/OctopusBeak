import { CaptchaProviderRejectedError } from "../captcha-rejection.ts";
import { SourceTextIntegrityError } from "../source-text.ts";
import { ProviderProtocolOutdatedError, SourceAccessChallengeError, SourceUnavailableError } from "../source-access.ts";
import { ExternalPrerequisiteUnavailableError } from "../external-prerequisite.ts";
import { BrowserRuntimeConfigurationError } from "./browser-runtime.ts";
import type { WorkflowRunEvent } from "../run-event.ts";
import {
  ProductCollectionFatalError,
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

/**
 * Classify from typed failure evidence only; never persist the thrown message.
 * Commit outcome is not decided here: the Active Automation Task Run applies the
 * run's Commit attempts (ADR 0056).
 */
export function classifyTypedWorkflowFailure(
  error: unknown,
  events: readonly WorkflowRunEvent[],
  signalAborted = false,
): TypedWorkflowErrorCode {
  if (error instanceof ProductCollectionInterruptedError || error instanceof ProductCollectionFatalError) {
    if (ERROR_CODES.has(error.errorCode)) return error.errorCode;
  }
  if (error instanceof BrowserRuntimeConfigurationError) return "browser-runtime-config-failed";
  if (error instanceof SourceTextIntegrityError) return "source-integrity-failed";
  if (error instanceof SourceAccessChallengeError) return "source-access-challenged";
  if (error instanceof SourceUnavailableError) return "source-unavailable";
  if (error instanceof ProviderProtocolOutdatedError) return "provider-protocol-outdated";
  if (error instanceof ExternalPrerequisiteUnavailableError) return "external-prerequisite-unavailable";

  if (signalAborted) return "cancelled";
  if (events.some((event) => event.signal === "verification-solver-exhausted")) {
    return "verification-failed";
  }
  if (error instanceof CaptchaProviderRejectedError) return "captcha-provider-rejected";
  if (events.some((event) => event.signal === "solver-route-unavailable"
    || event.signal === "solver-challenge-unsupported")) {
    return "verification-configuration-failed";
  }
  if (events.some((event) => event.signal === "human-assistance-failed")) return "verification-failed";
  if (events.some((event) => event.stage === "decoding" && event.outcome === "failed")) {
    return "source-integrity-failed";
  }
  if (events.some((event) => event.stage === "validation" && event.outcome === "failed")) {
    return "source-validation-failed";
  }
  // Finalization reports the terminal state; the preceding stage records the
  // operation that actually failed. No exception text enters the diagnosis.
  const operation = events.findLast((event) => event.stage !== "finalization");
  if (operation?.stage === "authentication") {
    if (error instanceof Error && error.name === "TimeoutError") return "authentication-timeout";
    if (operation.signal === "login-dialog-interrupted") return "authentication-dialog-interrupted";
    return "authentication-failed";
  }
  if (operation?.stage === "collection" || operation?.stage === "decoding") {
    return "source-collection-failed";
  }
  return "workflow-failed";
}
