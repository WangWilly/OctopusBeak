import type { AutomationPersistenceProvider, AutomationTaskRun } from "./store.ts";
import type {
  HumanAssistanceCompletionStatus,
  HumanAssistanceContract,
  HumanAssistanceContractInput,
} from "../human-assistance.ts";
import { taskById } from "./tasks.ts";

export function humanSessionFromRun(
  run: (Pick<AutomationTaskRun, "status">
    & Partial<Pick<AutomationTaskRun, "taskRunId">>) | undefined,
  taskId: string,
) {
  if (run?.status !== "waiting_for_human") {
    throw new Error(`Automation task is not waiting for human input: ${taskId}`);
  }

  const task = taskById(taskId);
  if (!task?.workflowId) {
    throw new Error(`Human assistance requires an App browser workflow: ${taskId}`);
  }
  if (run.taskRunId) return run.taskRunId;
  throw new Error(`Missing App workflow run ID for automation task: ${taskId}`);
}

export async function humanSessionForTask(
  taskId: string,
  provider: AutomationPersistenceProvider,
): Promise<string> {
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);
  const latest = await provider.automation.latestTaskRuns();
  return humanSessionFromRun(latest[taskId], taskId);
}

export async function humanAssistanceContractForTask(
  taskId: string,
  provider: AutomationPersistenceProvider,
): Promise<HumanAssistanceContract | null> {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  if (!task.workflowId) {
    throw new Error(`Human assistance requires an App browser workflow: ${taskId}`);
  }
  return (await provider.automation.latestTaskRuns())[taskId]?.humanAssistanceContract ?? null;
}

export async function updateHumanAssistanceCompletionForTask(
  taskId: string,
  status: HumanAssistanceCompletionStatus,
  provider: AutomationPersistenceProvider,
): Promise<HumanAssistanceContract> {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  if (!task.workflowId) {
    throw new Error(`Human assistance requires an App browser workflow: ${taskId}`);
  }
  const run = (await provider.automation.latestTaskRuns())[taskId];
  if (run?.status !== "waiting_for_human") {
    throw new Error(`Automation task is not waiting for human input: ${taskId}`);
  }
  return provider.automation.updateHumanAssistanceCompletion(run.taskRunId, status);
}

export async function updateHumanAssistanceContractForTask(
  taskId: string,
  input: HumanAssistanceContractInput,
  provider: AutomationPersistenceProvider,
): Promise<HumanAssistanceContract> {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  if (!task.workflowId) {
    throw new Error(`Human assistance requires an App browser workflow: ${taskId}`);
  }
  const run = (await provider.automation.latestTaskRuns())[taskId];
  if (run?.status !== "waiting_for_human") {
    throw new Error(`Automation task is not waiting for human input: ${taskId}`);
  }
  return provider.automation.updateHumanAssistanceContract(run.taskRunId, input);
}
