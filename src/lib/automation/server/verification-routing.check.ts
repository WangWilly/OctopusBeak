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
  selectVerificationChallengeImage,
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
    charset: "digits",
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "provider.login.captcha-image",
      rect: { x: 0, y: 0, width: 200, height: 80 },
    },
  });
}

function imageSelectionContract(): HumanAssistanceContract {
  return contract({
    challengeKind: "image-selection",
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "provider.login.captcha-image",
      rect: { x: 0, y: 0, width: 300, height: 300 },
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
  const injectedSelections: Array<readonly { x: number; y: number }[]> = [];
  const resumed: string[] = [];
  const clicked: string[] = [];
  const failed: string[] = [];
  const dependencies: VerificationRoutingDependencies = {
    solver: overrides.solver ?? confidentSolver("1234", 0.95),
    captureChallengeImage: overrides.captureChallengeImage ?? (async () => {
      calls.push("capture");
      return Buffer.from("challenge-image");
    }),
    injectAnswer: overrides.injectAnswer ?? (async (_session, _contract, answer) => {
      calls.push("inject");
      injected.push(answer);
    }),
    probePostSubmit: overrides.probePostSubmit,
    injectSelections: overrides.injectSelections ?? (async (_session, _contract, selections) => {
      calls.push("inject-selections");
      injectedSelections.push(selections);
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
  return { calls, injected, injectedSelections, resumed, clicked, failed, dependencies };
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
  assert.deepEqual(tracked.injected, ["1234"]);
  assert.deepEqual(tracked.resumed, ["ses-solver"]);
});

test("a failed answer injection fails closed without a CAPTCHA retry", async () => {
  const tracked = trackDependencies({
    injectAnswer: async () => {
      throw new Error("SinoPac CAPTCHA input did not retain the solver answer.");
    },
  });
  const outcome = await routeVerificationActor({
    actor: "solver",
    contract: textCaptchaContract(),
    session: "ses-injection-failed",
    confidenceThreshold: 0.9,
    dependencies: tracked.dependencies,
  });
  assert.deepEqual(outcome, { kind: "failed" });
  assert.deepEqual(tracked.calls, ["capture", "finalize"]);
  assert.deepEqual(tracked.resumed, []);
  assert.deepEqual(
    tracked.failed,
    ["Verification solver failed to solve the challenge."],
  );
});

test("a generic answer injection failure finalizes without a CAPTCHA retry", async () => {
  const tracked = trackDependencies({
    injectAnswer: async () => {
      throw new Error("CDP transport closed while injecting the answer");
    },
  });
  const outcome = await routeVerificationActor({
    actor: "solver",
    contract: textCaptchaContract(),
    session: "ses-injection-transport-failed",
    confidenceThreshold: 0.9,
    dependencies: tracked.dependencies,
  });
  assert.deepEqual(outcome, { kind: "failed" });
  assert.deepEqual(tracked.calls, ["capture", "finalize"]);
  assert.deepEqual(tracked.resumed, []);
  assert.deepEqual(tracked.failed, ["Verification solver failed to solve the challenge."]);
});

test("a provider-proven CAPTCHA rejection reaches the retry campaign outcome", async () => {
  const probeCalls: string[] = [];
  const tracked = trackDependencies({
    probePostSubmit: async (_session, _contract, resume) => {
      probeCalls.push("probe");
      await resume();
      return "provider-rejected";
    },
  });
  const outcome = await routeVerificationActor({
    actor: "solver",
    contract: textCaptchaContract(),
    session: "ses-provider-rejected",
    confidenceThreshold: 0.9,
    dependencies: tracked.dependencies,
  });
  assert.deepEqual(outcome, { kind: "retryable", reason: "provider-rejected" });
  assert.deepEqual(tracked.calls, ["capture", "inject", "resume"]);
  assert.deepEqual(probeCalls, ["probe"]);
  assert.deepEqual(tracked.failed, []);
});

test("an unrecognized provider dialog fails closed without a CAPTCHA retry", async () => {
  const probeCalls: string[] = [];
  const tracked = trackDependencies({
    probePostSubmit: async (_session, _contract, resume) => {
      probeCalls.push("probe");
      await resume();
      return "unrecognized-dialog";
    },
  });
  const outcome = await routeVerificationActor({
    actor: "solver",
    contract: textCaptchaContract(),
    session: "ses-unrecognized-dialog",
    confidenceThreshold: 0.9,
    dependencies: tracked.dependencies,
  });
  assert.deepEqual(outcome, { kind: "failed" });
  assert.deepEqual(tracked.calls, ["capture", "inject", "resume", "finalize"]);
  assert.deepEqual(probeCalls, ["probe"]);
  assert.deepEqual(tracked.failed, ["Provider login dialog was not recognized."]);
});

test("a direct solver route uses contract metadata before compatibility arguments", async () => {
  const solverInputs: Array<{
    prompt?: string;
    charset?: string;
    imagePreprocessing?: readonly string[];
    ocrPageSegmentationMode?: string;
    attempt?: number;
    strategy?: unknown;
    expectedAnswerLength?: number;
  }> = [];
  const tracked = trackDependencies({
    solver: {
      async solve(input) {
        solverInputs.push({
          prompt: input.prompt,
          charset: input.charset,
          imagePreprocessing: input.imagePreprocessing,
          ocrPageSegmentationMode: input.ocrPageSegmentationMode,
          attempt: input.attempt,
          strategy: input.strategy,
          expectedAnswerLength: input.expectedAnswerLength,
        });
        return { answer: "2038", confidence: 0.85 };
      },
    },
  });
  const outcome = await routeVerificationActor({
    actor: "solver",
    contract: {
      ...textCaptchaContract(),
      prompt: "Enter the digits shown.",
      imagePreprocessing: ["remove-interference-lines"],
      ocrPageSegmentationMode: "single-word",
      ocrAttemptPlan: [
        { ocrPageSegmentationMode: "single-word" },
        {
          imagePreprocessing: [],
          ocrOutputStage: "grayscale",
          ocrPageSegmentationMode: "single-line",
        },
      ],
      solveAcceptancePolicy: {
        mode: "confidence-or-agreement",
        conflictResolution: "reject",
      },
      solverConfidenceThreshold: 0.9,
      expectedAnswerLength: 4,
    },
    session: "ses-contract-metadata",
    confidenceThreshold: 0.99,
    dependencies: tracked.dependencies,
  });
  assert.deepEqual(outcome, { kind: "resumed" });
  assert.deepEqual(solverInputs, [{
    prompt: "Enter the digits shown.",
    charset: "digits",
    imagePreprocessing: ["remove-interference-lines"],
    ocrPageSegmentationMode: "single-word",
    attempt: 1,
    strategy: { ocrPageSegmentationMode: "single-word" },
    expectedAnswerLength: 4,
  }, {
    prompt: "Enter the digits shown.",
    charset: "digits",
    imagePreprocessing: ["remove-interference-lines"],
    ocrPageSegmentationMode: "single-word",
    attempt: 2,
    strategy: {
      imagePreprocessing: [],
      ocrOutputStage: "grayscale",
      ocrPageSegmentationMode: "single-line",
    },
    expectedAnswerLength: 4,
  }]);
  assert.deepEqual(tracked.calls, ["capture", "inject", "resume"]);
});

test("a direct solver route inherits omitted contract metadata from compatibility arguments", async () => {
  const solverInputs: Array<{
    charset?: string;
    expectedAnswerLength?: number;
  }> = [];
  const tracked = trackDependencies({
    solver: {
      async solve(input) {
        solverInputs.push({
          charset: input.charset,
          expectedAnswerLength: input.expectedAnswerLength,
        });
        return { answer: "2038", confidence: 0.95 };
      },
    },
  });
  const outcome = await routeVerificationActor({
    actor: "solver",
    contract: {
      ...textCaptchaContract(),
      charset: undefined,
      expectedAnswerLength: undefined,
    },
    session: "ses-contract-fallback-metadata",
    confidenceThreshold: 0.9,
    charset: "digits",
    expectedAnswerLength: 4,
    dependencies: tracked.dependencies,
  });
  assert.deepEqual(outcome, { kind: "resumed" });
  assert.deepEqual(solverInputs, [{ charset: "digits", expectedAnswerLength: 4 }]);
  assert.deepEqual(tracked.calls, ["capture", "inject", "resume"]);
});

test("unregistered challenge images use the generic screenshot seam", async () => {
  const calls: string[] = [];
  const selection = selectVerificationChallengeImage(textCaptchaContract(), {
    provider: {
      handlesChallengeImage: () => false,
      captureChallengeImage: async () => {
        calls.push("provider");
        return Buffer.from("provider");
      },
      isChallengeImageCurrent: async () => true,
    },
    genericCaptureChallengeImage: async () => {
      calls.push("generic");
      return Buffer.from("generic");
    },
  });
  assert.deepEqual(
    await selection.captureChallengeImage("session", textCaptchaContract()),
    Buffer.from("generic"),
  );
  assert.deepEqual(calls, ["generic"]);
  assert.equal(selection.validateChallengeImage, undefined);
});

test("registered capture failures do not fall back to the generic screenshot", async () => {
  const calls: string[] = [];
  const provider = {
    handlesChallengeImage: () => true,
    captureChallengeImage: async () => {
      calls.push("provider");
      return null;
    },
    isChallengeImageCurrent: async () => true,
  };
  const selection = selectVerificationChallengeImage(textCaptchaContract(), {
    provider,
    genericCaptureChallengeImage: async () => {
      calls.push("generic");
      return Buffer.from("generic");
    },
  });
  assert.deepEqual(
    await selection.captureChallengeImage("session", textCaptchaContract()),
    null,
  );
  assert.deepEqual(calls, ["provider"]);
  assert.equal(
    await selection.validateChallengeImage!("session", textCaptchaContract()),
    true,
  );
});

test("waiting-run routing keeps the selected image owner through execution", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "verification-routing-image-owner-"));
  try {
    const run = createWaitingRun(ledgerDir, { contract: textCaptchaContract() });
    const calls: string[] = [];
    const tracked = trackDependencies();
    const db = openLedgerDatabase(ledgerDir);
    const outcome = await routeWaitingRunVerification({
      taskId: run.taskId,
      taskRunId: run.taskRunId,
      db,
      scheduleResume: (session) => tracked.dependencies.resume(session),
      solver: tracked.dependencies.solver,
      genericCaptureChallengeImage: async () => {
        calls.push("generic");
        return Buffer.from("generic-image");
      },
      providerVerification: {
        handlesChallengeImage: () => false,
        captureChallengeImage: async () => {
          calls.push("provider");
          return Buffer.from("provider-image");
        },
        isChallengeImageCurrent: async () => true,
      },
      injectAnswer: tracked.dependencies.injectAnswer,
      clickTarget: tracked.dependencies.clickTarget,
      finalizeFailed: tracked.dependencies.finalizeFailed,
      settings: { LIBRETTO_CLOUD_FUBON_VERIFICATION_ACTOR: "solver" },
    });
    db.close();
    assert.deepEqual(outcome, { kind: "resumed" });
    assert.deepEqual(calls, ["generic"]);
    assert.deepEqual(tracked.calls, ["inject", "resume"]);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("waiting-run routing injects a solver answer through the provider owner", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "verification-routing-provider-input-"));
  try {
    const verificationContract = {
      ...textCaptchaContract(),
      targets: [{
        ...textCaptchaContract().targets[0]!,
        semanticId: "sinopac.login.captcha-input",
      }],
      challengeImageRegion: {
        ...textCaptchaContract().challengeImageRegion!,
        semanticId: "sinopac.login.captcha-image",
      },
    };
    const run = createWaitingRun(ledgerDir, {
      taskId: "sinopac-statements",
      contract: verificationContract,
    });
    const injected: Array<{ session: string; answer: string }> = [];
    const resumed: string[] = [];
    const db = openLedgerDatabase(ledgerDir);
    const outcome = await routeWaitingRunVerification({
      taskId: run.taskId,
      taskRunId: run.taskRunId,
      db,
      scheduleResume: (session) => {
        resumed.push(session);
      },
      solver: confidentSolver("120987", 0.99),
      providerVerification: {
        handlesChallengeImage: () => true,
        captureChallengeImage: async () => Buffer.from("sinopac-captcha"),
        isChallengeImageCurrent: async () => true,
      },
      providerInjectAnswer: async (session, _contract, answer) => {
        injected.push({ session, answer });
      },
      finalizeFailed: () => {},
      settings: { LIBRETTO_CLOUD_SINOPAC_VERIFICATION_ACTOR: "solver" },
    });
    db.close();
    assert.deepEqual(outcome, { kind: "resumed" });
    assert.deepEqual(injected, [{ session: "ses-solver", answer: "120987" }]);
    assert.deepEqual(resumed, ["ses-solver"]);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("waiting-run routing does not invoke generic capture after a provider owner claims the image", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "verification-routing-image-failure-"));
  try {
    const run = createWaitingRun(ledgerDir, { contract: textCaptchaContract() });
    const calls: string[] = [];
    const tracked = trackDependencies();
    const db = openLedgerDatabase(ledgerDir);
    const outcome = await routeWaitingRunVerification({
      taskId: run.taskId,
      taskRunId: run.taskRunId,
      db,
      scheduleResume: (session) => tracked.dependencies.resume(session),
      solver: tracked.dependencies.solver,
      genericCaptureChallengeImage: async () => {
        calls.push("generic");
        return Buffer.from("generic-image");
      },
      providerVerification: {
        handlesChallengeImage: () => true,
        captureChallengeImage: async () => {
          calls.push("provider");
          return null;
        },
        isChallengeImageCurrent: async () => true,
      },
      injectAnswer: tracked.dependencies.injectAnswer,
      clickTarget: tracked.dependencies.clickTarget,
      finalizeFailed: tracked.dependencies.finalizeFailed,
      settings: { LIBRETTO_CLOUD_FUBON_VERIFICATION_ACTOR: "solver" },
    });
    db.close();
    assert.deepEqual(outcome, { kind: "failed" });
    assert.deepEqual(calls, ["provider"]);
    assert.deepEqual(tracked.calls, ["finalize"]);
    assert.deepEqual(tracked.resumed, []);
    assert.deepEqual(tracked.injected, []);
    assert.deepEqual(
      tracked.failed,
      ["Verification challenge image capture failed."],
    );
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("a solver actor injects a selection answer as click coordinates and resumes", async () => {
  const tracked = trackDependencies({
    solver: {
      async solve() {
        return { selections: [{ x: 10, y: 20 }], confidence: 0.95 };
      },
    },
  });
  const outcome = await routeVerificationActor({
    actor: "solver",
    contract: imageSelectionContract(),
    session: "ses-solver",
    confidenceThreshold: 0.9,
    dependencies: tracked.dependencies,
  });
  assert.deepEqual(outcome, { kind: "resumed" });
  assert.deepEqual(tracked.calls, ["capture", "inject-selections", "resume"]);
  assert.deepEqual(tracked.injectedSelections, [[{ x: 10, y: 20 }]]);
});

test("an exhausted solve returns a retryable outcome without finalizing the run", async () => {
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
  assert.deepEqual(outcome, { kind: "retryable", reason: "solver-exhausted" });
  assert.deepEqual(tracked.calls, ["capture", "capture", "capture"]);
  assert.deepEqual(tracked.injected, []);
  assert.deepEqual(tracked.failed, []);
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
    injectSelections: async () => {},
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
  const secretAnswer = "120987";
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
  input: {
    taskId?: string;
    contract?: HumanAssistanceContract;
    logTail?: string;
  } = {},
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
    logTail: input.logTail ?? "automation-session: ses-solver\nWorkflow paused.",
  });
  if (input.contract) updateHumanAssistanceContract(db, run.taskRunId, input.contract);
  db.close();
  return { taskRunId: run.taskRunId, taskId };
}

test("waiting-run routing uses the current execution session over an earlier log entry", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "verification-routing-current-session-"));
  try {
    const run = createWaitingRun(ledgerDir, {
      contract: textCaptchaContract(),
      logTail:
        "automation-session: ses-round-one\n" +
        "captcha-retry: restarting workflow\n" +
        "automation-session: ses-round-two\nWorkflow paused.",
    });
    const capturedSessions: string[] = [];
    const tracked = trackDependencies({
      captureChallengeImage: async (session) => {
        capturedSessions.push(session);
        return Buffer.from("challenge-image");
      },
    });
    const db = openLedgerDatabase(ledgerDir);
    const outcome = await routeWaitingRunVerification({
      taskId: run.taskId,
      taskRunId: run.taskRunId,
      session: "ses-round-two",
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
    assert.deepEqual(capturedSessions, ["ses-round-two"]);
    assert.deepEqual(tracked.resumed, ["ses-round-two"]);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("an unset Yuanta source routes as human and leaves the run untouched", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "verification-routing-human-"));
  try {
    const run = createWaitingRun(ledgerDir, {
      taskId: "yuanta-all-statements",
      contract: textCaptchaContract(),
    });
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

test("an unset HNCB source routes as human and leaves the run untouched", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "verification-routing-hncb-human-"));
  try {
    const run = createWaitingRun(ledgerDir, {
      taskId: "hncb-statements",
      contract: textCaptchaContract(),
    });
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

test("an HNCB digit CAPTCHA routes through the local solver without preprocessing", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "verification-routing-hncb-solver-"));
  try {
    const run = createWaitingRun(ledgerDir, {
      taskId: "hncb-statements",
      contract: {
        ...textCaptchaContract(),
        stageId: "hncb-login-captcha",
        ocrPageSegmentationMode: "single-word",
        solverConfidenceThreshold: 0.8,
        targets: [{
          ...textCaptchaContract().targets[0]!,
          semanticId: "hncb.login.captcha-input",
        }],
        challengeImageRegion: {
          ...textCaptchaContract().challengeImageRegion!,
          semanticId: "hncb.login.captcha-image",
        },
      },
    });
    const solverInputs: Array<{
      challengeKind: string;
      charset?: string;
      imagePreprocessing?: readonly string[];
      ocrPageSegmentationMode?: string;
    }> = [];
    const tracked = trackDependencies({
      solver: {
        async solve(input) {
          solverInputs.push({
            challengeKind: input.challengeKind,
            charset: input.charset,
            imagePreprocessing: input.imagePreprocessing,
            ocrPageSegmentationMode: input.ocrPageSegmentationMode,
          });
          return { answer: "1234", confidence: 0.85 };
        },
      },
    });
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
      settings: { LIBRETTO_CLOUD_HNCB_VERIFICATION_ACTOR: "solver" },
    });
    db.close();
    assert.deepEqual(outcome, { kind: "resumed" });
    assert.deepEqual(solverInputs, [{
      challengeKind: "text-captcha",
      charset: "digits",
      imagePreprocessing: undefined,
      ocrPageSegmentationMode: "single-word",
    }]);
    assert.deepEqual(tracked.calls, ["capture", "inject", "resume"]);
    assert.deepEqual(tracked.injected, ["1234"]);
    assert.deepEqual(tracked.resumed, ["ses-solver"]);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("an unset Post source routes as human and leaves the run untouched", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "verification-routing-post-human-"));
  try {
    const run = createWaitingRun(ledgerDir, {
      taskId: "post-statements",
      contract: {
        ...textCaptchaContract(),
        stageId: "ipost-login-captcha",
        imagePreprocessing: ["remove-interference-lines"],
        ocrPageSegmentationMode: "single-word",
        expectedAnswerLength: 4,
      },
    });
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

test("a Post digit CAPTCHA routes through the local solver seam and resumes", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "verification-routing-post-solver-"));
  try {
    const run = createWaitingRun(ledgerDir, {
      taskId: "post-statements",
      contract: {
        ...textCaptchaContract(),
        stageId: "ipost-login-captcha",
        imagePreprocessing: ["remove-interference-lines"],
        ocrPageSegmentationMode: "single-word",
        expectedAnswerLength: 4,
      },
    });
    const solverInputs: Array<{
      challengeKind: string;
      charset?: string;
      imagePreprocessing?: readonly string[];
      ocrPageSegmentationMode?: string;
      expectedAnswerLength?: number;
    }> = [];
    const tracked = trackDependencies({
      solver: {
        async solve(input) {
          solverInputs.push({
            challengeKind: input.challengeKind,
            charset: input.charset,
            imagePreprocessing: input.imagePreprocessing,
            ocrPageSegmentationMode: input.ocrPageSegmentationMode,
            expectedAnswerLength: input.expectedAnswerLength,
          });
          return { answer: "5241", confidence: 0.97 };
        },
      },
    });
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
      settings: { LIBRETTO_CLOUD_POST_VERIFICATION_ACTOR: "solver" },
    });
    db.close();
    assert.deepEqual(outcome, { kind: "resumed" });
    assert.deepEqual(solverInputs, [{
      challengeKind: "text-captcha",
      charset: "digits",
      imagePreprocessing: ["remove-interference-lines"],
    ocrPageSegmentationMode: "single-word",
    expectedAnswerLength: 4,
  }]);
    assert.deepEqual(tracked.calls, ["capture", "inject", "resume"]);
    assert.deepEqual(tracked.injected, ["5241"]);
    assert.deepEqual(tracked.resumed, ["ses-solver"]);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("an unset E-Invoice source routes as human and leaves the run untouched", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "verification-routing-einvoice-human-"));
  try {
    const run = createWaitingRun(ledgerDir, {
      taskId: "einvoice-personal-invoices",
      contract: {
        ...textCaptchaContract(),
        stageId: "einvoice-login-captcha",
        imagePreprocessing: ["remove-interference-lines"],
        ocrPageSegmentationMode: "single-line",
        expectedAnswerLength: 5,
      },
    });
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

test("an E-Invoice digit CAPTCHA routes through the local solver seam and resumes", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "verification-routing-einvoice-solver-"));
  try {
    const run = createWaitingRun(ledgerDir, {
      taskId: "einvoice-personal-invoices",
      contract: {
        ...textCaptchaContract(),
        stageId: "einvoice-login-captcha",
        imagePreprocessing: ["remove-interference-lines"],
        ocrPageSegmentationMode: "single-line",
        expectedAnswerLength: 5,
      },
    });
    const solverInputs: Array<{
      challengeKind: string;
      charset?: string;
      imagePreprocessing?: readonly string[];
      ocrPageSegmentationMode?: string;
      expectedAnswerLength?: number;
    }> = [];
    const tracked = trackDependencies({
      solver: {
        async solve(input) {
          solverInputs.push({
            challengeKind: input.challengeKind,
            charset: input.charset,
            imagePreprocessing: input.imagePreprocessing,
            ocrPageSegmentationMode: input.ocrPageSegmentationMode,
            expectedAnswerLength: input.expectedAnswerLength,
          });
          return { answer: "32770", confidence: 0.964 };
        },
      },
    });
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
      settings: { LIBRETTO_CLOUD_EINVOICE_VERIFICATION_ACTOR: "solver" },
    });
    db.close();
    assert.deepEqual(outcome, { kind: "resumed" });
    assert.deepEqual(solverInputs, [{
      challengeKind: "text-captcha",
      charset: "digits",
      imagePreprocessing: ["remove-interference-lines"],
      ocrPageSegmentationMode: "single-line",
      expectedAnswerLength: 5,
    }]);
    assert.deepEqual(tracked.calls, ["capture", "inject", "resume"]);
    assert.deepEqual(tracked.injected, ["32770"]);
    assert.deepEqual(tracked.resumed, ["ses-solver"]);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("a Yuanta source routes its digit CAPTCHA through the local solver seam and resumes", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "verification-routing-yuanta-"));
  try {
    const run = createWaitingRun(ledgerDir, {
      taskId: "yuanta-all-statements",
      contract: {
        ...textCaptchaContract(),
        imagePreprocessing: ["remove-interference-lines"],
      },
    });
    const solverInputs: Array<{
      challengeKind: string;
      charset?: string;
      imagePreprocessing?: readonly string[];
      ocrPageSegmentationMode?: string;
    }> = [];
    const tracked = trackDependencies({
      solver: {
        async solve(input) {
          solverInputs.push({
            challengeKind: input.challengeKind,
            charset: input.charset,
            imagePreprocessing: input.imagePreprocessing,
            ocrPageSegmentationMode: input.ocrPageSegmentationMode,
          });
          return { answer: "1234", confidence: 0.95 };
        },
      },
    });
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
      settings: { LIBRETTO_CLOUD_YUANTA_VERIFICATION_ACTOR: "solver" },
    });
    db.close();
    assert.deepEqual(outcome, { kind: "resumed" });
    assert.deepEqual(solverInputs, [{
      challengeKind: "text-captcha",
      charset: "digits",
      imagePreprocessing: ["remove-interference-lines"],
      ocrPageSegmentationMode: undefined,
    }]);
    assert.deepEqual(tracked.calls, ["capture", "inject", "resume"]);
    assert.deepEqual(tracked.injected, ["1234"]);
    assert.deepEqual(tracked.resumed, ["ses-solver"]);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});
