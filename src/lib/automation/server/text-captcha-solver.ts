import { createWorker, OEM, PSM } from "tesseract.js";
import type { VerificationSolver, VerificationSolverResult } from "./verification-solver.ts";

export type TextRecognitionEngine = {
  recognize(image: Buffer): Promise<{ text: string; confidence: number }>;
};

export function normalizeCaptchaText(text: string): string {
  return text.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function textCaptchaSolver(engine: TextRecognitionEngine): VerificationSolver {
  return {
    async solve({ image, challengeKind }): Promise<VerificationSolverResult> {
      if (challengeKind !== "text-captcha") {
        throw new Error(
          `OCR solver does not support challenge kind ${challengeKind}.`,
        );
      }
      const recognition = await engine.recognize(image);
      const answer = normalizeCaptchaText(recognition.text);
      if (!answer) return { answer: "", confidence: 0 };
      return { answer, confidence: clampConfidence(recognition.confidence) };
    },
  };
}

let workerPromise: ReturnType<typeof createWorker> | null = null;

function tesseractWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = createWorker("eng", OEM.LSTM_ONLY, {
    logger: () => {},
  })
    .then(async (worker) => {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
      return worker;
    })
    .catch((error) => {
      workerPromise = null;
      throw error;
    });
  return workerPromise;
}

export const tesseractTextRecognitionEngine: TextRecognitionEngine = {
  async recognize(image) {
    const worker = await tesseractWorker();
    const result = await worker.recognize(image);
    return {
      text: result.data.text ?? "",
      confidence: (result.data.confidence ?? 0) / 100,
    };
  },
};
