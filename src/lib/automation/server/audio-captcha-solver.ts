import type {
  VerificationSolver,
  VerificationSolverResult,
} from "./verification-solver.ts";

export type SpeechRecognitionEngine = {
  transcribe(audio: Buffer): Promise<{ text: string }>;
};

/**
 * Map a space-separated transcription to decimal digits, dropping any
 * non-numeral tokens (such as the spoken "開始播放" prompt). Individual
 * Chinese numerals are the target; a token that is itself a run of numeral
 * characters is mapped character-by-character.
 */
export function chineseNumeralsToDigits(text: string): string {
  return text
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => {
      const direct = CHINESE_NUMERALS[token];
      if (direct !== undefined) return direct;
      return [...token].map((character) => CHINESE_NUMERALS[character] ?? "").join("");
    })
    .join("");
}

const CHINESE_NUMERALS: Record<string, string> = {
  "零": "0",
  "〇": "0",
  "一": "1",
  "壹": "1",
  "幺": "1",
  "二": "2",
  "贰": "2",
  "貳": "2",
  "两": "2",
  "兩": "2",
  "三": "3",
  "叁": "3",
  "參": "3",
  "四": "4",
  "肆": "4",
  "五": "5",
  "伍": "5",
  "六": "6",
  "陆": "6",
  "陸": "6",
  "七": "7",
  "柒": "7",
  "八": "8",
  "捌": "8",
  "九": "9",
  "玖": "9",
};

export const stubSpeechRecognitionEngine: SpeechRecognitionEngine = {
  async transcribe() {
    return { text: "" };
  },
};

export function audioCaptchaSolver(
  engine: SpeechRecognitionEngine,
): VerificationSolver {
  return {
    async solve({
      audio,
      challengeKind,
      expectedAnswerLength,
    }): Promise<VerificationSolverResult> {
      if (challengeKind !== "audio-captcha") {
        throw new Error(
          `Audio solver does not support challenge kind ${challengeKind}.`,
        );
      }
      if (!audio) {
        throw new Error("Audio solver requires a challenge audio clip.");
      }
      const { text } = await engine.transcribe(audio);
      const answer = chineseNumeralsToDigits(text);
      // A grammar-constrained recogniser reports maximal per-word confidence,
      // so confidence is not a trustworthy acceptance signal here. Report full
      // confidence only when the transcription is structurally valid (the
      // declared digit count); correctness is left to the login outcome.
      const lengthMatches = expectedAnswerLength === undefined
        || answer.length === expectedAnswerLength;
      if (!answer || !lengthMatches) return { answer: "", confidence: 0 };
      return { answer, confidence: 1 };
    },
  };
}
