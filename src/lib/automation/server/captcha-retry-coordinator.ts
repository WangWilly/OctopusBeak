import { randomUUID } from "node:crypto";
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
  finalizeAutomationTaskRun,
  type AutomationTaskExecutionResult,
} from "./task-run-finalization.ts";
import {
  type AutomationPersistenceProvider,
} from "./store.ts";
import {
  routeWaitingRunVerification,
  type VerificationRoutingOutcome,
} from "./verification-routing.ts";
import {
  registerAppWorkflowHumanAssistanceRequestHandler,
  resumeAppWorkflowHumanAssistance,
} from "./app-workflow-human-assistance.ts";
import type {
  ProviderVerificationHost,
} from "./provider-verification.ts";
import { probeProviderVerificationPostSubmit } from "./provider-verification.ts";
import { appWorkflowPageForSession } from "./app-browser-host.ts";
import {
  type AutomationTaskExecutionOptions,
} from "./task-run-execution.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";
import { taskById } from "./tasks.ts";
import { routeYuantaTradeAppAssistanceRequest } from "./yuanta-trade-assistance.ts";

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

export type CaptchaRetryCoordinatorDependencies = {
  taskId: string;
  /** Browser workflows and the two App-owned nonbrowser workflows route explicitly. */
  appWorkflow: boolean;
  provider: AutomationPersistenceProvider;
  launchVerificationSettings: AutomationSettingsFile;
  initialExecutionOptions: AutomationTaskExecutionOptions;
  execute: (
    options: AutomationTaskExecutionOptions,
  ) => Promise<CaptchaRetryExecutionResult>;
  isCancellationRequested: () => boolean;
  /** Injection point for deterministic coordinator tests. */
  routeWaitingRunVerification?: typeof routeWaitingRunVerification;
};

function appProviderPostSubmitProbe(): ProviderVerificationHost["probePostSubmit"] {
  return async (viewerKey, contract, resume) =>
    await probeProviderVerificationPostSubmit(
      viewerKey,
      contract,
      resume,
      async () => {
        const page = appWorkflowPageForSession(viewerKey);
        if (!page) throw new Error("App verification browser session is unavailable for cleanup.");
        await page.context().close();
      },
    );
}

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

async function finalizeCaptchaRetryExecution(
  provider: AutomationPersistenceProvider,
  taskRunId: string,
  result: CaptchaRetryExecutionResult,
  message?: string,
) {
  const run = await provider.automation.taskRunById(taskRunId);
  if (!run) return { status: "failed" as const };
  const processResult = "result" in result ? result.result : null;
  const fallback: AutomationTaskExecutionResult = {
    exitCode: 1,
    signal: null,
    error: new Error("Automation task execution failed."),
    statementSummary: null,
    outputPersistenceWarnings: [],
    externalPrerequisiteIds: [],
  };
  const cancelled = message === "Automation task cancelled."
    || result.status === "cancelled";
  return finalizeAutomationTaskRun(
    {
      provider,
      taskId: run.taskId,
      taskKind: run.kind,
      taskRunId,
    },
    {
      ...(processResult ?? fallback),
      ...(message
        ? {
          exitCode: cancelled ? null : 1,
          signal: cancelled ? "SIGTERM" as const : null,
          error: new Error(message),
        }
        : {}),
    },
  );
}

async function prepareCaptchaRetryRound(
  provider: AutomationPersistenceProvider,
  taskRunId: string,
  round: number,
) {
  const run = await provider.automation.taskRunById(taskRunId);
  if (!run) return false;
  await provider.automation.updateTaskRun(taskRunId, {
    status: "running",
    finishedAt: null,
    exitCode: null,
    signal: null,
    attempt: round,
    maxAttempts: MAX_CAPTCHA_RETRY_ROUNDS,
  });
  return true;
}

const NON_BROWSER_APP_TASK_IDS = new Set(["exchange-rates", "sync-maicoin"]);
const TEXT_CAPTCHA_APP_TASK_IDS = new Set([
  "fubon-all-statements",
  "yuanta-all-statements",
  "hncb-statements",
  "post-statements",
  "einvoice-personal-invoices",
  "sinopac-statements",
]);

/**
 * Coordinate App CAPTCHA campaigns around single workflow executions.
 * The two nonbrowser workflows execute once and never enter verification routing.
 */
export async function runCaptchaRetryCampaign(
  dependencies: CaptchaRetryCoordinatorDependencies,
) {
  const {
    taskId,
    provider,
    launchVerificationSettings,
    execute,
    isCancellationRequested,
  } = dependencies;
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  const appWorkflow = Boolean(task.workflowId && task.kind === "crawler");
  if (dependencies.appWorkflow !== appWorkflow) {
    throw new Error(`Automation task routing does not match the App catalog: ${taskId}`);
  }
  if (!appWorkflow && !NON_BROWSER_APP_TASK_IDS.has(taskId)) {
    throw new Error(`Automation task is not an App workflow or supported nonbrowser task: ${taskId}`);
  }
  const route = dependencies.routeWaitingRunVerification
    ?? routeWaitingRunVerification;
  const routesYuantaTradeCaptcha = taskId === "yuanta-trade-statements";
  const routesCaptcha = appWorkflow && (
    TEXT_CAPTCHA_APP_TASK_IDS.has(taskId) || routesYuantaTradeCaptcha
  );
  const routesSinopacCaptcha = taskId === "sinopac-statements";
  let campaign: CaptchaRetryCampaign = createCaptchaRetryCampaign();
  const executeAppCaptchaAndRoute = async (
    executionOptions: AutomationTaskExecutionOptions,
  ): Promise<{
    execution: CaptchaRetryExecutionResult;
    routing?: VerificationRoutingOutcome;
  }> => {
    const appExecutionOptions = {
      ...executionOptions,
      executionId: executionOptions.executionId ?? randomUUID(),
      ...(routesYuantaTradeCaptcha ? { verificationRouteOwnedByCampaign: true } : {}),
    };
    let routing: VerificationRoutingOutcome | undefined;
    let settleExecution!: (execution: CaptchaRetryExecutionResult) => void;
    const executionSettled = new Promise<CaptchaRetryExecutionResult>((resolve) => {
      settleExecution = resolve;
    });
    let routePromise: Promise<void> | null = null;
    let routeSignal: AbortSignal | undefined;
    let unregister: (() => void) | undefined;
    try {
      unregister = registerAppWorkflowHumanAssistanceRequestHandler(
        taskId,
        (request) => {
          routeSignal = request.signal;
          routePromise = (async () => {
            try {
              const onChallengeCaptured = async () => {
                const executionId = appExecutionOptions.executionId;
                campaign = recordCapturedChallenge(campaign, executionId);
                if (campaign.status === "awaiting-outcome") {
                  await provider.automation.updateTaskRun(request.taskRunId, {
                    attempt: campaign.activeRound,
                    maxAttempts: campaign.maxRounds,
                  });
                }
              };
              const routeOutcome = routesYuantaTradeCaptcha
                ? await routeYuantaTradeAppAssistanceRequest(request, {
                    provider,
                    settings: launchVerificationSettings,
                    route,
                    routeOptions: { onChallengeCaptured },
                  }) ?? { kind: "human" as const }
                : await route({
                taskId,
                taskRunId: request.taskRunId,
                provider,
                resumeAppWorkflow: async () => {
                  const current = await provider.automation.taskRunById(request.taskRunId);
                  if (!current) throw new Error("App workflow run is unavailable for verification resume.");
                  const status = current.humanAssistanceContract?.completion.mode === "independent"
                    ? "verified"
                    : "entered";
                  await provider.automation.updateHumanAssistanceCompletion(request.taskRunId, status);
                  const resumedInPlace = await resumeAppWorkflowHumanAssistance(request.taskRunId, status);
                  if (!resumedInPlace) {
                    throw new Error("App workflow verification stage is no longer active.");
                  }
                },
                finalizeFailed: async (message) => {
                  request.signal.throwIfAborted();
                  throw new Error(message);
                },
                providerProbePostSubmit: routesSinopacCaptcha
                  ? async (_session, _contract, resume) => {
                    await resume();
                    // Join the worker and browser cleanup before starting another round.
                    // Cleanup normally aborts the assistance request signal.
                    const execution = await executionSettled;
                    if (execution.result?.appWorkflowOutcome?.errorCode === "captcha-provider-rejected") {
                      return "provider-rejected";
                    }
                    return execution.status === "completed" || execution.status === "partial"
                      ? "none" : "unrecognized-dialog";
                  }
                  : appProviderPostSubmitProbe(),
                onChallengeCaptured,
                settings: launchVerificationSettings,
              });
              routing = routeOutcome;
              if (
                routing.kind === "retryable"
                && routing.reason === "provider-rejected"
                && campaign.status === "ready"
                && request.contract.challengeImageRegion
              ) {
                campaign = recordCapturedChallenge(campaign, appExecutionOptions.executionId);
                if (campaign.status === "awaiting-outcome") {
                  await provider.automation.updateTaskRun(request.taskRunId, {
                    attempt: campaign.activeRound,
                    maxAttempts: campaign.maxRounds,
                  });
                }
              }
              if (routing.kind === "failed") {
                throw new Error("App workflow verification route failed closed.");
              }
              if (
                routing.kind === "retryable"
                && routing.reason === "solver-exhausted"
              ) {
                // Reject the worker's pending assistance stage. The worker
                // cleans up its browser before the coordinator opens a new round.
                throw new Error("App workflow solver exhausted this challenge.");
              }
            } catch (error) {
              if (!request.signal.aborted && !routing) routing = { kind: "failed" };
              throw error;
            }
          })();
          return routePromise;
        },
      );

      const execution = await execute(appExecutionOptions);
      settleExecution(execution);
      if (routePromise) {
        try {
          await routePromise;
        } catch {
          if (!routeSignal?.aborted && !routing) routing = { kind: "failed" };
        }
      }
      return { execution, ...(routing ? { routing } : {}) };
    } finally {
      unregister?.();
    }
  };

  const executeAndRoute = async (
    executionOptions: AutomationTaskExecutionOptions,
  ): Promise<{
    execution: CaptchaRetryExecutionResult;
    routing?: VerificationRoutingOutcome;
  }> => {
    if (routesCaptcha) {
      return executeAppCaptchaAndRoute(executionOptions);
    }
    return { execution: await execute(executionOptions) };
  };

  let executionOptions: AutomationTaskExecutionOptions = {
    ...dependencies.initialExecutionOptions,
    launchVerificationSettings,
  };
  while (true) {
    const routed = await executeAndRoute(executionOptions);
    const execution = routed.execution;
    const taskRunId = persistenceTaskRunId(execution);
    // The typed assistance callback can advance the campaign during execute.
    // Re-widen the callback-mutated state after the await for TypeScript.
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

    // Cancellation or CAPTCHA routing must not replace an uncertain financial
    // commit with a cancelled outcome or admit another execution of the run.
    if (processResultOf(execution)?.appWorkflowOutcome?.errorCode === "commit-outcome-unknown") {
      if (taskRunId !== undefined) {
        await finalizeCaptchaRetryExecution(provider, taskRunId, execution);
      }
      return { status: "failed" as const };
    }

    if (routed.routing?.kind === "failed") {
      if (taskRunId !== undefined) {
        await finalizeCaptchaRetryExecution(
          provider,
          taskRunId,
          execution,
          "Verification route failed closed.",
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
    if (
      execution.status === "waiting_for_human"
      && (!appWorkflow || taskRunId === undefined)
    ) {
      if (taskRunId !== undefined) {
        await finalizeCaptchaRetryExecution(
          provider,
          taskRunId,
          execution,
          "Nonbrowser workflow cannot pause for human assistance.",
        );
      }
      return { status: "failed" as const };
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
      } else if (campaign.status !== "exhausted") {
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
      const nextRound = campaign.nextRound;
      if (nextRound === undefined) {
        await finalizeCaptchaRetryExecution(
          provider,
          taskRunId,
          execution,
          "CAPTCHA retry campaign has no admitted next round.",
        );
        return { status: "failed" as const };
      }
      const prepared = await prepareCaptchaRetryRound(
        provider,
        taskRunId,
        nextRound,
      );
      if (!prepared) {
        await finalizeCaptchaRetryExecution(
          provider,
          taskRunId,
          execution,
          "CAPTCHA retry could not prepare the existing App workflow run.",
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
        ...dependencies.initialExecutionOptions,
        launchVerificationSettings,
        taskRunId,
        attempt: nextRound,
        maxAttempts: MAX_CAPTCHA_RETRY_ROUNDS,
        executionId: randomUUID(),
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
