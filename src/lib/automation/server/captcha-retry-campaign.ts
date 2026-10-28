/**
 * Pure state machine for one solver-backed CAPTCHA retry campaign.
 *
 * A campaign counts fresh, successfully captured challenges. OCR strategies
 * run inside a challenge round and are deliberately not represented here.
 * The host uses the state returned by `transitionCaptchaRetryCampaign` to
 * decide whether it may launch another workflow execution.
 */

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

export class CaptchaRetryCampaignTransitionError extends Error {
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

/** True when the host may launch a new workflow execution for this campaign. */
export function isCaptchaRetryCampaignReady(
  campaign: CaptchaRetryCampaign,
): campaign is CaptchaRetryCampaignReady {
  return campaign.status === "ready";
}

/**
 * Apply one ordered event without mutating the input. Invalid, duplicate,
 * stale, and out-of-order events throw a typed transition error.
 */
export function transitionCaptchaRetryCampaign(
  campaign: CaptchaRetryCampaign,
  event: CaptchaRetryCampaignEvent,
): CaptchaRetryCampaign {
  if (terminalCampaign(campaign)) {
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
