import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import {
  createTaskRun,
  updateHumanAssistanceContract,
} from "./store.ts";
import {
  routeVerificationActor,
  routeWaitingRunVerification,
  type VerificationRoutingDependencies,
} from "./verification-routing.ts";
import type { HumanAssistanceContract } from "../human-assistance.ts";
import type { VerificationSolver } from "./verification-solver.ts";

function contract(overrides: Partial<HumanAssistanceContract> = {}): HumanAssistanceContract {
  return {
    schemaVersion: 1,
    version: 1,
    stageId: "provider-captcha",
    title: "Complete the CAPTCHA",
    targets: [{
      id: "captcha-input",
      label: "CAPTCHA input",
      semanticId: "provider.login.captcha-input",
      modes: ["click", "type"],
      rect: { x: 10, y: 20, width: 100, height: 24 },
    }],
    contextRegions: [],
    completion: { mode: "inline", targetIds: ["captcha-input"], status: "pending" },
    focus: { targetId: "captcha-input", contextRegionIds: [] },
    ...overrides,
  };
}

function textCaptchaContract(): HumanAssistanceContract {
  return contract({
    challengeKind: "text-captcha",
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "provider.login.captcha-image",
      rect: { x: 0, y: 0, width: 200, height: 80 },
    },
  });
}

const confidentSolver = (answer: string, confidence: number): VerificationSolver => ({
  async solve() {
    return { answer, confidence };
  },
});

function trackDependencies(overrides: Partial<VerificationRoutingDependencies> = {}) {
  const calls: string[] = [];
  const injected: string[] = [];
  const resumed: string[] = [];
  const clicked: string[] = [];
  const failed: string[] = [];
  const dependencies: VerificationRoutingDependencies = {
    solver: overrides.solver ?? confidentSolver("A1B2", 0.95),
    captureChallengeImage: overrides.captureChallengeImage ?? (async () => {
      calls.push("capture");
      return Buffer.from("challenge-image");
    }),
    injectAnswer: overrides.injectAnswer ?? (async (_session, _contract, answer) => {
      calls.push("inject");
      injected.push(answer);
    }),
    clickTarget: overrides.clickTarget ?? (async (_session, _contract, targetId) => {
      calls.push("click");
      clicked.push(targetId);
    }),
    resume: overrides.resume ?? ((session) => {
      calls.push("resume");
      resumed.push(session);
    }),
    finalizeFailed: overrides.finalizeFailed ?? ((message) => {
      calls.push("finalize");
      failed.push(message);
    }),
  };
  return { calls, injected, resumed, clicked, failed, dependencies };
}

test("a human actor keeps the existing contract and never touches the solver", async () => {
  const tracked = trackDependencies();
  const outcome = await routeVerificationActor({
    actor: "human",
    contract: textCaptchaContract(),
    session: "ses-human",
    confidenceThreshold: 0.9,
    dependencies: tracked.dependencies,
  });
  assert.deepEqual(outcome, { kind: "human" });
  assert.deepEqual(tracked.calls, []);
});

test("a solver actor solves an inline challenge and resumes", async () => {
  const tracked = trackDependencies();
  const outcome = await routeVerificationActor({
    actor: "solver",
    contract: textCaptchaContract(),
    session: "ses-solver",
    confidenceThreshold: 0.9,
    dependencies: tracked.dependencies,
  });
  assert.deepEqual(outcome, { kind: "resumed" });
  assert.deepEqual(tracked.calls, ["capture", "inject", "resume"]);
  assert.deepEqual(tracked.injected, ["A1B2"]);
  assert.deepEqual(tracked.resumed, ["ses-solver"]);
});

test("an exhausted solve finalizes the run as failed", async () => {
  const tracked = trackDependencies({
    solver: confidentSolver("LOW", 0.1),
  });
  const outcome = await routeVerificationActor({
    actor: "solver",
    contract: textCaptchaContract(),
    session: "ses-solver",
    confidenceThreshold: 0.9,
    dependencies: tracked.dependencies,
  });
  assert.deepEqual(outcome, { kind: "failed" });
  assert.deepEqual(tracked.calls, ["capture", "capture", "capture", "finalize"]);
  assert.deepEqual(tracked.injected, []);
  assert.deepEqual(tracked.failed, ["Verification solver exhausted its attempts."]);
});

test("a checkbox challenge performs a declared click with no solver call", async () => {
  const tracked = trackDependencies();
  const outcome = await routeVerificationActor({
    actor: "solver",
    contract: contract({ challengeKind: "checkbox" }),
    session: "ses-solver",
    confidenceThreshold: 0.9,
    dependencies: tracked.dependencies,
  });
  assert.deepEqual(outcome, { kind: "resumed" });
  assert.deepEqual(tracked.calls, ["click", "resume"]);
  assert.deepEqual(tracked.clicked, ["captcha-input"]);
});

test("an absent challenge proceeds without a solve or a pause", async () => {
  const calls: string[] = [];
  const injected: string[] = [];
  const dependencies: VerificationRoutingDependencies = {
    solver: confidentSolver("X", 1),
    captureChallengeImage: async () => {
      calls.push("capture");
      return null;
    },
    injectAnswer: async (_session, _contract, answer) => {
      injected.push(answer);
    },
    clickTarget: async () => {},
    resume: () => {
      calls.push("resume");
    },
    finalizeFailed: () => {},
  };
  const outcome = await routeVerificationActor({
    actor: "solver",
    contract: textCaptchaContract(),
    session: "ses-solver",
    confidenceThreshold: 0.9,
    dependencies,
  });
  assert.deepEqual(outcome, { kind: "resumed" });
  assert.deepEqual(calls, ["capture", "resume"]);
  assert.deepEqual(injected, []);
});

test("an unsolvable declaration finalizes the run as failed", async () => {
  const tracked = trackDependencies();
  const outcome = await routeVerificationActor({
    actor: "solver",
    contract: contract({ challengeKind: "text-captcha" }),
    session: "ses-solver",
    confidenceThreshold: 0.9,
    dependencies: tracked.dependencies,
  });
  assert.deepEqual(outcome, { kind: "failed" });
  assert.deepEqual(tracked.failed, ["Verification challenge cannot be solved."]);
  assert.deepEqual(tracked.calls, ["finalize"]);
});

test("a failed solver invocation finalizes the run as failed", async () => {
  const tracked = trackDependencies({
    solver: {
      async solve() {
        throw new Error("model unavailable");
      },
    },
  });
  const outcome = await routeVerificationActor({
    actor: "solver",
    contract: textCaptchaContract(),
    session: "ses-solver",
    confidenceThreshold: 0.9,
    dependencies: tracked.dependencies,
  });
  assert.deepEqual(outcome, { kind: "failed" });
  assert.deepEqual(tracked.failed, ["Verification solver failed to solve the challenge."]);
});

test("the solver answer never leaks into resume, failure, or click output", async () => {
  const secretAnswer = "SOLVER-SECRET-ANSWER-7f3a";
  const tracked = trackDependencies({ solver: confidentSolver(secretAnswer, 0.99) });
  const outcome = await routeVerificationActor({
    actor: "solver",
    contract: textCaptchaContract(),
    session: "ses-solver",
    confidenceThreshold: 0.9,
    dependencies: tracked.dependencies,
  });
  assert.deepEqual(outcome, { kind: "resumed" });
  assert.deepEqual(tracked.injected, [secretAnswer]);
  assert.equal(tracked.resumed.some((value) => value.includes(secretAnswer)), false);
  assert.equal(tracked.failed.some((value) => value.includes(secretAnswer)), false);
  assert.equal(tracked.clicked.some((value) => value.includes(secretAnswer)), false);
});

function createWaitingRun(
  ledgerDir: string,
  input: { taskId?: string; contract?: HumanAssistanceContract } = {},
) {
  const taskId = input.taskId ?? "fubon-all-statements";
  const db = openLedgerDatabase(ledgerDir);
  const run = createTaskRun(db, {
    taskId,
    script: "run:fubon-all-statements",
    kind: "crawler",
    status: "waiting_for_human",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-08-08T08:00:00.000Z",
    logPath: join(ledgerDir, "run.log"),
    logTail: "automation-session: ses-solver\nWorkflow paused.",
  });
  if (input.contract) updateHumanAssistanceContract(db, run.taskRunId, input.contract);
  db.close();
  return { taskRunId: run.taskRunId, taskId };
}

test("an unset source routes as human and leaves the run untouched", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "verification-routing-human-"));
  try {
    const run = createWaitingRun(ledgerDir, { contract: textCaptchaContract() });
    const tracked = trackDependencies();
    const db = openLedgerDatabase(ledgerDir);
    const outcome = await routeWaitingRunVerification({
      taskId: run.taskId,
      taskRunId: run.taskRunId,
      db,
      scheduleResume: (session) => tracked.dependencies.resume(session),
      solver: tracked.dependencies.solver,
      captureChallengeImage: tracked.dependencies.captureChallengeImage,
      injectAnswer: tracked.dependencies.injectAnswer,
      clickTarget: tracked.dependencies.clickTarget,
      finalizeFailed: tracked.dependencies.finalizeFailed,
      settings: {},
    });
    db.close();
    assert.deepEqual(outcome, { kind: "human" });
    assert.deepEqual(tracked.calls, []);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("a solver source routes through the solver seam with configured threshold", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "verification-routing-solver-"));
  try {
    const run = createWaitingRun(ledgerDir, { contract: textCaptchaContract() });
    const tracked = trackDependencies();
    const db = openLedgerDatabase(ledgerDir);
    const outcome = await routeWaitingRunVerification({
      taskId: run.taskId,
      taskRunId: run.taskRunId,
      db,
      scheduleResume: (session) => tracked.dependencies.resume(session),
      solver: tracked.dependencies.solver,
      captureChallengeImage: tracked.dependencies.captureChallengeImage,
      injectAnswer: tracked.dependencies.injectAnswer,
      clickTarget: tracked.dependencies.clickTarget,
      finalizeFailed: tracked.dependencies.finalizeFailed,
      settings: { LIBRETTO_CLOUD_FUBON_VERIFICATION_ACTOR: "solver" },
    });
    db.close();
    assert.deepEqual(outcome, { kind: "resumed" });
    assert.deepEqual(tracked.calls, ["capture", "inject", "resume"]);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});
