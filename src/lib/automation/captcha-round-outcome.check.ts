import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPTCHA_ROUND_OUTCOME_MAX_FRAME_BYTES,
  CAPTCHA_ROUND_OUTCOME_SCHEMA_VERSION,
  captchaRoundOutcomeAuthFrame,
  captchaRoundOutcomeFrame,
  createCaptchaRoundOutcomeMessage,
  createCaptchaRoundOutcomeReceiver,
  parseCaptchaRoundOutcomeAuthFrame,
  parseCaptchaRoundOutcomeFrame,
  type CaptchaRoundOutcomeMessage,
} from "./captcha-round-outcome.ts";

const executionId = "captcha-execution-01";
const stageId = "yuanta-login-captcha";

function capturedMessage(sequence = 1): CaptchaRoundOutcomeMessage {
  return createCaptchaRoundOutcomeMessage(executionId, sequence, {
    kind: "captured",
    stageId,
    challengeKind: "text-captcha",
  });
}

function solverExhaustedMessage(sequence = 2): CaptchaRoundOutcomeMessage {
  return createCaptchaRoundOutcomeMessage(executionId, sequence, {
    kind: "retryable",
    stageId,
    reason: "solver-exhausted",
  });
}

test("CAPTCHA round outcome frames are versioned and parse as a closed union", () => {
  const message = capturedMessage();
  const frame = captchaRoundOutcomeFrame(message);

  assert.deepEqual(parseCaptchaRoundOutcomeFrame(frame), message);
  assert.equal(message.schemaVersion, CAPTCHA_ROUND_OUTCOME_SCHEMA_VERSION);
  assert.equal(frame.endsWith("\n"), true);
  assert.equal(frame.includes("image"), false);
  assert.equal(frame.includes("answer"), false);
  assert.equal(frame.includes("credential"), false);
});

test("CAPTCHA outcome parsing rejects stale schema and unknown sensitive fields", () => {
  const message = capturedMessage();
  const parsed = JSON.parse(captchaRoundOutcomeFrame(message)) as Record<string, unknown>;

  assert.equal(
    parseCaptchaRoundOutcomeFrame(
      JSON.stringify({ ...parsed, schemaVersion: 99 }),
    ),
    null,
  );
  assert.equal(
    parseCaptchaRoundOutcomeFrame(
      JSON.stringify({ ...parsed, answer: "123456" }),
    ),
    null,
  );
  assert.equal(
    parseCaptchaRoundOutcomeFrame(
      JSON.stringify({
        ...parsed,
        outcome: { ...(parsed.outcome as object), image: "base64" },
      }),
    ),
    null,
  );
  assert.equal(
    parseCaptchaRoundOutcomeFrame(
      JSON.stringify({
        ...parsed,
        outcome: { kind: "retryable", stageId, reason: "not-a-reason" },
      }),
    ),
    null,
  );
});

test("CAPTCHA outcome frames have a bounded size", () => {
  assert.equal(
    parseCaptchaRoundOutcomeFrame(
      `${"x".repeat(CAPTCHA_ROUND_OUTCOME_MAX_FRAME_BYTES)}\n`,
    ),
    null,
  );
});

test("CAPTCHA outcome authentication frames are versioned and separate from outcomes", () => {
  const token = "a".repeat(32);
  const frame = captchaRoundOutcomeAuthFrame({ executionId, token });

  assert.deepEqual(parseCaptchaRoundOutcomeAuthFrame(frame), {
    schemaVersion: CAPTCHA_ROUND_OUTCOME_SCHEMA_VERSION,
    type: "authenticate",
    executionId,
    token,
  });
  assert.equal(parseCaptchaRoundOutcomeAuthFrame(JSON.stringify({
    schemaVersion: CAPTCHA_ROUND_OUTCOME_SCHEMA_VERSION,
    type: "authenticate",
    executionId,
    token,
    answer: "123456",
  })), null);
});

test("CAPTCHA outcome receiver accepts one capture and one retryable outcome", () => {
  const receiver = createCaptchaRoundOutcomeReceiver(executionId);

  assert.deepEqual(receiver.accept(capturedMessage()), { accepted: true });
  assert.deepEqual(receiver.accept(solverExhaustedMessage()), { accepted: true });
  assert.deepEqual(receiver.state(), {
    executionId,
    lastSequence: 2,
    challengeCaptured: true,
    terminal: true,
    capturedStageId: stageId,
  });
});

test("CAPTCHA outcome receiver rejects duplicate, stale, out-of-order, and terminal-before-capture messages", () => {
  const receiver = createCaptchaRoundOutcomeReceiver(executionId);

  assert.deepEqual(receiver.accept(solverExhaustedMessage(1)), {
    accepted: false,
    reason: "terminal-outcome-before-capture",
  });
  assert.deepEqual(receiver.accept(capturedMessage(2)), {
    accepted: false,
    reason: "out-of-order-sequence",
  });
  assert.deepEqual(receiver.accept(capturedMessage()), { accepted: true });
  assert.deepEqual(receiver.accept(capturedMessage(1)), {
    accepted: false,
    reason: "duplicate-sequence",
  });
  assert.deepEqual(receiver.accept(solverExhaustedMessage(2)), { accepted: true });
  assert.deepEqual(receiver.accept(solverExhaustedMessage(1)), {
    accepted: false,
    reason: "stale-sequence",
  });
  assert.deepEqual(receiver.accept(solverExhaustedMessage(3)), {
    accepted: false,
    reason: "terminal-outcome-already-reported",
  });
});

test("CAPTCHA outcome receiver rejects wrong execution and malformed messages without advancing", () => {
  const receiver = createCaptchaRoundOutcomeReceiver(executionId);
  const wrongExecution = {
    ...capturedMessage(),
    executionId: "other-execution",
  };

  assert.deepEqual(receiver.accept(wrongExecution), {
    accepted: false,
    reason: "wrong-execution",
  });
  assert.deepEqual(receiver.accept({}), {
    accepted: false,
    reason: "malformed-message",
  });
  assert.deepEqual(receiver.state(), {
    executionId,
    lastSequence: 0,
    challengeCaptured: false,
    terminal: false,
  });
});

test("CAPTCHA outcome receiver requires matching captured stage and allows non-retryable failure before capture", () => {
  const failed = createCaptchaRoundOutcomeReceiver(executionId);
  assert.deepEqual(
    failed.accept(createCaptchaRoundOutcomeMessage(executionId, 1, {
      kind: "failed",
      stageId,
      reason: "capture-failed",
    })),
    { accepted: true },
  );

  const mismatched = createCaptchaRoundOutcomeReceiver(executionId);
  assert.deepEqual(mismatched.accept(capturedMessage()), { accepted: true });
  assert.deepEqual(
    mismatched.accept(createCaptchaRoundOutcomeMessage(executionId, 2, {
      kind: "succeeded",
      stageId: "other-stage",
    })),
    { accepted: false, reason: "stage-mismatch" },
  );
});
