import { appendFileSync, closeSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import {
  statementRunSummaryLine,
  type StatementRunSummary,
} from "../statement-run-summary.ts";
import { resolveTaskCommand } from "./desktop-command.ts";
import { readLibrettoSessionState } from "./libretto-session.ts";
import {
  armAutomationSessionTimeout,
  finalizeExactOwnedAutomationSession,
  finalizeOwnedAutomationSession,
  ownAutomationSession,
  ownedAutomationSession,
  type OwnedAutomationSession,
} from "./session-lifecycle.ts";
import {
  activeTaskRuns,
  taskRunById,
  updateTaskRun,
  type AutomationTaskRun,
  type AutomationTaskStatus,
} from "./store.ts";
import { taskById, type AutomationTaskKind } from "./tasks.ts";

const SESSION_LOG_PREFIX_BYTES = 4_000;

export type AutomationTaskRunExecution = {
  task: NonNullable<ReturnType<typeof taskById>>;
  taskDb: ReturnType<typeof openLedgerDatabase>;
  run: Pick<AutomationTaskRun, "taskRunId">;
  logPath: string;
  command: ReturnType<typeof resolveTaskCommand>;
  session: string | null;
  owner: OwnedAutomationSession | null;
};

export type AutomationTaskProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
  logTail: string;
  resumeFailure: string | null;
  statementSummary: StatementRunSummary | null;
  outputPersistenceWarnings: string[];
};

export function appendLog(logPath: string, chunk: string) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, chunk);
}

export function tail(value: string) {
  return value.slice(-4000);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function shouldRetainAutomationSession(status: AutomationTaskStatus) {
  return status === "waiting_for_human";
}

export function appendCleanupError(message: string | null, cleanup: string) {
  const suffix = "Session cleanup failed: " + cleanup;
  return message ? message + "\n" + suffix : suffix;
}

export function shouldMarkWaitingForHuman(output: string) {
  return /manual-(?:auth|otp)-required|workflow paused|resume --session|\benter\b[^\r\n]*(?:captcha|otp|verification|certificate)/i.test(output);
}

export function finalFailureMessage(logTail: string, exitCode: number | null) {
  const message = logTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .toReversed()
    .find((line) =>
      !/^automation-progress:/i.test(line) &&
      !/^automation-output-write-failed:/i.test(line) &&
      !/^libretto run CDP patch/i.test(line) &&
      !/^Running workflow /i.test(line) &&
      !/^Browser is still open\./i.test(line)
    );
  return message ?? `Task exited with code ${exitCode}`;
}

export function isForceQuitRun(
  run: Pick<AutomationTaskRun, "status" | "errorMessage"> | null | undefined,
) {
  return run?.status === "failed" && run.errorMessage?.startsWith("Browser session force quit") === true;
}

export function nextAttemptStatus(input: {
  kind: AutomationTaskKind;
  attempt: number;
  maxAttempts: number;
  exitCode: number | null;
  waitingForHuman?: boolean;
}): AutomationTaskStatus {
  if (input.exitCode === 0 && input.waitingForHuman) return "waiting_for_human";
  if (input.exitCode === 0) return "completed";
  return "failed";
}

export function automationCleanupFailureDetails(
  owner: OwnedAutomationSession,
  error: unknown,
) {
  return {
    taskRunId: owner.taskRunId,
    sessionId: owner.session,
    retainedPid: owner.pid,
    error: errorMessage(error),
  };
}

export async function finalizeTerminalAutomationSession(
  owner: OwnedAutomationSession,
  workflowError: string | null,
  finalize: () => Promise<unknown> = () => finalizeExactOwnedAutomationSession(owner),
) {
  try {
    await finalize();
    return { errorMessage: workflowError, cleanupFailed: false };
  } catch (error) {
    console.error(
      "automation-session-cleanup-failed",
      automationCleanupFailureDetails(owner, error),
    );
    return {
      errorMessage: appendCleanupError(workflowError, errorMessage(error)),
      cleanupFailed: true,
    };
  }
}

export function sessionPid(session: string) {
  try {
    return readLibrettoSessionState(session)?.pid ?? null;
  } catch {
    return null;
  }
}

export function sessionFromRun(run: AutomationTaskRun) {
  try {
    const buffer = Buffer.alloc(SESSION_LOG_PREFIX_BYTES);
    const descriptor = openSync(run.logPath, "r");
    let length: number;
    try {
      length = readSync(descriptor, buffer, 0, SESSION_LOG_PREFIX_BYTES, 0);
    } finally {
      closeSync(descriptor);
    }
    const output = buffer.toString("utf8", 0, length);
    const session = automationSessionFromLog(output) ?? resumeSessionFromLog(output);
    if (session) return session;
  } catch {
    // The bounded log tail remains the recovery source when the log file is unavailable.
  }
  return automationSessionFromLog(run.logTail) ?? resumeSessionFromLog(run.logTail);
}

export function automationSessionFromLog(output: string) {
  return output.match(/automation-session:\s+([A-Za-z0-9._-]+)/i)?.[1] ?? null;
}

export function resumeSessionFromLog(output: string) {
  return output.match(/libretto resume --session\s+([\w-]+)/i)?.[1] ?? null;
}

export async function finalizePersistedRun(
  db: ReturnType<typeof openLedgerDatabase>,
  run: AutomationTaskRun,
  reason: string,
) {
  const session = sessionFromRun(run);
  const pid = session ? sessionPid(session) : null;
  let cleanupError: string | null = null;
  if (!session) {
    cleanupError = "Missing Libretto session identity";
  } else {
    ownAutomationSession({ taskId: run.taskId, taskRunId: run.taskRunId, session, pid });
    try {
      await finalizeOwnedAutomationSession(run.taskId);
    } catch (error) {
      cleanupError = errorMessage(error);
    }
  }
  updateTaskRun(db, run.taskRunId, {
    status: "failed",
    finishedAt: new Date().toISOString(),
    exitCode: null,
    signal: null,
    errorMessage: cleanupError
      ? appendCleanupError(run.errorMessage ?? reason, cleanupError)
      : run.errorMessage ?? reason,
  });
  appendLog(
    run.logPath,
    `automation-session-finalize: session=${session ?? "unknown"} pid=${pid ?? "unknown"} cleanup-error=${cleanupError ?? "none"}\n`,
  );
}

export async function finalizePersistedActiveRuns(
  ledgerDir: string,
  reason: string,
  finalizeRun: typeof finalizePersistedRun = finalizePersistedRun,
) {
  const db = openLedgerDatabase(ledgerDir);
  const errors: unknown[] = [];
  try {
    for (const run of activeTaskRuns(db)) {
      try {
        await finalizeRun(db, run, reason);
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    db.close();
  }
  if (errors.length) throw new AggregateError(errors, "Failed to finalize persisted automation runs");
}

function scheduleAutomationTaskRunTimeout(
  execution: AutomationTaskRunExecution,
  ledgerDir: string,
) {
  if (!execution.session) return;
  const timeoutOwner = {
    taskId: execution.task.id,
    taskRunId: execution.run.taskRunId,
    session: execution.session,
  };
  armAutomationSessionTimeout(execution.task.id, async () => {
    const timeoutDb = openLedgerDatabase(ledgerDir);
    try {
      if (taskRunById(timeoutDb, execution.run.taskRunId)?.status !== "waiting_for_human") return;
      let timeoutError: string | null = null;
      try {
        await finalizeExactOwnedAutomationSession(timeoutOwner);
      } catch (error) {
        timeoutError = errorMessage(error);
      }
      if (taskRunById(timeoutDb, execution.run.taskRunId)?.status !== "waiting_for_human") return;
      updateTaskRun(timeoutDb, execution.run.taskRunId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        exitCode: null,
        signal: null,
        errorMessage: timeoutError
          ? appendCleanupError("等待人工操作超過 20 分鐘", timeoutError)
          : "等待人工操作超過 20 分鐘",
      });
    } catch (error) {
      console.error("automation-session-timeout-failed", error);
    } finally {
      timeoutDb.close();
    }
  });
}

export async function finalizeAutomationTaskRun(
  execution: AutomationTaskRunExecution,
  result: AutomationTaskProcessResult,
  ledgerDir: string,
) {
  const resumeFailure = result.resumeFailure;
  let status: AutomationTaskStatus = result.error || resumeFailure
    ? "failed"
    : nextAttemptStatus({
      kind: execution.task.kind,
      attempt: 1,
      maxAttempts: 1,
      exitCode: result.exitCode,
      waitingForHuman: shouldMarkWaitingForHuman(result.logTail),
    });
  if (status === "completed" && result.statementSummary) status = result.statementSummary.status;
  const statementFailure = result.statementSummary?.status === "failed"
    ? result.statementSummary.results
      .filter((statement) => statement.status === "failed")
      .map((statement) => `${statement.typeId}: ${statement.error ?? "Failed"}`)
      .join("\n") || "No statement components completed."
    : null;
  let taskError = result.error?.message
    ?? resumeFailure
    ?? (status === "failed" ? statementFailure || finalFailureMessage(result.logTail, result.exitCode) : null);
  taskError = [taskError, ...result.outputPersistenceWarnings].filter(Boolean).join("\n") || null;
  if (execution.owner && !shouldRetainAutomationSession(status)) {
    const retainedOwner = ownedAutomationSession(execution.task.id) ?? execution.owner;
    const cleanup = await finalizeTerminalAutomationSession(
      retainedOwner,
      taskError,
      () => finalizeExactOwnedAutomationSession(execution.owner!),
    );
    taskError = cleanup.errorMessage;
    if (cleanup.cleanupFailed && (status === "completed" || status === "partial")) status = "failed";
  }
  if (isForceQuitRun(taskRunById(execution.taskDb, execution.run.taskRunId))) return { status: "failed" as const };
  let logTail = result.logTail;
  if (result.statementSummary) {
    const summaryLine = statementRunSummaryLine(result.statementSummary.results);
    try {
      appendLog(execution.logPath, `\n${summaryLine}\n`);
    } catch (error) {
      const warning = `automation-output-write-failed: ${errorMessage(error)}`;
      console.error(warning);
      taskError = [taskError, warning].filter(Boolean).join("\n") || null;
      logTail = tail(`${logTail}\n${warning}\n`);
    }
    logTail = tail(`${logTail}\n${summaryLine}\n`);
  }
  updateTaskRun(execution.taskDb, execution.run.taskRunId, {
    status,
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    signal: result.signal,
    logTail,
    errorMessage: taskError,
  });
  if (execution.session && shouldRetainAutomationSession(status)) {
    scheduleAutomationTaskRunTimeout(execution, ledgerDir);
  }
  return { status };
}
