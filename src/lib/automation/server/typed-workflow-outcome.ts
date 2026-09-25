import { SourceTextIntegrityError } from "../source-text.ts";
import type { WorkflowRunEvent } from "../workflow-executor.ts";

export type TypedWorkflowErrorCode =
  | "cancelled"
  | "source-integrity-failed"
  | "source-validation-failed"
  | "canonical-commit-failed"
  | "commit-outcome-unknown"
  | "workflow-failed";

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

/** Classify from typed failure evidence only; never persist the thrown message. */
export function classifyTypedWorkflowFailure(
  error: unknown,
  events: readonly WorkflowRunEvent[],
  signalAborted = false,
): TypedWorkflowErrorCode {
  if (error instanceof SourceTextIntegrityError) return "source-integrity-failed";

  const commitEvents = events.filter((event) => event.stage === "commit");
  const commitFailed = commitEvents.some((event) => /(?:canonical-)?commit-failed$/u.test(event.code));
  if (commitFailed) return "canonical-commit-failed";

  const commitStarted = commitEvents.some((event) => /(?:canonical-)?commit-started$/u.test(event.code));
  const commitCompleted = commitEvents.some((event) => /(?:canonical-)?commit-completed$/u.test(event.code));
  if (commitStarted && !commitCompleted) return "commit-outcome-unknown";

  if (signalAborted) return "cancelled";
  if (events.some((event) => event.stage === "decoding" && /(?:rejected|failed|malformed)$/u.test(event.code))) {
    return "source-integrity-failed";
  }
  if (events.some((event) => event.stage === "validation" && /(?:rejected|failed)$/u.test(event.code))) {
    return "source-validation-failed";
  }
  return "workflow-failed";
}
