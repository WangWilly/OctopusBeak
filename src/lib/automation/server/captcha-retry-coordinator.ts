import { signalRunEvent } from "../run-event.ts";
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
import type { ActiveAutomationTaskRun, TaskRunReport } from "./active-task-run.ts";
import {
  WORKFLOW_OWNED_CAPTCHA_OUTCOME_TASK_IDS,
  appWorkflowRoutesVerification,
  appVerificationSolver,
  noPostSubmitOutcome,
  routeWaitingRunVerification,
  sourceVerificationRoute,
  type VerificationRoutingOutcome,
} from "./verification-routing.ts";
import {
  completeAppWorkflowHumanAssistance,
  type HumanAssistanceRoute,
} from "./app-workflow-human-assistance.ts";
import type { AutomationTaskExecutionOptions } from "./task-run-execution.ts";
import { taskById } from "./tasks.ts";
import { workflowRuntimeForTask } from "./app-workflow-registry.ts";
import type { PageForRun } from "./automation-viewer.ts";

export type CaptchaRetryCoordinatorDependencies = {
  taskId: string;
  /** Browser workflows and the App-owned nonbrowser workflows route explicitly. */
  appWorkflow: boolean;
  run: ActiveAutomationTaskRun;
  /** Finds the page each round's Workflow execution hosts, for verification routing. */
  pageForRun: PageForRun;
  launchVerificationSettings: AutomationSettingsFile;
  execute: (options: AutomationTaskExecutionOptions) => Promise<TaskRunReport>;
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

function failed(report: TaskRunReport): TaskRunReport {
  return { summary: report.summary, failure: report.failure ?? { code: "workflow-failed", proven: false } };
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
): Promise<TaskRunReport> {
  const {
    taskId,
    run,
    pageForRun,
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
  const sourceRoute = sourceVerificationRoute(taskId);
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
    report: TaskRunReport;
    routing?: VerificationRoutingOutcome;
  }> => {
    const appExecutionOptions = {
      ...executionOptions,
      executionId: executionOptions.executionId ?? randomUUID(),
    };
    let routing: VerificationRoutingOutcome | undefined;
    let settleExecution!: (report: TaskRunReport) => void;
    const executionSettled = new Promise<TaskRunReport>((resolve) => {
      settleExecution = resolve;
    });
    let routePromise: Promise<void> | null = null;
    let routeSignal: AbortSignal | undefined;
    const assistanceRoute: HumanAssistanceRoute = (request) => {
      routeSignal = request.signal;
      routePromise = (async () => {
        try {
          const onChallengeCaptured = async () => {
            campaign = recordCapturedChallenge(campaign, appExecutionOptions.executionId);
            await recordActiveRound();
          };
          const routeOutcome = sourceRoute
            ? await sourceRoute(request, {
                settings: launchVerificationSettings,
                route,
                onChallengeCaptured,
                pageForRun,
              })
            : await route({
              run: request.run,
              pageForRun,
              solver: appVerificationSolver,
              resume: () => completeAppWorkflowHumanAssistance(request),
              postSubmitOutcome: workflowOwnsCaptchaOutcome
                ? async () => {
                  // Join the worker and browser cleanup before starting another round.
                  // Cleanup normally aborts the assistance request signal.
                  const { status, errorCode } = run.assess(await executionSettled);
                  if (errorCode === "captcha-provider-rejected") return "provider-rejected";
                  return status === "completed" || status === "partial"
                    ? "none" : "unrecognized-dialog";
                }
                : noPostSubmitOutcome,
              finalizeFailed: async (message) => {
                request.signal.throwIfAborted();
                throw new Error(message);
              },
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
    };

    // The execution holds the route from its start, so no worker request can find none.
    const report = await execute({ ...appExecutionOptions, assistanceRoute });
    settleExecution(report);
    if (routePromise) {
      try {
        await routePromise;
      } catch {
        if (!routeSignal?.aborted && !routing) routing = { kind: "failed" };
      }
    }
    return { report, ...(routing ? { routing } : {}) };
  };

  const executeAndRoute = async (
    executionOptions: AutomationTaskExecutionOptions,
  ): Promise<{
    report: TaskRunReport;
    routing?: VerificationRoutingOutcome;
  }> => {
    if (routesCaptcha) {
      return executeAppCaptchaAndRoute(executionOptions);
    }
    return { report: await execute(executionOptions) };
  };

  let executionOptions: AutomationTaskExecutionOptions = {};
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
    const assessed = run.assess(report);
    if (assessed.errorCode === "commit-outcome-unknown") return report;
    // Another round would sign in again only to be refused until the person
    // runs a Canonical Reset (ADR 0062).
    if (assessed.errorCode === "canonical-reset-required") return report;
    if (routing?.kind === "failed") return failed(report);
    if (run.signal.aborted || assessed.status === "cancelled") {
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
        // Written between executions, so it belongs to none; the report below
        // names the failure itself and nothing classifies this signal.
        await run.appendEvent(signalRunEvent("verification-solver-exhausted", {
          runId: run.taskRunId,
          occurredAt: new Date().toISOString(),
        }));
        return { summary: report.summary, failure: { code: "verification-failed", proven: true } };
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
        attempt: nextRound,
        maxAttempts: MAX_CAPTCHA_RETRY_ROUNDS,
        executionId: randomUUID(),
        retrying: true,
      };
      continue;
    }

    if (campaign.status === "awaiting-outcome") {
      if (assessed.status === "completed" || assessed.status === "partial") {
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
