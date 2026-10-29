/**
 * The CAPTCHA Retry Campaign of one Active run (ADR 0074).
 *
 * Every run goes through `runCaptchaRetryCampaign`. It numbers each round,
 * admits the next one, waits out a source's cooldown, and decides with
 * `decideAfterRound` whether the run stops or retries. A round adapter runs the
 * Workflow execution and its verification routing.
 *
 * The state machine below counts fresh, successfully captured challenges.
 * OCR strategies run inside a challenge round and are deliberately not
 * represented here.
 */

import { randomUUID } from "node:crypto";
import { signalRunEvent } from "../run-event.ts";
import type {
  ActiveAutomationTaskRun,
  TaskRunOutcome,
  TaskRunReport,
} from "./active-task-run.ts";
import {
  captchaRetryCooldownMs,
  type VerificationRoutingOutcome,
} from "./verification-routing.ts";

export const MAX_CAPTCHA_RETRY_ROUNDS = 3 as const;

export type CaptchaRetryReason =
  | "solver-exhausted"
  | "provider-rejected";

/** Reasons that can end a campaign without opening another round. */
export type CaptchaFailureReason =
  | "load-failed"
  | "locator-failed"
  | "capture-failed"
  | "invalid-challenge"
  | "solver-failed"
  | "workflow-failed"
  | "credentials-failed"
  | "account-restricted"
  | "provider-rejection-unproven"
  | "ambiguous-post-submit"
  | "transport-failed"
  | "unknown";

export type CaptchaCaptureFailureReason =
  | "load-failed"
  | "locator-failed"
  | "capture-failed";

/**
 * One typed result from host-side verification routing for a workflow
 * execution. The execution identity belongs to the enclosing event so stale
 * or duplicate routing results cannot advance the campaign.
 */
export type CaptchaRoundOutcome =
  | { kind: "succeeded" }
  | { kind: "retryable"; reason: CaptchaRetryReason }
  | { kind: "failed"; reason: CaptchaFailureReason }
  | { kind: "cancelled" };

export type CaptchaRetryCampaignEvent =
  | {
      kind: "challenge-captured";
      executionId: string;
      /** A false value records that capture succeeded but the contract was invalid. */
      structurallyValid?: boolean;
    }
  | {
      kind: "challenge-absent";
      executionId: string;
    }
  | {
      kind: "challenge-capture-failed";
      executionId: string;
      reason: CaptchaCaptureFailureReason;
    }
  | {
      kind: "round-outcome";
      executionId: string;
      outcome: CaptchaRoundOutcome;
    }
  | {
      /** Cancellation can happen before an execution reports a capture. */
      kind: "cancelled";
      executionId?: string;
    };

type CampaignCommon = {
  readonly consumedRounds: number;
  readonly maxRounds: typeof MAX_CAPTCHA_RETRY_ROUNDS;
};

export type CaptchaRetryCampaignReady = CampaignCommon & {
  readonly status: "ready";
  /** Present after a retry; absent for a newly created campaign. */
  readonly nextRound?: number;
  readonly lastExecutionId?: string;
  readonly usedExecutionIds?: readonly string[];
};

export type CaptchaRetryCampaignAwaitingOutcome = CampaignCommon & {
  readonly status: "awaiting-outcome";
  readonly activeRound: number;
  readonly activeExecutionId: string;
  readonly challengeStructurallyValid: boolean;
  readonly usedExecutionIds: readonly string[];
};

export type CaptchaRetryCampaignCompleted = CampaignCommon & {
  readonly status: "completed";
  readonly completionReason: "succeeded" | "challenge-absent";
  readonly lastExecutionId?: string;
};

export type CaptchaRetryCampaignFailed = CampaignCommon & {
  readonly status: "failed";
  readonly failureReason: CaptchaFailureReason;
  readonly lastExecutionId?: string;
};

export type CaptchaRetryCampaignCancelled = CampaignCommon & {
  readonly status: "cancelled";
  readonly lastExecutionId?: string;
};

export type CaptchaRetryCampaignExhausted = CampaignCommon & {
  readonly status: "exhausted";
  readonly lastExecutionId: string;
  readonly lastRetryReason: CaptchaRetryReason;
};

export type CaptchaRetryCampaign =
  | CaptchaRetryCampaignReady
  | CaptchaRetryCampaignAwaitingOutcome
  | CaptchaRetryCampaignCompleted
  | CaptchaRetryCampaignFailed
  | CaptchaRetryCampaignCancelled
  | CaptchaRetryCampaignExhausted;

export type CaptchaRetryCampaignTransitionErrorCode =
  | "invalid-transition"
  | "stale-event"
  | "duplicate-event";

class CaptchaRetryCampaignTransitionError extends Error {
  readonly code: CaptchaRetryCampaignTransitionErrorCode;

  constructor(
    message: string,
    code: CaptchaRetryCampaignTransitionErrorCode = "invalid-transition",
  ) {
    super(message);
    this.name = "CaptchaRetryCampaignTransitionError";
    this.code = code;
  }
}

function usedExecutionIds(campaign: CaptchaRetryCampaign): readonly string[] {
  return "usedExecutionIds" in campaign && campaign.usedExecutionIds
    ? campaign.usedExecutionIds
    : [];
}

function assertUniqueExecutionId(
  executionId: string,
  campaign: CaptchaRetryCampaign,
) {
  if (usedExecutionIds(campaign).includes(executionId)) {
    throw new CaptchaRetryCampaignTransitionError(
      `Execution ${executionId} was already used by this campaign.`,
      "duplicate-event",
    );
  }
}

function assertCurrentExecution(
  executionId: string,
  campaign: CaptchaRetryCampaignAwaitingOutcome,
) {
  if (executionId !== campaign.activeExecutionId) {
    throw new CaptchaRetryCampaignTransitionError(
      `Stale CAPTCHA event for execution ${executionId}; expected ${campaign.activeExecutionId}.`,
      "stale-event",
    );
  }
}

function terminalCampaign(
  campaign: CaptchaRetryCampaign,
): campaign is
  | CaptchaRetryCampaignCompleted
  | CaptchaRetryCampaignFailed
  | CaptchaRetryCampaignCancelled
  | CaptchaRetryCampaignExhausted {
  return campaign.status === "completed"
    || campaign.status === "failed"
    || campaign.status === "cancelled"
    || campaign.status === "exhausted";
}

/** Construct a new campaign with the non-configurable three-round bound. */
export function createCaptchaRetryCampaign(): CaptchaRetryCampaignReady {
  return {
    status: "ready",
    consumedRounds: 0,
    maxRounds: MAX_CAPTCHA_RETRY_ROUNDS,
  };
}

/**
 * Apply one ordered event without mutating the input. Invalid, duplicate,
 * stale, and out-of-order events throw a typed transition error. Cancelling
 * an ended campaign, and a refreshed challenge within the active execution
 * (ADR 0046), leave it unchanged.
 */
export function transitionCaptchaRetryCampaign(
  campaign: CaptchaRetryCampaign,
  event: CaptchaRetryCampaignEvent,
): CaptchaRetryCampaign {
  if (terminalCampaign(campaign)) {
    if (event.kind === "cancelled") return campaign;
    throw new CaptchaRetryCampaignTransitionError(
      `Cannot transition terminal CAPTCHA campaign (${campaign.status}).`,
      "invalid-transition",
    );
  }

  if (event.kind === "cancelled") {
    if (campaign.status === "awaiting-outcome" && event.executionId !== undefined) {
      assertCurrentExecution(event.executionId, campaign);
    }
    if (
      campaign.status === "ready"
      && event.executionId !== undefined
      && usedExecutionIds(campaign).includes(event.executionId)
    ) {
      throw new CaptchaRetryCampaignTransitionError(
        `Stale cancellation for execution ${event.executionId}.`,
        "stale-event",
      );
    }
    return {
      status: "cancelled",
      consumedRounds: campaign.consumedRounds,
      maxRounds: MAX_CAPTCHA_RETRY_ROUNDS,
      ...(campaign.status === "awaiting-outcome"
        ? { lastExecutionId: campaign.activeExecutionId }
        : campaign.lastExecutionId
          ? { lastExecutionId: campaign.lastExecutionId }
          : {}),
    };
  }

  if (campaign.status === "awaiting-outcome") {
    if (event.kind === "challenge-captured" && event.executionId === campaign.activeExecutionId) return campaign;
    if (event.kind !== "round-outcome") {
      throw new CaptchaRetryCampaignTransitionError(
        "A captured challenge must receive exactly one round outcome before another capture event.",
        "invalid-transition",
      );
    }
    assertCurrentExecution(event.executionId, campaign);
    if (
      !campaign.challengeStructurallyValid
      && (event.outcome.kind === "succeeded"
        || (event.outcome.kind === "retryable" && event.outcome.reason === "provider-rejected"))
    ) {
      throw new CaptchaRetryCampaignTransitionError(
        "An invalid captured challenge cannot be submitted or succeed.",
        "invalid-transition",
      );
    }
    if (event.outcome.kind === "retryable") {
      if (campaign.consumedRounds >= MAX_CAPTCHA_RETRY_ROUNDS) {
        return {
          status: "exhausted",
          consumedRounds: MAX_CAPTCHA_RETRY_ROUNDS,
          maxRounds: MAX_CAPTCHA_RETRY_ROUNDS,
          lastExecutionId: campaign.activeExecutionId,
          lastRetryReason: event.outcome.reason,
        };
      }
      return {
        status: "ready",
        consumedRounds: campaign.consumedRounds,
        maxRounds: MAX_CAPTCHA_RETRY_ROUNDS,
        nextRound: campaign.consumedRounds + 1,
        lastExecutionId: campaign.activeExecutionId,
        usedExecutionIds: [...campaign.usedExecutionIds],
      };
    }
    if (event.outcome.kind === "succeeded") {
      return {
        status: "completed",
        consumedRounds: campaign.consumedRounds,
        maxRounds: MAX_CAPTCHA_RETRY_ROUNDS,
        completionReason: "succeeded",
        lastExecutionId: campaign.activeExecutionId,
      };
    }
    if (event.outcome.kind === "failed") {
      return {
        status: "failed",
        consumedRounds: campaign.consumedRounds,
        maxRounds: MAX_CAPTCHA_RETRY_ROUNDS,
        failureReason: event.outcome.reason,
        lastExecutionId: campaign.activeExecutionId,
      };
    }
    return {
      status: "cancelled",
      consumedRounds: campaign.consumedRounds,
      maxRounds: MAX_CAPTCHA_RETRY_ROUNDS,
      lastExecutionId: campaign.activeExecutionId,
    };
  }

  if (event.kind === "round-outcome") {
    throw new CaptchaRetryCampaignTransitionError(
      "A round outcome arrived before a challenge was captured.",
      "stale-event",
    );
  }

  if (campaign.status !== "ready") {
    throw new CaptchaRetryCampaignTransitionError(
      "CAPTCHA campaign is not accepting a new challenge execution.",
      "invalid-transition",
    );
  }

  if (event.kind === "challenge-captured") {
    assertUniqueExecutionId(event.executionId, campaign);
    const structurallyValid = event.structurallyValid ?? true;
    return {
      status: "awaiting-outcome",
      consumedRounds: campaign.consumedRounds + 1,
      maxRounds: MAX_CAPTCHA_RETRY_ROUNDS,
      activeRound: campaign.consumedRounds + 1,
      activeExecutionId: event.executionId,
      challengeStructurallyValid: structurallyValid,
      usedExecutionIds: [...usedExecutionIds(campaign), event.executionId],
    };
  }

  assertUniqueExecutionId(event.executionId, campaign);
  if (event.kind === "challenge-absent") {
    return {
      status: "completed",
      consumedRounds: campaign.consumedRounds,
      maxRounds: MAX_CAPTCHA_RETRY_ROUNDS,
      completionReason: "challenge-absent",
      lastExecutionId: event.executionId,
    };
  }
  return {
    status: "failed",
    consumedRounds: campaign.consumedRounds,
    maxRounds: MAX_CAPTCHA_RETRY_ROUNDS,
    failureReason: event.reason,
    lastExecutionId: event.executionId,
  };
}

function cancelCampaign(campaign: CaptchaRetryCampaign) {
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

/** Resolves false as soon as the run is stopped during the wait. */
function waitForCaptchaRetryCooldown(
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

/** What the campaign tells the round adapter about one round. */
export type CaptchaRoundRequest = Readonly<{
  attempt: number;
  maxAttempts: number;
  /** This execution is another round of the same visible run. */
  retrying: boolean;
  executionId: string;
  /**
   * The round captured its challenge. Advances the campaign and records the
   * round on the run before the round ends, so progress shows it at once.
   */
  onChallengeCaptured: () => Promise<void>;
}>;

export type CaptchaRoundResult = Readonly<{
  report: TaskRunReport;
  /** Absent when the round routed no verification. */
  routing?: VerificationRoutingOutcome;
}>;

/** Runs one Workflow execution and joins its verification routing. */
export type CaptchaRound = (request: CaptchaRoundRequest) => Promise<CaptchaRoundResult>;

/** The part of the Active run the campaign drives. */
export type CaptchaRetryCampaignRun = Pick<
  ActiveAutomationTaskRun,
  "taskRunId" | "signal" | "assess" | "update" | "transition" | "appendEvent"
>;

export type CaptchaRetryCampaignDependencies = Readonly<{
  taskId: string;
  run: CaptchaRetryCampaignRun;
  executeRound: CaptchaRound;
  /** Injection point so checks do not wait out real cooldowns. */
  captchaRetryCooldownMs?: typeof captchaRetryCooldownMs;
}>;

export type CaptchaRoundDecision =
  | Readonly<{
      kind: "stop";
      /** The report the run finishes with. */
      report: TaskRunReport;
      campaign: CaptchaRetryCampaign;
      /** The campaign spent its last round; the run records that signal. */
      exhausted: boolean;
    }>
  | Readonly<{ kind: "retry"; nextRound: number; campaign: CaptchaRetryCampaignReady }>;

/**
 * Decide what one finished round means for the run. Earlier checks win: an
 * uncertain financial commit, a Canonical Reset, a failed route, a stop, a
 * retryable route, and last the round's own report.
 */
export function decideAfterRound(input: Readonly<{
  campaign: CaptchaRetryCampaign;
  report: TaskRunReport;
  assessed: Pick<TaskRunOutcome, "status" | "errorCode">;
  routing?: VerificationRoutingOutcome;
  /** The run was stopped. */
  aborted: boolean;
}>): CaptchaRoundDecision {
  const { campaign, report, assessed, routing, aborted } = input;
  const stop = (
    ending: TaskRunReport,
    next: CaptchaRetryCampaign = campaign,
    exhausted = false,
  ): CaptchaRoundDecision => ({ kind: "stop", report: ending, campaign: next, exhausted });

  // Cancellation or CAPTCHA routing must not replace an uncertain financial
  // commit with a cancelled outcome or admit another execution of the run.
  if (assessed.errorCode === "commit-outcome-unknown") return stop(report);
  // Another round would sign in again only to be refused until the person
  // runs a Canonical Reset (ADR 0062).
  if (assessed.errorCode === "canonical-reset-required") return stop(report);
  if (routing?.kind === "failed") return stop(failed(report));
  if (aborted || assessed.status === "cancelled") return stop(report, cancelCampaign(campaign));

  if (routing?.kind === "retryable") {
    if (campaign.status !== "awaiting-outcome") return stop(failed(report));
    const next = transitionCaptchaRetryCampaign(campaign, {
      kind: "round-outcome",
      executionId: campaign.activeExecutionId,
      outcome: { kind: "retryable", reason: routing.reason },
    });
    if (next.status === "exhausted") {
      return stop({ summary: report.summary, failure: { code: "verification-failed", proven: true } }, next, true);
    }
    if (next.status !== "ready" || next.nextRound === undefined) return stop(failed(report), next);
    return { kind: "retry", nextRound: next.nextRound, campaign: next };
  }

  if (
    campaign.status === "awaiting-outcome"
    && (assessed.status === "completed" || assessed.status === "partial")
  ) {
    return stop(report, transitionCaptchaRetryCampaign(campaign, {
      kind: "round-outcome",
      executionId: campaign.activeExecutionId,
      outcome: { kind: "succeeded" },
    }));
  }
  return stop(report);
}

/**
 * Run rounds until `decideAfterRound` stops, and return the report the run
 * finishes with. A run that routes no verification runs one round.
 */
export async function runCaptchaRetryCampaign(
  dependencies: CaptchaRetryCampaignDependencies,
): Promise<TaskRunReport> {
  const { taskId, run, executeRound } = dependencies;
  let campaign: CaptchaRetryCampaign = createCaptchaRetryCampaign();
  // Round one keeps the run's single attempt until it captures a challenge.
  let round = 1;
  let maxAttempts = 1;
  while (true) {
    const executionId = randomUUID();
    const { report, routing } = await executeRound({
      attempt: round,
      maxAttempts,
      retrying: round > 1,
      executionId,
      onChallengeCaptured: async () => {
        campaign = transitionCaptchaRetryCampaign(campaign, { kind: "challenge-captured", executionId });
        if (campaign.status === "awaiting-outcome") {
          await run.update({ attempt: campaign.activeRound, maxAttempts: campaign.maxRounds });
        }
      },
    });

    const decision = decideAfterRound({
      campaign,
      report,
      assessed: run.assess(report),
      routing,
      aborted: run.signal.aborted,
    });
    campaign = decision.campaign;
    if (decision.kind === "stop") {
      if (decision.exhausted) {
        // Written between executions, so it belongs to none; the report
        // names the failure itself and nothing classifies this signal.
        await run.appendEvent(signalRunEvent("verification-solver-exhausted", {
          runId: run.taskRunId,
          occurredAt: new Date().toISOString(),
        }));
      }
      return decision.report;
    }

    const admitted = await run.transition("running", {
      attempt: decision.nextRound,
      maxAttempts: MAX_CAPTCHA_RETRY_ROUNDS,
    });
    if (!admitted) return run.signal.aborted ? report : failed(report);
    const cooldownMs = (dependencies.captchaRetryCooldownMs ?? captchaRetryCooldownMs)(taskId);
    const cooledDown = cooldownMs === undefined
      ? !run.signal.aborted
      : await waitForCaptchaRetryCooldown(cooldownMs, run.signal);
    if (!cooledDown) {
      campaign = cancelCampaign(campaign);
      return report;
    }
    round = decision.nextRound;
    maxAttempts = MAX_CAPTCHA_RETRY_ROUNDS;
  }
}
