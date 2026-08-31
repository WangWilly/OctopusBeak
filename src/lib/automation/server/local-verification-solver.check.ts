import assert from "node:assert/strict";
import test from "node:test";
import { localVerificationSolver } from "./local-verification-solver.ts";
import type { TextRecognitionEngine } from "./text-captcha-solver.ts";
import type { VisionSelectionEngine } from "./image-selection-solver.ts";

const image = Buffer.from("challenge-image");

const textEngine: TextRecognitionEngine = {
  async recognize() {
    return { text: "A1B2", confidence: 0.8 };
  },
};

const visionEngine: VisionSelectionEngine = {
  async select({ prompt }) {
    assert.equal(prompt, "traffic lights");
    return { selections: [{ x: 1, y: 2 }], confidence: 0.9 };
  },
};

test("the local solver routes text-captcha to the OCR engine", async () => {
  const solver = localVerificationSolver({ textEngine });
  assert.deepEqual(
    await solver.solve({ image, challengeKind: "text-captcha" }),
    { answer: "A1B2", confidence: 0.8 },
  );
});

test("the local solver routes image-selection to the vision engine", async () => {
  const solver = localVerificationSolver({ visionEngine });
  assert.deepEqual(
    await solver.solve({
      image,
      challengeKind: "image-selection",
      prompt: "traffic lights",
    }),
    { selections: [{ x: 1, y: 2 }], confidence: 0.9 },
  );
});

test("the local solver routes image-selection to the stub vision engine by default", async () => {
  const solver = localVerificationSolver();
  assert.deepEqual(
    await solver.solve({
      image,
      challengeKind: "image-selection",
      prompt: "traffic lights",
    }),
    { selections: [], confidence: 0 },
  );
});
