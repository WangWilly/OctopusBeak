import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { resumeSessionFromLog } from "./runner.ts";
import { latestTaskRuns } from "./store.ts";
import { taskById } from "./tasks.ts";

export function humanSessionForTask(taskId: string, ledgerDir = process.env.LEDGER_DIR ?? "data/ledger") {
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);

  const db = openLedgerDatabase(ledgerDir, { readOnly: true });
  try {
    const run = latestTaskRuns(db)[taskId];
    if (run?.status !== "waiting_for_human") {
      throw new Error(`Automation task is not waiting for human input: ${taskId}`);
    }

    const session = resumeSessionFromLog(run.logTail);
    if (!session) throw new Error(`Missing Libretto resume session for automation task: ${taskId}`);
    return session;
  } finally {
    db.close();
  }
}
