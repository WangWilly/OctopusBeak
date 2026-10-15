import type { CaptchaOcrAttemptStrategy, ChallengeCharacterSet } from "../../src/lib/automation/human-assistance.ts";
import type { SolveAcceptancePolicy } from "../../src/lib/automation/solve-acceptance-policy.ts";
import { MAX_SOLVE_ATTEMPTS, solveVerificationChallenge } from "../../src/lib/automation/server/verification-solver.ts";
import type { CalibrationBankSpec } from "./banks.ts";
import type { CaptureRecord, LabelsFile, StrategyCandidate } from "./corpus.ts";
import { STRATEGY_GRID, type CalibrationStrategy } from "./strategies.ts";

export const THRESHOLDS: readonly number[] = [
  ...Array.from({ length: 10 }, (_, index) => (50 + index * 5) / 100),
  0.97,
  0.99,
];
export const MAX_FALSE_ACCEPT_RATE = 0.02;
export const MIN_ACCEPTED_SAMPLES = 20;
export const MIN_CONFIRMED_LABELS = 30;

export const POLICIES = {
  "confidence-only": { mode: "confidence-only" },
  "agreement-only": { mode: "agreement-only" },
  "confidence-or-agreement/reject": { mode: "confidence-or-agreement", conflictResolution: "reject" },
} as const satisfies Record<string, SolveAcceptancePolicy>;
export type PolicyName = keyof typeof POLICIES;

export type Configuration = Readonly<{
  policy: PolicyName;
  strategies: readonly CalibrationStrategy[];
  threshold: number | null;
}>;

export type LabelledItem = Readonly<{
  id: string;
  truth: string | null;
  candidates: ReadonlyMap<string, StrategyCandidate>;
}>;

export type ConfigurationSummary = Readonly<{ policy: PolicyName; strategies: readonly string[]; threshold: number | null }>;

export type ConfigurationResult = Readonly<{
  configuration: ConfigurationSummary;
  total: number;
  accepted: number;
  correct: number;
  wrong: number;
  coverage: number;
  falseAcceptRate: number;
  wrongPerTotal: number;
  accuracyWhenAccepted: number;
}>;

export type ExpectedLength = Readonly<{ value: number; basis: "source" | "page" | "labels" }>;

export type PairAgreement = Readonly<{ strategies: readonly [string, string]; agreed: number; agreedCorrect: number }>;

export type Recommendation =
  | Readonly<{
    status: "recommended";
    result: ConfigurationResult;
    falseAcceptUpperBound: number;
    declaration: string;
    familySentence: string;
  }>
  | Readonly<{ status: "refused"; reason: string }>;

export type Evaluation = Readonly<{
  bank: string;
  captures: number;
  confirmed: number;
  unreadable: number;
  missingSuggestions: number;
  expectedAnswerLength: ExpectedLength | null;
  geometry: Readonly<Record<string, number>>;
  answerLengths: Readonly<Record<string, number>>;
  characterClasses: readonly ("digits" | "uppercase" | "lowercase")[];
  singleStrategyAccuracy: readonly Readonly<{ strategy: string; correct: number; accuracy: number }>[];
  results: readonly ConfigurationResult[];
  agreement: readonly PairAgreement[];
  recommendation: Recommendation;
}>;

function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  return items.flatMap((item, index) => combinations(items.slice(index + 1), size - 1).map((rest) => [item, ...rest]));
}

export function configurations(grid: readonly CalibrationStrategy[] = STRATEGY_GRID): Configuration[] {
  const result: Configuration[] = [];
  const add = (policy: PolicyName, strategies: readonly CalibrationStrategy[]) => {
    if (policy === "agreement-only") result.push({ policy, strategies, threshold: null });
    else for (const threshold of THRESHOLDS) result.push({ policy, strategies, threshold });
  };
  for (const strategy of grid) add("confidence-only", [strategy]);
  for (let size = 2; size <= MAX_SOLVE_ATTEMPTS; size += 1) {
    for (const strategies of combinations(grid, size)) {
      for (const policy of Object.keys(POLICIES) as PolicyName[]) add(policy, strategies);
    }
  }
  return result;
}

function histogram(values: readonly (string | number)[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function smallestMostFrequent(values: readonly number[]): number | null {
  const counts = histogram(values);
  let best: number | null = null;
  for (const value of values) {
    if (best === null || counts[value]! > counts[best]! || (counts[value] === counts[best] && value < best)) best = value;
  }
  return best;
}

export function expectedAnswerLength(
  bank: CalibrationBankSpec,
  captures: readonly CaptureRecord[],
  items: readonly LabelledItem[],
): ExpectedLength | null {
  if (bank.declaredLength?.authority === "source") return { value: bank.declaredLength.value, basis: "source" };
  const page = smallestMostFrequent(captures.flatMap(({ declaredLength }) => declaredLength === undefined ? [] : [declaredLength]));
  if (page !== null) return { value: page, basis: "page" };
  const labels = smallestMostFrequent(items.flatMap(({ truth }) => truth === null ? [] : [truth.length]));
  return labels === null ? null : { value: labels, basis: "labels" };
}

const DUMMY_IMAGE = Buffer.alloc(1);

async function acceptedAnswer(
  item: LabelledItem,
  configuration: Configuration,
  labelOf: ReadonlyMap<CaptchaOcrAttemptStrategy, string>,
  charset: ChallengeCharacterSet,
  expectedLength: number | undefined,
): Promise<string | null> {
  let injected: string | null = null;
  await solveVerificationChallenge({
    challengeKind: "text-captcha",
    confidenceThreshold: configuration.threshold ?? 0,
    solver: {
      solve: async ({ strategy }) => {
        const candidate = strategy && item.candidates.get(labelOf.get(strategy)!);
        return { answer: candidate?.answer ?? "", confidence: candidate?.confidence ?? 0 };
      },
    },
    captureChallengeImage: async () => DUMMY_IMAGE,
    injectAnswer: async (answer) => { injected = answer; },
    charset,
    ocrAttemptPlan: configuration.strategies.map(({ strategy }) => strategy),
    solveAcceptancePolicy: POLICIES[configuration.policy],
    expectedAnswerLength: expectedLength,
  });
  return injected;
}

export async function evaluateConfiguration(
  items: readonly LabelledItem[],
  configuration: Configuration,
  charset: ChallengeCharacterSet,
  expectedLength: number | undefined,
): Promise<ConfigurationResult> {
  const labelOf = new Map(configuration.strategies.map(({ label, strategy }) => [strategy, label]));
  let correct = 0;
  let wrong = 0;
  for (const item of items) {
    const answer = await acceptedAnswer(item, configuration, labelOf, charset, expectedLength);
    if (answer === null) continue;
    if (answer === item.truth) correct += 1;
    else wrong += 1;
  }
  const accepted = correct + wrong;
  const total = items.length;
  return {
    configuration: { ...configuration, strategies: configuration.strategies.map(({ label }) => label) },
    total,
    accepted,
    correct,
    wrong,
    coverage: total === 0 ? 0 : accepted / total,
    falseAcceptRate: accepted === 0 ? 0 : wrong / accepted,
    wrongPerTotal: total === 0 ? 0 : wrong / total,
    accuracyWhenAccepted: accepted === 0 ? 0 : correct / accepted,
  };
}

export function pairAgreement(items: readonly LabelledItem[], grid: readonly CalibrationStrategy[] = STRATEGY_GRID): PairAgreement[] {
  return combinations(grid, 2).map(([first, second]) => {
    let agreed = 0;
    let agreedCorrect = 0;
    for (const item of items) {
      const answer = item.candidates.get(first!.label)?.answer;
      if (!answer || answer !== item.candidates.get(second!.label)?.answer) continue;
      agreed += 1;
      if (answer === item.truth) agreedCorrect += 1;
    }
    return { strategies: [first!.label, second!.label] as const, agreed, agreedCorrect };
  });
}

export function wilsonUpperBound(failures: number, trials: number): number {
  if (trials === 0) return 1;
  const z = 1.959964;
  const p = failures / trials;
  const z2 = z * z;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return Math.min(1, (centre + margin) / (1 + z2 / trials));
}

function characterClasses(answers: readonly string[]): Evaluation["characterClasses"] {
  const joined = answers.join("");
  return ([["digits", /\d/u], ["uppercase", /[A-Z]/u], ["lowercase", /[a-z]/u]] as const)
    .filter(([, pattern]) => pattern.test(joined))
    .map(([name]) => name);
}

function answerPattern(classes: Evaluation["characterClasses"], length: number): string {
  const ranges = { digits: "0-9", uppercase: "A-Z", lowercase: "a-z" };
  const set = classes.length === 1 && classes[0] === "digits" ? "\\d" : `[${classes.map((name) => ranges[name]).join("")}]`;
  return `/^${set}{${length}}$/u`;
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function constantName(bank: CalibrationBankSpec): string {
  return `${bank.id.toUpperCase()}_CAPTCHA`;
}

function policyLiteral(policy: PolicyName): string {
  return `{ ${Object.entries(POLICIES[policy]).map(([key, value]) => `${key}: "${value}"`).join(", ")} }`;
}

const STRATEGY_BY_LABEL = new Map(STRATEGY_GRID.map(({ label, strategy }) => [label, strategy]));

function strategyLiteral(label: string): string {
  const strategy = STRATEGY_BY_LABEL.get(label)!;
  const preprocessing = `[${(strategy.imagePreprocessing ?? []).map((mode) => `"${mode}"`).join(", ")}]`;
  return `{ imagePreprocessing: ${preprocessing}, ocrPageSegmentationMode: "${strategy.ocrPageSegmentationMode}" }`;
}

export function familyDeclaration(
  bank: CalibrationBankSpec,
  result: ConfigurationResult,
  length: number,
  geometry: Readonly<{ width: number; height: number }>,
  classes: Evaluation["characterClasses"],
): string {
  const { configuration } = result;
  return [
    `export const ${constantName(bank)}_FAMILY = {`,
    `  challengeKind: "text-captcha",`,
    `  charset: "${bank.charset}",`,
    "  ocrAttemptPlan: [",
    ...configuration.strategies.map((strategy) => `    ${strategyLiteral(strategy)},`),
    "  ],",
    `  solveAcceptancePolicy: ${policyLiteral(configuration.policy)},`,
    ...(configuration.threshold === null ? [] : [`  solverConfidenceThreshold: ${configuration.threshold},`]),
    `  expectedAnswerLength: ${length},`,
    "} as const;",
    "",
    `export const ${constantName(bank)}_SHAPE = {`,
    `  geometry: { width: ${geometry.width}, height: ${geometry.height} },`,
    `  answerPattern: ${answerPattern(classes, length)},`,
    "} as const;",
  ].join("\n");
}

function describePolicy(configuration: ConfigurationSummary): string {
  const count = NUMBER_WORDS[configuration.strategies.length];
  if (configuration.policy === "agreement-only") return `OCR Agreement from at least two of ${count} declared strategies; missing agreement fails closed`;
  if (configuration.policy === "confidence-or-agreement/reject") {
    return `confidence at or above ${configuration.threshold} or OCR Agreement across ${count} declared strategies, rejecting conflicts`;
  }
  return `confidence at or above ${configuration.threshold} from ${configuration.strategies.length === 1 ? "one declared strategy" : `the best of ${count} declared strategies`}`;
}

export function familySentence(
  bank: CalibrationBankSpec,
  result: ConfigurationResult,
  length: number,
  geometry: Readonly<{ width: number; height: number }>,
  classes: Evaluation["characterClasses"],
): string {
  const glyphs = classes.length === 1 && classes[0] === "digits" ? "decimal digits" : `characters from ${classes.join(", ")}`;
  return `**${bank.displayName} login CAPTCHA**: The calibrated CAPTCHA family on the ${bank.displayName} preview source: `
    + `a ${geometry.width}-by-${geometry.height}-pixel image whose answer is exactly ${NUMBER_WORDS[length] ?? length} ${glyphs}. `
    + `Automatic submission requires ${describePolicy(result.configuration)}. `
    + "A capture with different dimensions, answer length, or character set is unsupported and must not be submitted automatically.";
}

function strictness(configuration: ConfigurationSummary): number {
  return configuration.threshold ?? Number.POSITIVE_INFINITY;
}

const qualifies = (result: ConfigurationResult) =>
  result.accepted >= MIN_ACCEPTED_SAMPLES && result.falseAcceptRate <= MAX_FALSE_ACCEPT_RATE;

export function chooseConfiguration(results: readonly ConfigurationResult[], confirmed: number): ConfigurationResult | string {
  if (confirmed < MIN_CONFIRMED_LABELS) {
    return `Only ${confirmed} confirmed labels; a recommendation needs at least ${MIN_CONFIRMED_LABELS}.`;
  }
  const qualifying = results.filter(qualifies);
  if (qualifying.length === 0) {
    return `No configuration accepts at least ${MIN_ACCEPTED_SAMPLES} challenges with a false-accept rate at or below ${MAX_FALSE_ACCEPT_RATE * 100}%.`;
  }
  return qualifying.reduce((best, current) => {
    if (current.coverage !== best.coverage) return current.coverage > best.coverage ? current : best;
    const sizes = current.configuration.strategies.length - best.configuration.strategies.length;
    if (sizes !== 0) return sizes < 0 ? current : best;
    return strictness(current.configuration) > strictness(best.configuration) ? current : best;
  });
}

export function labelledItems(captures: readonly CaptureRecord[], labels: LabelsFile) {
  const items: LabelledItem[] = [];
  let missingSuggestions = 0;
  for (const capture of captures) {
    const entry = labels.entries[capture.id];
    if (!entry?.confirmed) continue;
    if (!entry.suggested) {
      missingSuggestions += 1;
      continue;
    }
    items.push({
      id: capture.id,
      truth: "answer" in entry.confirmed ? entry.confirmed.answer : null,
      candidates: new Map(entry.suggested.candidates.map((candidate) => [candidate.strategy, candidate])),
    });
  }
  return { items, missingSuggestions };
}

export async function evaluateCorpus(
  bank: CalibrationBankSpec,
  captures: readonly CaptureRecord[],
  labels: LabelsFile,
  grid: readonly CalibrationStrategy[] = STRATEGY_GRID,
): Promise<Evaluation> {
  const { items, missingSuggestions } = labelledItems(captures, labels);
  const length = expectedAnswerLength(bank, captures, items);
  const results: ConfigurationResult[] = [];
  for (const configuration of configurations(grid)) {
    results.push(await evaluateConfiguration(items, configuration, bank.charset, length?.value));
  }
  const answers = items.flatMap(({ truth }) => truth === null ? [] : [truth]);
  const classes = characterClasses(answers);
  const geometry = histogram(captures.map(({ width, height }) => `${width}x${height}`));
  const chosen = chooseConfiguration(results, items.length);
  let recommendation: Recommendation;
  if (typeof chosen === "string") {
    recommendation = { status: "refused", reason: chosen };
  } else {
    const [width, height] = Object.entries(geometry).sort(([, a], [, b]) => b - a)[0]![0].split("x").map(Number);
    const size = { width: width!, height: height! };
    recommendation = {
      status: "recommended",
      result: chosen,
      falseAcceptUpperBound: wilsonUpperBound(chosen.wrong, chosen.accepted),
      declaration: familyDeclaration(bank, chosen, length!.value, size, classes),
      familySentence: familySentence(bank, chosen, length!.value, size, classes),
    };
  }
  return {
    bank: bank.id,
    captures: captures.length,
    confirmed: items.length,
    unreadable: items.filter(({ truth }) => truth === null).length,
    missingSuggestions,
    expectedAnswerLength: length,
    geometry,
    answerLengths: histogram(answers.map((answer) => answer.length)),
    characterClasses: classes,
    singleStrategyAccuracy: grid.map(({ label }) => {
      const correct = items.filter((item) => item.truth !== null && item.candidates.get(label)?.answer === item.truth).length;
      return { strategy: label, correct, accuracy: items.length === 0 ? 0 : correct / items.length };
    }),
    results,
    agreement: pairAgreement(items, grid),
    recommendation,
  };
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

function describeConfiguration({ policy, strategies, threshold }: ConfigurationSummary): string {
  return `${policy} @ ${threshold ?? "n/a"} [${strategies.join(", ")}]`;
}

function resultLine(result: ConfigurationResult): string {
  return `  ${describeConfiguration(result.configuration)}: coverage ${percent(result.coverage)} (${result.accepted}/${result.total}), `
    + `FAR ${percent(result.falseAcceptRate)} (${result.wrong}/${result.accepted}), wrong/total ${percent(result.wrongPerTotal)}, `
    + `accuracy when accepted ${percent(result.accuracyWhenAccepted)}`;
}

export function formatEvaluation(evaluation: Evaluation, top = 15): string {
  const lines = [
    `CAPTCHA calibration evaluation: ${evaluation.bank}`,
    `Captures ${evaluation.captures}; confirmed ${evaluation.confirmed} (unreadable ${evaluation.unreadable}); confirmed without OCR suggestions ${evaluation.missingSuggestions}.`,
    `Expected answer length: ${evaluation.expectedAnswerLength ? `${evaluation.expectedAnswerLength.value} (from ${evaluation.expectedAnswerLength.basis})` : "unknown"}.`,
    `Geometry: ${Object.entries(evaluation.geometry).map(([size, count]) => `${size} x${count}`).join(", ") || "none"}.`,
    `Answer lengths: ${Object.entries(evaluation.answerLengths).map(([length, count]) => `${length} x${count}`).join(", ") || "none"}; character classes: ${evaluation.characterClasses.join(", ") || "none"}.`,
    "Agreement-only ignores the confidence threshold; it is listed once with threshold n/a.",
    "",
    "Single strategy exact accuracy (any confidence):",
    ...[...evaluation.singleStrategyAccuracy].sort((a, b) => b.correct - a.correct)
      .map(({ strategy, correct, accuracy }) => `  ${strategy}: ${percent(accuracy)} (${correct}/${evaluation.confirmed})`),
    "",
    `Top configurations with FAR <= ${percent(MAX_FALSE_ACCEPT_RATE)} and >= ${MIN_ACCEPTED_SAMPLES} accepts, by coverage:`,
  ];
  const qualifying = evaluation.results
    .filter(qualifies)
    .sort((a, b) => b.coverage - a.coverage)
    .slice(0, top);
  lines.push(...(qualifying.length > 0 ? qualifying.map(resultLine) : ["  none"]));
  lines.push("", "Most frequent OCR agreement pairs:");
  lines.push(...[...evaluation.agreement].sort((a, b) => b.agreed - a.agreed).slice(0, 10).map(({ strategies, agreed, agreedCorrect }) =>
    `  ${strategies.join(" + ")}: agreed ${agreed}/${evaluation.confirmed}, agreed answer right ${agreedCorrect}/${agreed}`));
  lines.push("");
  const { recommendation } = evaluation;
  if (recommendation.status === "refused") {
    lines.push(`No recommendation. ${recommendation.reason}`);
  } else {
    lines.push(
      "Recommendation:",
      resultLine(recommendation.result),
      `  Wilson 95% upper bound of the false-accept rate: ${percent(recommendation.falseAcceptUpperBound)}.`,
      "",
      recommendation.declaration,
      "",
      recommendation.familySentence,
    );
  }
  return `${lines.join("\n")}\n`;
}
