import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SOLVE_ATTEMPTS,
  solveVerificationChallenge,
  verificationPlanForContract,
  type VerificationSolver,
} from "./verification-solver.ts";
import type { HumanAssistanceContract } from "../human-assistance.ts";

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

const image = Buffer.from("challenge-image-bytes");

test("a text-captcha declaration plans a solve", () => {
  const plan = verificationPlanForContract(contract({
    challengeKind: "text-captcha",
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "provider.login.captcha-image",
      rect: { x: 0, y: 0, width: 200, height: 80 },
    },
  }));
  assert.deepEqual(plan, { kind: "solve", challengeKind: "text-captcha" });
});

test("an image-selection declaration plans a solve", () => {
  const plan = verificationPlanForContract(contract({
    challengeKind: "image-selection",
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "provider.login.captcha-image",
      rect: { x: 0, y: 0, width: 200, height: 80 },
    },
  }));
  assert.deepEqual(plan, { kind: "solve", challengeKind: "image-selection" });
});

test("a checkbox declaration plans a declared click without a solver", () => {
  const plan = verificationPlanForContract(contract({
    challengeKind: "checkbox",
  }));
  assert.deepEqual(plan, { kind: "click", targetId: "captcha-input" });
});

test("a solver challenge without an image region is unsolvable", () => {
  const plan = verificationPlanForContract(contract({
    challengeKind: "text-captcha",
  }));
  assert.deepEqual(plan, { kind: "unsolvable" });
});

test("a declaration without a challenge kind proceeds", () => {
  assert.deepEqual(verificationPlanForContract(contract()), { kind: "proceed" });
  assert.deepEqual(verificationPlanForContract(null), { kind: "proceed" });
});

test("a confident solve is captured once, solved, and injected", async () => {
  const captured: Buffer[] = [];
  const injected: string[] = [];
  const solver: VerificationSolver = {
    async solve({ image: received }) {
      captured.push(received);
      return { answer: "A1B2", confidence: 0.95 };
    },
  };
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    confidenceThreshold: 0.9,
    solver,
    captureChallengeImage: async () => image,
    injectAnswer: async (answer) => {
      injected.push(answer);
    },
  });
  assert.deepEqual(outcome, { status: "solved" });
  assert.deepEqual(captured, [image]);
  assert.deepEqual(injected, ["A1B2"]);
});

test("a below-threshold answer is withheld and retried", async () => {
  let captures = 0;
  const injected: string[] = [];
  const solver: VerificationSolver = {
    async solve() {
      captures += 1;
      return captures < MAX_SOLVE_ATTEMPTS
        ? { answer: "LOW", confidence: 0.4 }
        : { answer: "HIGH", confidence: 0.99 };
    },
  };
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    confidenceThreshold: 0.9,
    solver,
    captureChallengeImage: async () => image,
    injectAnswer: async (answer) => {
      injected.push(answer);
    },
  });
  assert.deepEqual(outcome, { status: "solved" });
  assert.equal(captures, MAX_SOLVE_ATTEMPTS);
  assert.deepEqual(injected, ["HIGH"]);
});

test("three withheld attempts exhaust the challenge", async () => {
  let solves = 0;
  const injected: string[] = [];
  const solver: VerificationSolver = {
    async solve() {
      solves += 1;
      return { answer: "LOW", confidence: 0.1 };
    },
  };
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    confidenceThreshold: 0.9,
    solver,
    captureChallengeImage: async () => image,
    injectAnswer: async (answer) => {
      injected.push(answer);
    },
  });
  assert.deepEqual(outcome, { status: "exhausted" });
  assert.equal(solves, MAX_SOLVE_ATTEMPTS);
  assert.deepEqual(injected, []);
});

test("an absent challenge stops solving immediately", async () => {
  let solves = 0;
  const solver: VerificationSolver = {
    async solve() {
      solves += 1;
      return { answer: "X", confidence: 1 };
    },
  };
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    confidenceThreshold: 0.9,
    solver,
    captureChallengeImage: async () => null,
    injectAnswer: async () => {},
  });
  assert.deepEqual(outcome, { status: "absent" });
  assert.equal(solves, 0);
});

test("a selection answer is injected as the matched click coordinates", async () => {
  const selections = [
    { x: 10, y: 20 },
    { x: 40, y: 50 },
  ];
  const injectedSelections: Array<readonly { x: number; y: number }[]> = [];
  const solver: VerificationSolver = {
    async solve() {
      return { selections, confidence: 0.95 };
    },
  };
  const outcome = await solveVerificationChallenge({
    challengeKind: "image-selection",
    confidenceThreshold: 0.9,
    solver,
    captureChallengeImage: async () => image,
    injectAnswer: async () => {
      throw new Error("text injection must not run for a selection answer");
    },
    injectSelections: async (received) => {
      injectedSelections.push(received);
    },
  });
  assert.deepEqual(outcome, { status: "solved" });
  assert.deepEqual(injectedSelections, [selections]);
});

test("a below-threshold selection is withheld and never injected", async () => {
  let solves = 0;
  const injectedSelections: Array<readonly { x: number; y: number }[]> = [];
  const solver: VerificationSolver = {
    async solve() {
      solves += 1;
      return { selections: [{ x: 5, y: 5 }], confidence: 0.2 };
    },
  };
  const outcome = await solveVerificationChallenge({
    challengeKind: "image-selection",
    confidenceThreshold: 0.9,
    solver,
    captureChallengeImage: async () => image,
    injectAnswer: async () => {},
    injectSelections: async (received) => {
      injectedSelections.push(received);
    },
  });
  assert.deepEqual(outcome, { status: "exhausted" });
  assert.equal(solves, MAX_SOLVE_ATTEMPTS);
  assert.deepEqual(injectedSelections, []);
});

test("an empty selection set is withheld like a failed attempt", async () => {
  let solves = 0;
  const injectedSelections: Array<readonly { x: number; y: number }[]> = [];
  const solver: VerificationSolver = {
    async solve() {
      solves += 1;
      return { selections: [], confidence: 0.95 };
    },
  };
  const outcome = await solveVerificationChallenge({
    challengeKind: "image-selection",
    confidenceThreshold: 0.9,
    solver,
    captureChallengeImage: async () => image,
    injectAnswer: async () => {},
    injectSelections: async (received) => {
      injectedSelections.push(received);
    },
  });
  assert.deepEqual(outcome, { status: "exhausted" });
  assert.equal(solves, MAX_SOLVE_ATTEMPTS);
  assert.deepEqual(injectedSelections, []);
});

test("a selection answer without an injection handler is rejected", async () => {
  const solver: VerificationSolver = {
    async solve() {
      return { selections: [{ x: 1, y: 1 }], confidence: 0.95 };
    },
  };
  await assert.rejects(
    solveVerificationChallenge({
      challengeKind: "image-selection",
      confidenceThreshold: 0.9,
      solver,
      captureChallengeImage: async () => image,
      injectAnswer: async () => {},
    }),
    /no selection injection is available/,
  );
});

test("solveVerificationChallenge forwards the character set to the solver", async () => {
  let receivedCharset: unknown;
  const solver: VerificationSolver = {
    async solve({ charset }) {
      receivedCharset = charset;
      return { answer: "123", confidence: 0.95 };
    },
  };
  await solveVerificationChallenge({
    challengeKind: "text-captcha",
    confidenceThreshold: 0.9,
    solver,
    captureChallengeImage: async () => image,
    injectAnswer: async () => {},
    charset: "digits",
  });
  assert.equal(receivedCharset, "digits");
});

test("solveVerificationChallenge forwards image preprocessing modes to the solver", async () => {
  let receivedModes: unknown;
  const solver: VerificationSolver = {
    async solve({ imagePreprocessing }) {
      receivedModes = imagePreprocessing;
      return { answer: "123", confidence: 0.95 };
    },
  };
  await solveVerificationChallenge({
    challengeKind: "text-captcha",
    confidenceThreshold: 0.9,
    solver,
    captureChallengeImage: async () => image,
    injectAnswer: async () => {},
    imagePreprocessing: ["remove-interference-lines"],
  });
  assert.deepEqual(receivedModes, ["remove-interference-lines"]);
});

test("solveVerificationChallenge forwards the provider OCR segmentation mode", async () => {
  let receivedMode: unknown;
  const solver: VerificationSolver = {
    async solve({ ocrPageSegmentationMode }) {
      receivedMode = ocrPageSegmentationMode;
      return { answer: "2038", confidence: 0.85 };
    },
  };
  await solveVerificationChallenge({
    challengeKind: "text-captcha",
    confidenceThreshold: 0.8,
    solver,
    captureChallengeImage: async () => image,
    injectAnswer: async () => {},
    ocrPageSegmentationMode: "single-word",
  });
  assert.equal(receivedMode, "single-word");
});

test("solveVerificationChallenge forwards the expected answer length", async () => {
  let receivedLength: unknown;
  const solver: VerificationSolver = {
    async solve({ expectedAnswerLength }) {
      receivedLength = expectedAnswerLength;
      return { answer: "32770", confidence: 0.964 };
    },
  };
  await solveVerificationChallenge({
    challengeKind: "text-captcha",
    confidenceThreshold: 0.9,
    solver,
    captureChallengeImage: async () => image,
    injectAnswer: async () => {},
    expectedAnswerLength: 5,
  });
  assert.equal(receivedLength, 5);
});

test("a declared OCR attempt plan captures once and gives each low-confidence attempt a distinct strategy", async () => {
  let captures = 0;
  const attempts: Array<{ attempt?: number; strategy?: unknown }> = [];
  const solver: VerificationSolver = {
    async solve({ attempt, strategy }) {
      attempts.push({ attempt, strategy });
      return { answer: "LOW", confidence: 0.1 };
    },
  };
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    confidenceThreshold: 0.9,
    solver,
    captureChallengeImage: async () => {
      captures += 1;
      return image;
    },
    injectAnswer: async () => {},
    ocrAttemptPlan: [
      { ocrPageSegmentationMode: "single-word" },
      { ocrOutputStage: "grayscale" },
      { ocrOutputStage: "final" },
    ],
  });
  assert.deepEqual(outcome, { status: "exhausted" });
  assert.equal(captures, 1);
  assert.deepEqual(attempts, [
    { attempt: 1, strategy: { ocrPageSegmentationMode: "single-word" } },
    { attempt: 2, strategy: { ocrOutputStage: "grayscale" } },
    { attempt: 3, strategy: { ocrOutputStage: "final" } },
  ]);
});

test("a planned solve executes every strategy before injecting the winner", async () => {
  const solvedAttempts: number[] = [];
  let captures = 0;
  const solver: VerificationSolver = {
    async solve({ attempt }) {
      solvedAttempts.push(attempt!);
      return { answer: "123456", confidence: attempt === 2 ? 0.99 : 0.95 };
    },
  };
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    confidenceThreshold: 0.9,
    solver,
    captureChallengeImage: async () => {
      captures += 1;
      return image;
    },
    injectAnswer: async () => {},
    ocrAttemptPlan: [
      { ocrPageSegmentationMode: "single-word" },
      { ocrOutputStage: "grayscale" },
      { ocrOutputStage: "final" },
    ],
  });
  assert.deepEqual(outcome, { status: "solved" });
  assert.equal(captures, 1);
  assert.deepEqual(solvedAttempts, [1, 2, 3]);
});

test("a planned solve ranks eligible six-digit candidates after every strategy", async () => {
  const injected: string[] = [];
  const candidates = [
    { answer: "123", confidence: 0.999 },
    { answer: "123456", confidence: 0.91 },
    { answer: "654321", confidence: 0.99 },
  ];
  let captures = 0;
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    charset: "digits",
    expectedAnswerLength: 6,
    confidenceThreshold: 0.9,
    solver: {
      async solve({ attempt }) {
        return candidates[attempt! - 1]!;
      },
    },
    captureChallengeImage: async () => {
      captures += 1;
      return image;
    },
    injectAnswer: async (answer) => {
      injected.push(answer);
    },
    ocrAttemptPlan: [
      { ocrPageSegmentationMode: "single-line" },
      { ocrPageSegmentationMode: "single-word" },
      { ocrPageSegmentationMode: "raw-line" },
    ],
  });
  assert.deepEqual(outcome, { status: "solved" });
  assert.equal(captures, 1);
  assert.deepEqual(injected, ["654321"]);
});

test("a planned solve breaks equal-confidence ties by declaration order", async () => {
  const injected: string[] = [];
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    charset: "digits",
    expectedAnswerLength: 6,
    confidenceThreshold: 0.9,
    solver: {
      async solve({ attempt }) {
        return {
          answer: attempt === 1 ? "111111" : "222222",
          confidence: 0.95,
        };
      },
    },
    captureChallengeImage: async () => image,
    injectAnswer: async (answer) => {
      injected.push(answer);
    },
    ocrAttemptPlan: [
      { ocrPageSegmentationMode: "single-line" },
      { ocrPageSegmentationMode: "single-word" },
    ],
  });
  assert.deepEqual(outcome, { status: "solved" });
  assert.deepEqual(injected, ["111111"]);
});

test("two distinct low-confidence OCR strategies can establish agreement", async () => {
  const injected: string[] = [];
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    charset: "digits",
    expectedAnswerLength: 4,
    confidenceThreshold: 0.9,
    solver: {
      async solve({ attempt }) {
        return { answer: "6417", confidence: attempt === 1 ? 0.62 : 0.7 };
      },
    },
    captureChallengeImage: async () => image,
    injectAnswer: async (answer) => {
      injected.push(answer);
    },
    ocrAttemptPlan: [
      { ocrPageSegmentationMode: "single-line" },
      { ocrPageSegmentationMode: "single-word" },
    ],
    solveAcceptancePolicy: {
      mode: "confidence-or-agreement",
      conflictResolution: "reject",
    },
  });
  assert.deepEqual(outcome, { status: "solved" });
  assert.deepEqual(injected, ["6417"]);
});

test("agreement-only accepts matching low-confidence strategies", async () => {
  const injected: string[] = [];
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    charset: "digits",
    expectedAnswerLength: 5,
    confidenceThreshold: 0.9,
    solver: {
      async solve() {
        return { answer: "69850", confidence: 0.84 };
      },
    },
    captureChallengeImage: async () => image,
    injectAnswer: async (answer) => {
      injected.push(answer);
    },
    ocrAttemptPlan: [
      { imagePreprocessing: ["mask-bottom-interference-band"] },
      { imagePreprocessing: ["suppress-horizontal-interference"] },
    ],
    solveAcceptancePolicy: { mode: "agreement-only" },
  });
  assert.deepEqual(outcome, { status: "solved" });
  assert.deepEqual(injected, ["69850"]);
});

test("agreement-only rejects a lone high-confidence answer", async () => {
  const injected: string[] = [];
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    charset: "digits",
    expectedAnswerLength: 5,
    confidenceThreshold: 0.9,
    solver: {
      async solve({ attempt }) {
        return attempt === 1
          ? { answer: "22020", confidence: 0.98 }
          : { answer: "", confidence: 0 };
      },
    },
    captureChallengeImage: async () => image,
    injectAnswer: async (answer) => {
      injected.push(answer);
    },
    ocrAttemptPlan: [
      { imagePreprocessing: ["mask-bottom-interference-band"] },
      { imagePreprocessing: ["suppress-horizontal-interference"] },
    ],
    solveAcceptancePolicy: { mode: "agreement-only" },
  });
  assert.deepEqual(outcome, { status: "exhausted" });
  assert.deepEqual(injected, []);
});

test("repeating one effective OCR strategy cannot establish agreement", async () => {
  const injected: string[] = [];
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    charset: "digits",
    expectedAnswerLength: 4,
    confidenceThreshold: 0.9,
    solver: {
      async solve() {
        return { answer: "6417", confidence: 0.7 };
      },
    },
    captureChallengeImage: async () => image,
    injectAnswer: async (answer) => {
      injected.push(answer);
    },
    ocrAttemptPlan: [
      { ocrPageSegmentationMode: "single-word" },
      { ocrPageSegmentationMode: "single-word" },
    ],
    solveAcceptancePolicy: {
      mode: "confidence-or-agreement",
      conflictResolution: "reject",
    },
  });
  assert.deepEqual(outcome, { status: "exhausted" });
  assert.deepEqual(injected, []);
});

test("reject conflict resolution withholds conflicting confidence and agreement", async () => {
  const injected: string[] = [];
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    charset: "digits",
    expectedAnswerLength: 4,
    confidenceThreshold: 0.9,
    solver: {
      async solve({ attempt }) {
        return attempt === 3
          ? { answer: "2222", confidence: 0.95 }
          : { answer: "1111", confidence: 0.7 + attempt! / 100 };
      },
    },
    captureChallengeImage: async () => image,
    injectAnswer: async (answer) => {
      injected.push(answer);
    },
    ocrAttemptPlan: [
      { ocrPageSegmentationMode: "single-line" },
      { ocrPageSegmentationMode: "single-word" },
      { ocrPageSegmentationMode: "raw-line" },
    ],
    solveAcceptancePolicy: {
      mode: "confidence-or-agreement",
      conflictResolution: "reject",
    },
  });
  assert.deepEqual(outcome, { status: "exhausted" });
  assert.deepEqual(injected, []);
});

test("prefer-agreement resolves a conflict in favor of OCR agreement", async () => {
  const injected: string[] = [];
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    charset: "digits",
    expectedAnswerLength: 4,
    confidenceThreshold: 0.9,
    solver: {
      async solve({ attempt }) {
        return attempt === 3
          ? { answer: "2222", confidence: 0.95 }
          : { answer: "1111", confidence: 0.7 + attempt! / 100 };
      },
    },
    captureChallengeImage: async () => image,
    injectAnswer: async (answer) => {
      injected.push(answer);
    },
    ocrAttemptPlan: [
      { ocrPageSegmentationMode: "single-line" },
      { ocrPageSegmentationMode: "single-word" },
      { ocrPageSegmentationMode: "raw-line" },
    ],
    solveAcceptancePolicy: {
      mode: "confidence-or-agreement",
      conflictResolution: "prefer-agreement",
    },
  });
  assert.deepEqual(outcome, { status: "solved" });
  assert.deepEqual(injected, ["1111"]);
});

test("prefer-confidence resolves a conflict in favor of Solve Confidence", async () => {
  const injected: string[] = [];
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    charset: "digits",
    expectedAnswerLength: 4,
    confidenceThreshold: 0.9,
    solver: {
      async solve({ attempt }) {
        return attempt === 3
          ? { answer: "2222", confidence: 0.95 }
          : { answer: "1111", confidence: 0.7 + attempt! / 100 };
      },
    },
    captureChallengeImage: async () => image,
    injectAnswer: async (answer) => {
      injected.push(answer);
    },
    ocrAttemptPlan: [
      { ocrPageSegmentationMode: "single-line" },
      { ocrPageSegmentationMode: "single-word" },
      { ocrPageSegmentationMode: "raw-line" },
    ],
    solveAcceptancePolicy: {
      mode: "confidence-or-agreement",
      conflictResolution: "prefer-confidence",
    },
  });
  assert.deepEqual(outcome, { status: "solved" });
  assert.deepEqual(injected, ["2222"]);
});

test("a planned solve exhausts when all candidates have the wrong length or confidence", async () => {
  let solves = 0;
  const injected: string[] = [];
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    charset: "digits",
    expectedAnswerLength: 6,
    confidenceThreshold: 0.9,
    solver: {
      async solve({ attempt }) {
        solves += 1;
        return attempt === 1
          ? { answer: "12345", confidence: 0.99 }
          : { answer: "123456", confidence: 0.89 };
      },
    },
    captureChallengeImage: async () => image,
    injectAnswer: async (answer) => {
      injected.push(answer);
    },
    ocrAttemptPlan: [
      { ocrPageSegmentationMode: "single-line" },
      { ocrPageSegmentationMode: "single-word" },
    ],
  });
  assert.deepEqual(outcome, { status: "exhausted" });
  assert.equal(solves, 2);
  assert.deepEqual(injected, []);
});

test("a stale provider capture is withheld after ranking and never injected", async () => {
  let validations = 0;
  const injected: string[] = [];
  const outcome = await solveVerificationChallenge({
    challengeKind: "text-captcha",
    charset: "digits",
    expectedAnswerLength: 6,
    confidenceThreshold: 0.9,
    solver: {
      async solve() {
        return { answer: "123456", confidence: 0.99 };
      },
    },
    captureChallengeImage: async () => image,
    validateChallengeImage: async () => {
      validations += 1;
      return false;
    },
    injectAnswer: async (answer) => {
      injected.push(answer);
    },
    ocrAttemptPlan: [
      { ocrPageSegmentationMode: "single-line" },
    ],
  });
  assert.deepEqual(outcome, { status: "exhausted" });
  assert.equal(validations, 1);
  assert.deepEqual(injected, []);
});
