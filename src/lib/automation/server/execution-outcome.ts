import type { TaskRunFailure, TaskRunReport } from "./active-task-run.ts";
import type { AppWorkflowWorkerOutcome } from "./app-workflow-worker-supervisor.ts";
import type { WorkflowRunEvent } from "../run-event.ts";
import type { WorkflowRunResult } from "../workflow-run-result.ts";
import { TYPED_WORKFLOW_ERROR_CODES, type TypedWorkflowErrorCode } from "../workflow-failures.ts";
import { classifyFailure } from "../failure-classification.ts";
import { summarizeInterruptedProductCollection } from "./typed-workflow-outcome.ts";

/** How one workflow execution ended, as the host saw it. */
export type ExecutionEnding =
  | Readonly<{ kind: "worker"; outcome: AppWorkflowWorkerOutcome }>
  | Readonly<{
    kind: "host-error";
    error: unknown;
    cancelled: boolean;
    /** The worker's summary when the host failed after the worker returned. */
    workerSummary: WorkflowRunResult | null;
  }>;

const ERROR_CODES: ReadonlySet<string> = new Set(TYPED_WORKFLOW_ERROR_CODES);

/** Only the run's Commit attempts can say a commit outcome is unknown (ADR 0056). */
function classified(code: TypedWorkflowErrorCode): TaskRunFailure {
  return { code: code === "commit-outcome-unknown" ? "workflow-failed" : code, proven: false };
}

/**
 * A worker's code counts as reported when it is specific, or when a failed
 * product confirms a generic workflow-failed.
 */
function reportedWorkerCode(
  outcome: Extract<AppWorkflowWorkerOutcome, { status: "failed" }>,
): TaskRunFailure["code"] | undefined {
  if (!ERROR_CODES.has(outcome.errorCode)) return undefined;
  const code = outcome.errorCode as TypedWorkflowErrorCode;
  if (code === "commit-outcome-unknown") return undefined;
  const productConfirms = outcome.summary?.products?.some(
    (product) => product.status === "failed" && product.errorCode === code,
  );
  return code !== "workflow-failed" || productConfirms ? code : undefined;
}

/**
 * A failed worker's code is proven when the classification names it, or when
 * the host's missing solver route names a verification configuration failure.
 * Anything else is classified from the execution's events.
 */
function workerFailure(
  outcome: Exclude<AppWorkflowWorkerOutcome, { status: "completed" }>,
  events: readonly WorkflowRunEvent[],
): TaskRunFailure {
  if (outcome.status === "cancelled") return { code: "cancelled", proven: false };
  const reported = reportedWorkerCode(outcome);
  const code = classifyFailure({ reported, events, stopped: false });
  if (reported !== undefined && code === reported) return { code: reported, proven: true };
  return code === "verification-configuration-failed" ? { code, proven: true } : classified(code);
}

/**
 * The report one execution gives its Active Automation Task Run, before the
 * run's Commit attempts and stop are applied (ADR 0058).
 */
export function reportExecution(
  ending: ExecutionEnding,
  events: readonly WorkflowRunEvent[],
): TaskRunReport {
  if (ending.kind === "host-error") {
    return {
      summary: summarizeInterruptedProductCollection(ending.error) ?? ending.workerSummary,
      failure: classified(classifyFailure({ error: ending.error, events, stopped: ending.cancelled })),
    };
  }
  const { outcome } = ending;
  return {
    summary: outcome.summary,
    failure: outcome.status === "completed" ? null : workerFailure(outcome, events),
  };
}
