import { createWorker, OEM, PSM, type Page } from "tesseract.js";
import type {
  CaptchaImagePreprocessingMode,
  CaptchaOcrPageSegmentationMode,
  ChallengeCharacterSet,
} from "../human-assistance.ts";
import type { VerificationSolver, VerificationSolverResult } from "./verification-solver.ts";
import { preprocessCaptchaImage } from "./captcha-preprocess.ts";
import { openCaptchaDebugSession } from "./captcha-debug.ts";

export type TextRecognitionEngine = {
  recognize(
    image: Buffer,
    charset?: ChallengeCharacterSet,
    imagePreprocessing?: readonly CaptchaImagePreprocessingMode[],
    ocrPageSegmentationMode?: CaptchaOcrPageSegmentationMode,
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

export function normalizeCaptchaText(
  text: string,
  charset: ChallengeCharacterSet = "alphanumeric",
): string {
  if (charset === "digits") return text.replace(/[^0-9]/g, "");
  return text.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function textCaptchaSolver(engine: TextRecognitionEngine): VerificationSolver {
  return {
    async solve({
      image,
      challengeKind,
      charset,
      imagePreprocessing,
      ocrPageSegmentationMode,
      expectedAnswerLength,
    }): Promise<VerificationSolverResult> {
      if (challengeKind !== "text-captcha") {
        throw new Error(
          `OCR solver does not support challenge kind ${challengeKind}.`,
        );
      }
      const recognition = await engine.recognize(
        image,
        charset,
        imagePreprocessing,
        ocrPageSegmentationMode,
      );
      const answer = normalizeCaptchaText(recognition.text, charset);
      const expectedLengthMatches = expectedAnswerLength === undefined
        || answer.length === expectedAnswerLength;
      if (expectedLengthMatches || !imagePreprocessing?.includes("remove-interference-lines")) {
        if (!answer) return { answer: "", confidence: 0 };
        return { answer, confidence: clampConfidence(recognition.confidence) };
      }

      const fallbackPreprocessing = imagePreprocessing.filter(
        (mode) => mode !== "remove-interference-lines",
      );
      const fallback = await engine.recognize(
        image,
        charset,
        fallbackPreprocessing.length > 0 ? fallbackPreprocessing : undefined,
        ocrPageSegmentationMode,
      );
      const fallbackAnswer = normalizeCaptchaText(fallback.text, charset);
      if (fallbackAnswer.length === expectedAnswerLength) {
        return {
          answer: fallbackAnswer,
          confidence: clampConfidence(fallback.confidence),
        };
      }
      if (!answer) return { answer: "", confidence: 0 };
      return { answer, confidence: clampConfidence(recognition.confidence) };
    },
  };
}

let workerPromise: ReturnType<typeof createWorker> | null = null;
let recognitionQueue = Promise.resolve();

const TESSERACT_PAGE_SEGMENTATION_MODES: Record<
  CaptchaOcrPageSegmentationMode,
  PSM
> = {
  "single-line": PSM.SINGLE_LINE,
  "single-word": PSM.SINGLE_WORD,
  "raw-line": PSM.RAW_LINE,
};

export function tesseractPageSegmentationMode(
  mode: CaptchaOcrPageSegmentationMode = "single-line",
): PSM {
  return TESSERACT_PAGE_SEGMENTATION_MODES[mode];
}

function tesseractWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = createWorker("eng", OEM.LSTM_ONLY, {
    logger: () => {},
  })
    .then((worker) => worker)
    .catch((error) => {
      workerPromise = null;
      throw error;
    });
  return workerPromise;
}

function enqueueRecognition<T>(operation: () => Promise<T>): Promise<T> {
  const next = recognitionQueue.then(operation, operation);
  recognitionQueue = next.then(() => undefined, () => undefined);
  return next;
}

export const tesseractTextRecognitionEngine: TextRecognitionEngine = {
  recognize(image, charset, imagePreprocessing, ocrPageSegmentationMode) {
    return enqueueRecognition(async () => {
      const worker = await tesseractWorker();
      await worker.setParameters({
        tessedit_char_whitelist: tesseractWhitelist(charset ?? "alphanumeric"),
        tessedit_pageseg_mode: tesseractPageSegmentationMode(ocrPageSegmentationMode),
      });
      const debug = openCaptchaDebugSession();
      debug?.writeImage("raw", image);
      const processed = preprocessCaptchaImage(
        image,
        debug ? (step, buffer) => debug.writeImage(step, buffer) : undefined,
        {
          removeInterferenceLines: imagePreprocessing?.includes(
            "remove-interference-lines",
          ),
        },
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
    });
  },
};
