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
  claimAutomationSessionForCleanup,
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

export type AutomationTaskRunFinalizationContext = {
  taskDb: ReturnType<typeof openLedgerDatabase>;
  taskId: string;
  taskKind: AutomationTaskKind;
  taskRunId: string;
  logPath: string;
  ledgerDir: string;
  session: string | null;
  owner: OwnedAutomationSession | null;
};

export type ForceQuitFinalizationDependencies = Partial<{
  readSessionState: typeof readLibrettoSessionState;
  claimSession: typeof claimAutomationSessionForCleanup;
  finalizeSession: typeof finalizeExactOwnedAutomationSession;
}>;

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

type AutomationSessionDisposition = "retain" | "relinquish";

type TaskRunFinalizationIntent = {
  status: AutomationTaskStatus;
  sessionDisposition: AutomationSessionDisposition;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  errorMessage: string | null;
  logTail: string;
  statementSummary?: StatementRunSummary | null;
  sessionFinalizationLog?: boolean;
  sessionOwner?: OwnedAutomationSession | null;
  sessionCleanupMode?: "exact" | "owned";
  sessionCleanupError?: string | null;
};

function isTerminalTaskRunStatus(status: AutomationTaskStatus) {
  return status === "completed" || status === "partial" || status === "failed";
}

async function finalizeTaskRunTransition(
  db: ReturnType<typeof openLedgerDatabase>,
  run: Pick<AutomationTaskRun, "taskRunId" | "logPath">,
  intent: TaskRunFinalizationIntent,
) {
  const current = taskRunById(db, run.taskRunId);
  if (!current) throw new Error(`Missing automation task run: ${run.taskRunId}`);
  if (isTerminalTaskRunStatus(current.status)) return { status: current.status, skipped: true };
  if (current.status !== "running" && current.status !== "waiting_for_human") {
    return { status: current.status, skipped: true };
  }
  if (current.status === "waiting_for_human" && intent.status !== "failed") {
    return { status: current.status, skipped: true };
  }

  let status = intent.status;
  let taskError = intent.errorMessage;
  let logTail = intent.logTail;
  let cleanupResult: SessionCleanupResult | null = null;
  if (intent.sessionDisposition === "relinquish") {
    if (intent.sessionCleanupError) {
      cleanupResult = {
        errorMessage: appendCleanupError(taskError, intent.sessionCleanupError),
        cleanupFailed: true,
      };
    } else if (intent.sessionOwner) {
      if (intent.sessionCleanupMode === "owned") ownAutomationSession(intent.sessionOwner);
      cleanupResult = await finalizeTerminalAutomationSession(
        intent.sessionOwner,
        taskError,
        intent.sessionCleanupMode === "owned"
          ? () => finalizeOwnedAutomationSession(intent.sessionOwner!.taskId)
          : undefined,
      );
    }
    if (cleanupResult) taskError = cleanupResult.errorMessage;
    if (cleanupResult?.cleanupFailed && (status === "completed" || status === "partial")) {
      status = "failed";
    }
  }

  const afterCleanup = taskRunById(db, run.taskRunId);
  if (!afterCleanup) throw new Error(`Missing automation task run: ${run.taskRunId}`);
  if (isTerminalTaskRunStatus(afterCleanup.status)) {
    return { status: afterCleanup.status, skipped: true };
  }

  const summaryLine = intent.statementSummary
    ? statementRunSummaryLine(intent.statementSummary.results)
    : null;
  const logAppend = intent.sessionFinalizationLog
    ? "automation-session-finalize: session="
      + (intent.sessionOwner?.session ?? "unknown")
      + " pid=" + (intent.sessionOwner?.pid ?? "unknown")
      + " cleanup-error=" + (cleanupResult?.cleanupFailed ? "failed" : intent.sessionCleanupError ?? "none") + "\n"
    : summaryLine
      ? `\n${summaryLine}\n`
      : null;
  if (logAppend) {
    try {
      appendLog(run.logPath, logAppend);
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
    exitCode: intent.exitCode,
    signal: intent.signal,
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
  const result = await finalizeTaskRunTransition(db, run, {
    status: "failed",
    sessionDisposition: "relinquish",
    exitCode: null,
    signal: null,
    errorMessage: run.errorMessage ?? reason,
    logTail: run.logTail,
    sessionFinalizationLog: true,
    sessionOwner: owner,
    sessionCleanupMode: "owned",
    sessionCleanupError: owner ? null : "Missing Libretto session identity",
  });
}

export async function finalizeForceQuitTaskRun(
  db: ReturnType<typeof openLedgerDatabase>,
  run: AutomationTaskRun,
  session: string,
  dependencies: ForceQuitFinalizationDependencies = {},
) {
  const current = taskRunById(db, run.taskRunId);
  if (!current || current.status !== "waiting_for_human") {
    throw new Error(`Automation task is not waiting for human input: ${run.taskId}`);
  }

  const deps = {
    readSessionState: readLibrettoSessionState,
    claimSession: claimAutomationSessionForCleanup,
    finalizeSession: finalizeExactOwnedAutomationSession,
    ...dependencies,
  };
  let owner: OwnedAutomationSession = {
    taskId: run.taskId,
    taskRunId: run.taskRunId,
    session,
    pid: null,
  };
  let cleanupFailure: unknown = null;
  const workflowError = "Browser session force quit.";
  let taskError = workflowError;
  try {
    owner = {
      ...owner,
      pid: deps.readSessionState(session)?.pid ?? null,
    };
    if (!deps.claimSession(owner)) {
      throw new Error(`Automation session ownership changed for task: ${run.taskId}`);
    }
    let finalizeFailure: unknown = null;
    const cleanupResult = await finalizeTerminalAutomationSession(
      owner,
      workflowError,
      async () => {
        try {
          if (!await deps.finalizeSession(owner)) {
            throw new Error(`Automation session ownership changed for task: ${run.taskId}`);
          }
        } catch (error) {
          finalizeFailure = error;
          throw error;
        }
      },
    );
    cleanupFailure = finalizeFailure;
    taskError = cleanupResult.errorMessage ?? workflowError;
  } catch (error) {
    cleanupFailure = error;
    taskError = appendCleanupError(workflowError, errorMessage(error));
  }

  await finalizeTaskRunTransition(db, run, {
    status: "failed",
    sessionDisposition: "relinquish",
    exitCode: null,
    signal: null,
    errorMessage: taskError,
    logTail: run.logTail,
  });
  if (cleanupFailure) throw cleanupFailure;
  return { session };
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
  context: AutomationTaskRunFinalizationContext,
) {
  if (!context.session) return;
  const timeoutOwner = context.owner ?? {
    taskId: context.taskId,
    taskRunId: context.taskRunId,
    session: context.session,
    pid: sessionPid(context.session),
  };
  armAutomationSessionTimeout(context.taskId, async () => {
    const timeoutDb = openLedgerDatabase(context.ledgerDir);
    try {
      const run = taskRunById(timeoutDb, context.taskRunId);
      if (!run || run.status !== "waiting_for_human") return;
      await finalizeTaskRunTransition(timeoutDb, run, {
        status: "failed",
        sessionDisposition: "relinquish",
        exitCode: null,
        signal: null,
        errorMessage: "等待人工操作超過 20 分鐘",
        logTail: run.logTail,
        sessionOwner: timeoutOwner,
        sessionCleanupMode: "exact",
      });
    } catch (error) {
      console.error("automation-session-timeout-failed", error);
    } finally {
      timeoutDb.close();
    }
  });
}

export async function finalizeAutomationTaskRun(
  context: AutomationTaskRunFinalizationContext,
  result: AutomationTaskProcessResult,
) {
  const resumeFailure = result.resumeFailure;
  let status: AutomationTaskStatus = result.error || resumeFailure
    ? "failed"
    : nextAttemptStatus({
      kind: context.taskKind,
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
  if (isForceQuitRun(taskRunById(context.taskDb, context.taskRunId))) return { status: "failed" as const };
  let logTail = result.logTail;
  if (result.statementSummary) {
    logTail = tail(`${logTail}\n${statementRunSummaryLine(result.statementSummary.results)}\n`);
  }
  const sessionDisposition = shouldRetainAutomationSession(status) ? "retain" : "relinquish";
  const owner = context.owner && sessionDisposition === "relinquish"
    ? ownedAutomationSession(context.taskId) ?? context.owner
    : null;
  const transition = await finalizeTaskRunTransition(context.taskDb, {
    taskRunId: context.taskRunId,
    logPath: context.logPath,
  }, {
    status,
    sessionDisposition,
    exitCode: result.exitCode,
    signal: result.signal,
    errorMessage: taskError,
    logTail,
    statementSummary: result.statementSummary,
    sessionOwner: owner,
    sessionCleanupMode: "exact",
  });
  if (!transition.skipped && context.session && sessionDisposition === "retain") {
    scheduleAutomationTaskRunTimeout(context);
  }
  return { status: transition.status };
}
