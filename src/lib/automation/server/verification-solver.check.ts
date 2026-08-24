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
