import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  meanSymbolConfidence,
  normalizeCaptchaText,
  tesseractPageSegmentationMode,
  tesseractWhitelist,
  textCaptchaSolver,
  type TextRecognitionEngine,
} from "./text-captcha-solver.ts";

const fixtureImage = Buffer.from("known-captcha-image-bytes");

function engineReturning(
  text: string,
  confidence: number,
): TextRecognitionEngine & { received: Buffer[] } {
  const received: Buffer[] = [];
  return {
    received,
    async recognize(image) {
      received.push(image);
      return { text, confidence };
    },
  };
}

test("the OCR solver returns a normalized answer and confidence", async () => {
  const engine = engineReturning("a 1 b-2", 0.95);
  const result = await textCaptchaSolver(engine).solve({
    image: fixtureImage,
    challengeKind: "text-captcha",
  });
  assert.deepEqual(result, { answer: "A1B2", confidence: 0.95 });
  assert.equal(engine.received.length, 1);
  assert.equal(engine.received[0], fixtureImage);
});

test("the OCR solver rejects a non-text challenge kind", async () => {
  await assert.rejects(
    textCaptchaSolver(engineReturning("x", 1)).solve({
      image: fixtureImage,
      challengeKind: "image-selection",
    }),
    /does not support challenge kind image-selection/,
  );
});

test("an empty OCR result yields a zero-confidence answer", async () => {
  const result = await textCaptchaSolver(engineReturning(" -_ ", 0.9)).solve({
    image: fixtureImage,
    challengeKind: "text-captcha",
  });
  assert.deepEqual(result, { answer: "", confidence: 0 });
});

test("normalizeCaptchaText keeps only alphanumeric characters, uppercased", () => {
  assert.equal(normalizeCaptchaText("aB1-2 c\n"), "AB12C");
  assert.equal(normalizeCaptchaText(""), "");
  assert.equal(normalizeCaptchaText("!@#$"), "");
});

test("normalizeCaptchaText enforces a digits-only answer for digit challenges", () => {
  assert.equal(normalizeCaptchaText("2O-3 eight", "digits"), "23");
});

test("tesseractWhitelist maps a named set to tesseract's whitelist string", () => {
  assert.equal(tesseractWhitelist("digits"), "0123456789");
  assert.equal(
    tesseractWhitelist("alphanumeric"),
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  );
});

test("tesseractPageSegmentationMode keeps the default and provider modes explicit", () => {
  assert.equal(tesseractPageSegmentationMode(), "7");
  assert.equal(tesseractPageSegmentationMode("single-word"), "8");
  assert.equal(tesseractPageSegmentationMode("raw-line"), "13");
});

test("meanSymbolConfidence averages per-symbol confidences", () => {
  const page = {
    blocks: [
      {
        paragraphs: [
          {
            lines: [
              {
                words: [
                  {
                    symbols: [
                      { text: "8", confidence: 56 },
                      { text: "2", confidence: 90 },
                      { text: "1", confidence: 92 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  } as unknown as Parameters<typeof meanSymbolConfidence>[0];
  assert.equal(meanSymbolConfidence(page), (56 + 90 + 92) / 3);
});

test("meanSymbolConfidence returns null without any symbols", () => {
  assert.equal(meanSymbolConfidence({ blocks: null } as never), null);
});

test("the OCR solver forwards the character set to the engine", async () => {
  let receivedCharset: unknown;
  const engine: TextRecognitionEngine = {
    async recognize(_image, charset) {
      receivedCharset = charset;
      return { text: "123", confidence: 0.9 };
    },
  };
  await textCaptchaSolver(engine).solve({
    image: fixtureImage,
    challengeKind: "text-captcha",
    charset: "digits",
  });
  assert.equal(receivedCharset, "digits");
});

test("the OCR solver forwards image preprocessing modes to the engine", async () => {
  let receivedModes: unknown;
  const engine: TextRecognitionEngine = {
    async recognize(_image, _charset, imagePreprocessing) {
      receivedModes = imagePreprocessing;
      return { text: "123", confidence: 0.9 };
    },
  };
  await textCaptchaSolver(engine).solve({
    image: fixtureImage,
    challengeKind: "text-captcha",
    charset: "digits",
    imagePreprocessing: ["remove-interference-lines"],
  });
  assert.deepEqual(receivedModes, ["remove-interference-lines"]);
});

test("the OCR solver forwards the provider-declared page segmentation mode", async () => {
  let receivedMode: unknown;
  const engine: TextRecognitionEngine = {
    async recognize(_image, _charset, _imagePreprocessing, ocrPageSegmentationMode) {
      receivedMode = ocrPageSegmentationMode;
      return { text: "2038", confidence: 0.85 };
    },
  };
  await textCaptchaSolver(engine).solve({
    image: fixtureImage,
    challengeKind: "text-captcha",
    charset: "digits",
    ocrPageSegmentationMode: "single-word",
  });
  assert.equal(receivedMode, "single-word");
});

test("the OCR solver falls back without line removal when the processed answer has the wrong length", async () => {
  const receivedModes: Array<readonly string[] | undefined> = [];
  const engine: TextRecognitionEngine = {
    async recognize(_image, _charset, imagePreprocessing) {
      receivedModes.push(imagePreprocessing);
      return imagePreprocessing?.includes("remove-interference-lines")
        ? { text: "2", confidence: 0.54 }
        : { text: "32770", confidence: 0.964 };
    },
  };
  const result = await textCaptchaSolver(engine).solve({
    image: fixtureImage,
    challengeKind: "text-captcha",
    charset: "digits",
    imagePreprocessing: ["remove-interference-lines"],
    expectedAnswerLength: 5,
  });
  assert.deepEqual(result, { answer: "32770", confidence: 0.964 });
  assert.deepEqual(receivedModes, [["remove-interference-lines"], undefined]);
});

test("the OCR solver rejects malformed primary and fallback answers", async () => {
  const result = await textCaptchaSolver({
    async recognize(_image, _charset, imagePreprocessing) {
      return imagePreprocessing?.includes("remove-interference-lines")
        ? { text: "0748", confidence: 0.94 }
        : { text: "748", confidence: 0.95 };
    },
  }).solve({
    image: fixtureImage,
    challengeKind: "text-captcha",
    charset: "digits",
    imagePreprocessing: ["remove-interference-lines"],
    expectedAnswerLength: 6,
  });
  assert.deepEqual(result, { answer: "", confidence: 0 });
});

test("the OCR solver applies a planned strategy over the base metadata", async () => {
  let received: unknown[] = [];
  const engine: TextRecognitionEngine = {
    async recognize(...args) {
      received = args;
      return { text: "123456", confidence: 0.95 };
    },
  };
  const result = await textCaptchaSolver(engine).solve({
    image: fixtureImage,
    challengeKind: "text-captcha",
    charset: "digits",
    imagePreprocessing: ["remove-interference-lines"],
    ocrPageSegmentationMode: "single-word",
    expectedAnswerLength: 6,
    strategy: {
      imagePreprocessing: [],
      ocrPageSegmentationMode: "single-line",
      ocrOutputStage: "grayscale",
    },
  });
  assert.deepEqual(result, { answer: "123456", confidence: 0.95 });
  assert.deepEqual(received.slice(2), [[], "single-line", "grayscale"]);
});

test("a planned wrong-length strategy does not run an undeclared fallback pipeline", async () => {
  let calls = 0;
  const result = await textCaptchaSolver({
    async recognize() {
      calls += 1;
      return { text: "36951", confidence: 0.96 };
    },
  }).solve({
    image: fixtureImage,
    challengeKind: "text-captcha",
    charset: "digits",
    imagePreprocessing: ["remove-interference-lines"],
    expectedAnswerLength: 6,
    strategy: { ocrPageSegmentationMode: "single-line" },
  });
  assert.deepEqual(result, { answer: "", confidence: 0 });
  assert.equal(calls, 1);
});

test("the OCR solver does not run a fallback when the processed answer has the expected length", async () => {
  let calls = 0;
  const engine: TextRecognitionEngine = {
    async recognize() {
      calls += 1;
      return { text: "5241", confidence: 0.97 };
    },
  };
  const result = await textCaptchaSolver(engine).solve({
    image: fixtureImage,
    challengeKind: "text-captcha",
    charset: "digits",
    imagePreprocessing: ["remove-interference-lines"],
    expectedAnswerLength: 4,
  });
  assert.deepEqual(result, { answer: "5241", confidence: 0.97 });
  assert.equal(calls, 1);
});

test("the OCR solver reads the image in memory without persisting or logging it", () => {
  const source = readFileSync(
    new URL("./text-captcha-solver.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream|from\("node:fs"\)/);
  assert.doesNotMatch(source, /console\.(log|info|debug|warn)/);
});
