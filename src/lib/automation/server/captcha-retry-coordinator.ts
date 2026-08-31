import type { LedgerDatabase } from "../../../ledger/db/client.ts";
import type { AutomationSettingsFile } from "./config-files.ts";
import {
  MAX_CAPTCHA_RETRY_ROUNDS,
  createCaptchaRetryCampaign,
  isCaptchaRetryCampaignReady,
  transitionCaptchaRetryCampaign,
  CaptchaRetryCampaignTransitionError,
  type CaptchaRetryCampaign,
} from "./captcha-retry-campaign.ts";
import {
  appendLog,
  errorMessage,
  finalizeAutomationSessionForRun,
  sessionFromRun,
  type OwnedAutomationSession,
} from "./automation-session-disposition.ts";
import {
  finalizeAutomationTaskRun,
  type AutomationTaskProcessResult,
} from "./task-run-finalization.ts";
import {
  taskRunById,
  updateTaskRun,
} from "./store.ts";
import {
  routeWaitingRunVerification,
  type VerificationRoutingOutcome,
} from "./verification-routing.ts";
import {
  SINOPAC_DIALOG_OWNER_ENV,
  sinopacHostDialogOwner,
} from "../sinopac-captcha.ts";
import {
  YUANTA_DIALOG_OWNER_ENV,
  yuantaHostDialogOwner,
} from "../yuanta-captcha.ts";
import type {
  AutomationTaskExecutionOptions,
  runAutomationTaskExecution,
} from "./task-run-execution.ts";

type CaptchaRetryExecutionResult = Awaited<
  ReturnType<typeof runAutomationTaskExecution>
>;

type RoutedExecution = {
  execution: CaptchaRetryExecutionResult;
  routing?: VerificationRoutingOutcome;
  /** The current execution's exact session was already finalized and joined. */
  sessionCleaned?: boolean;
};

const CAPTCHA_RESUME_JOIN_TIMEOUT_MS = 5_000;

async function settleCaptchaResume(
  promise: Promise<unknown>,
  timeoutMs = CAPTCHA_RESUME_JOIN_TIMEOUT_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise.then(
      (value) => ({ timedOut: false as const, value }),
      (error) => ({ timedOut: false as const, error }),
    ),
    new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

export type CaptchaRetryCoordinatorDependencies = {
  taskId: string;
  taskDb: LedgerDatabase;
  ledgerDir: string;
  launchVerificationSettings: AutomationSettingsFile;
  initialExecutionOptions: AutomationTaskExecutionOptions;
  execute: (
    options: AutomationTaskExecutionOptions,
  ) => Promise<CaptchaRetryExecutionResult>;
  isCancellationRequested: () => boolean;
  /**
   * Injection point for deterministic coordinator tests. Production callers
   * use the verification router's normal implementation.
   */
  routeWaitingRunVerification?: typeof routeWaitingRunVerification;
  /** Exact-session cleanup seam used by the coordinator and focused tests. */
  finalizeSessionForRun?: typeof finalizeAutomationSessionForRun;
};

function processResultOf(execution: CaptchaRetryExecutionResult) {
  return "result" in execution ? execution.result : null;
}

function executionIdOf(execution: CaptchaRetryExecutionResult) {
  return "executionId" in execution ? execution.executionId : null;
}

function recordCapturedChallenge(
  campaign: CaptchaRetryCampaign,
  executionId: string,
) {
  if (campaign.status === "ready") {
    return transitionCaptchaRetryCampaign(campaign, {
      kind: "challenge-captured",
      executionId,
    });
  }
  if (
    campaign.status === "awaiting-outcome" &&
    campaign.activeExecutionId === executionId
  ) {
    return campaign;
  }
  if (campaign.status === "awaiting-outcome") {
    throw new CaptchaRetryCampaignTransitionError(
      `A second CAPTCHA challenge was captured by execution ${executionId} before execution ${campaign.activeExecutionId} reported its round outcome.`,
      "invalid-transition",
    );
  }
  return campaign;
}

function markCaptchaCampaignCancelled(campaign: CaptchaRetryCampaign) {
  if (
    campaign.status === "completed" ||
    campaign.status === "failed" ||
    campaign.status === "cancelled" ||
    campaign.status === "exhausted"
  ) return campaign;
  return transitionCaptchaRetryCampaign(campaign, {
    kind: "cancelled",
    executionId: campaign.status === "awaiting-outcome"
      ? campaign.activeExecutionId
      : undefined,
  });
}

async function finalizeCaptchaRetryCampaign(
  taskDb: LedgerDatabase,
  taskRunId: string,
  result: CaptchaRetryExecutionResult,
  ledgerDir: string,
  message: string,
) {
  const run = taskRunById(taskDb, taskRunId);
  if (!run) return { status: "failed" as const };
  const processResult = processResultOf(result);
  const fallback: AutomationTaskProcessResult = {
    exitCode: null,
    signal: null,
    error: new Error(message),
    logTail: run.logTail,
    resumeFailure: null,
    statementSummary: null,
    outputPersistenceWarnings: [],
    externalPrerequisiteIds: [],
  };
  return finalizeAutomationTaskRun(
    {
      taskDb,
      taskId: run.taskId,
      taskKind: run.kind,
      taskRunId,
      logPath: run.logPath,
      ledgerDir,
    },
    {
      ...(processResult ?? fallback),
      exitCode: null,
      signal: null,
      error: new Error(message),
      logTail: processResult?.logTail ?? run.logTail,
    },
  );
}

async function cleanUpCaptchaRetryRound(
  taskDb: LedgerDatabase,
  taskRunId: string,
  reason: string,
  activeOwner?: OwnedAutomationSession | null,
  sessionAlreadyCleaned = false,
) {
  const run = taskRunById(taskDb, taskRunId);
  if (!run) return { ok: false as const, message: "Missing automation task run." };
  const cleanup = !sessionAlreadyCleaned && (activeOwner ?? sessionFromRun(run))
    ? await finalizeAutomationSessionForRun(run, null, "exact", activeOwner)
    : null;
  if (cleanup?.cleanupFailed) {
    return {
      ok: false as const,
      message: cleanup.errorMessage ?? "CAPTCHA retry session cleanup failed.",
    };
  }
  const marker = `captcha-retry: restarting workflow (${reason})`;
  try {
    appendLog(run.logPath, marker + "\n");
  } catch {
    // The finalization path will retain the existing log-tail warning if the
    // log cannot be appended; a retry does not depend on this diagnostic.
  }
  updateTaskRun(taskDb, taskRunId, {
    status: "running",
    finishedAt: null,
    exitCode: null,
    signal: null,
    errorMessage: null,
    logTail: `${run.logTail}\n${marker}\n`.slice(-4_000),
  });
  return { ok: true as const };
}

/**
 * Own the stateful CAPTCHA retry campaign around otherwise ordinary workflow
 * executions. The caller only supplies a single-execution function; this
 * module owns routing, round transitions, cleanup, persistence, and serial
 * workflow restarts.
 */
export async function runCaptchaRetryCampaign(
  dependencies: CaptchaRetryCoordinatorDependencies,
) {
  const {
    taskId,
    taskDb,
    ledgerDir,
    launchVerificationSettings,
    execute,
    isCancellationRequested,
  } = dependencies;
  const route = dependencies.routeWaitingRunVerification
    ?? routeWaitingRunVerification;
  const finalizeSession = dependencies.finalizeSessionForRun
    ?? finalizeAutomationSessionForRun;
  let campaign: CaptchaRetryCampaign = createCaptchaRetryCampaign();

  const executeAndRoute = async (
    executionOptions: AutomationTaskExecutionOptions,
  ): Promise<RoutedExecution> => {
    const execution = await execute(executionOptions);
    if (!("taskRunId" in execution) || execution.status !== "waiting_for_human") {
      return { execution };
    }

    let resumed: RoutedExecution | null = null;
    let resumePromise: Promise<void> | null = null;
    let resumeSettled = false;
    let sessionCleaned = false;
    let routing: VerificationRoutingOutcome;
    const cleanupResumedSession = async () => {
      if (sessionCleaned) return;
      const currentRun = taskRunById(taskDb, execution.taskRunId);
      if (!currentRun) return;
      const cleanup = await finalizeSession(
        currentRun,
        null,
        "exact",
      );
      if (cleanup.cleanupFailed) {
        throw new Error(
          cleanup.errorMessage ?? "CAPTCHA retry session cleanup failed.",
        );
      }
      sessionCleaned = true;
    };
    try {
      routing = await route({
        taskId,
        taskRunId: execution.taskRunId,
        session: execution.session ?? undefined,
        db: taskDb,
        scheduleResume: (session) => {
          const nextResume = executeAndRoute({
            ...executionOptions,
            taskRunId: execution.taskRunId,
            resumeSession: session,
            // The workflow may let the host probe own post-submit dialogs
            // only for this explicit solver retry. Human/direct resumes keep
            // their workflow-owned fail-fast dialog handler.
            launchEnv: {
              ...(executionOptions.launchEnv ?? {}),
              [SINOPAC_DIALOG_OWNER_ENV]: sinopacHostDialogOwner(session),
              [YUANTA_DIALOG_OWNER_ENV]: yuantaHostDialogOwner(session),
            },
          });
          resumePromise = nextResume.then((result) => {
            resumed = result;
          }).finally(() => {
            resumeSettled = true;
          });
          return resumePromise;
        },
        cleanupSession: cleanupResumedSession,
        onChallengeCaptured: () => {
          const executionId = executionIdOf(execution);
          if (!executionId) return;
          campaign = recordCapturedChallenge(campaign, executionId);
          if (campaign.status === "awaiting-outcome") {
            updateTaskRun(taskDb, execution.taskRunId, {
              attempt: campaign.activeRound,
              maxAttempts: campaign.maxRounds,
            });
          }
        },
        settings: launchVerificationSettings,
      });
      // Providers should join their resumed execution as part of the probe.
      // Keep the coordinator defensive as well: a route that returns while a
      // resume is still in flight must terminate and join it before the outer
      // campaign can clean up and start another round.
      if (resumePromise && !resumeSettled) {
        let cleanupError: unknown = null;
        try {
          await cleanupResumedSession();
        } catch (error) {
          cleanupError = error;
        }
        const joined = await settleCaptchaResume(resumePromise);
        if (cleanupError) throw cleanupError;
        if (joined.timedOut) {
          throw new Error("CAPTCHA retry resume did not settle after cleanup.");
        }
        if ("error" in joined) throw joined.error;
      } else if (resumePromise) {
        await resumePromise;
      }
    } catch (error) {
      await finalizeCaptchaRetryCampaign(
        taskDb,
        execution.taskRunId,
        execution,
        ledgerDir,
        errorMessage(error),
      );
      return { execution, routing: { kind: "failed" }, sessionCleaned };
    }
    if (routing.kind === "resumed" && resumed) return resumed;
    return { execution, routing, sessionCleaned };
  };

  let executionOptions = dependencies.initialExecutionOptions;
  while (true) {
    const routed = await executeAndRoute(executionOptions);
    const execution = routed.execution;
    // The campaign can advance in the asynchronous capture callback above.
    // Keep the union visible to TypeScript after that await boundary.
    campaign = campaign as CaptchaRetryCampaign;
    if (campaign.consumedRounds > 0 && "taskRunId" in execution) {
      updateTaskRun(taskDb, execution.taskRunId!, {
        attempt: campaign.status === "awaiting-outcome"
          ? campaign.activeRound
          : campaign.consumedRounds,
        maxAttempts: campaign.maxRounds,
      });
    }

    if (routed.routing?.kind === "failed") {
      if ("taskRunId" in execution && !routed.sessionCleaned) {
        // A provider-owned dialog may make the resumed child fail before the
        // route returns. Finalize from the coordinator as well so a
        // fail-closed route cannot leave that resumed session running.
        await finalizeCaptchaRetryCampaign(
          taskDb,
          execution.taskRunId!,
          execution,
          ledgerDir,
          "Verification route failed closed.",
        );
      }
      return { status: "failed" as const };
    }
    if (execution.status === "cancelled") {
      if ("taskRunId" in execution) {
        await finalizeCaptchaRetryCampaign(
          taskDb,
          execution.taskRunId!,
          execution,
          ledgerDir,
          "Automation task cancelled.",
        );
      }
      return { status: "failed" as const };
    }
    if (isCancellationRequested() && "taskRunId" in execution) {
      campaign = markCaptchaCampaignCancelled(campaign);
      await finalizeCaptchaRetryCampaign(
        taskDb,
        execution.taskRunId!,
        execution,
        ledgerDir,
        "Automation task cancelled.",
      );
      return { status: "failed" as const };
    }
    if (routed.routing?.kind === "human") {
      if (campaign.status === "awaiting-outcome") {
        campaign = transitionCaptchaRetryCampaign(campaign, {
          kind: "round-outcome",
          executionId: campaign.activeExecutionId,
          outcome: { kind: "succeeded" },
        });
      }
      return { status: "waiting_for_human" as const };
    }

    const routeRetry = routed.routing?.kind === "retryable"
      ? routed.routing.reason
      : null;
    if (routeRetry) {
      if (!("taskRunId" in execution)) return { status: "failed" as const };
      if (campaign.status === "awaiting-outcome") {
        campaign = transitionCaptchaRetryCampaign(campaign, {
          kind: "round-outcome",
          executionId: campaign.activeExecutionId,
          outcome: { kind: "retryable", reason: routeRetry },
        });
      } else if (campaign.status !== "ready" && campaign.status !== "exhausted") {
        await finalizeCaptchaRetryCampaign(
          taskDb,
          execution.taskRunId!,
          execution,
          ledgerDir,
          "CAPTCHA retry requested without a captured challenge.",
        );
        return { status: "failed" as const };
      }
      if (!isCaptchaRetryCampaignReady(campaign)) {
        if (campaign.status === "exhausted") {
          await finalizeCaptchaRetryCampaign(
            taskDb,
            execution.taskRunId!,
            execution,
            ledgerDir,
            `CAPTCHA retry campaign exhausted after ${MAX_CAPTCHA_RETRY_ROUNDS} rounds.`,
          );
          return { status: "failed" as const };
        }
        return { status: "failed" as const };
      }
      const cleanup = await cleanUpCaptchaRetryRound(
        taskDb,
        execution.taskRunId!,
        routeRetry,
        "owner" in execution ? execution.owner : null,
        routed.sessionCleaned ?? false,
      );
      if (!cleanup.ok) {
        await finalizeCaptchaRetryCampaign(
          taskDb,
          execution.taskRunId!,
          execution,
          ledgerDir,
          cleanup.message,
        );
        return { status: "failed" as const };
      }
      if (isCancellationRequested()) {
        campaign = markCaptchaCampaignCancelled(campaign);
        await finalizeCaptchaRetryCampaign(
          taskDb,
          execution.taskRunId!,
          execution,
          ledgerDir,
          "Automation task cancelled.",
        );
        return { status: "failed" as const };
      }
      executionOptions = {
        scheduledAtUtc: dependencies.initialExecutionOptions.scheduledAtUtc,
        taskRunId: execution.taskRunId,
        attempt: campaign.nextRound,
        maxAttempts: MAX_CAPTCHA_RETRY_ROUNDS,
      };
      continue;
    }

    if (
      campaign.status === "awaiting-outcome" &&
      "taskRunId" in execution &&
      (execution.status === "completed" || execution.status === "partial")
    ) {
      campaign = transitionCaptchaRetryCampaign(campaign, {
        kind: "round-outcome",
        executionId: campaign.activeExecutionId,
        outcome: { kind: "succeeded" },
      });
    }
    return {
      status: "status" in execution ? execution.status : "failed",
    };
  }
}
