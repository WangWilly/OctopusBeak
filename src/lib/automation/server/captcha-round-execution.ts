import type { CaptchaRound } from "./captcha-retry-campaign.ts";
import type { ActiveAutomationTaskRun, TaskRunReport } from "./active-task-run.ts";
import {
  appVerificationSolver,
  noPostSubmitOutcome,
  routeWaitingRunVerification,
  type VerificationRoutingOutcome,
} from "./verification-routing.ts";
import {
  completeAppWorkflowHumanAssistance,
  type HumanAssistanceRoute,
} from "./app-workflow-human-assistance.ts";
import type { WorkflowExecutionRound } from "./task-run-execution.ts";
import type { TaskRunPlan } from "./task-run-plan.ts";
import type { PageForRun } from "./automation-viewer.ts";

export type CaptchaRoundExecutionDependencies = Readonly<{
  plan: Pick<TaskRunPlan, "task" | "verification" | "launchVerificationSettings">;
  run: ActiveAutomationTaskRun;
  /** Finds the page each round's Workflow execution hosts, for verification routing. */
  pageForRun: PageForRun;
  execute: (round: WorkflowExecutionRound) => Promise<TaskRunReport>;
  /** Injection point for deterministic routing checks. */
  routeWaitingRunVerification?: typeof routeWaitingRunVerification;
}>;

/**
 * The round adapter of a CAPTCHA Retry Campaign (ADR 0074). A round of a task
 * that routes verification answers the execution's assistance requests and
 * joins the route with the execution; any other round only executes.
 */
export function captchaRoundExecution(
  dependencies: CaptchaRoundExecutionDependencies,
): CaptchaRound {
  const { plan, run, pageForRun, execute } = dependencies;
  const { task, verification, launchVerificationSettings } = plan;
  const route = dependencies.routeWaitingRunVerification
    ?? routeWaitingRunVerification;

  if (!verification?.routesVerification) {
    return async ({ attempt, maxAttempts, retrying, executionId }) => ({
      report: await execute({ attempt, maxAttempts, retrying, executionId }),
    });
  }
  const { sourceRoute, workflowOwnsCaptchaOutcome } = verification;

  return async (round) => {
    const { onChallengeCaptured: recordCapture, ...executionOptions } = round;
    let challengeCaptured = false;
    const onChallengeCaptured = async () => {
      challengeCaptured = true;
      await recordCapture();
    };
    let routing: VerificationRoutingOutcome | undefined;
    let settleExecution!: (report: TaskRunReport) => void;
    const executionSettled = new Promise<TaskRunReport>((resolve) => {
      settleExecution = resolve;
    });
    // Only the latest request's route is joined; an earlier one is overwritten.
    let routePromise: Promise<void> | null = null;
    let routeSignal: AbortSignal | undefined;
    const assistanceRoute: HumanAssistanceRoute = (request) => {
      routeSignal = request.signal;
      routePromise = (async () => {
        try {
          const routeOutcome = sourceRoute
            ? await sourceRoute(request, {
                task,
                settings: launchVerificationSettings,
                route,
                onChallengeCaptured,
                pageForRun,
              })
            : await route({
              run: request.run,
              task,
              pageForRun,
              signal: request.signal,
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
            && !challengeCaptured
            && request.contract.challengeImageRegion
          ) {
            await onChallengeCaptured();
          }
          if (routing.kind === "failed") {
            throw new Error("App workflow verification route failed closed.");
          }
          if (
            routing.kind === "retryable"
            && routing.reason === "solver-exhausted"
          ) {
            // Reject the worker's pending assistance stage. The worker
            // cleans up its browser before the campaign opens a new round.
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
    const report = await execute({ ...executionOptions, assistanceRoute });
    settleExecution(report);
    // A route that ignores its abort signal keeps this join waiting.
    if (routePromise) {
      try {
        await routePromise;
      } catch {
        if (!routeSignal?.aborted && !routing) routing = { kind: "failed" };
      }
    }
    return { report, ...(routing ? { routing } : {}) };
  };
}
