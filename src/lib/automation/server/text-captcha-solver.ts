import { createWorker, OEM, PSM, type Page } from "tesseract.js";
import type { ChallengeCharacterSet } from "../human-assistance.ts";
import type { VerificationSolver, VerificationSolverResult } from "./verification-solver.ts";
import { preprocessCaptchaImage } from "./captcha-preprocess.ts";
import { openCaptchaDebugSession } from "./captcha-debug.ts";

export type TextRecognitionEngine = {
  recognize(
    image: Buffer,
    charset?: ChallengeCharacterSet,
  ): Promise<{ text: string; confidence: number }>;
};

const TESSERACT_CHARACTER_WHITELISTS: Record<ChallengeCharacterSet, string> = {
  digits: "0123456789",
  alphanumeric:
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
};

export function tesseractWhitelist(charset: ChallengeCharacterSet): string {
  return TESSERACT_CHARACTER_WHITELISTS[charset];
}

export function meanSymbolConfidence(page: Page): number | null {
  const confidences: number[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          for (const symbol of word.symbols ?? []) {
            if (Number.isFinite(symbol.confidence) && symbol.confidence >= 0) {
              confidences.push(symbol.confidence);
            }
          }
        }
      }
    }
  }
  if (confidences.length === 0) return null;
  return confidences.reduce((sum, confidence) => sum + confidence, 0) /
    confidences.length;
}

export function normalizeCaptchaText(text: string): string {
  return text.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function textCaptchaSolver(engine: TextRecognitionEngine): VerificationSolver {
  return {
    async solve({ image, challengeKind, charset }): Promise<VerificationSolverResult> {
      if (challengeKind !== "text-captcha") {
        throw new Error(
          `OCR solver does not support challenge kind ${challengeKind}.`,
        );
      }
      const recognition = await engine.recognize(image, charset);
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
  async recognize(image, charset) {
    const worker = await tesseractWorker();
    await worker.setParameters({
      tessedit_char_whitelist: tesseractWhitelist(charset ?? "alphanumeric"),
    });
    const debug = openCaptchaDebugSession();
    debug?.writeImage("raw", image);
    const processed = preprocessCaptchaImage(
      image,
      debug ? (step, buffer) => debug.writeImage(step, buffer) : undefined,
    );
    const result = await worker.recognize(processed, {}, {
      text: true,
      blocks: true,
    });
    const text = result.data.text ?? "";
    const confidence =
      (meanSymbolConfidence(result.data) ?? result.data.confidence ?? 0) / 100;
    debug?.writeResult(text, confidence);
    return { text, confidence };
  },
};
