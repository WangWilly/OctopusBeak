import assert from "node:assert/strict";
import test from "node:test";
import {
  createCaptchaRoundOutcomeMessage,
} from "../captcha-round-outcome.ts";
import { createCaptchaRoundOutcomeReporter } from "../../../workflows/captcha-round-outcome.ts";
import { createCaptchaRoundOutcomeIpcServer } from "./task-run-execution.ts";

test("the host CAPTCHA outcome socket authenticates the child and retains typed metadata only", async () => {
  const server = createCaptchaRoundOutcomeIpcServer({
    executionId: "execution-host-check",
  });
  await server.ready;
  const reporter = createCaptchaRoundOutcomeReporter({
    endpoint: server.endpoint,
    token: server.token,
    executionId: server.executionId,
  });
  try {
    await reporter.reportChallengeCaptured({
      stageId: "yuanta-login-captcha",
      challengeKind: "text-captcha",
    });
    await reporter.reportSolverExhausted("yuanta-login-captcha");
  } finally {
    await reporter.close();
    await server.close();
  }

  const messages = server.messages();
  assert.deepEqual(messages.map((message) => message.outcome.kind), [
    "captured",
    "retryable",
  ]);
  assert.equal(messages.every((message) =>
    !JSON.stringify(message).match(/image|answer|credential|password/i)
  ), true);
  assert.deepEqual(
    createCaptchaRoundOutcomeMessage(
      server.executionId,
      1,
      messages[0]!.outcome,
    ).outcome,
    messages[0]!.outcome,
  );
});
