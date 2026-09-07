import {
  tesseractTextRecognitionEngine,
  textCaptchaSolver,
  type TextRecognitionEngine,
} from "./text-captcha-solver.ts";
import {
  imageSelectionSolver,
  type VisionSelectionEngine,
} from "./image-selection-solver.ts";
import {
  audioCaptchaSolver,
  type SpeechRecognitionEngine,
} from "./audio-captcha-solver.ts";
import { createSherpaOnnxSpeechRecognitionEngine } from "./speech-recognition.ts";
import type {
  VerificationSolver,
  VerificationSolverResult,
} from "./verification-solver.ts";

export const stubVisionSelectionEngine: VisionSelectionEngine = {
  async select() {
    return { selections: [], confidence: 0 };
  },
};

export function localVerificationSolver(deps: {
  textEngine?: TextRecognitionEngine;
  visionEngine?: VisionSelectionEngine;
  audioEngine?: SpeechRecognitionEngine;
} = {}): VerificationSolver {
  const ocrSolver = textCaptchaSolver(
    deps.textEngine ?? tesseractTextRecognitionEngine,
  );
  const visionSolver = imageSelectionSolver(
    deps.visionEngine ?? stubVisionSelectionEngine,
  );
  const audioSolver = audioCaptchaSolver(
    deps.audioEngine ?? createSherpaOnnxSpeechRecognitionEngine(),
  );
  return {
    async solve(input): Promise<VerificationSolverResult> {
      if (input.challengeKind === "text-captcha") return ocrSolver.solve(input);
      if (input.challengeKind === "image-selection") {
        return visionSolver.solve(input);
      }
      if (input.challengeKind === "audio-captcha") return audioSolver.solve(input);
      throw new Error(
        `Local verification solver does not support challenge kind ${input.challengeKind}.`,
      );
    },
  };
}
