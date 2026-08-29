import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CAPTCHA_ROUND_OUTCOME_SCHEMA_VERSION,
  parseCaptchaRoundOutcomeAuthFrame,
  parseCaptchaRoundOutcomeFrame,
} from "../lib/automation/captcha-round-outcome.ts";
import {
  CaptchaRoundOutcomeIpcProtocolError,
  CaptchaRoundOutcomeIpcUnavailableError,
  createCaptchaRoundOutcomeReporter,
} from "./captcha-round-outcome.ts";

const TOKEN = "a".repeat(32);
const executionId = "execution-captcha-01";
const stageId = "yuanta-login-captcha";

function waitForClose(socket: Socket) {
  return new Promise<void>((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once("close", () => resolve());
  });
}

async function outcomeServer(endpoint: string) {
  const frames: string[] = [];
  const server = createServer((socket) => {
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      frames.push(...lines.filter(Boolean));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(endpoint);
  });
  return {
    frames,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("CAPTCHA outcome reporter fails clearly when the private IPC is unavailable", async () => {
  const reporter = createCaptchaRoundOutcomeReporter({
    endpoint: join(tmpdir(), "missing-captcha-round-outcome.sock"),
    token: TOKEN,
    executionId,
  });

  await assert.rejects(
    () => reporter.reportChallengeCaptured({
      stageId,
      challengeKind: "text-captcha",
    }),
    (error: unknown) => error instanceof CaptchaRoundOutcomeIpcUnavailableError,
  );
  await reporter.close();
});

test("CAPTCHA outcome reporter authenticates once and emits typed frames without sensitive values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cro-"));
  const endpoint = join(dir, "round-outcome.sock");
  const server = await outcomeServer(endpoint);
  const reporter = createCaptchaRoundOutcomeReporter({ endpoint, token: TOKEN, executionId });
  try {
    await reporter.reportChallengeCaptured({ stageId, challengeKind: "text-captcha" });
    await reporter.reportSolverExhausted(stageId);
    await reporter.close();
    assert.equal(server.frames.length, 3);
    assert.deepEqual(parseCaptchaRoundOutcomeAuthFrame(server.frames[0]!), {
      schemaVersion: CAPTCHA_ROUND_OUTCOME_SCHEMA_VERSION,
      type: "authenticate",
      executionId,
      token: TOKEN,
    });
    const messages = server.frames.slice(1).map((frame) =>
      parseCaptchaRoundOutcomeFrame(frame),
    );
    assert.deepEqual(messages.map((message) => message?.sequence), [1, 2]);
    assert.deepEqual(messages.map((message) => message?.outcome.kind), [
      "captured",
      "retryable",
    ]);
    for (const frame of server.frames.slice(1)) {
      assert.equal(frame.includes("image"), false);
      assert.equal(frame.includes("answer"), false);
      assert.equal(frame.includes("credential"), false);
      assert.equal(frame.includes("password"), false);
    }
  } finally {
    await reporter.close();
    await server.close();
    assert.equal(existsSync(endpoint), false);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CAPTCHA outcome reporter enforces capture-before-terminal and one terminal outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cro-"));
  const endpoint = join(dir, "round-outcome.sock");
  const server = await outcomeServer(endpoint);
  const reporter = createCaptchaRoundOutcomeReporter({ endpoint, token: TOKEN, executionId });
  try {
    await assert.rejects(
      () => reporter.reportSolverExhausted(stageId),
      (error: unknown) => error instanceof CaptchaRoundOutcomeIpcProtocolError
        && error.reason === "terminal-outcome-before-capture",
    );
    await reporter.reportChallengeCaptured({ stageId, challengeKind: "image-selection" });
    await assert.rejects(
      () => reporter.reportChallengeCaptured({ stageId, challengeKind: "image-selection" }),
      (error: unknown) => error instanceof CaptchaRoundOutcomeIpcProtocolError
        && error.reason === "capture-already-reported",
    );
    await reporter.reportSucceeded(stageId);
    await assert.rejects(
      () => reporter.reportSolverExhausted(stageId),
      (error: unknown) => error instanceof CaptchaRoundOutcomeIpcProtocolError
        && error.reason === "terminal-outcome-already-reported",
    );
  } finally {
    await reporter.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CAPTCHA provider rejection requires an explicitly registered probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cro-"));
  const endpoint = join(dir, "round-outcome.sock");
  const server = await outcomeServer(endpoint);
  const reporter = createCaptchaRoundOutcomeReporter({ endpoint, token: TOKEN, executionId });
  try {
    await reporter.reportChallengeCaptured({ stageId, challengeKind: "text-captcha" });
    await assert.rejects(
      () => reporter.reportProviderRejected(stageId, {
        providerId: "yuanta",
        probeId: "login-captcha-error",
      }),
      (error: unknown) => error instanceof CaptchaRoundOutcomeIpcProtocolError
        && error.reason === "provider-rejection-probe-not-registered",
    );
  } finally {
    await reporter.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }

  const registeredDir = mkdtempSync(join(tmpdir(), "cro-"));
  const registeredEndpoint = join(registeredDir, "round-outcome.sock");
  const registeredServer = await outcomeServer(registeredEndpoint);
  const registeredReporter = createCaptchaRoundOutcomeReporter({
    endpoint: registeredEndpoint,
    token: TOKEN,
    executionId,
    providerRejectionProbes: [{ providerId: "yuanta", probeId: "login-captcha-error" }],
  });
  try {
    await registeredReporter.reportChallengeCaptured({ stageId, challengeKind: "text-captcha" });
    await registeredReporter.reportProviderRejected(stageId, {
      providerId: "yuanta",
      probeId: "login-captcha-error",
    });
    await registeredReporter.close();
    const message = parseCaptchaRoundOutcomeFrame(registeredServer.frames[2]!);
    assert.equal(message?.outcome.kind, "retryable");
    if (message?.outcome.kind === "retryable") {
      assert.equal(message.outcome.reason, "provider-rejected");
    }
  } finally {
    await registeredReporter.close();
    await registeredServer.close();
    rmSync(registeredDir, { recursive: true, force: true });
  }
});

test("CAPTCHA outcome reporter validates authentication configuration before connecting", async () => {
  const reporter = createCaptchaRoundOutcomeReporter({
    endpoint: "",
    token: "short",
    executionId,
  });
  await assert.rejects(
    () => reporter.reportChallengeCaptured({ stageId, challengeKind: "text-captcha" }),
    (error: unknown) => error instanceof CaptchaRoundOutcomeIpcUnavailableError,
  );
  await reporter.close();
});
