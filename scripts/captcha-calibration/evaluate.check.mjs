import assert from "node:assert/strict";
import test from "node:test";
import { CALIBRATION_BANK_SPECS } from "./banks.ts";
import {
  chooseConfiguration,
  configurations,
  evaluateCorpus,
  formatEvaluation,
  wilsonUpperBound,
} from "./evaluate.ts";
import { STRATEGY_GRID } from "./strategies.ts";

const [A, B, C] = STRATEGY_GRID;
const GRID = [A, B, C];
const mega = CALIBRATION_BANK_SPECS.mega;

/** rows: [truth or null for unreadable, [answer, confidence] for A, B, C] */
function corpus(rows) {
  const captures = [];
  const entries = {};
  rows.forEach(([truth, ...answers], index) => {
    const id = `capture-${index}`;
    captures.push({ id, file: `images/${id}.png`, capturedAt: "t", width: 100, height: 30, sourceMediaType: "image/png", method: "preview-source" });
    entries[id] = {
      suggested: {
        at: "t",
        answer: "",
        agreementCount: 0,
        candidates: GRID.map(({ label }, slot) => ({ strategy: label, answer: answers[slot][0], confidence: answers[slot][1] })),
      },
      confirmed: truth === null ? { unreadable: true, at: "t" } : { answer: truth, at: "t" },
    };
  });
  return { captures, labels: { version: 1, bank: "mega", entries } };
}

const find = (evaluation, policy, strategies, threshold) => evaluation.results.find((result) =>
  result.configuration.policy === policy
  && result.configuration.threshold === threshold
  && result.configuration.strategies.join() === strategies.map(({ label }) => label).join());

const SMALL = [
  ["11111", ["11111", 0.9], ["11111", 0.6], ["22222", 0.95]],
  ["33333", ["33333", 0.7], ["44444", 0.8], ["33333", 0.5]],
  [null, ["55555", 0.99], ["55555", 0.6], ["", 0]],
  ["66666", ["6666", 0.99], ["66666", 0.55], ["66666", 0.52]],
];

test("coverage, false-accept rate, and accuracy follow the production solver per threshold", async () => {
  const { captures, labels } = corpus(SMALL);
  const evaluation = await evaluateCorpus(mega, captures, labels, GRID);

  const pick = (threshold) => {
    const { accepted, correct, wrong, coverage, falseAcceptRate, wrongPerTotal, accuracyWhenAccepted } = find(evaluation, "confidence-only", [A], threshold);
    return { accepted, correct, wrong, coverage, falseAcceptRate, wrongPerTotal, accuracyWhenAccepted };
  };
  assert.deepEqual(pick(0.5), { accepted: 3, correct: 2, wrong: 1, coverage: 0.75, falseAcceptRate: 1 / 3, wrongPerTotal: 0.25, accuracyWhenAccepted: 2 / 3 });
  assert.deepEqual(pick(0.75), { accepted: 2, correct: 1, wrong: 1, coverage: 0.5, falseAcceptRate: 0.5, wrongPerTotal: 0.25, accuracyWhenAccepted: 0.5 });
  assert.deepEqual(pick(0.95), { accepted: 1, correct: 0, wrong: 1, coverage: 0.25, falseAcceptRate: 1, wrongPerTotal: 0.25, accuracyWhenAccepted: 0 });

  const agreementAB = find(evaluation, "agreement-only", [A, B], null);
  assert.deepEqual([agreementAB.accepted, agreementAB.correct, agreementAB.wrong], [2, 1, 1], "the agreed unreadable image is a false accept");
  const agreementABC = find(evaluation, "agreement-only", [A, B, C], null);
  assert.deepEqual([agreementABC.accepted, agreementABC.correct, agreementABC.wrong], [4, 3, 1], "a wrong-length candidate cannot agree");
  const rejectAC = find(evaluation, "confidence-or-agreement/reject", [A, C], 0.9);
  assert.deepEqual([rejectAC.accepted, rejectAC.correct, rejectAC.wrong], [3, 1, 2]);

  assert.deepEqual(evaluation.singleStrategyAccuracy.map(({ correct }) => correct), [2, 2, 2]);
  assert.equal(evaluation.singleStrategyAccuracy[0].accuracy, 0.5);
  assert.deepEqual(evaluation.agreement.map(({ agreed, agreedCorrect }) => [agreed, agreedCorrect]), [[2, 1], [1, 1], [1, 1]]);
  assert.deepEqual(evaluation.expectedAnswerLength, { value: 5, basis: "source" });
  assert.deepEqual(evaluation.geometry, { "100x30": 4 });
  assert.deepEqual(evaluation.answerLengths, { 5: 3 });
  assert.deepEqual(evaluation.characterClasses, ["digits"]);
  assert.equal(evaluation.unreadable, 1);
  assert.equal(evaluation.recommendation.status, "refused");
  assert.match(evaluation.recommendation.reason, /Only 4 confirmed labels/u);
});

test("agreement-only appears once per strategy set and every pair and triple is covered", () => {
  const all = configurations(GRID);
  assert.equal(all.filter(({ policy }) => policy === "agreement-only").length, 4);
  assert.equal(all.filter(({ policy, strategies }) => policy === "confidence-only" && strategies.length === 1).length, 3 * 12);
  assert.equal(configurations().length, 18 * 12 + (153 + 816) * (12 + 1 + 12));
});

function recommendationRows() {
  const rows = [];
  for (let index = 0; index < 30; index += 1) {
    const truth = String(10000 + index);
    rows.push([truth, [truth, 0.96], [truth, 0.7], ["99999", 0.4]]);
  }
  for (let index = 0; index < 8; index += 1) {
    const truth = String(20000 + index);
    rows.push([truth, ["88888", 0.8], [truth, 0.7], [truth, 0.6]]);
  }
  rows.push([null, ["12121", 0.6], ["34343", 0.55], ["56565", 0.5]]);
  rows.push([null, ["12121", 0.6], ["34343", 0.55], ["56565", 0.5]]);
  return rows;
}

test("the recommendation maximizes coverage under 2% false accepts, then fewer strategies, then a higher threshold", async () => {
  const { captures, labels } = corpus(recommendationRows());
  const evaluation = await evaluateCorpus(mega, captures, labels, GRID);
  const { recommendation } = evaluation;

  assert.equal(recommendation.status, "recommended");
  assert.equal(recommendation.result.configuration.policy, "confidence-only");
  assert.deepEqual(recommendation.result.configuration.strategies, [B.label]);
  assert.equal(recommendation.result.configuration.threshold, 0.7);
  assert.deepEqual([recommendation.result.accepted, recommendation.result.wrong], [38, 0]);
  assert.ok(Math.abs(recommendation.falseAcceptUpperBound - 0.0918) < 0.0005);
  assert.match(recommendation.declaration, /solveAcceptancePolicy: \{ mode: "confidence-only" \},/u);
  assert.match(recommendation.declaration, /solverConfidenceThreshold: 0\.7,/u);
  assert.match(recommendation.declaration, /expectedAnswerLength: 5,/u);
  assert.ok(recommendation.declaration.includes(`ocrPageSegmentationMode: "${B.strategy.ocrPageSegmentationMode}"`));
  assert.ok(recommendation.declaration.includes("geometry: { width: 100, height: 30 }"));
  assert.ok(recommendation.declaration.includes("answerPattern: /^\\d{5}$/u"));
  assert.match(recommendation.familySentence, /^\*\*Mega Bank login CAPTCHA\*\*: .*100-by-30-pixel image whose answer is exactly five decimal digits/u);
  assert.match(formatEvaluation(evaluation), /Wilson 95% upper bound of the false-accept rate: 9\.2%/u);
});

test("the recommendation refuses when nothing stays under 2% false accepts", async () => {
  const rows = recommendationRows().map(([truth, a, b, c]) => truth === null ? [truth, a, b, c] : [truth, ["77777", 0.99], ["77777", 0.99], ["77777", 0.99]]);
  const { captures, labels } = corpus(rows);
  const { recommendation } = await evaluateCorpus(mega, captures, labels, GRID);
  assert.equal(recommendation.status, "refused");
  assert.match(recommendation.reason, /No configuration accepts at least 20 challenges/u);
});

test("the recommendation needs enough confirmed labels and accepted samples", () => {
  const result = (accepted, wrong, total) => ({
    configuration: { policy: "confidence-only", strategies: [A.label], threshold: 0.9 },
    total,
    accepted,
    correct: accepted - wrong,
    wrong,
    coverage: accepted / total,
    falseAcceptRate: wrong / accepted,
    wrongPerTotal: wrong / total,
    accuracyWhenAccepted: (accepted - wrong) / accepted,
  });
  assert.match(chooseConfiguration([result(29, 0, 29)], 29), /Only 29 confirmed labels/u);
  assert.match(chooseConfiguration([result(19, 0, 40)], 40), /No configuration/u);
  const fifty = result(50, 1, 60);
  assert.equal(chooseConfiguration([result(19, 0, 40), fifty, result(55, 2, 60)], 60), fifty, "2/55 is above 2%; 1/50 is exactly 2%");
});

test("the Wilson upper bound matches the closed form", () => {
  assert.equal(wilsonUpperBound(0, 0), 1);
  assert.ok(Math.abs(wilsonUpperBound(1, 50) - 0.1050) < 0.0005);
});
