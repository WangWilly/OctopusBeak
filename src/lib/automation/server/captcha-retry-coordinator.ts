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
import { decideAutomationTaskRunOutcome } from "./task-run-finalization.ts";
import type { AutomationPersistenceProvider } from "./store.ts";
import type { ActiveAutomationTaskRun } from "./active-task-run.ts";
import type { TypedWorkflowOutcome } from "./typed-workflow-outcome.ts";
import {
  WORKFLOW_OWNED_CAPTCHA_OUTCOME_TASK_IDS,
  appProviderPostSubmitProbe,
  appWorkflowRoutesVerification,
  routeWaitingRunVerification,
  type VerificationRoutingOutcome,
} from "./verification-routing.ts";
import {
  registerAppWorkflowHumanAssistanceRequestHandler,
  resumeAppWorkflowHumanAssistance,
} from "./app-workflow-human-assistance.ts";
import type { AutomationTaskExecutionOptions } from "./task-run-execution.ts";
import { taskById } from "./tasks.ts";
import { workflowRuntimeForTask } from "./app-workflow-registry.ts";
import {
  YUANTA_TRADE_APP_TASK_ID,
  routeYuantaTradeAppAssistanceRequest,
} from "./yuanta-trade-assistance.ts";

export type CaptchaRetryCoordinatorDependencies = {
  taskId: string;
  /** Browser workflows and the App-owned nonbrowser workflows route explicitly. */
  appWorkflow: boolean;
  provider: AutomationPersistenceProvider;
  run: ActiveAutomationTaskRun;
  launchVerificationSettings: AutomationSettingsFile;
  initialExecutionOptions: AutomationTaskExecutionOptions;
  execute: (options: AutomationTaskExecutionOptions) => Promise<TypedWorkflowOutcome>;
  /** Injection point for deterministic coordinator tests. */
  routeWaitingRunVerification?: typeof routeWaitingRunVerification;
  /** Injection point so coordinator tests do not wait out real cooldowns. */
  captchaRetryCooldownMs?: typeof captchaRetryCooldownMs;
};

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

function failed(report: TypedWorkflowOutcome): TypedWorkflowOutcome {
  return { errorCode: report.errorCode ?? "workflow-failed", summary: report.summary };
}

// Fubon refuses a login that follows the previous session within seconds.
const CAPTCHA_RETRY_COOLDOWN_MS: Readonly<Record<string, number>> = {
  "fubon-all-statements": 20_000,
};

export function captchaRetryCooldownMs(taskId: string): number | undefined {
  return CAPTCHA_RETRY_COOLDOWN_MS[taskId];
}

/** Resolves false as soon as the run is stopped during the wait. */
export function waitForCaptchaRetryCooldown(
  durationMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, durationMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Coordinate App CAPTCHA campaigns around single workflow executions and
 * return the report the run finishes with. Nonbrowser workflows execute once
 * and never enter verification routing.
 */
export async function runCaptchaRetryCampaign(
  dependencies: CaptchaRetryCoordinatorDependencies,
): Promise<TypedWorkflowOutcome> {
  const {
    taskId,
    provider,
    run,
    launchVerificationSettings,
    execute,
  } = dependencies;
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  const appWorkflow = Boolean(task.workflowId && task.kind === "crawler");
  if (dependencies.appWorkflow !== appWorkflow) {
    throw new Error(`Automation task routing does not match the App catalog: ${taskId}`);
  }
  if (!appWorkflow && workflowRuntimeForTask(task.workflowId).kind !== "nonbrowser") {
    throw new Error(`Automation task is not an App workflow or supported nonbrowser task: ${taskId}`);
  }
  const route = dependencies.routeWaitingRunVerification
    ?? routeWaitingRunVerification;
  const routesYuantaTradeCaptcha = taskId === YUANTA_TRADE_APP_TASK_ID;
  const routesCaptcha = appWorkflow && appWorkflowRoutesVerification(taskId);
  const workflowOwnsCaptchaOutcome = WORKFLOW_OWNED_CAPTCHA_OUTCOME_TASK_IDS.has(taskId);
  let campaign: CaptchaRetryCampaign = createCaptchaRetryCampaign();
  const recordActiveRound = async () => {
    if (campaign.status === "awaiting-outcome") {
      await run.update({ attempt: campaign.activeRound, maxAttempts: campaign.maxRounds });
    }
  };
  const executeAppCaptchaAndRoute = async (
    executionOptions: AutomationTaskExecutionOptions,
  ): Promise<{
    report: TypedWorkflowOutcome;
    routing?: VerificationRoutingOutcome;
  }> => {
    const appExecutionOptions = {
      ...executionOptions,
      executionId: executionOptions.executionId ?? randomUUID(),
      ...(routesYuantaTradeCaptcha ? { verificationRouteOwnedByCampaign: true } : {}),
    };
    let routing: VerificationRoutingOutcome | undefined;
    let settleExecution!: (report: TypedWorkflowOutcome) => void;
    const executionSettled = new Promise<TypedWorkflowOutcome>((resolve) => {
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
                campaign = recordCapturedChallenge(campaign, appExecutionOptions.executionId);
                await recordActiveRound();
              };
              const routeOutcome = routesYuantaTradeCaptcha
                ? await routeYuantaTradeAppAssistanceRequest(request, {
                    provider,
                    settings: launchVerificationSettings,
                    route,
                    routeOptions: { onChallengeCaptured },
                  })
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
                providerProbePostSubmit: workflowOwnsCaptchaOutcome
                  ? async (_session, _contract, resume) => {
                    await resume();
                    // Join the worker and browser cleanup before starting another round.
                    // Cleanup normally aborts the assistance request signal.
                    const report = await executionSettled;
                    if (report.errorCode === "captcha-provider-rejected") return "provider-rejected";
                    const { status } = decideAutomationTaskRunOutcome(report, null);
                    return status === "completed" || status === "partial"
                      ? "none" : "unrecognized-dialog";
                  }
                  : appProviderPostSubmitProbe(),
                onChallengeCaptured,
                settings: launchVerificationSettings,
              });
              if (!routeOutcome) return;
              routing = routeOutcome;
              if (
                routing.kind === "retryable"
                && routing.reason === "provider-rejected"
                && campaign.status === "ready"
                && request.contract.challengeImageRegion
              ) {
                campaign = recordCapturedChallenge(campaign, appExecutionOptions.executionId);
                await recordActiveRound();
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

      const report = await execute(appExecutionOptions);
      settleExecution(report);
      if (routePromise) {
        try {
          await routePromise;
        } catch {
          if (!routeSignal?.aborted && !routing) routing = { kind: "failed" };
        }
      }
      return { report, ...(routing ? { routing } : {}) };
    } finally {
      unregister?.();
    }
  };

  const executeAndRoute = async (
    executionOptions: AutomationTaskExecutionOptions,
  ): Promise<{
    report: TypedWorkflowOutcome;
    routing?: VerificationRoutingOutcome;
  }> => {
    if (routesCaptcha) {
      return executeAppCaptchaAndRoute(executionOptions);
    }
    return { report: await execute(executionOptions) };
  };

  let executionOptions: AutomationTaskExecutionOptions = {
    ...dependencies.initialExecutionOptions,
    launchVerificationSettings,
  };
  while (true) {
    const { report, routing } = await executeAndRoute(executionOptions);
    // The typed assistance callback can advance the campaign during execute.
    // Re-widen the callback-mutated state after the await for TypeScript.
    campaign = campaign as CaptchaRetryCampaign;
    if (campaign.consumedRounds > 0) {
      await run.update({
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
    if (report.errorCode === "commit-outcome-unknown") return report;
    if (routing?.kind === "failed") return failed(report);
    if (run.signal.aborted || report.errorCode === "cancelled") {
      campaign = markCaptchaCampaignCancelled(campaign);
      return report;
    }

    const routeRetry = routing?.kind === "retryable" ? routing.reason : null;
    if (routeRetry) {
      if (campaign.status === "awaiting-outcome") {
        campaign = transitionCaptchaRetryCampaign(campaign, {
          kind: "round-outcome",
          executionId: campaign.activeExecutionId,
          outcome: { kind: "retryable", reason: routeRetry },
        });
      } else if (campaign.status !== "exhausted") {
        return failed(report);
      }
      if (!isCaptchaRetryCampaignReady(campaign)) {
        if (campaign.status !== "exhausted") return failed(report);
        await provider.automation.appendRunEvent({
          runId: run.taskRunId,
          stage: "authentication",
          code: "verification-solver-exhausted",
          occurredAt: new Date().toISOString(),
        });
        return { errorCode: "verification-failed", summary: report.summary };
      }
      const nextRound = campaign.nextRound;
      if (nextRound === undefined) return failed(report);
      const admitted = await run.transition("running", {
        attempt: nextRound,
        maxAttempts: MAX_CAPTCHA_RETRY_ROUNDS,
      });
      if (!admitted) return run.signal.aborted ? report : failed(report);
      const cooldownMs = (dependencies.captchaRetryCooldownMs ?? captchaRetryCooldownMs)(taskId);
      const cooledDown = cooldownMs === undefined
        ? !run.signal.aborted
        : await waitForCaptchaRetryCooldown(cooldownMs, run.signal);
      if (!cooledDown) {
        campaign = markCaptchaCampaignCancelled(campaign);
        return report;
      }
      executionOptions = {
        ...dependencies.initialExecutionOptions,
        launchVerificationSettings,
        attempt: nextRound,
        maxAttempts: MAX_CAPTCHA_RETRY_ROUNDS,
        executionId: randomUUID(),
        retrying: true,
      };
      continue;
    }

    if (campaign.status === "awaiting-outcome") {
      const { status } = decideAutomationTaskRunOutcome(report, null);
      if (status === "completed" || status === "partial") {
        campaign = transitionCaptchaRetryCampaign(campaign, {
          kind: "round-outcome",
          executionId: campaign.activeExecutionId,
          outcome: { kind: "succeeded" },
        });
      }
    }
    return report;
  }
}
