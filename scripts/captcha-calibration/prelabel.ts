import { readFile } from "node:fs/promises";
import {
  textCaptchaSolver,
  type TextRecognitionEngine,
} from "../../src/lib/automation/server/text-captcha-solver.ts";
import type { CalibrationBankSpec } from "./banks.ts";
import {
  imagePath,
  readCaptures,
  updateLabels,
  withSuggestion,
  type StrategyCandidate,
  type Suggestion,
} from "./corpus.ts";
import { STRATEGY_GRID } from "./strategies.ts";

/** The answer most strategies agree on; ties go to the higher best confidence, then grid order. */
export function suggestAnswer(candidates: readonly StrategyCandidate[]): Pick<Suggestion, "answer" | "agreementCount"> {
  const groups = new Map<string, { count: number; confidence: number }>();
  for (const { answer, confidence } of candidates) {
    if (!answer) continue;
    const group = groups.get(answer) ?? { count: 0, confidence: 0 };
    groups.set(answer, { count: group.count + 1, confidence: Math.max(group.confidence, confidence) });
  }
  let best: { answer: string; count: number; confidence: number } | null = null;
  for (const [answer, group] of groups) {
    if (!best || group.count > best.count || (group.count === best.count && group.confidence > best.confidence)) {
      best = { answer, ...group };
    }
  }
  return best ? { answer: best.answer, agreementCount: best.count } : { answer: "", agreementCount: 0 };
}

export async function prelabelCorpus(options: Readonly<{
  corpusDirectory: string;
  bank: CalibrationBankSpec;
  engine: TextRecognitionEngine;
  now?: () => string;
  log?: (line: string) => void;
}>): Promise<Readonly<{ labelled: number }>> {
  const now = options.now ?? (() => new Date().toISOString());
  const solver = textCaptchaSolver(options.engine);
  const captures = await readCaptures(options.corpusDirectory);
  for (const [index, capture] of captures.entries()) {
    const image = await readFile(imagePath(options.corpusDirectory, capture));
    const candidates: StrategyCandidate[] = [];
    for (const { label, strategy } of STRATEGY_GRID) {
      // No expected length: evaluate applies the length the labels show.
      const result = await solver.solve({
        image,
        challengeKind: "text-captcha",
        charset: options.bank.charset,
        strategy,
        expectedAnswerLength: undefined,
      });
      if (!("answer" in result)) throw new Error("The OCR solver returned a selection answer.");
      candidates.push({ strategy: label, answer: result.answer, confidence: result.confidence });
    }
    const suggestion: Suggestion = { at: now(), ...suggestAnswer(candidates), candidates };
    await updateLabels(options.corpusDirectory, options.bank.id, (entries) => withSuggestion(entries, capture.id, suggestion));
    options.log?.(`prelabel ${index + 1}/${captures.length} ${capture.id}`);
  }
  return { labelled: captures.length };
}
