import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import {
  finalizeForceQuitTaskRun,
  finalizeForceQuitTaskRunWithPersistence,
  type ForceQuitFinalizationDependencies,
} from "./task-run-finalization.ts";
import { resumeSessionFromLog } from "./automation-session-disposition.ts";
import {
  latestTaskRuns,
  type AutomationPersistenceProvider,
  updateHumanAssistanceContract,
  updateHumanAssistanceCompletion,
  type AutomationTaskRun,
} from "./store.ts";
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

export function humanSessionForTask(
  taskId: string,
  provider: AutomationPersistenceProvider,
): Promise<string>;
export function humanSessionForTask(taskId: string, ledgerDir?: string): string;
export function humanSessionForTask(
  taskId: string,
  ledgerDirOrProvider: string | AutomationPersistenceProvider = process.env.LEDGER_DIR ?? "data/ledger",
) {
  if (typeof ledgerDirOrProvider !== "string") {
    return humanSessionForTaskWithPersistence(taskId, ledgerDirOrProvider);
  }
  const ledgerDir = ledgerDirOrProvider;
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);

  const db = openLedgerDatabase(ledgerDir, { readOnly: true });
  try {
    return humanSessionFromRun(latestTaskRuns(db)[taskId], taskId);
  } finally {
    db.close();
  }
}

/** Read a human session through the injected asynchronous persistence port. */
export async function humanSessionForTaskWithPersistence(
  taskId: string,
  provider: AutomationPersistenceProvider,
) {
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);
  const latest = await provider.automation.latestTaskRuns();
  return humanSessionFromRun(latest[taskId], taskId);
}

export function humanAssistanceContractForTask(
  taskId: string,
  provider: AutomationPersistenceProvider,
): Promise<HumanAssistanceContract | null>;
export function humanAssistanceContractForTask(
  taskId: string,
  ledgerDir?: string,
): HumanAssistanceContract | null;
export function humanAssistanceContractForTask(
  taskId: string,
  ledgerDirOrProvider: string | AutomationPersistenceProvider = process.env.LEDGER_DIR ?? "data/ledger",
): HumanAssistanceContract | null | Promise<HumanAssistanceContract | null> {
  if (typeof ledgerDirOrProvider !== "string") {
    return humanAssistanceContractForTaskWithPersistence(taskId, ledgerDirOrProvider);
  }
  const ledgerDir = ledgerDirOrProvider;
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);

  const db = openLedgerDatabase(ledgerDir, { readOnly: true });
  try {
    return latestTaskRuns(db)[taskId]?.humanAssistanceContract ?? null;
  } finally {
    db.close();
  }
}

export async function humanAssistanceContractForTaskWithPersistence(
  taskId: string,
  provider: AutomationPersistenceProvider,
): Promise<HumanAssistanceContract | null> {
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);
  return (await provider.automation.latestTaskRuns())[taskId]?.humanAssistanceContract ?? null;
}

export function updateHumanAssistanceCompletionForTask(
  taskId: string,
  status: HumanAssistanceCompletionStatus,
  provider: AutomationPersistenceProvider,
): Promise<HumanAssistanceContract>;
export function updateHumanAssistanceCompletionForTask(
  taskId: string,
  status: HumanAssistanceCompletionStatus,
  ledgerDir?: string,
): HumanAssistanceContract;
export function updateHumanAssistanceCompletionForTask(
  taskId: string,
  status: HumanAssistanceCompletionStatus,
  ledgerDirOrProvider: string | AutomationPersistenceProvider = process.env.LEDGER_DIR ?? "data/ledger",
): HumanAssistanceContract | Promise<HumanAssistanceContract> {
  if (typeof ledgerDirOrProvider !== "string") {
    return updateHumanAssistanceCompletionForTaskWithPersistence(taskId, status, ledgerDirOrProvider);
  }
  const ledgerDir = ledgerDirOrProvider;
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);

  const db = openLedgerDatabase(ledgerDir);
  try {
    const run = latestTaskRuns(db)[taskId];
    if (run?.status !== "waiting_for_human") {
      throw new Error(`Automation task is not waiting for human input: ${taskId}`);
    }
    return updateHumanAssistanceCompletion(db, run.taskRunId, status);
  } finally {
    db.close();
  }
}

export async function updateHumanAssistanceCompletionForTaskWithPersistence(
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

export function updateHumanAssistanceContractForTask(
  taskId: string,
  input: HumanAssistanceContractInput,
  provider: AutomationPersistenceProvider,
): Promise<HumanAssistanceContract>;
export function updateHumanAssistanceContractForTask(
  taskId: string,
  input: HumanAssistanceContractInput,
  ledgerDir?: string,
): HumanAssistanceContract;
export function updateHumanAssistanceContractForTask(
  taskId: string,
  input: HumanAssistanceContractInput,
  ledgerDirOrProvider: string | AutomationPersistenceProvider = process.env.LEDGER_DIR ?? "data/ledger",
): HumanAssistanceContract | Promise<HumanAssistanceContract> {
  if (typeof ledgerDirOrProvider !== "string") {
    return updateHumanAssistanceContractForTaskWithPersistence(taskId, input, ledgerDirOrProvider);
  }
  const ledgerDir = ledgerDirOrProvider;
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);

  const db = openLedgerDatabase(ledgerDir);
  try {
    const run = latestTaskRuns(db)[taskId];
    if (run?.status !== "waiting_for_human") {
      throw new Error(`Automation task is not waiting for human input: ${taskId}`);
    }
    return updateHumanAssistanceContract(db, run.taskRunId, input);
  } finally {
    db.close();
  }
}

export async function updateHumanAssistanceContractForTaskWithPersistence(
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
  dependencies?: ForceQuitFinalizationDependencies,
): Promise<{ session: string | null }>;
export async function forceQuitHumanSessionForTask(
  taskId: string,
  ledgerDir?: string,
  dependencies?: ForceQuitFinalizationDependencies,
): Promise<{ session: string | null }>;
export async function forceQuitHumanSessionForTask(
  taskId: string,
  ledgerDirOrProvider: string | AutomationPersistenceProvider = process.env.LEDGER_DIR ?? "data/ledger",
  dependencies: ForceQuitFinalizationDependencies = {},
) {
  if (typeof ledgerDirOrProvider !== "string") {
    if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);
    const run = (await ledgerDirOrProvider.automation.latestTaskRuns())[taskId];
    if (!run) throw new Error(`Automation task is not waiting for human input: ${taskId}`);
    return finalizeForceQuitTaskRunWithPersistence(ledgerDirOrProvider, run, dependencies);
  }
  const ledgerDir = ledgerDirOrProvider;
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);

  const db = openLedgerDatabase(ledgerDir);
  try {
    const run = latestTaskRuns(db)[taskId];
    if (!run) throw new Error(`Automation task is not waiting for human input: ${taskId}`);
    return await finalizeForceQuitTaskRun(db, run, dependencies);
  } finally {
    db.close();
  }
}
