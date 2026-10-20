import assert from "node:assert/strict";
import test from "node:test";
import { calibratedCaptchaSolver, MEGA_CAPTCHA_FAMILY, nextbankAudioCaptchaSolver, RAKUTEN_CAPTCHA_FAMILY, TAISHIN_CAPTCHA_FAMILY, type PreviewCaptchaFamily } from "./preview-captcha.ts";
import { blankPng, scriptedOcrEngine } from "./preview-source-harness.ts";
import { PreviewSourceFailure, type PreviewCaptchaChallenge } from "./source-kit.ts";
import type { SpeechRecognitionEngine } from "../automation/server/audio-captcha-solver.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";

function solve(family: PreviewCaptchaFamily, challenge: PreviewCaptchaChallenge, results: readonly { text: string; confidence: number }[] = []) {
  const engine = scriptedOcrEngine(results);
  const events: string[] = [];
  const context = { event: async (_stage: string, code: string) => { events.push(code); } } as unknown as PreviewWorkflowContext;
  return { engine, events, answer: calibratedCaptchaSolver(family, engine)(context, challenge) };
}

const mega = (overrides: Partial<PreviewCaptchaChallenge> = {}): PreviewCaptchaChallenge =>
  ({ image: blankPng(100, 49), charset: "digits", expectedLength: 5, ...overrides });
const taishin = (overrides: Partial<PreviewCaptchaChallenge> = {}): PreviewCaptchaChallenge =>
  ({ image: blankPng(120, 36), charset: "digits", expectedLength: 6, ...overrides });

test("Rakuten accepts only whole-string / character agreement, including at low confidence", async () => {
  const challenge: PreviewCaptchaChallenge = { image: blankPng(152, 60), charset: "alphanumeric", expectedLength: 4 };
  const result = solve(RAKUTEN_CAPTCHA_FAMILY, challenge, [{ text: "AB29", confidence: 0.01 }, { text: "ab29", confidence: 0.02 }]);
  assert.equal(await result.answer, "AB29");
  assert.deepEqual(result.engine.calls, [
    { imagePreprocessing: ["rakuten-teal-closed"], ocrPageSegmentationMode: "single-line" },
    { imagePreprocessing: ["rakuten-teal-foreground"], ocrPageSegmentationMode: undefined, ocrCharacterSegmentation: "rakuten-four-slots" },
  ]);
  for (const second of ["AB28", "", "AB299", "AB2"]) {
    assert.equal(await solve(RAKUTEN_CAPTCHA_FAMILY, challenge, [{ text: "AB29", confidence: 1 }, { text: second, confidence: 1 }]).answer, null);
  }
});

test("a capture outside the family is refused as unsupported before any OCR runs", async () => {
  const cases: Record<string, readonly [PreviewCaptchaFamily, PreviewCaptchaChallenge]> = {
    "Mega at another width": [MEGA_CAPTCHA_FAMILY, mega({ image: blankPng(101, 49) })],
    "Mega at Taishin's size": [MEGA_CAPTCHA_FAMILY, mega({ image: blankPng(120, 36) })],
    "Mega with a six-digit answer": [MEGA_CAPTCHA_FAMILY, mega({ expectedLength: 6 })],
    "Mega with letters": [MEGA_CAPTCHA_FAMILY, mega({ charset: "alphanumeric" })],
    "Mega as undecoded JPEG": [MEGA_CAPTCHA_FAMILY, mega({ image: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]) })],
    "Taishin at another height": [TAISHIN_CAPTCHA_FAMILY, taishin({ image: blankPng(120, 40) })],
    "Taishin with a page that declares four digits": [TAISHIN_CAPTCHA_FAMILY, taishin({ expectedLength: 4 })],
    "Rakuten at another width": [RAKUTEN_CAPTCHA_FAMILY, { image: blankPng(151, 60), charset: "alphanumeric", expectedLength: 4 }],
    "Rakuten with another length": [RAKUTEN_CAPTCHA_FAMILY, { image: blankPng(152, 60), charset: "alphanumeric", expectedLength: 5 }],
    "Rakuten with digits-only charset": [RAKUTEN_CAPTCHA_FAMILY, { image: blankPng(152, 60), charset: "digits", expectedLength: 4 }],
  };
  for (const [name, [family, challenge]] of Object.entries(cases)) {
    const { engine, events, answer } = solve(family, challenge);
    await assert.rejects(answer, (error) => error instanceof PreviewSourceFailure && error.reason === "verification-unsupported", name);
    assert.deepEqual(events, ["solver-challenge-unsupported"], name);
    assert.equal(engine.calls.length, 0, `${name} runs no OCR`);
  }
});

test("Mega runs its three declared strategies on one image and takes the most confident answer at or above 0.99", async () => {
  const { engine, answer } = solve(MEGA_CAPTCHA_FAMILY, mega(), [
    { text: "11111", confidence: 0.992 },
    { text: "22222", confidence: 0.998 },
    { text: "33333", confidence: 0.95 },
  ]);
  assert.equal(await answer, "22222");
  assert.deepEqual(engine.calls, [
    { imagePreprocessing: [], ocrPageSegmentationMode: "single-line" },
    { imagePreprocessing: [], ocrPageSegmentationMode: "single-word" },
    { imagePreprocessing: ["remove-interference-lines"], ocrPageSegmentationMode: "single-line" },
  ]);
});

test("an answer below the threshold, of the wrong length, or with letters is not accepted", async () => {
  const cases: Record<string, readonly { text: string; confidence: number }[]> = {
    "below 0.99": [{ text: "12345", confidence: 0.989 }, { text: "12345", confidence: 0.98 }, { text: "12345", confidence: 0.5 }],
    "four digits": [{ text: "1234", confidence: 1 }, { text: "1234", confidence: 1 }, { text: "1234", confidence: 1 }],
    "six digits": [{ text: "123456", confidence: 1 }, { text: "123456", confidence: 1 }, { text: "123456", confidence: 1 }],
    "letters only": [{ text: "ABCDE", confidence: 1 }, { text: "ABCDE", confidence: 1 }, { text: "ABCDE", confidence: 1 }],
  };
  for (const [name, results] of Object.entries(cases)) {
    assert.equal(await solve(MEGA_CAPTCHA_FAMILY, mega(), results).answer, null, name);
  }
});

test("Taishin accepts a confidence of exactly 0.5 and prefers the first strategy on a tie", async () => {
  const { engine, answer } = solve(TAISHIN_CAPTCHA_FAMILY, taishin(), [
    { text: "123456", confidence: 0.5 },
    { text: "654321", confidence: 0.5 },
  ]);
  assert.equal(await answer, "123456");
  assert.deepEqual(engine.calls, [
    { imagePreprocessing: [], ocrPageSegmentationMode: "single-word" },
    { imagePreprocessing: ["remove-interference-lines"], ocrPageSegmentationMode: "single-word" },
  ]);
  assert.equal(await solve(TAISHIN_CAPTCHA_FAMILY, taishin({ expectedLength: undefined }), [
    { text: "123456", confidence: 0.49 },
    { text: "1234567", confidence: 0.99 },
  ]).answer, null, "a page without a declared length still needs six digits");
});

function scriptedSpeechEngine(texts: readonly string[]): SpeechRecognitionEngine {
  let index = 0;
  return {
    async transcribe() {
      const text = texts[index] ?? texts[texts.length - 1] ?? "";
      index += 1;
      return { text };
    },
  };
}

const audioChallenge = (expectedLength = 5): PreviewCaptchaChallenge =>
  ({ audio: [Buffer.from("clip-1"), Buffer.from("clip-2"), Buffer.from("clip-3"), Buffer.from("clip-4"), Buffer.from("clip-5")], expectedLength });

function audioContext(): PreviewWorkflowContext & { events: string[] } {
  const events: string[] = [];
  const context = { event: async (_stage: string, code: string) => { events.push(code); } } as unknown as PreviewWorkflowContext & { events: string[] };
  context.events = events;
  return context;
}

test("the NextBank audio solver maps each spoken clip to one digit", async () => {
  const answer = await nextbankAudioCaptchaSolver(scriptedSpeechEngine(["一", "二", "三", "四", "五"]))(audioContext(), audioChallenge());
  assert.equal(answer, "12345");
});

test("the NextBank audio solver recovers the digit 二 from the 嗯 confusion", async () => {
  const answer = await nextbankAudioCaptchaSolver(scriptedSpeechEngine(["八", "嗯", "四", "八", "九"]))(audioContext(), audioChallenge());
  assert.equal(answer, "82489");
});

test("a clip that does not map to exactly one digit is not accepted", async () => {
  const answer = await nextbankAudioCaptchaSolver(scriptedSpeechEngine(["一", "二", "三", "四 五"]))(audioContext(), audioChallenge());
  assert.equal(answer, null, "one clip speaking two digits fails closed");
});

test("an empty clip transcription is not accepted", async () => {
  const answer = await nextbankAudioCaptchaSolver(scriptedSpeechEngine(["一", "二", "三", "四", ""]))(audioContext(), audioChallenge());
  assert.equal(answer, null);
});

test("the NextBank audio solver refuses an image challenge as unsupported", async () => {
  const context = audioContext();
  const challenge: PreviewCaptchaChallenge = { image: blankPng(302, 96), charset: "digits", expectedLength: 5 };
  await assert.rejects(
    nextbankAudioCaptchaSolver(scriptedSpeechEngine(["一", "二", "三", "四", "五"]))(context, challenge),
    (error) => error instanceof PreviewSourceFailure && error.reason === "verification-unsupported",
  );
  assert.deepEqual(context.events, ["solver-challenge-unsupported"]);
});
