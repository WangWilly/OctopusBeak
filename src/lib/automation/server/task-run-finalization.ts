import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import {
  statementRunSummaryLine,
  type StatementRunSummary,
} from "../statement-run-summary.ts";
import { resolveTaskCommand } from "./desktop-command.ts";
import {
  appendLog,
  automationSessionOwnerForRun,
  errorMessage,
  finalizeAutomationSessionForRun,
  forceQuitAutomationSessionForRun,
  armAutomationSessionDispositionTimeout,
  sessionFromRun,
  tail,
  type AutomationSessionCleanupResult,
  type AutomationSessionDisposition,
  type ForceQuitFinalizationDependencies,
  type OwnedAutomationSession,
} from "./automation-session-disposition.ts";
export {
  appendCleanupError,
  automationCleanupFailureDetails,
  automationSessionFromLog,
  errorMessage,
  finalizeAutomationSession as finalizeTerminalAutomationSession,
  resumeSessionFromLog,
} from "./automation-session-disposition.ts";
export type { ForceQuitFinalizationDependencies } from "./automation-session-disposition.ts";
import {
  activeTaskRuns,
  taskRunById,
  updateTaskRun,
  type AutomationTaskRun,
  type AutomationTaskStatus,
} from "./store.ts";
import { taskById, type AutomationTaskKind } from "./tasks.ts";
import {
  createAutomationSecretBoundaryGate,
  secretBoundaryFailureMessage,
  type SecretBoundaryGate,
  type SecretBoundaryFailure,
} from "./secret-boundary.ts";

export type AutomationTaskRunExecution = {
  task: NonNullable<ReturnType<typeof taskById>>;
  taskDb: ReturnType<typeof openLedgerDatabase>;
  run: Pick<AutomationTaskRun, "taskRunId">;
  logPath: string;
  command: ReturnType<typeof resolveTaskCommand>;
  session: string | null;
  owner: OwnedAutomationSession | null;
  secretGate: SecretBoundaryGate;
};

export type AutomationTaskRunFinalizationContext = {
  taskDb: ReturnType<typeof openLedgerDatabase>;
  taskId: string;
  taskKind: AutomationTaskKind;
  taskRunId: string;
  logPath: string;
  ledgerDir: string;
  secretGate?: SecretBoundaryGate;
};

export type AutomationTaskProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
  logTail: string;
  resumeFailure: string | null;
  statementSummary: StatementRunSummary | null;
  outputPersistenceWarnings: string[];
  secretBoundaryFailure: SecretBoundaryFailure | null;
};

export function shouldRetainAutomationSession(status: AutomationTaskStatus) {
  return status === "waiting_for_human";
}

export function shouldMarkWaitingForHuman(output: string) {
  return /manual-(?:auth|otp)-required|workflow paused|resume --session|\benter\b[^\r\n]*(?:captcha|otp|verification|certificate)/i.test(output);
}

export function finalFailureMessage(
  logTail: string,
  exitCode: number | null,
  secretGate: SecretBoundaryGate = createAutomationSecretBoundaryGate(),
) {
  const protectedLogTail = secretGate.protectText("final-failure", logTail);
  if (protectedLogTail.failure) {
    return secretBoundaryFailureMessage(protectedLogTail.failure);
  }
  const message = protectedLogTail.value
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

type TaskRunFinalizationIntent = {
  status: AutomationTaskStatus;
  sessionDisposition: AutomationSessionDisposition;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  errorMessage: string | null;
  logTail: string;
  statementSummary?: StatementRunSummary | null;
};

type TaskRunFinalizationImplementation = {
  sessionFinalizationLog?: boolean;
  sessionCleanup?: AutomationSessionCleanupResult | null;
};

function isTerminalTaskRunStatus(status: AutomationTaskStatus) {
  return status === "completed" || status === "partial" || status === "failed";
}

async function finalizeTaskRunTransition(
  db: ReturnType<typeof openLedgerDatabase>,
  run: Pick<AutomationTaskRun, "taskRunId" | "logPath">,
  intent: TaskRunFinalizationIntent,
  implementation: TaskRunFinalizationImplementation = {},
  secretGate: SecretBoundaryGate = createAutomationSecretBoundaryGate(),
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
  const cleanupResult = intent.sessionDisposition === "relinquish"
    ? implementation.sessionCleanup
    : null;
  if (cleanupResult) {
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

  const summaryLine = intent.statementSummary
    ? statementRunSummaryLine(intent.statementSummary.results)
    : null;
  const logAppend = implementation.sessionFinalizationLog
    ? "automation-session-finalize: session="
      + (cleanupResult?.session ?? "unknown")
      + " pid=" + (cleanupResult?.pid ?? "unknown")
      + " cleanup-error=" + (cleanupResult?.cleanupFailed ? "failed" : "none") + "\n"
    : summaryLine
      ? `\n${summaryLine}\n`
      : null;
  if (logAppend) {
    try {
      appendLog(run.logPath, logAppend, secretGate);
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
  }, secretGate);
  return { status, skipped: false };
}

export async function finalizePersistedRun(
  db: ReturnType<typeof openLedgerDatabase>,
  run: AutomationTaskRun,
  reason: string,
) {
  const secretGate = createAutomationSecretBoundaryGate();
  const current = taskRunById(db, run.taskRunId);
  if (!current || isTerminalTaskRunStatus(current.status)) return;
  const sessionCleanup = await finalizeAutomationSessionForRun(
    current,
    current.errorMessage ?? reason,
    "recovery",
    secretGate,
  );
  await finalizeTaskRunTransition(db, run, {
    status: "failed",
    sessionDisposition: "relinquish",
    exitCode: null,
    signal: null,
    errorMessage: null,
    logTail: current.logTail,
  }, {
    sessionFinalizationLog: true,
    sessionCleanup,
  }, secretGate);
}

export async function finalizeForceQuitTaskRun(
  db: ReturnType<typeof openLedgerDatabase>,
  run: AutomationTaskRun,
  dependencies: ForceQuitFinalizationDependencies = {},
) {
  const secretGate = createAutomationSecretBoundaryGate();
  const current = taskRunById(db, run.taskRunId);
  if (!current || current.status !== "waiting_for_human") {
    throw new Error(`Automation task is not waiting for human input: ${run.taskId}`);
  }
  const { operationalError, ...sessionCleanup } = await forceQuitAutomationSessionForRun(
    run,
    dependencies,
    secretGate,
  );
  await finalizeTaskRunTransition(db, run, {
    status: "failed",
    sessionDisposition: "relinquish",
    exitCode: null,
    signal: null,
    errorMessage: null,
    logTail: run.logTail,
  }, {
    sessionCleanup,
  }, secretGate);
  if (operationalError) throw operationalError;
  return { session: sessionCleanup.session };
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
  const initialRun = taskRunById(context.taskDb, context.taskRunId);
  if (!initialRun || !sessionFromRun(initialRun)) return;
  armAutomationSessionDispositionTimeout(context.taskId, async () => {
    const timeoutDb = openLedgerDatabase(context.ledgerDir);
    try {
      const run = taskRunById(timeoutDb, context.taskRunId);
      if (!run || run.status !== "waiting_for_human") return;
      const sessionCleanup = await finalizeAutomationSessionForRun(
        run,
        "等待人工操作超過 20 分鐘",
        "exact",
        context.secretGate,
      );
      await finalizeTaskRunTransition(timeoutDb, run, {
        status: "failed",
        sessionDisposition: "relinquish",
        exitCode: null,
        signal: null,
        errorMessage: null,
        logTail: run.logTail,
      }, {
        sessionCleanup,
      }, context.secretGate);
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
  const secretGate = context.secretGate ?? createAutomationSecretBoundaryGate();
  const resumeFailure = result.resumeFailure;
  let status: AutomationTaskStatus = result.error
      || resumeFailure
      || result.secretBoundaryFailure
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
  const taskErrorCandidate = result.error?.message
    ?? resumeFailure
    ?? (status === "failed"
      ? statementFailure || finalFailureMessage(result.logTail, result.exitCode, secretGate)
      : null);
  const combinedTaskError = [
    taskErrorCandidate,
    ...result.outputPersistenceWarnings,
  ].filter(Boolean).join("\n") || null;
  const protectedTaskError = combinedTaskError === null
    ? null
    : secretGate.protectText("final-failure", combinedTaskError);
  const boundaryFailure = result.secretBoundaryFailure
    ?? protectedTaskError?.failure
    ?? null;
  if (boundaryFailure) status = "failed";
  const taskError = boundaryFailure
    ? secretBoundaryFailureMessage(boundaryFailure)
    : protectedTaskError?.value ?? null;
  const currentRun = taskRunById(context.taskDb, context.taskRunId);
  if (!currentRun) throw new Error(`Missing automation task run: ${context.taskRunId}`);
  if (isTerminalTaskRunStatus(currentRun.status)) return { status: currentRun.status };
  if (isForceQuitRun(currentRun)) return { status: "failed" as const };
  let logTail = result.logTail;
  if (result.statementSummary) {
    logTail = tail(`${logTail}\n${statementRunSummaryLine(result.statementSummary.results)}\n`);
  }
  const sessionDisposition = shouldRetainAutomationSession(status) ? "retain" : "relinquish";
  const sessionCleanup = sessionDisposition === "relinquish" && currentRun
    && automationSessionOwnerForRun(currentRun)
    ? await finalizeAutomationSessionForRun(
      currentRun,
      taskError,
      "exact",
      secretGate,
    )
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
  }, {
    sessionCleanup,
  }, secretGate);
  if (!transition.skipped && sessionDisposition === "retain") {
    scheduleAutomationTaskRunTimeout(context);
  }
  return { status: transition.status };
}
