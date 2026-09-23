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
  type AutomationPersistenceProvider,
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
} from "./task-run-execution.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";
import { verificationActorForSource } from "../verification-config.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, taskById } from "./tasks.ts";

type CaptchaRetryExecutionResult = Awaited<
  ReturnType<typeof runAutomationTaskExecution>
>;

function persistenceTaskRunId(
  execution: CaptchaRetryExecutionResult,
): string | undefined {
  if (!("taskRunId" in execution)) return undefined;
  return typeof execution.taskRunId === "string" && execution.taskRunId.length > 0
    ? execution.taskRunId
    : undefined;
}

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
  provider: AutomationPersistenceProvider;
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
  provider: AutomationPersistenceProvider,
  taskRunId: string,
  result: CaptchaRetryExecutionResult,
  message: string,
  sessionAlreadyCleaned = false,
) {
  const run = await provider.automation.taskRunById(taskRunId);
  if (!run) return { status: "failed" as const };
  const processResult = "result" in result ? result.result : null;
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
      provider,
      taskId: run.taskId,
      taskKind: run.kind,
      taskRunId,
      logPath: run.logPath,
      sessionAlreadyCleaned,
    },
    {
      ...(processResult ?? fallback),
      exitCode: null,
      signal: null,
      error: new Error(message),
      logTail: run.logTail || processResult?.logTail || "",
    },
  );
}

async function finalizeCaptchaRetryExecution(
  provider: AutomationPersistenceProvider,
  taskRunId: string,
  result: CaptchaRetryExecutionResult,
  message?: string,
  sessionAlreadyCleaned = false,
) {
  const processResult = "result" in result ? result.result : null;
  if (!message && processResult) {
    const run = await provider.automation.taskRunById(taskRunId);
    if (!run) return { status: "failed" as const };
    return finalizeAutomationTaskRun(
      {
        provider,
        taskId: run.taskId,
        taskKind: run.kind,
        taskRunId,
        logPath: run.logPath,
      },
      processResult,
    );
  }
  return finalizeCaptchaRetryCampaign(
    provider,
    taskRunId,
    result,
    message ?? "Automation task failed.",
    sessionAlreadyCleaned,
  );
}

async function cleanUpCaptchaRetryRound(
  provider: AutomationPersistenceProvider,
  taskRunId: string,
  reason: string,
  activeOwner?: OwnedAutomationSession | null,
  sessionAlreadyCleaned = false,
) {
  const run = await provider.automation.taskRunById(taskRunId);
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
    // The finalization path retains any existing log-tail warning.
  }
  await provider.automation.updateTaskRun(taskRunId, {
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
export async function runCaptchaRetryCampaign(dependencies: {
  taskId: string;
  provider: AutomationPersistenceProvider;
  launchVerificationSettings: AutomationSettingsFile;
  initialExecutionOptions: AutomationTaskExecutionOptions;
  execute: (
    options: AutomationTaskExecutionOptions,
  ) => Promise<CaptchaRetryExecutionResult>;
  isCancellationRequested: () => boolean;
  routeWaitingRunVerification?: typeof routeWaitingRunVerification;
  finalizeSessionForRun?: typeof finalizeAutomationSessionForRun;
}) {
  const {
    taskId,
    provider,
    launchVerificationSettings,
    execute,
    isCancellationRequested,
  } = dependencies;
  const route = dependencies.routeWaitingRunVerification
    ?? routeWaitingRunVerification;
  const finalizeSession = dependencies.finalizeSessionForRun
    ?? finalizeAutomationSessionForRun;
  let campaign: CaptchaRetryCampaign = createCaptchaRetryCampaign();
  const task = taskById(taskId);
  const group = AUTOMATION_CREDENTIAL_GROUPS.find(
    (candidate) => candidate.id === task?.credentialGroupId,
  );
  const hostOwnedDialogProvider = taskId === "sinopac-statements"
    && verificationActorForSource(group?.verificationActorKey, launchVerificationSettings) === "solver"
    ? "sinopac" as const
    : undefined;

  const executeAndRoute = async (
    executionOptions: AutomationTaskExecutionOptions,
  ): Promise<{
    execution: CaptchaRetryExecutionResult;
    routing?: VerificationRoutingOutcome;
    sessionCleaned?: boolean;
  }> => {
    const execution = await execute(executionOptions);
    if (!("taskRunId" in execution) || execution.status !== "waiting_for_human") {
      return { execution };
    }

    let resumed: {
      execution: CaptchaRetryExecutionResult;
      routing?: VerificationRoutingOutcome;
      sessionCleaned?: boolean;
    } | null = null;
    let resumePromise: Promise<void> | null = null;
    let resumeSettled = false;
    let routing: VerificationRoutingOutcome;
    let sessionCleaned = false;
    const cleanupResumedSession = async () => {
      if (sessionCleaned) return;
      const currentRun = await provider.automation.taskRunById(execution.taskRunId);
      if (!currentRun) return;
      const cleanup = await finalizeSession(currentRun, null, "exact");
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
        provider,
        scheduleResume: (session) => {
          const nextResume = executeAndRoute({
            ...executionOptions,
            taskRunId: execution.taskRunId,
            resumeSession: session,
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
        onChallengeCaptured: async () => {
          const executionId = "executionId" in execution
            ? execution.executionId
            : null;
          if (!executionId) return;
          campaign = recordCapturedChallenge(campaign, executionId);
          if (campaign.status === "awaiting-outcome") {
            await provider.automation.updateTaskRun(execution.taskRunId, {
              attempt: campaign.activeRound,
              maxAttempts: campaign.maxRounds,
            });
          }
        },
        settings: launchVerificationSettings,
      });
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
      await finalizeCaptchaRetryExecution(
        provider,
        execution.taskRunId,
        execution,
        errorMessage(error),
      );
      return { execution, routing: { kind: "failed" }, sessionCleaned };
    }
    if (routing.kind === "resumed" && resumed) return resumed;
    return { execution, routing, sessionCleaned };
  };

  let executionOptions: AutomationTaskExecutionOptions = {
    ...dependencies.initialExecutionOptions,
    hostOwnedDialogProvider,
  };
  while (true) {
    const routed = await executeAndRoute(executionOptions);
    const execution = routed.execution;
    const taskRunId = persistenceTaskRunId(execution);
    campaign = campaign as CaptchaRetryCampaign;
    if (campaign.consumedRounds > 0 && taskRunId !== undefined) {
      await provider.automation.updateTaskRun(taskRunId, {
        attempt: campaign.status === "awaiting-outcome"
          ? campaign.activeRound
          : campaign.status === "ready" && campaign.nextRound !== undefined
            ? campaign.nextRound
            : campaign.consumedRounds,
        maxAttempts: campaign.maxRounds,
      });
    }

    if (routed.routing?.kind === "failed") {
      if (taskRunId !== undefined) {
        const failureMessage =
          (await provider.automation.taskRunById(taskRunId))?.errorMessage
          ?? "Verification route failed closed.";
        await finalizeCaptchaRetryExecution(
          provider,
          taskRunId,
          execution,
          failureMessage,
          routed.sessionCleaned ?? false,
        );
      }
      return { status: "failed" as const };
    }
    if (execution.status === "cancelled") {
      if (taskRunId !== undefined) {
        await finalizeCaptchaRetryExecution(
          provider,
          taskRunId,
          execution,
          "Automation task cancelled.",
        );
      }
      return { status: "failed" as const };
    }
    if (isCancellationRequested() && taskRunId !== undefined) {
      campaign = markCaptchaCampaignCancelled(campaign);
      await finalizeCaptchaRetryExecution(
        provider,
        taskRunId,
        execution,
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
      if (taskRunId === undefined) return { status: "failed" as const };
      if (campaign.status === "awaiting-outcome") {
        campaign = transitionCaptchaRetryCampaign(campaign, {
          kind: "round-outcome",
          executionId: campaign.activeExecutionId,
          outcome: { kind: "retryable", reason: routeRetry },
        });
      } else if (campaign.status !== "ready" && campaign.status !== "exhausted") {
        await finalizeCaptchaRetryExecution(
          provider,
          taskRunId,
          execution,
          "CAPTCHA retry requested without a captured challenge.",
        );
        return { status: "failed" as const };
      }
      if (!isCaptchaRetryCampaignReady(campaign)) {
        if (campaign.status === "exhausted") {
          await finalizeCaptchaRetryExecution(
            provider,
            taskRunId,
            execution,
            `CAPTCHA retry campaign exhausted after ${MAX_CAPTCHA_RETRY_ROUNDS} rounds.`,
          );
          return { status: "failed" as const };
        }
        return { status: "failed" as const };
      }
      const cleanup = await cleanUpCaptchaRetryRound(
        provider,
        taskRunId,
        routeRetry,
        "owner" in execution ? execution.owner : null,
        routed.sessionCleaned ?? false,
      );
      if (!cleanup.ok) {
        await finalizeCaptchaRetryExecution(
          provider,
          taskRunId,
          execution,
          cleanup.message,
        );
        return { status: "failed" as const };
      }
      if (isCancellationRequested()) {
        campaign = markCaptchaCampaignCancelled(campaign);
        await finalizeCaptchaRetryExecution(
          provider,
          taskRunId,
          execution,
          "Automation task cancelled.",
        );
        return { status: "failed" as const };
      }
      executionOptions = {
        scheduledAtUtc: dependencies.initialExecutionOptions.scheduledAtUtc,
        taskRunId,
        attempt: campaign.nextRound,
        maxAttempts: MAX_CAPTCHA_RETRY_ROUNDS,
        hostOwnedDialogProvider,
      };
      continue;
    }

    if (
      campaign.status === "awaiting-outcome" &&
      taskRunId !== undefined &&
      (execution.status === "completed" || execution.status === "partial")
    ) {
      campaign = transitionCaptchaRetryCampaign(campaign, {
        kind: "round-outcome",
        executionId: campaign.activeExecutionId,
        outcome: { kind: "succeeded" },
      });
    }
    if (taskRunId !== undefined && execution.status !== "waiting_for_human") {
      const finalized = await finalizeCaptchaRetryExecution(
        provider,
        taskRunId,
        execution,
      );
      return { status: finalized.status };
    }
    return {
      status: "status" in execution ? execution.status : "failed",
    };
  }
}
