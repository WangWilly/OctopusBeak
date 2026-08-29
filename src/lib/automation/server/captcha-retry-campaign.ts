/**
 * Pure state machine for one solver-backed CAPTCHA retry campaign.
 *
 * A campaign counts fresh, successfully captured challenges. OCR strategies
 * run inside a challenge round and are deliberately not represented here.
 * The host uses the state returned by `transitionCaptchaRetryCampaign` to
 * decide whether it may launch another workflow execution.
 */

export const MAX_CAPTCHA_RETRY_ROUNDS = 10 as const;
export const CAPTCHA_RETRY_CAMPAIGN_MAX_ROUNDS = MAX_CAPTCHA_RETRY_ROUNDS;

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

export type CaptchaRetryCampaignFailureReason = CaptchaFailureReason;

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

export type CaptchaRetryCampaignStatus = CaptchaRetryCampaign["status"];

export type CaptchaRetryCampaignTransitionErrorCode =
  | "invalid-state"
  | "invalid-event"
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

const RETRY_REASONS = new Set<CaptchaRetryReason>([
  "solver-exhausted",
  "provider-rejected",
]);

const FAILURE_REASONS = new Set<CaptchaFailureReason>([
  "load-failed",
  "locator-failed",
  "capture-failed",
  "invalid-challenge",
  "solver-failed",
  "workflow-failed",
  "credentials-failed",
  "account-restricted",
  "provider-rejection-unproven",
  "ambiguous-post-submit",
  "transport-failed",
  "unknown",
]);

const CAPTURE_FAILURE_REASONS = new Set<CaptchaCaptureFailureReason>([
  "load-failed",
  "locator-failed",
  "capture-failed",
]);

const CAMPAIGN_STATUSES = new Set<CaptchaRetryCampaignStatus>([
  "ready",
  "awaiting-outcome",
  "completed",
  "failed",
  "cancelled",
  "exhausted",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CaptchaRetryCampaignTransitionError(
      `${label} must be a non-empty string.`,
      "invalid-event",
    );
  }
  return value;
}

function assertIntegerInRange(
  value: unknown,
  label: string,
  min: number,
  max: number,
) {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new CaptchaRetryCampaignTransitionError(
      `${label} must be an integer between ${min} and ${max}.`,
      "invalid-state",
    );
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

function assertOutcome(outcome: unknown): asserts outcome is CaptchaRoundOutcome {
  if (!isRecord(outcome) || typeof outcome.kind !== "string") {
    throw new CaptchaRetryCampaignTransitionError(
      "CAPTCHA round outcome is malformed.",
      "invalid-event",
    );
  }
  if (outcome.kind === "succeeded") {
    if (!exactKeys(outcome, ["kind"])) {
      throw new CaptchaRetryCampaignTransitionError(
        "Succeeded CAPTCHA round outcome has unexpected fields.",
        "invalid-event",
      );
    }
    return;
  }
  if (outcome.kind === "cancelled") {
    if (!exactKeys(outcome, ["kind"])) {
      throw new CaptchaRetryCampaignTransitionError(
        "Cancelled CAPTCHA round outcome has unexpected fields.",
        "invalid-event",
      );
    }
    return;
  }
  if (outcome.kind === "retryable") {
    if (!exactKeys(outcome, ["kind", "reason"])
      || !RETRY_REASONS.has(outcome.reason as CaptchaRetryReason)) {
      throw new CaptchaRetryCampaignTransitionError(
        `Unknown CAPTCHA retry reason: ${String(outcome.reason)}.`,
        "invalid-event",
      );
    }
    return;
  }
  if (outcome.kind === "failed") {
    if (!exactKeys(outcome, ["kind", "reason"])
      || !FAILURE_REASONS.has(outcome.reason as CaptchaFailureReason)) {
      throw new CaptchaRetryCampaignTransitionError(
        `Unknown CAPTCHA failure reason: ${String(outcome.reason)}.`,
        "invalid-event",
      );
    }
    return;
  }
  throw new CaptchaRetryCampaignTransitionError(
    `Unknown CAPTCHA round outcome: ${outcome.kind}.`,
    "invalid-event",
  );
}

function assertCampaignState(value: unknown): asserts value is CaptchaRetryCampaign {
  if (!isRecord(value) || !CAMPAIGN_STATUSES.has(value.status as CaptchaRetryCampaignStatus)) {
    throw new CaptchaRetryCampaignTransitionError(
      "CAPTCHA retry campaign state is malformed.",
      "invalid-state",
    );
  }
  if (value.maxRounds !== MAX_CAPTCHA_RETRY_ROUNDS) {
    throw new CaptchaRetryCampaignTransitionError(
      `CAPTCHA retry campaign maxRounds must remain ${MAX_CAPTCHA_RETRY_ROUNDS}.`,
      "invalid-state",
    );
  }
  assertIntegerInRange(
    value.consumedRounds,
    "consumedRounds",
    0,
    MAX_CAPTCHA_RETRY_ROUNDS,
  );
  if (value.status === "ready") {
    if (value.consumedRounds === MAX_CAPTCHA_RETRY_ROUNDS) {
      throw new CaptchaRetryCampaignTransitionError(
        "A ready campaign cannot have consumed all rounds.",
        "invalid-state",
      );
    }
    if ((value.consumedRounds as number) > 0 && value.nextRound === undefined) {
      throw new CaptchaRetryCampaignTransitionError(
        "A retried campaign must declare its next round.",
        "invalid-state",
      );
    }
    if (value.lastExecutionId !== undefined) {
      nonEmptyString(value.lastExecutionId, "lastExecutionId");
    }
    if (value.usedExecutionIds !== undefined) {
      if (!Array.isArray(value.usedExecutionIds)) {
        throw new CaptchaRetryCampaignTransitionError(
          "usedExecutionIds must be an array.",
          "invalid-state",
        );
      }
      assertExecutionIdList(value.usedExecutionIds);
    }
  }
  if (value.status === "awaiting-outcome") {
    assertIntegerInRange(
      value.activeRound,
      "activeRound",
      1,
      MAX_CAPTCHA_RETRY_ROUNDS,
    );
    if (value.activeRound !== value.consumedRounds) {
      throw new CaptchaRetryCampaignTransitionError(
        "Active round must equal consumedRounds.",
        "invalid-state",
      );
    }
    nonEmptyString(value.activeExecutionId, "activeExecutionId");
    if (typeof value.challengeStructurallyValid !== "boolean") {
      throw new CaptchaRetryCampaignTransitionError(
        "challengeStructurallyValid must be boolean.",
        "invalid-state",
      );
    }
    if (!Array.isArray(value.usedExecutionIds)) {
      throw new CaptchaRetryCampaignTransitionError(
        "usedExecutionIds must be an array.",
        "invalid-state",
      );
    }
    assertExecutionIdList(value.usedExecutionIds);
    if (value.usedExecutionIds.at(-1) !== value.activeExecutionId) {
      throw new CaptchaRetryCampaignTransitionError(
        "The active execution must be the latest used execution.",
        "invalid-state",
      );
    }
  }
  if (value.status === "ready" && value.nextRound !== undefined) {
    assertIntegerInRange(
      value.nextRound,
      "nextRound",
      1,
      MAX_CAPTCHA_RETRY_ROUNDS,
    );
    if (value.nextRound !== (value.consumedRounds as number) + 1) {
      throw new CaptchaRetryCampaignTransitionError(
        "nextRound must be the first unconsumed round.",
        "invalid-state",
      );
    }
  }
  if (
    value.status === "completed" &&
    value.completionReason !== "succeeded" &&
    value.completionReason !== "challenge-absent"
  ) {
    throw new CaptchaRetryCampaignTransitionError(
      "Completed campaign has an invalid completion reason.",
      "invalid-state",
    );
  }
  if (value.status === "completed" && value.lastExecutionId !== undefined) {
    nonEmptyString(value.lastExecutionId, "lastExecutionId");
  }
  if (value.status === "failed" && !FAILURE_REASONS.has(value.failureReason as CaptchaFailureReason)) {
    throw new CaptchaRetryCampaignTransitionError(
      "Failed campaign has an invalid failure reason.",
      "invalid-state",
    );
  }
  if (value.status === "failed" && value.lastExecutionId !== undefined) {
    nonEmptyString(value.lastExecutionId, "lastExecutionId");
  }
  if (value.status === "cancelled" && value.lastExecutionId !== undefined) {
    nonEmptyString(value.lastExecutionId, "lastExecutionId");
  }
  if (value.status === "exhausted") {
    if (value.consumedRounds !== MAX_CAPTCHA_RETRY_ROUNDS) {
      throw new CaptchaRetryCampaignTransitionError(
        "An exhausted campaign must have consumed all rounds.",
        "invalid-state",
      );
    }
    nonEmptyString(value.lastExecutionId, "lastExecutionId");
    if (!RETRY_REASONS.has(value.lastRetryReason as CaptchaRetryReason)) {
      throw new CaptchaRetryCampaignTransitionError(
        "Exhausted campaign has an invalid retry reason.",
        "invalid-state",
      );
    }
  }
}

function assertExecutionIdList(value: readonly unknown[]) {
  const seen = new Set<string>();
  for (const candidate of value) {
    const executionId = nonEmptyString(candidate, "usedExecutionIds entry");
    if (seen.has(executionId)) {
      throw new CaptchaRetryCampaignTransitionError(
        `Execution ${executionId} is duplicated in campaign state.`,
        "invalid-state",
      );
    }
    seen.add(executionId);
  }
}

function assertEvent(value: unknown): asserts value is CaptchaRetryCampaignEvent {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new CaptchaRetryCampaignTransitionError(
      "CAPTCHA retry campaign event is malformed.",
      "invalid-event",
    );
  }
  if (value.kind === "cancelled") {
    if (value.executionId !== undefined) {
      nonEmptyString(value.executionId, "executionId");
    }
    return;
  }
  if (value.kind === "challenge-captured") {
    nonEmptyString(value.executionId, "executionId");
    if (value.structurallyValid !== undefined && typeof value.structurallyValid !== "boolean") {
      throw new CaptchaRetryCampaignTransitionError(
        "structurallyValid must be boolean.",
        "invalid-event",
      );
    }
    return;
  }
  if (value.kind === "challenge-absent") {
    nonEmptyString(value.executionId, "executionId");
    return;
  }
  if (value.kind === "challenge-capture-failed") {
    nonEmptyString(value.executionId, "executionId");
    if (!CAPTURE_FAILURE_REASONS.has(value.reason as CaptchaCaptureFailureReason)) {
      throw new CaptchaRetryCampaignTransitionError(
        `Unknown CAPTCHA capture failure reason: ${String(value.reason)}.`,
        "invalid-event",
      );
    }
    return;
  }
  if (value.kind === "round-outcome") {
    nonEmptyString(value.executionId, "executionId");
    assertOutcome(value.outcome);
    return;
  }
  throw new CaptchaRetryCampaignTransitionError(
    `Unknown CAPTCHA retry campaign event: ${value.kind}.`,
    "invalid-event",
  );
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

/** Construct a new campaign with the non-configurable ten-round bound. */
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

/** True when no further event is allowed for this campaign. */
export function isCaptchaRetryCampaignTerminal(
  campaign: CaptchaRetryCampaign,
): boolean {
  return terminalCampaign(campaign);
}

/**
 * Apply one ordered event without mutating the input. Invalid, duplicate,
 * stale, and out-of-order events throw a typed transition error.
 */
export function transitionCaptchaRetryCampaign(
  campaign: CaptchaRetryCampaign,
  event: CaptchaRetryCampaignEvent,
): CaptchaRetryCampaign {
  assertCampaignState(campaign);
  assertEvent(event);

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

  nonEmptyString(event.executionId, "executionId");
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

/** Alias for callers that prefer event-oriented terminology. */
export const applyCaptchaRetryCampaignEvent = transitionCaptchaRetryCampaign;
