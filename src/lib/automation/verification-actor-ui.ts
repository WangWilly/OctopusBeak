import type { WorkflowRunEvent } from "./workflow-executor.ts";

type VerificationEvent = Pick<WorkflowRunEvent, "stage" | "code">;

export function isVerificationSolverExhaustedEvent(event: VerificationEvent): boolean {
  return event.stage === "authentication" && event.code === "verification-solver-exhausted";
}

export function verificationSolverExhausted(
  events: readonly VerificationEvent[] | null | undefined,
): boolean {
  return events?.some(isVerificationSolverExhaustedEvent) ?? false;
}
