import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  meanSymbolConfidence,
  normalizeCaptchaText,
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

test("tesseractWhitelist maps a named set to tesseract's whitelist string", () => {
  assert.equal(tesseractWhitelist("digits"), "0123456789");
  assert.equal(
    tesseractWhitelist("alphanumeric"),
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  );
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

test("the OCR solver reads the image in memory without persisting or logging it", () => {
  const source = readFileSync(
    new URL("./text-captcha-solver.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream|from\("node:fs"\)/);
  assert.doesNotMatch(source, /console\.(log|info|debug|warn)/);
});
