import { isValidExternalPrerequisiteMetadata } from "../external-prerequisite.ts";
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
import { sanitizeAutomationLogChunk } from "./log-sanitizer.ts";
import type {
  TypedWorkflowErrorCode,
  TypedWorkflowOutcomeSummary,
} from "./typed-workflow-outcome.ts";
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
  isActiveTaskRunStatus,
  isTerminalTaskRunStatus,
  type AutomationPersistenceProvider,
  type AutomationTaskRun,
  type AutomationTaskStatus,
} from "./store.ts";
import { taskById, type AutomationTaskKind } from "./tasks.ts";
import {
  dataVersionStore,
  type DataVersionStore,
} from "../../shared-shell/data-version.ts";
import {
  automationRuntimeState,
  runtimeTaskSnapshotFromRun,
} from "./runtime-state.ts";

export type AutomationTaskRunExecution = {
  task: NonNullable<ReturnType<typeof taskById>>;
  persistence: AutomationPersistenceProvider["automation"];
  run: Pick<AutomationTaskRun, "taskRunId" | "attempt">;
  logPath: string;
  command: ReturnType<typeof resolveTaskCommand>;
  session: string | null;
  owner: OwnedAutomationSession | null;
  executionId: string;
  onRuntimeUpdate?: (taskRunId: string) => void | Promise<void>;
};

export type AutomationTaskRunFinalizationContext = {
  provider: AutomationPersistenceProvider;
  taskId: string;
  taskKind: AutomationTaskKind;
  taskRunId: string;
  logPath: string;
  forceTerminated?: boolean;
  /** The coordinator has already cleaned the exact browser session. */
  sessionAlreadyCleaned?: boolean;
  dataVersionStore?: DataVersionStore;
};

export type AutomationTaskProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
  logTail: string;
  resumeFailure: string | null;
  statementSummary: StatementRunSummary | null;
  /** Typed App result kept on the process boundary for durable finalization. */
  appWorkflowOutcome?: Readonly<{
    errorCode: TypedWorkflowErrorCode | null;
    summary: TypedWorkflowOutcomeSummary | null;
  }>;
  outputPersistenceWarnings: string[];
  externalPrerequisiteIds: string[];
};

export function shouldRetainAutomationSession(status: AutomationTaskStatus) {
  return status === "waiting_for_human";
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
  run: Pick<AutomationTaskRun, "status" | "errorMessage" | "terminationMode"> | null | undefined,
) {
  return run?.terminationMode === "forced"
    || (run?.status === "failed" && run.errorMessage?.startsWith("Browser session force quit") === true);
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
  terminationMode?: "forced";
  statementSummary?: StatementRunSummary | null;
};

type TaskRunFinalizationImplementation = {
  sessionFinalizationLog?: boolean;
  sessionCleanup?: AutomationSessionCleanupResult | null;
};

export type AsyncTaskRunFinalizationIntent = {
  status: AutomationTaskStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  errorMessage: string | null;
  logTail: string;
  terminationMode?: "forced";
};

export async function finalizeTaskRunTransition(
  provider: AutomationPersistenceProvider,
  run: Pick<AutomationTaskRun, "taskRunId" | "logPath">,
  intent: AsyncTaskRunFinalizationIntent,
) {
  const persistence = provider.automation;
  const current = await persistence.taskRunById(run.taskRunId);
  if (!current) throw new Error(`Missing automation task run: ${run.taskRunId}`);
  if (isTerminalTaskRunStatus(current.status)) {
    return { status: current.status, skipped: true } as const;
  }
  if (!isActiveTaskRunStatus(current.status) || current.status === "queued") {
    return { status: current.status, skipped: true } as const;
  }
  if (
    current.status === "waiting_for_human"
    && intent.status !== "failed"
    && intent.status !== "cancelled"
    && intent.status !== "interrupted"
  ) {
    return { status: current.status, skipped: true } as const;
  }
  if (intent.status === "waiting_for_human") {
    await persistence.updateTaskRun(run.taskRunId, {
      status: intent.status,
      finishedAt: null,
      exitCode: intent.exitCode,
      signal: intent.signal,
      errorMessage: intent.errorMessage,
      logTail: intent.logTail,
    });
    const persisted = await persistence.taskRunById(run.taskRunId);
    if (!persisted) throw new Error(`Missing automation task run: ${run.taskRunId}`);
    return { status: persisted.status, skipped: false } as const;
  }
  if (!isTerminalTaskRunStatus(intent.status)) {
    return { status: current.status, skipped: true } as const;
  }
  const transition = await persistence.transitionTaskRunToTerminal(run.taskRunId, {
    status: intent.status,
    finishedAt: new Date().toISOString(),
    exitCode: intent.exitCode,
    signal: intent.signal,
    errorMessage: intent.errorMessage,
    logTail: intent.logTail,
    ...(intent.terminationMode ? { terminationMode: intent.terminationMode } : {}),
  });
  if (!transition.applied) {
    return { status: transition.status, skipped: true } as const;
  }
  const persisted = await persistence.taskRunById(run.taskRunId);
  if (!persisted) throw new Error(`Missing automation task run: ${run.taskRunId}`);
  return { status: persisted.status, skipped: false } as const;
}

/**
 * Finalize one worker-owned run with the same status and session semantics as
 * finalizeAutomationTaskRun.  All persistence reads and writes are awaited;
 * the function deliberately accepts only the injected port.
 */
export async function finalizeAutomationTaskRun(
  context: AutomationTaskRunFinalizationContext,
  result: AutomationTaskProcessResult,
) {
  const resumeFailure = result.resumeFailure;
  const cancelled = context.forceTerminated === true
    || result.signal === "SIGTERM"
    || result.error?.message === "Automation task cancelled.";
  let status: AutomationTaskStatus = cancelled
    ? "cancelled"
    : result.error || resumeFailure
    ? "failed"
    : nextAttemptStatus({
      kind: context.taskKind,
      attempt: 1,
      maxAttempts: 1,
      exitCode: result.exitCode,
      waitingForHuman: shouldMarkWaitingForHuman(result.logTail),
    });
  if (status === "completed" && result.statementSummary) {
    status = result.statementSummary.status;
  }
  const statementFailure = result.statementSummary?.status === "failed"
    ? result.statementSummary.results
      .filter((statement) => statement.status === "failed")
      .map((statement) => `${statement.typeId}: ${statement.error ?? "Failed"}`)
      .join("\n") || "No statement components completed."
    : null;
  let taskError = result.error?.message
    ?? resumeFailure
    ?? (status === "failed"
      ? statementFailure || finalFailureMessage(result.logTail, result.exitCode)
      : null);
  taskError = [taskError, ...result.outputPersistenceWarnings].filter(Boolean).join("\n") || null;
  const persistence = context.provider.automation;
  const currentRun = await persistence.taskRunById(context.taskRunId);
  if (!currentRun) throw new Error(`Missing automation task run: ${context.taskRunId}`);
  if (isTerminalTaskRunStatus(currentRun.status)) return { status: currentRun.status };
  if (isForceQuitRun(currentRun)) return { status: "failed" as const };
  let logTail = result.logTail;
  if (result.statementSummary) {
    logTail = tail(`${logTail}\n${statementRunSummaryLine(result.statementSummary.results)}\n`);
  }
  const sessionDisposition = shouldRetainAutomationSession(status) ? "retain" : "relinquish";
  const sessionCleanup = sessionDisposition === "relinquish"
    && !context.sessionAlreadyCleaned
    && automationSessionOwnerForRun(currentRun)
    ? await finalizeAutomationSessionForRun(currentRun, taskError, "exact")
    : null;
  const transition = await finalizeTaskRunTransition(
    context.provider,
    { taskRunId: context.taskRunId, logPath: context.logPath },
    {
      status,
      exitCode: result.exitCode,
      signal: result.signal,
      errorMessage: sessionCleanup?.errorMessage ?? taskError,
      logTail,
      ...(status === "cancelled" && context.forceTerminated
        ? { terminationMode: "forced" as const }
        : {}),
    },
  );
  if (!transition.skipped && sessionDisposition === "retain") {
    scheduleAutomationTaskRunTimeout({
      provider: context.provider,
      taskId: context.taskId,
      taskRunId: context.taskRunId,
      logPath: context.logPath,
    });
  }
  if (!transition.skipped) {
    if (transition.status === "completed" || transition.status === "partial") {
      (context.dataVersionStore ?? dataVersionStore).markStale("automation-completed");
    }
    const task = taskById(context.taskId);
    const prerequisites = new Map(
      (task?.externalPrerequisites ?? [])
        .filter(isValidExternalPrerequisiteMetadata)
        .map((prerequisite) => [prerequisite.id, prerequisite]),
    );
    if (transition.status === "completed") {
      await persistence.resolveTaskPrerequisiteNotices(
        context.taskId,
        context.taskRunId,
        new Date().toISOString(),
      );
    } else if (transition.status === "failed" || transition.status === "partial") {
      const detectedAt = new Date().toISOString();
      for (const prerequisiteId of result.externalPrerequisiteIds) {
        if (!prerequisites.has(prerequisiteId)) continue;
        await persistence.upsertTaskPrerequisiteNotice({
          taskId: context.taskId,
          prerequisiteId,
          taskRunId: context.taskRunId,
          detectedAt,
          errorMessage: taskError,
        });
      }
    }
  }
  return { status: transition.status };
}

export async function finalizePersistedRun(
  provider: AutomationPersistenceProvider,
  run: AutomationTaskRun,
  reason: string,
  status: Extract<AutomationTaskStatus, "failed" | "interrupted"> = "failed",
): Promise<void> {
  const current = await provider.automation.taskRunById(run.taskRunId);
  if (!current || isTerminalTaskRunStatus(current.status)) return;
  const sessionCleanup = await finalizeAutomationSessionForRun(
    current,
    current.errorMessage ?? reason,
    "recovery",
  );
  const finalizationLog = "automation-session-finalize: session="
    + (sessionCleanup.session ?? "unknown")
    + " pid=" + (sessionCleanup.pid ?? "unknown")
    + " cleanup-error=" + (sessionCleanup.cleanupFailed ? "failed" : "none") + "\n";
  let logTail = current.logTail;
  let errorText = sessionCleanup.errorMessage;
  if (!taskById(current.taskId)?.workflowId) {
    try {
      appendLog(current.logPath, finalizationLog);
    } catch (error) {
      const warning = sanitizeAutomationLogChunk(
        "automation-output-write-failed: " + errorMessage(error),
      );
      console.error(warning);
      errorText = [errorText, warning].filter(Boolean).join("\n") || null;
      logTail = tail(logTail + "\n" + warning + "\n");
    }
  }
  await finalizeTaskRunTransition(provider, run, {
    status,
    exitCode: null,
    signal: null,
    errorMessage: errorText,
    logTail,
  });
}

export async function finalizeForceQuitTaskRun(
  provider: AutomationPersistenceProvider,
  run: AutomationTaskRun,
  dependencies: ForceQuitFinalizationDependencies = {},
) {
  const current = await provider.automation.taskRunById(run.taskRunId);
  if (!current || current.status !== "waiting_for_human") {
    throw new Error(`Automation task is not waiting for human input: ${run.taskId}`);
  }
  const { operationalError, ...sessionCleanup } = await forceQuitAutomationSessionForRun(
    run,
    dependencies,
  );
  await finalizeTaskRunTransition(provider, run, {
    status: "cancelled",
    exitCode: null,
    signal: null,
    errorMessage: sessionCleanup.errorMessage,
    logTail: run.logTail,
    terminationMode: "forced",
  });
  if (operationalError) throw operationalError;
  return { session: sessionCleanup.session };
}

export async function finalizeFailedWaitingRun(
  provider: AutomationPersistenceProvider,
  run: AutomationTaskRun,
  workflowError: string,
) {
  const current = await provider.automation.taskRunById(run.taskRunId);
  if (!current || current.status !== "waiting_for_human") return;
  const sessionCleanup = await finalizeAutomationSessionForRun(
    current,
    workflowError,
    "exact",
  );
  await finalizeTaskRunTransition(provider, run, {
    status: "failed",
    exitCode: null,
    signal: null,
    errorMessage: sessionCleanup.errorMessage,
    logTail: current.logTail,
  });
}

export async function finalizePersistedActiveRuns(
  provider: AutomationPersistenceProvider,
  reason: string,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    for (const run of await provider.automation.activeTaskRuns()) {
      try {
        await finalizePersistedRun(provider, run, reason, "interrupted");
      } catch (error) {
        errors.push(error);
      }
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, "Failed to finalize persisted automation runs");
}

export type AutomationTaskRunTimeoutContext = {
  provider: AutomationPersistenceProvider;
  taskId: string;
  taskRunId: string;
  logPath: string;
};

/** Schedule the same waiting-session timeout using only async persistence. */
export function scheduleAutomationTaskRunTimeout(
  context: AutomationTaskRunTimeoutContext,
) {
  void context.provider.automation.taskRunById(context.taskRunId).then((initialRun) => {
    if (!initialRun || !sessionFromRun(initialRun)) return;
    armAutomationSessionDispositionTimeout(context.taskId, async () => {
      try {
        const run = await context.provider.automation.taskRunById(context.taskRunId);
        if (!run || run.status !== "waiting_for_human") return;
        const sessionCleanup = await finalizeAutomationSessionForRun(
          run,
          "等待人工操作超過 20 分鐘",
          "exact",
        );
        await finalizeTaskRunTransition(
          context.provider,
          { taskRunId: context.taskRunId, logPath: context.logPath },
          {
            status: "failed",
            exitCode: null,
            signal: null,
            errorMessage: sessionCleanup.errorMessage,
            logTail: run.logTail,
          },
        );
      } catch (error) {
        console.error("automation-session-timeout-failed", error);
      }
    });
  }).catch((error) => {
    console.error("automation-session-timeout-schedule-failed", error);
  });
}
