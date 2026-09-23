import {
  finalizeForceQuitTaskRun,
  type ForceQuitFinalizationDependencies,
} from "./task-run-finalization.ts";
import { resumeSessionFromLog } from "./automation-session-disposition.ts";
import type { AutomationPersistenceProvider, AutomationTaskRun } from "./store.ts";
import type {
  HumanAssistanceCompletionStatus,
  HumanAssistanceContract,
  HumanAssistanceContractInput,
} from "../human-assistance.ts";
import { taskById } from "./tasks.ts";

export function humanSessionFromRun(
  run: Pick<AutomationTaskRun, "status" | "logTail"> | undefined,
  taskId: string,
) {
  if (run?.status !== "waiting_for_human") {
    throw new Error(`Automation task is not waiting for human input: ${taskId}`);
  }

  const session = resumeSessionFromLog(run.logTail);
  if (!session) throw new Error(`Missing Libretto resume session for automation task: ${taskId}`);
  return session;
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
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);
  return (await provider.automation.latestTaskRuns())[taskId]?.humanAssistanceContract ?? null;
}

export async function updateHumanAssistanceCompletionForTask(
  taskId: string,
  status: HumanAssistanceCompletionStatus,
  provider: AutomationPersistenceProvider,
): Promise<HumanAssistanceContract> {
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);
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
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);
  const run = (await provider.automation.latestTaskRuns())[taskId];
  if (run?.status !== "waiting_for_human") {
    throw new Error(`Automation task is not waiting for human input: ${taskId}`);
  }
  return provider.automation.updateHumanAssistanceContract(run.taskRunId, input);
}

export async function forceQuitHumanSessionForTask(
  taskId: string,
  provider: AutomationPersistenceProvider,
  dependencies: ForceQuitFinalizationDependencies = {},
): Promise<{ session: string | null }> {
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);
  const run = (await provider.automation.latestTaskRuns())[taskId];
  if (!run) throw new Error(`Automation task is not waiting for human input: ${taskId}`);
  return finalizeForceQuitTaskRun(provider, run, dependencies);
}
