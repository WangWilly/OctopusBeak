import type { WorkflowFailureCorrelation } from "../automation/server/workflow-failure-diagnostics.ts";

/**
 * Whether the host lets a workflow's write through (ADR 0058, ADR 0148).
 * `run-not-current`: the write names no run, an unknown run, a run with no
 * current execution, or an execution launched without a scope.
 *
 * The RPC servers import this module alone, so the PGlite worker graph never
 * loads automation settings or the preview-source registry.
 */
export type WorkflowWriteAdmission = "admitted" | "scope-changed" | "run-not-current";

/** Asked before each gated write of a correlated request. A throw is an ordinary failure, not a refusal. */
export type WorkflowWriteAdmissionCheck = (context: WorkflowFailureCorrelation) => WorkflowWriteAdmission;

/** The admission of a request, which is `run-not-current` when it names no run. */
export function workflowWriteAdmission(
  check: WorkflowWriteAdmissionCheck,
  context: WorkflowFailureCorrelation | undefined,
): WorkflowWriteAdmission {
  return context ? check(context) : "run-not-current";
}

/** The diagnostic Failure code of a refusal: only a changed scope is `collection-scope-changed`. */
export function refusalDiagnosticCode(admission: Exclude<WorkflowWriteAdmission, "admitted">) {
  return admission === "scope-changed" ? "collection-scope-changed" : "run-not-current";
}
