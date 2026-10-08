import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorker, OEM, PSM, type Page } from "tesseract.js";
import type {
  CaptchaImagePreprocessingMode,
  CaptchaOcrOutputStage,
  CaptchaOcrPageSegmentationMode,
  ChallengeCharacterSet,
} from "../human-assistance.ts";
import type { VerificationSolver, VerificationSolverResult } from "./verification-solver.ts";
import { preprocessCaptchaImage } from "./captcha-preprocess.ts";

export type TextRecognitionEngine = {
  recognize(
    image: Buffer,
    charset?: ChallengeCharacterSet,
    imagePreprocessing?: readonly CaptchaImagePreprocessingMode[],
    ocrPageSegmentationMode?: CaptchaOcrPageSegmentationMode,
    ocrOutputStage?: CaptchaOcrOutputStage,
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
      strategy,
    }): Promise<VerificationSolverResult> {
      if (challengeKind !== "text-captcha") {
        throw new Error(
          `OCR solver does not support challenge kind ${challengeKind}.`,
        );
      }
      if (!image) {
        throw new Error("OCR solver requires a challenge image.");
      }
      const effectiveImagePreprocessing = strategy?.imagePreprocessing
        ?? imagePreprocessing;
      const effectivePageSegmentationMode = strategy?.ocrPageSegmentationMode
        ?? ocrPageSegmentationMode;
      const effectiveOutputStage = strategy?.ocrOutputStage;
      const recognition = await engine.recognize(
        image,
        charset,
        effectiveImagePreprocessing,
        effectivePageSegmentationMode,
        effectiveOutputStage,
      );
      const answer = normalizeCaptchaText(recognition.text, charset);
      const expectedLengthMatches = expectedAnswerLength === undefined
        || answer.length === expectedAnswerLength;
      // An ordered attempt plan is the provider's complete pipeline. Do not
      // add the legacy line-removal fallback inside a planned attempt: that
      // would silently run another (possibly unsafe) OCR flow before the next
      // declared strategy gets a chance.
      if (strategy) {
        if (!answer || (expectedAnswerLength !== undefined && !expectedLengthMatches)) {
          return { answer: "", confidence: 0 };
        }
        return { answer, confidence: clampConfidence(recognition.confidence) };
      }
      if (expectedLengthMatches || !effectiveImagePreprocessing?.includes("remove-interference-lines")) {
        if (!answer) return { answer: "", confidence: 0 };
        if (expectedAnswerLength !== undefined && !expectedLengthMatches) {
          return { answer: "", confidence: 0 };
        }
        return { answer, confidence: clampConfidence(recognition.confidence) };
      }

      const fallbackPreprocessing = effectiveImagePreprocessing.filter(
        (mode) => mode !== "remove-interference-lines",
      );
      const fallback = await engine.recognize(
        image,
        charset,
        fallbackPreprocessing.length > 0 ? fallbackPreprocessing : undefined,
        effectivePageSegmentationMode,
        effectiveOutputStage,
      );
      const fallbackAnswer = normalizeCaptchaText(fallback.text, charset);
      if (fallbackAnswer.length === expectedAnswerLength) {
        return {
          answer: fallbackAnswer,
          confidence: clampConfidence(fallback.confidence),
        };
      }
      return { answer: "", confidence: 0 };
    },
  };
}

let workerPromise: ReturnType<typeof createWorker> | null = null;
let recognitionQueue = Promise.resolve();

// Tesseract.js writes downloaded language models to `cachePath`. Keep those
// runtime artifacts outside the repository so a local OCR run cannot create a
// source-controlled `*.traineddata` file in the current working directory.
export const TESSERACT_CACHE_PATH = join(tmpdir(), "octopusbeak", "tesseract");

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

const TESSERACT_WORKER_READY_TIMEOUT_MS = 60_000;

/**
 * Tesseract.js swallows a failed language-model load inside `createWorker`, so
 * its promise never settles when the model download fails or stalls. Load the
 * model through `reinitialize`, whose job rejects, and stop the worker on any
 * failure so a later round can start a fresh one.
 */
export async function createTesseractWorker(options: Readonly<{
  cachePath: string;
  langPath?: string;
  readyTimeoutMs: number;
}>): Promise<Awaited<ReturnType<typeof createWorker>>> {
  await mkdir(options.cachePath, { recursive: true });
  const worker = await createWorker([], OEM.LSTM_ONLY, {
    logger: () => {},
    cachePath: options.cachePath,
    ...(options.langPath ? { langPath: options.langPath } : {}),
    errorHandler: () => {},
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      worker.reinitialize("eng", OEM.LSTM_ONLY),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Tesseract worker did not become ready before the deadline.")),
          options.readyTimeoutMs,
        );
      }),
    ]);
    return worker;
  } catch (error) {
    await worker.terminate().catch(() => undefined);
    throw error instanceof Error ? error : new Error(`Tesseract worker failed: ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

function tesseractWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = createTesseractWorker({
    cachePath: TESSERACT_CACHE_PATH,
    readyTimeoutMs: TESSERACT_WORKER_READY_TIMEOUT_MS,
  }).catch((error) => {
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
  recognize(
    image,
    charset,
    imagePreprocessing,
    ocrPageSegmentationMode,
    ocrOutputStage,
  ) {
    return enqueueRecognition(async () => {
      const worker = await tesseractWorker();
      await worker.setParameters({
        tessedit_char_whitelist: tesseractWhitelist(charset ?? "alphanumeric"),
        tessedit_pageseg_mode: tesseractPageSegmentationMode(ocrPageSegmentationMode),
      });
      const processed = preprocessCaptchaImage(
        image,
        undefined,
        {
          imagePreprocessing,
          removeInterferenceLines: imagePreprocessing?.includes(
            "remove-interference-lines",
          ),
          outputStage: ocrOutputStage,
        },
      );
      const result = await worker.recognize(processed, {}, {
        text: true,
        blocks: true,
      });
      const text = result.data.text ?? "";
      const confidence =
        (meanSymbolConfidence(result.data) ?? result.data.confidence ?? 0) / 100;
      return { text, confidence };
    });
  },
};
