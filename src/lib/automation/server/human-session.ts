import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import {
  finalizeForceQuitTaskRun,
  type ForceQuitFinalizationDependencies,
} from "./task-run-finalization.ts";
import { resumeSessionFromLog } from "./automation-session-disposition.ts";
import {
  latestTaskRuns,
  type AutomationTaskRun,
} from "./store.ts";
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

export function humanSessionForTask(taskId: string, ledgerDir = process.env.LEDGER_DIR ?? "data/ledger") {
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);

  const db = openLedgerDatabase(ledgerDir, { readOnly: true });
  try {
    return humanSessionFromRun(latestTaskRuns(db)[taskId], taskId);
  } finally {
    db.close();
  }
}

export async function forceQuitHumanSessionForTask(
  taskId: string,
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  dependencies: ForceQuitFinalizationDependencies = {},
) {
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
