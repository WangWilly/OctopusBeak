import type { CaptchaOcrAttemptStrategy, ChallengeCharacterSet } from "../automation/human-assistance.ts";
import type { SolveAcceptancePolicy } from "../automation/solve-acceptance-policy.ts";
import {
  tesseractTextRecognitionEngine,
  textCaptchaSolver,
  type TextRecognitionEngine,
} from "../automation/server/text-captcha-solver.ts";
import {
  recoverDigits,
  type SpeechRecognitionEngine,
} from "../automation/server/audio-captcha-solver.ts";
import { createSherpaOnnxSpeechRecognitionEngine } from "../automation/server/speech-recognition.ts";
import { solveVerificationChallenge } from "../automation/server/verification-solver.ts";
import { sniffImageType } from "./browser-http.ts";
import { refuseUnsupportedVerification, type PreviewCaptchaChallenge, type PreviewCaptchaSolver } from "./source-kit.ts";

export type PreviewCaptchaFamily = Readonly<{
  name: string;
  geometry: Readonly<{ width: number; height: number }>;
  charset: ChallengeCharacterSet;
  expectedAnswerLength: number;
  answerPattern: RegExp;
  ocrAttemptPlan: readonly CaptchaOcrAttemptStrategy[];
  solveAcceptancePolicy: SolveAcceptancePolicy;
  solverConfidenceThreshold: number;
}>;

export const TAISHIN_CAPTCHA_FAMILY: PreviewCaptchaFamily = {
  name: "taishin-login-captcha",
  geometry: { width: 120, height: 36 },
  charset: "digits",
  expectedAnswerLength: 6,
  answerPattern: /^\d{6}$/u,
  ocrAttemptPlan: [
    { imagePreprocessing: [], ocrPageSegmentationMode: "single-word" },
    { imagePreprocessing: ["remove-interference-lines"], ocrPageSegmentationMode: "single-word" },
  ],
  solveAcceptancePolicy: { mode: "confidence-only" },
  solverConfidenceThreshold: 0.5,
};

export const MEGA_CAPTCHA_FAMILY: PreviewCaptchaFamily = {
  name: "mega-login-captcha",
  geometry: { width: 100, height: 49 },
  charset: "digits",
  expectedAnswerLength: 5,
  answerPattern: /^\d{5}$/u,
  ocrAttemptPlan: [
    { imagePreprocessing: [], ocrPageSegmentationMode: "single-line" },
    { imagePreprocessing: [], ocrPageSegmentationMode: "single-word" },
    { imagePreprocessing: ["remove-interference-lines"], ocrPageSegmentationMode: "single-line" },
  ],
  solveAcceptancePolicy: { mode: "confidence-only" },
  solverConfidenceThreshold: 0.99,
};

/** Selection 123 images: 59/60 accepted correct. Held-out 60: 29/29 correct.
 * Keep this fixed pair even if a later grid sweep ranks another combination higher. */
export const RAKUTEN_CAPTCHA_FAMILY: PreviewCaptchaFamily = {
  name: "rakuten-login-captcha",
  geometry: { width: 152, height: 60 },
  charset: "alphanumeric",
  expectedAnswerLength: 4,
  answerPattern: /^[0-9A-Z]{4}$/u,
  ocrAttemptPlan: [
    { imagePreprocessing: ["rakuten-teal-closed"], ocrPageSegmentationMode: "single-line" },
    { imagePreprocessing: ["rakuten-teal-foreground"], ocrCharacterSegmentation: "rakuten-four-slots" },
  ],
  solveAcceptancePolicy: { mode: "agreement-only" },
  solverConfidenceThreshold: 0,
};

/** Fixed on 62 labelled images: 56 accepted, all correct. New captures must
 * validate this declaration rather than select a replacement from that set. */
export const KGIBANK_CAPTCHA_FAMILY: PreviewCaptchaFamily = {
  name: "kgibank-login-captcha",
  geometry: { width: 98, height: 25 },
  charset: "digits",
  expectedAnswerLength: 6,
  answerPattern: /^\d{6}$/u,
  ocrAttemptPlan: [
    { imagePreprocessing: [], ocrPageSegmentationMode: "single-line" },
    { imagePreprocessing: ["kgibank-dark-foreground"], ocrPageSegmentationMode: "single-line" },
    { imagePreprocessing: ["kgibank-dark-padded"], ocrPageSegmentationMode: "single-word" },
  ],
  solveAcceptancePolicy: { mode: "confidence-or-agreement", conflictResolution: "reject" },
  solverConfidenceThreshold: 0.99,
};

/** O-Bank shares the 152×60 teal layout, but has its own measured acceptance
 * pair: 24/60 accepted, all correct. Confidence alone never permits sign-in. */
export const OBANK_CAPTCHA_FAMILY: PreviewCaptchaFamily = {
  name: "obank-login-captcha",
  geometry: { width: 152, height: 60 },
  charset: "alphanumeric",
  expectedAnswerLength: 4,
  answerPattern: /^[0-9A-Z]{4}$/u,
  ocrAttemptPlan: [
    { imagePreprocessing: ["rakuten-teal-foreground"], ocrPageSegmentationMode: "single-word" },
    { imagePreprocessing: ["rakuten-teal-foreground"], ocrCharacterSegmentation: "rakuten-four-slots" },
  ],
  solveAcceptancePolicy: { mode: "agreement-only" },
  solverConfidenceThreshold: 0,
};

/** 62 maintainer-confirmed images: 53 correct among 54 accepts (FAR 1.85%). */
export const FIRSTBANK_CAPTCHA_FAMILY: PreviewCaptchaFamily = {
  name: "firstbank-login-captcha",
  geometry: { width: 67, height: 29 },
  charset: "alphanumeric",
  expectedAnswerLength: 4,
  answerPattern: /^[0-9A-Z]{4}$/u,
  ocrAttemptPlan: [
    { imagePreprocessing: ["remove-interference-lines"], ocrPageSegmentationMode: "single-line" },
    { imagePreprocessing: ["firstbank-dark-foreground"], ocrPageSegmentationMode: "single-line" },
    { imagePreprocessing: ["firstbank-dark-foreground"], ocrPageSegmentationMode: "single-word" },
  ],
  solveAcceptancePolicy: { mode: "confidence-only" },
  solverConfidenceThreshold: 0.97,
};

function pngSize(image: Buffer): Readonly<{ width: number; height: number }> | null {
  if (sniffImageType(image) !== "image/png" || image.length < 24) return null;
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

function fitsFamily(family: PreviewCaptchaFamily, challenge: PreviewCaptchaChallenge): boolean {
  if (!("image" in challenge)) return false;
  const size = pngSize(challenge.image);
  return size !== null
    && size.width === family.geometry.width
    && size.height === family.geometry.height
    && challenge.charset === family.charset
    && (challenge.expectedLength === undefined || challenge.expectedLength === family.expectedAnswerLength);
}

export function calibratedCaptchaSolver(
  family: PreviewCaptchaFamily,
  engine: TextRecognitionEngine = tesseractTextRecognitionEngine,
): PreviewCaptchaSolver {
  const solver = textCaptchaSolver(engine);
  return async (context, challenge) => {
    if (!("image" in challenge) || !fitsFamily(family, challenge)) return refuseUnsupportedVerification(context, `${family.name} capture outside its calibrated family`);
    let accepted = null as string | null;
    await solveVerificationChallenge({
      challengeKind: "text-captcha",
      confidenceThreshold: family.solverConfidenceThreshold,
      solver,
      captureChallengeImage: async () => challenge.image,
      injectAnswer: async (answer) => { accepted = answer; },
      charset: family.charset,
      ocrAttemptPlan: family.ocrAttemptPlan,
      solveAcceptancePolicy: family.solveAcceptancePolicy,
      expectedAnswerLength: family.expectedAnswerLength,
    });
    return accepted !== null && family.answerPattern.test(accepted) ? accepted : null;
  };
}

/**
 * Solve NextBank's 5-digit login CAPTCHA from its spoken audio. NextBank's
 * CAPTCHA endpoint answers `isAudio: true` with `captchaAudio`, a list of five
 * base64 clips, one spoken Chinese numeral each. The local sherpa-onnx
 * recogniser (paraformer-zh-small, the same one behind the Yuanta Trade audio
 * verification) transcribes each clip, and each clip must map to exactly one
 * decimal digit. Acceptance is structural (five clips, five digits); correctness
 * is left to the login outcome, as Yuanta Trade's audio verification does.
 */
const nextbankSpeechEngine = createSherpaOnnxSpeechRecognitionEngine();

export function nextbankAudioCaptchaSolver(
  engine: SpeechRecognitionEngine = nextbankSpeechEngine,
): PreviewCaptchaSolver {
  return async (context, challenge) => {
    if (!("audio" in challenge)) return refuseUnsupportedVerification(context, "nextbank-audio-captcha");
    const digits: string[] = [];
    for (const clip of challenge.audio) {
      const { text } = await engine.transcribe(clip);
      const digit = recoverDigits(text);
      if (digit.length !== 1) return null;
      digits.push(digit);
    }
    const answer = digits.join("");
    if (challenge.expectedLength !== undefined && answer.length !== challenge.expectedLength) return null;
    return answer;
  };
}
