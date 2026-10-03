import type {
  HumanAssistanceCompletionStatus,
  HumanAssistanceContractInput,
} from "../human-assistance.ts";
import type { WorkflowHumanAssistancePort } from "../workflow-executor.ts";
import { isSolverChallengeKind } from "../verification-config.ts";
import type { AutomationPersistencePort } from "./store.ts";

type PendingAssistance = Readonly<{
  persistence: AutomationPersistencePort;
  onRuntimeUpdate?: (taskRunId: string) => void | Promise<void>;
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
  taskRunId: string;
  persistence: AutomationPersistencePort;
  onRuntimeUpdate?: (taskRunId: string) => void | Promise<void>;
  requireSolverRoute?: boolean;
  onRequest?: (
    contract: HumanAssistanceContractInput,
    signal: AbortSignal,
  ) => void | Promise<void>;
}>): WorkflowHumanAssistancePort {
  return {
    async request(contract, signal) {
      signal.throwIfAborted();
      if (pendingAssistance.has(input.taskRunId)) {
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
      const waiter: PendingAssistance = {
        persistence: input.persistence,
        onRuntimeUpdate: input.onRuntimeUpdate,
        resolve: resolveCompletion,
      };
      pendingAssistance.set(input.taskRunId, waiter);
      const onAbort = () => {
        rejectCompletion(signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        const current = await input.persistence.taskRunById(input.taskRunId);
        if (!current || current.status !== "running") {
          throw new Error("App workflow is not active for human assistance.");
        }
        const registeredHandler = requestHandlers.get(current.taskId);
        if (
          input.requireSolverRoute
          && !input.onRequest
          && !registeredHandler
        ) {
          const reason = isSolverChallengeKind(contract.challengeKind)
            ? "solver-route-unavailable"
            : "solver-challenge-unsupported";
          await input.persistence.appendRunEvent({
            runId: input.taskRunId,
            stage: "authentication",
            code: reason,
            occurredAt: new Date().toISOString(),
          });
          await input.onRuntimeUpdate?.(input.taskRunId);
          throw new Error("App workflow solver route is unavailable for this verification stage.");
        }
        await input.persistence.updateHumanAssistanceContract(input.taskRunId, contract);
        const transition = await input.persistence.transitionTaskRunToActive(
          input.taskRunId,
          { status: "waiting_for_human" },
        );
        if (!transition.applied) {
          throw new Error("App workflow could not enter its human assistance stage.");
        }
        await input.onRuntimeUpdate?.(input.taskRunId);
        signal.throwIfAborted();
        if (input.onRequest || registeredHandler) {
          void Promise.resolve()
            .then(() => input.onRequest
              ? input.onRequest(contract, signal)
              : registeredHandler?.({
                  taskId: current.taskId,
                  taskRunId: input.taskRunId,
                  contract,
                  signal,
                }))
            .catch((error: unknown) => {
              if (signal.aborted || pendingAssistance.get(input.taskRunId) !== waiter) return;
              rejectCompletion(error instanceof Error ? error : new Error("App workflow verification route failed."));
            });
        }
        return await completion;
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (pendingAssistance.get(input.taskRunId) === waiter) {
          pendingAssistance.delete(input.taskRunId);
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
  if (!waiter) return false;
  const current = await waiter.persistence.taskRunById(taskRunId);
  if (
    current?.status !== "waiting_for_human"
    || current.humanAssistanceContract?.completion.status !== status
  ) return false;
  const transition = await waiter.persistence.transitionTaskRunToActive(
    taskRunId,
    { status: "running" },
  );
  if (!transition.applied) return false;
  await waiter.onRuntimeUpdate?.(taskRunId);
  waiter.resolve(status);
  return true;
}

export function hasPendingAppWorkflowHumanAssistance(taskRunId: string) {
  return pendingAssistance.has(taskRunId);
}
