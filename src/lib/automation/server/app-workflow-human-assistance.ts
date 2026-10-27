import { signalRunEvent } from "../run-event.ts";
import type { HumanAssistanceContractInput } from "../human-assistance.ts";
import type { WorkflowHumanAssistancePort } from "../workflow-executor.ts";
import { isSolverChallengeKind } from "../verification-config.ts";
import type { ActiveAutomationTaskRun, WorkflowExecution } from "./active-task-run.ts";

export type AppWorkflowHumanAssistanceRequest = Readonly<{
  run: ActiveAutomationTaskRun;
  /** The Workflow execution waiting on this request; a route records its signals here. */
  execution: WorkflowExecution;
  contract: HumanAssistanceContractInput;
  signal: AbortSignal;
}>;

/** Answers the human assistance requests of one Workflow execution. */
export type HumanAssistanceRoute = (
  request: AppWorkflowHumanAssistanceRequest,
) => void | Promise<void>;

export function createAppWorkflowHumanAssistancePort(input: Readonly<{
  run: ActiveAutomationTaskRun;
  execution: WorkflowExecution;
}>): WorkflowHumanAssistancePort {
  const { run, execution } = input;
  return {
    async request(contract, signal) {
      signal.throwIfAborted();
      const waiter = execution.holdAssistance();
      const onAbort = () => {
        waiter.reject(signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        if (run.current().status !== "running") {
          throw new Error("App workflow is not active for human assistance.");
        }
        const route = execution.assistanceRoute();
        if (!route) {
          const reason = isSolverChallengeKind(contract.challengeKind)
            ? "solver-route-unavailable"
            : "solver-challenge-unsupported";
          await execution.appendEvent(signalRunEvent(reason, {
            runId: run.taskRunId,
            occurredAt: new Date().toISOString(),
          }));
          throw new Error("App workflow solver route is unavailable for this verification stage.");
        }
        await run.updateHumanAssistanceContract(contract);
        if (!(await run.transition("waiting_for_human"))) {
          throw new Error("App workflow could not enter its human assistance stage.");
        }
        signal.throwIfAborted();
        void Promise.resolve()
          .then(() => route({ run, execution, contract, signal }))
          .catch((error: unknown) => {
            if (signal.aborted) return;
            waiter.reject(error instanceof Error ? error : new Error("App workflow verification route failed."));
          });
        return await waiter.completion;
      } finally {
        signal.removeEventListener("abort", onAbort);
        waiter.reject(new Error("The human assistance request has ended."));
      }
    },
  };
}

/**
 * Record the request's stage as complete in the way its contract declares,
 * then resume the execution waiting on it. The run moves back to running
 * only after the completion is stored.
 */
export async function completeAppWorkflowHumanAssistance(
  request: AppWorkflowHumanAssistanceRequest,
) {
  const { run, execution, signal } = request;
  signal.throwIfAborted();
  const current = run.current();
  const assistance = current.humanAssistanceContract;
  // A route that outlived its execution finds no waiter and writes nothing.
  if (
    !execution.pendingAssistance()
    || current.status !== "waiting_for_human"
    || assistance?.stageId !== request.contract.stageId
  ) {
    throw new Error("App workflow verification stage is no longer current.");
  }
  const status = assistance.completion.mode === "independent" ? "verified" : "entered";
  await run.updateHumanAssistanceCompletion(status);
  signal.throwIfAborted();
  const waiter = execution.pendingAssistance();
  if (
    !waiter
    || run.current().status !== "waiting_for_human"
    || run.current().humanAssistanceContract?.completion.status !== status
    || !(await run.transition("running"))
  ) {
    throw new Error("App workflow could not resume the current verification stage.");
  }
  waiter.resolve(status);
}
