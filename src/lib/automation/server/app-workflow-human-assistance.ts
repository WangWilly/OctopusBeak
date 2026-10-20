import type {
  HumanAssistanceCompletionStatus,
  HumanAssistanceContractInput,
} from "../human-assistance.ts";
import type { WorkflowHumanAssistancePort } from "../workflow-executor.ts";
import { isSolverChallengeKind } from "../verification-config.ts";
import type { ActiveAutomationTaskRun } from "./active-task-run.ts";

type PendingAssistance = Readonly<{
  run: ActiveAutomationTaskRun;
  resolve(status: Exclude<HumanAssistanceCompletionStatus, "pending">): void;
}>;

export type AppWorkflowHumanAssistanceRequest = Readonly<{
  taskId: string;
  taskRunId: string;
  contract: HumanAssistanceContractInput;
  signal: AbortSignal;
}>;

type HumanAssistanceRequestHandler = (
  request: AppWorkflowHumanAssistanceRequest,
) => void | Promise<void>;

const pendingAssistance = new Map<string, PendingAssistance>();
const requestHandlers = new Map<string, HumanAssistanceRequestHandler>();

/** Install the executor's verifier for the duration of one active task run. */
export function registerAppWorkflowHumanAssistanceRequestHandler(
  taskId: string,
  handler: HumanAssistanceRequestHandler,
) {
  if (requestHandlers.has(taskId)) {
    throw new Error("An App workflow human assistance route is already registered for this task.");
  }
  requestHandlers.set(taskId, handler);
  return () => {
    if (requestHandlers.get(taskId) === handler) requestHandlers.delete(taskId);
  };
}

export function createAppWorkflowHumanAssistancePort(input: Readonly<{
  run: ActiveAutomationTaskRun;
  onRequest?: (
    contract: HumanAssistanceContractInput,
    signal: AbortSignal,
  ) => void | Promise<void>;
}>): WorkflowHumanAssistancePort {
  const { run } = input;
  return {
    async request(contract, signal) {
      signal.throwIfAborted();
      if (pendingAssistance.has(run.taskRunId)) {
        throw new Error("This workflow run already has a pending human assistance request.");
      }

      let resolveCompletion!: PendingAssistance["resolve"];
      let rejectCompletion!: (error: Error) => void;
      const completion = new Promise<Exclude<HumanAssistanceCompletionStatus, "pending">>(
        (resolve, reject) => {
          resolveCompletion = resolve;
          rejectCompletion = reject;
        },
      );
      const waiter: PendingAssistance = { run, resolve: resolveCompletion };
      pendingAssistance.set(run.taskRunId, waiter);
      const onAbort = () => {
        rejectCompletion(signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        if (run.current().status !== "running") {
          throw new Error("App workflow is not active for human assistance.");
        }
        const registeredHandler = requestHandlers.get(run.taskId);
        if (!input.onRequest && !registeredHandler) {
          const reason = isSolverChallengeKind(contract.challengeKind)
            ? "solver-route-unavailable"
            : "solver-challenge-unsupported";
          await run.persistence.appendRunEvent({
            runId: run.taskRunId,
            stage: "authentication",
            code: reason,
            occurredAt: new Date().toISOString(),
          });
          throw new Error("App workflow solver route is unavailable for this verification stage.");
        }
        await run.persistence.updateHumanAssistanceContract(run.taskRunId, contract);
        if (!(await run.transition("waiting_for_human"))) {
          throw new Error("App workflow could not enter its human assistance stage.");
        }
        signal.throwIfAborted();
        if (input.onRequest || registeredHandler) {
          void Promise.resolve()
            .then(() => input.onRequest
              ? input.onRequest(contract, signal)
              : registeredHandler?.({
                  taskId: run.taskId,
                  taskRunId: run.taskRunId,
                  contract,
                  signal,
                }))
            .catch((error: unknown) => {
              if (signal.aborted || pendingAssistance.get(run.taskRunId) !== waiter) return;
              rejectCompletion(error instanceof Error ? error : new Error("App workflow verification route failed."));
            });
        }
        return await completion;
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (pendingAssistance.get(run.taskRunId) === waiter) {
          pendingAssistance.delete(run.taskRunId);
        }
      }
    },
  };
}

/** Resolve an active workflow only after the App has persisted completion. */
export async function resumeAppWorkflowHumanAssistance(
  taskRunId: string,
  status: Exclude<HumanAssistanceCompletionStatus, "pending">,
): Promise<boolean> {
  const waiter = pendingAssistance.get(taskRunId);
  if (!waiter || waiter.run.current().status !== "waiting_for_human") return false;
  const current = await waiter.run.persistence.taskRunById(taskRunId);
  if (current?.humanAssistanceContract?.completion.status !== status) return false;
  if (!(await waiter.run.transition("running"))) return false;
  waiter.resolve(status);
  return true;
}

export function hasPendingAppWorkflowHumanAssistance(taskRunId: string) {
  return pendingAssistance.has(taskRunId);
}
