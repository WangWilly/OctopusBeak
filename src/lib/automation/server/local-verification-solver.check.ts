import assert from "node:assert/strict";
import test from "node:test";
import { localVerificationSolver } from "./local-verification-solver.ts";
import type { TextRecognitionEngine } from "./text-captcha-solver.ts";
import type { VisionSelectionEngine } from "./image-selection-solver.ts";
import type { SpeechRecognitionEngine } from "./audio-captcha-solver.ts";

const image = Buffer.from("challenge-image");
const audio = Buffer.from("challenge-audio");

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

const audioEngine: SpeechRecognitionEngine = {
  async transcribe(received) {
    assert.equal(received, audio);
    return { text: "开始 播放 一 二 三 四 五 六" };
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

test("the local solver routes audio-captcha to the speech engine", async () => {
  const solver = localVerificationSolver({ audioEngine });
  assert.deepEqual(
    await solver.solve({
      audio,
      challengeKind: "audio-captcha",
      charset: "digits",
      expectedAnswerLength: 6,
    }),
    { answer: "123456", confidence: 1 },
  );
});
