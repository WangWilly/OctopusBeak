import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPTCHA_RETRY_CAMPAIGN_MAX_ROUNDS,
  createCaptchaRetryCampaign,
  transitionCaptchaRetryCampaign,
  type CaptchaRetryCampaign,
  type CaptchaRetryCampaignEvent,
} from "./captcha-retry-campaign.ts";

const capture = (
  executionId: string,
  overrides: Partial<Extract<CaptchaRetryCampaignEvent, { kind: "challenge-captured" }>> = {},
) => ({
  kind: "challenge-captured" as const,
  executionId,
  ...overrides,
});

const outcome = (
  executionId: string,
  roundOutcome: Extract<
    CaptchaRetryCampaignEvent,
    { kind: "round-outcome" }
  >["outcome"],
) => ({ kind: "round-outcome" as const, executionId, outcome: roundOutcome });

function capturedCampaign(executionId = "execution-1") {
  return transitionCaptchaRetryCampaign(
    createCaptchaRetryCampaign(),
    capture(executionId),
  );
}

function retryableCampaign(rounds = 1): CaptchaRetryCampaign {
  let campaign: CaptchaRetryCampaign = createCaptchaRetryCampaign();
  for (let round = 1; round <= rounds; round += 1) {
    const executionId = `execution-${round}`;
    campaign = transitionCaptchaRetryCampaign(campaign, capture(executionId));
    campaign = transitionCaptchaRetryCampaign(campaign, outcome(executionId, {
      kind: "retryable",
      reason: "solver-exhausted",
    }));
  }
  return campaign;
}

test("starts empty with the fixed ten-round limit", () => {
  assert.deepEqual(createCaptchaRetryCampaign(), {
    status: "ready",
    consumedRounds: 0,
    maxRounds: CAPTCHA_RETRY_CAMPAIGN_MAX_ROUNDS,
  });
});

test("a successful challenge capture consumes the first round", () => {
  const campaign = capturedCampaign();
  assert.equal(campaign.status, "awaiting-outcome");
  assert.equal(campaign.consumedRounds, 1);
  assert.equal(campaign.activeRound, 1);
  assert.equal(campaign.activeExecutionId, "execution-1");
});

test("challenge absence completes normally without consuming a round", () => {
  const campaign = transitionCaptchaRetryCampaign(
    createCaptchaRetryCampaign(),
    { kind: "challenge-absent", executionId: "execution-1" },
  );
  assert.deepEqual(campaign, {
    status: "completed",
    consumedRounds: 0,
    maxRounds: CAPTCHA_RETRY_CAMPAIGN_MAX_ROUNDS,
    completionReason: "challenge-absent",
    lastExecutionId: "execution-1",
  });
});

test("load, locator, and capture failures terminate without consuming a round", () => {
  for (const reason of ["load-failed", "locator-failed", "capture-failed"] as const) {
    const campaign = transitionCaptchaRetryCampaign(
      createCaptchaRetryCampaign(),
      { kind: "challenge-capture-failed", executionId: "execution-1", reason },
    );
    assert.equal(campaign.status, "failed");
    assert.equal(campaign.consumedRounds, 0);
    assert.equal(campaign.failureReason, reason);
  }
});

test("a captured structural-invalid challenge still consumes a round", () => {
  const campaign = transitionCaptchaRetryCampaign(
    createCaptchaRetryCampaign(),
    capture("execution-1", { structurallyValid: false }),
  );
  assert.equal(campaign.status, "awaiting-outcome");
  assert.equal(campaign.consumedRounds, 1);
  assert.equal(campaign.challengeStructurallyValid, false);
});

test("a structurally-invalid challenge cannot report a successful submission", () => {
  const campaign = transitionCaptchaRetryCampaign(
    createCaptchaRetryCampaign(),
    capture("execution-1", { structurallyValid: false }),
  );
  assert.throws(
    () => transitionCaptchaRetryCampaign(
      campaign,
      outcome("execution-1", { kind: "succeeded" }),
    ),
    /invalid captured challenge|invalid-transition|cannot be submitted/i,
  );
});

test("solver exhaustion requests the next fresh round", () => {
  const campaign = transitionCaptchaRetryCampaign(
    capturedCampaign(),
    outcome("execution-1", {
      kind: "retryable",
      reason: "solver-exhausted",
    }),
  );
  assert.equal(campaign.status, "ready");
  assert.equal(campaign.consumedRounds, 1);
  assert.equal(campaign.nextRound, 2);
  assert.equal(campaign.lastExecutionId, "execution-1");
});

test("a proven provider rejection requests the next fresh round", () => {
  const campaign = transitionCaptchaRetryCampaign(
    capturedCampaign(),
    outcome("execution-1", {
      kind: "retryable",
      reason: "provider-rejected",
    }),
  );
  assert.equal(campaign.status, "ready");
  assert.equal(campaign.consumedRounds, 1);
});

test("success completes the campaign and non-retryable failure ends it", () => {
  const solved = transitionCaptchaRetryCampaign(
    capturedCampaign(),
    outcome("execution-1", { kind: "succeeded" }),
  );
  assert.equal(solved.status, "completed");
  assert.equal(solved.consumedRounds, 1);

  const failed = transitionCaptchaRetryCampaign(
    capturedCampaign(),
    outcome("execution-1", { kind: "failed", reason: "workflow-failed" }),
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.consumedRounds, 1);
  assert.equal(failed.failureReason, "workflow-failed");
});

test("cancellation completes as a terminal campaign state", () => {
  const campaign = transitionCaptchaRetryCampaign(
    capturedCampaign(),
    outcome("execution-1", { kind: "cancelled" }),
  );
  assert.equal(campaign.status, "cancelled");
  assert.equal(campaign.consumedRounds, 1);
});

test("the tenth retryable round is exhausted and cannot start round eleven", () => {
  const campaign = retryableCampaign(CAPTCHA_RETRY_CAMPAIGN_MAX_ROUNDS - 1);
  const tenthExecution = `execution-${CAPTCHA_RETRY_CAMPAIGN_MAX_ROUNDS}`;
  const captured = transitionCaptchaRetryCampaign(
    campaign,
    capture(tenthExecution),
  );
  const exhausted = transitionCaptchaRetryCampaign(
    captured,
    outcome(tenthExecution, {
      kind: "retryable",
      reason: "solver-exhausted",
    }),
  );
  assert.equal(exhausted.status, "exhausted");
  assert.equal(exhausted.consumedRounds, CAPTCHA_RETRY_CAMPAIGN_MAX_ROUNDS);
  assert.throws(
    () => transitionCaptchaRetryCampaign(exhausted, capture("execution-11")),
    /terminal/i,
  );
});

test("outcomes from another execution are stale and cannot advance the campaign", () => {
  const campaign = capturedCampaign("execution-current");
  assert.throws(
    () => transitionCaptchaRetryCampaign(
      campaign,
      outcome("execution-stale", {
        kind: "retryable",
        reason: "solver-exhausted",
      }),
    ),
    /execution|stale/i,
  );
  assert.equal(campaign.consumedRounds, 1);
});

test("duplicate capture or duplicate outcome is rejected without advancing state", () => {
  const campaign = capturedCampaign("execution-1");
  assert.throws(() => transitionCaptchaRetryCampaign(campaign, capture("execution-1")), /order|capture/i);
  const ready = transitionCaptchaRetryCampaign(
    campaign,
    outcome("execution-1", { kind: "retryable", reason: "solver-exhausted" }),
  );
  assert.throws(
    () => transitionCaptchaRetryCampaign(
      ready,
      outcome("execution-1", { kind: "retryable", reason: "solver-exhausted" }),
    ),
    /order|execution|stale|outcome/i,
  );
});

test("an old execution cannot be reused for a later round", () => {
  const ready = transitionCaptchaRetryCampaign(
    capturedCampaign("execution-1"),
    outcome("execution-1", { kind: "retryable", reason: "solver-exhausted" }),
  );
  assert.throws(
    () => transitionCaptchaRetryCampaign(ready, capture("execution-1")),
    /reuse|duplicate|execution/i,
  );
});

test("malformed retry outcomes are rejected at runtime", () => {
  const campaign = capturedCampaign();
  assert.throws(
    () => transitionCaptchaRetryCampaign(campaign, {
      kind: "round-outcome",
      executionId: "execution-1",
      outcome: { kind: "retryable", reason: "unknown" },
    } as never),
    /reason|invalid|retry/i,
  );
  const completed = transitionCaptchaRetryCampaign(campaign, outcome("execution-1", {
    kind: "succeeded",
  }));
  assert.throws(
    () => transitionCaptchaRetryCampaign(completed, {
      kind: "round-outcome",
      executionId: "execution-1",
      outcome: { kind: "succeeded" },
    } as never),
    /terminal|outcome|order/i,
  );
});

test("a campaign can be cancelled before a challenge is captured", () => {
  const campaign = transitionCaptchaRetryCampaign(
    createCaptchaRetryCampaign(),
    { kind: "cancelled" },
  );
  assert.deepEqual(campaign, {
    status: "cancelled",
    consumedRounds: 0,
    maxRounds: CAPTCHA_RETRY_CAMPAIGN_MAX_ROUNDS,
  });
});
