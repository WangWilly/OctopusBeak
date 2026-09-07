import assert from "node:assert/strict";
import test from "node:test";
import {
  audioCaptchaSolver,
  chineseNumeralsToDigits,
  type SpeechRecognitionEngine,
} from "./audio-captcha-solver.ts";

const audio = Buffer.from("audio-mpeg-bytes");

function engineReturning(text: string): SpeechRecognitionEngine {
  return { async transcribe() { return { text }; } };
}

test("chinese numerals map to decimal digits and drop the spoken prompt", () => {
  assert.equal(
    chineseNumeralsToDigits("开始 播放 八 八 四 九 三 四"),
    "884934",
  );
  assert.equal(
    chineseNumeralsToDigits("開始 播放 零 九 四 九 三 六"),
    "094936",
  );
});

test("a run of numeral characters maps character-by-character", () => {
  assert.equal(chineseNumeralsToDigits("开始播放八八四九三四"), "884934");
});

test("the audio solver transcribes six digits and reports full confidence", async () => {
  const solver = audioCaptchaSolver(engineReturning("开始 播放 一 二 三 四 五 六"));
  const result = await solver.solve({
    audio,
    challengeKind: "audio-captcha",
    charset: "digits",
    expectedAnswerLength: 6,
  });
  assert.equal("answer" in result && result.answer, "123456");
  assert.equal(result.confidence, 1);
});

test("a transcription with the wrong digit count is rejected", async () => {
  const solver = audioCaptchaSolver(engineReturning("开始 播放 一 二 三 四"));
  const result = await solver.solve({
    audio,
    challengeKind: "audio-captcha",
    charset: "digits",
    expectedAnswerLength: 6,
  });
  assert.equal(result.confidence, 0);
  assert.equal("answer" in result && result.answer, "");
});

test("an empty transcription is rejected", async () => {
  const solver = audioCaptchaSolver(engineReturning("开始 播放"));
  const result = await solver.solve({
    audio,
    challengeKind: "audio-captcha",
    charset: "digits",
    expectedAnswerLength: 6,
  });
  assert.equal(result.confidence, 0);
});

test("the audio solver rejects a non-audio challenge kind", async () => {
  const solver = audioCaptchaSolver(engineReturning(""));
  await assert.rejects(
    () => solver.solve({
      audio,
      challengeKind: "text-captcha",
      expectedAnswerLength: 6,
    }),
    /does not support challenge kind/,
  );
});

test("the audio solver requires an audio clip", async () => {
  const solver = audioCaptchaSolver(engineReturning(""));
  await assert.rejects(
    () => solver.solve({
      challengeKind: "audio-captcha",
      expectedAnswerLength: 6,
    }),
    /requires a challenge audio clip/,
  );
});
