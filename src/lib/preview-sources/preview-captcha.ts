import type { CaptchaOcrAttemptStrategy, ChallengeCharacterSet } from "../automation/human-assistance.ts";
import type { SolveAcceptancePolicy } from "../automation/solve-acceptance-policy.ts";
import {
  tesseractTextRecognitionEngine,
  textCaptchaSolver,
  type TextRecognitionEngine,
} from "../automation/server/text-captcha-solver.ts";
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

function pngSize(image: Buffer): Readonly<{ width: number; height: number }> | null {
  if (sniffImageType(image) !== "image/png" || image.length < 24) return null;
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

function fitsFamily(family: PreviewCaptchaFamily, challenge: PreviewCaptchaChallenge): boolean {
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
    if (!fitsFamily(family, challenge)) return refuseUnsupportedVerification(context, `${family.name} capture outside its calibrated family`);
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
