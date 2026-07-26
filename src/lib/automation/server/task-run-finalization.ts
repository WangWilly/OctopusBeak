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

type SessionCleanupResult = {
  errorMessage: string | null;
  cleanupFailed: boolean;
};

type TaskRunFinalizationPlan = {
  status: AutomationTaskStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  errorMessage: string | null;
  logTail: string;
  logAppend?: string | ((cleanup: SessionCleanupResult | null) => string);
  cleanup?: (workflowError: string | null) => Promise<SessionCleanupResult>;
};

function isTerminalTaskRunStatus(status: AutomationTaskStatus) {
  return status === "completed" || status === "partial" || status === "failed";
}

async function finalizeTaskRunTransition(
  db: ReturnType<typeof openLedgerDatabase>,
  run: Pick<AutomationTaskRun, "taskRunId" | "logPath">,
  plan: TaskRunFinalizationPlan,
) {
  const current = taskRunById(db, run.taskRunId);
  if (!current) throw new Error(`Missing automation task run: ${run.taskRunId}`);
  if (isTerminalTaskRunStatus(current.status)) return { status: current.status, skipped: true };
  if (current.status !== "running" && current.status !== "waiting_for_human") {
    return { status: current.status, skipped: true };
  }
  if (current.status === "waiting_for_human" && plan.status !== "failed") {
    return { status: current.status, skipped: true };
  }

  let status = plan.status;
  let taskError = plan.errorMessage;
  let logTail = plan.logTail;
  let cleanupResult: SessionCleanupResult | null = null;
  if (plan.cleanup) {
    cleanupResult = await plan.cleanup(taskError);
    taskError = cleanupResult.errorMessage;
    if (cleanupResult.cleanupFailed && (status === "completed" || status === "partial")) {
      status = "failed";
    }
  }

  const afterCleanup = taskRunById(db, run.taskRunId);
  if (!afterCleanup) throw new Error(`Missing automation task run: ${run.taskRunId}`);
  if (isTerminalTaskRunStatus(afterCleanup.status)) {
    return { status: afterCleanup.status, skipped: true };
  }

  if (plan.logAppend) {
    try {
      appendLog(
        run.logPath,
        typeof plan.logAppend === "function"
          ? plan.logAppend(cleanupResult)
          : plan.logAppend,
      );
    } catch (error) {
      const warning = `automation-output-write-failed: ${errorMessage(error)}`;
      console.error(warning);
      taskError = [taskError, warning].filter(Boolean).join("\n") || null;
      logTail = tail(`${logTail}\n${warning}\n`);
    }
  }
  updateTaskRun(db, run.taskRunId, {
    status,
    finishedAt: new Date().toISOString(),
    exitCode: plan.exitCode,
    signal: plan.signal,
    logTail,
    errorMessage: taskError,
  });
  return { status, skipped: false };
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
  const owner = session
    ? { taskId: run.taskId, taskRunId: run.taskRunId, session, pid }
    : null;
  let cleanupError: string | null = owner ? null : "Missing Libretto session identity";
  const result = await finalizeTaskRunTransition(db, run, {
    status: "failed",
    exitCode: null,
    signal: null,
    errorMessage: run.errorMessage ?? reason,
    logTail: run.logTail,
    logAppend: () => "automation-session-finalize: session="
      + (session ?? "unknown")
      + " pid=" + (pid ?? "unknown")
      + " cleanup-error=" + (cleanupError ?? "none") + "\n",
    cleanup: owner
      ? async (workflowError) => {
        ownAutomationSession(owner);
        const result = await finalizeTerminalAutomationSession(
          owner,
          workflowError,
          () => finalizeOwnedAutomationSession(run.taskId),
        );
        if (result.cleanupFailed) cleanupError = result.errorMessage;
        return result;
      }
      : async (workflowError) => ({
        errorMessage: appendCleanupError(workflowError, cleanupError ?? "Missing Libretto session identity"),
        cleanupFailed: true,
      }),
  });
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
  const timeoutOwner = execution.owner ?? {
    taskId: execution.task.id,
    taskRunId: execution.run.taskRunId,
    session: execution.session,
    pid: sessionPid(execution.session),
  };
  armAutomationSessionTimeout(execution.task.id, async () => {
    const timeoutDb = openLedgerDatabase(ledgerDir);
    try {
      const run = taskRunById(timeoutDb, execution.run.taskRunId);
      if (!run || run.status !== "waiting_for_human") return;
      await finalizeTaskRunTransition(timeoutDb, run, {
        status: "failed",
        exitCode: null,
        signal: null,
        errorMessage: "等待人工操作超過 20 分鐘",
        logTail: run.logTail,
        cleanup: (workflowError) => finalizeTerminalAutomationSession(
          timeoutOwner,
          workflowError,
          () => finalizeExactOwnedAutomationSession(timeoutOwner),
        ),
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
  if (isForceQuitRun(taskRunById(execution.taskDb, execution.run.taskRunId))) return { status: "failed" as const };
  let logTail = result.logTail;
  let summaryLine: string | undefined;
  if (result.statementSummary) {
    summaryLine = statementRunSummaryLine(result.statementSummary.results);
    logTail = tail(`${logTail}\n${summaryLine}\n`);
  }
  const owner = execution.owner && !shouldRetainAutomationSession(status)
    ? ownedAutomationSession(execution.task.id) ?? execution.owner
    : null;
  const transition = await finalizeTaskRunTransition(execution.taskDb, {
    taskRunId: execution.run.taskRunId,
    logPath: execution.logPath,
  }, {
    status,
    exitCode: result.exitCode,
    signal: result.signal,
    errorMessage: taskError,
    logTail,
    logAppend: summaryLine ? `\n${summaryLine}\n` : undefined,
    cleanup: owner
      ? async (workflowError) => finalizeTerminalAutomationSession(
        owner,
        workflowError,
        () => finalizeExactOwnedAutomationSession(execution.owner!),
      )
      : undefined,
  });
  if (!transition.skipped && execution.session && shouldRetainAutomationSession(status)) {
    scheduleAutomationTaskRunTimeout(execution, ledgerDir);
  }
  return { status: transition.status };
}
