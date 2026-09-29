import { CaptchaProviderRejectedError } from "../captcha-rejection.ts";
import { SourceTextIntegrityError } from "../source-text.ts";
import { SourceAccessChallengeError, SourceUnavailableError } from "../source-access.ts";
import { BrowserRuntimeConfigurationError } from "./browser-runtime.ts";
import type { WorkflowRunEvent } from "../workflow-executor.ts";
import { TYPED_WORKFLOW_ERROR_CODES, type TypedWorkflowErrorCode } from "../workflow-failures.ts";

export type { TypedWorkflowErrorCode } from "../workflow-failures.ts";

export type TypedWorkflowOutcome = Readonly<{
  errorCode: TypedWorkflowErrorCode | null;
  summary: TypedWorkflowOutcomeSummary | null;
}>;

export type TypedWorkflowOutcomeSummary = Readonly<{
  status?: "financial-admitted" | "source-only" | "no-data" | "completed" | "partial" | "failed";
  counts: Readonly<Partial<Record<TypedWorkflowCountName, number>>>;
}>;

type TypedWorkflowCountName =
  | "accountCount"
  | "canonicalCaptureCount"
  | "count"
  | "financialItemCount"
  | "holdingGridCount"
  | "holdingPageCount"
  | "holdingRowCount"
  | "invoiceCount"
  | "itemCount"
  | "rowCount"
  | "skippedAccountCount"
  | "skippedProductCount"
  | "sourceCaptureCount"
  | "statementRowCount"
  | "tradeGridCount"
  | "tradePageCount"
  | "tradeRowCount";

const SAFE_STATUSES = new Set<TypedWorkflowOutcomeSummary["status"]>([
  "financial-admitted",
  "source-only",
  "no-data",
  "completed",
  "partial",
  "failed",
]);
const SAFE_COUNT_NAMES = [
  "accountCount",
  "canonicalCaptureCount",
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
] as const satisfies readonly TypedWorkflowCountName[];
const MAX_COUNT = 1_000_000_000;
const MAX_SUMMARY_BYTES = 512;
const ERROR_CODES = new Set<TypedWorkflowErrorCode>(TYPED_WORKFLOW_ERROR_CODES);

/** Keep only known aggregate fields; provider output may contain financial data. */
export function summarizeTypedWorkflowOutput(
  output: unknown,
): TypedWorkflowOutcomeSummary | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const candidate = output as Record<string, unknown>;
  const status = typeof candidate.status === "string"
    && SAFE_STATUSES.has(candidate.status as TypedWorkflowOutcomeSummary["status"])
    ? candidate.status as NonNullable<TypedWorkflowOutcomeSummary["status"]>
    : undefined;
  const counts: Partial<Record<TypedWorkflowCountName, number>> = {};
  for (const name of SAFE_COUNT_NAMES) {
    const value = candidate[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) {
      continue;
    }
    counts[name] = value;
  }
  if (status === undefined && Object.keys(counts).length === 0) return null;
  const summary: TypedWorkflowOutcomeSummary = {
    ...(status === undefined ? {} : { status }),
    counts,
  };
  if (Buffer.byteLength(JSON.stringify(summary), "utf8") > MAX_SUMMARY_BYTES) return null;
  return summary;
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
  let summary: TypedWorkflowOutcomeSummary | null = null;
  if (candidate.summary && typeof candidate.summary === "object" && !Array.isArray(candidate.summary)) {
    const source = candidate.summary as Record<string, unknown>;
    const counts = source.counts && typeof source.counts === "object" && !Array.isArray(source.counts)
      ? source.counts as Record<string, unknown>
      : {};
    summary = summarizeTypedWorkflowOutput({
      ...counts,
      ...(source.status === undefined ? {} : { status: source.status }),
    });
  }
  return { errorCode, summary };
}

/** Classify from typed failure evidence only; never persist the thrown message. */
export function classifyTypedWorkflowFailure(
  error: unknown,
  events: readonly WorkflowRunEvent[],
  signalAborted = false,
): TypedWorkflowErrorCode {
  if (error instanceof BrowserRuntimeConfigurationError) return "browser-runtime-config-failed";
  if (error instanceof SourceTextIntegrityError) return "source-integrity-failed";
  if (error instanceof SourceAccessChallengeError) return "source-access-challenged";
  if (error instanceof SourceUnavailableError) return "source-unavailable";

  const commitEvents = events.filter((event) => event.stage === "commit");
  const commitFailed = commitEvents.some((event) => /(?:canonical-)?commit-failed$/u.test(event.code));
  if (commitFailed) return "canonical-commit-failed";

  const commitStarted = commitEvents.some((event) => /(?:canonical-)?commit-started$/u.test(event.code));
  const commitCompleted = commitEvents.some((event) => /(?:canonical-)?commit-completed$/u.test(event.code));
  if (commitStarted && !commitCompleted) return "commit-outcome-unknown";

  if (signalAborted) return "cancelled";
  if (error instanceof CaptchaProviderRejectedError) return "captcha-provider-rejected";
  if (events.some((event) => event.stage === "authentication" && (
    event.code === "solver-route-unavailable"
    || event.code === "solver-challenge-unsupported"
  ))) {
    return "verification-configuration-failed";
  }
  if (events.some((event) => event.stage === "decoding" && /(?:rejected|failed|malformed)$/u.test(event.code))) {
    return "source-integrity-failed";
  }
  if (events.some((event) => event.stage === "validation" && /(?:rejected|failed)$/u.test(event.code))) {
    return "source-validation-failed";
  }
  // Finalization reports the terminal state; the preceding stage records the
  // operation that actually failed. No exception text enters the diagnosis.
  const operation = events.findLast((event) => event.stage !== "finalization");
  if (operation?.stage === "authentication") {
    if (error instanceof Error && error.name === "TimeoutError") return "authentication-timeout";
    if (operation.code === "login-dialog-interrupted") return "authentication-dialog-interrupted";
    if (operation.code === "human-assistance-failed") return "verification-failed";
    return "authentication-failed";
  }
  if (operation?.stage === "collection" || operation?.stage === "decoding") {
    return "source-collection-failed";
  }
  return "workflow-failed";
}
