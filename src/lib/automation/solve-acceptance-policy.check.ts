import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSolveAcceptancePolicy,
  selectAcceptedSolveCandidate,
  type SolveAcceptanceCandidate,
  type SolveAcceptancePolicy,
} from "./solve-acceptance-policy.ts";
import { createHumanAssistanceContract } from "./human-assistance.ts";

type Answer = { answer: string };

const candidate = (
  answer: string,
  confidence: number,
  strategyFingerprint: string,
): SolveAcceptanceCandidate<Answer> => ({
  value: { answer },
  confidence,
  strategyFingerprint,
});

function select(
  policy: SolveAcceptancePolicy | undefined,
  candidates: readonly SolveAcceptanceCandidate<Answer>[],
  strategyCount = candidates.length,
) {
  return selectAcceptedSolveCandidate(candidates, policy, {
    challengeKind: "text-captcha",
    strategyCount,
    confidenceThreshold: 0.9,
    identityKey: ({ answer }) => answer,
    agreementKey: ({ answer }) => answer,
  });
}

test("solve acceptance policy modes select their declared evidence", () => {
  const cases: Array<{
    name: string;
    policy: SolveAcceptancePolicy;
    candidates: readonly SolveAcceptanceCandidate<Answer>[];
    expectedAnswer: string | null;
  }> = [
    {
      name: "confidence-only accepts the strongest eligible candidate",
      policy: { mode: "confidence-only" },
      candidates: [candidate("1111", 0.91, "raw"), candidate("2222", 0.98, "cleaned")],
      expectedAnswer: "2222",
    },
    {
      name: "agreement-only accepts matching strategies below threshold",
      policy: { mode: "agreement-only" },
      candidates: [candidate("1234", 0.55, "raw"), candidate("1234", 0.7, "cleaned")],
      expectedAnswer: "1234",
    },
    {
      name: "confidence-or-agreement accepts the shared answer",
      policy: { mode: "confidence-or-agreement", conflictResolution: "reject" },
      candidates: [candidate("1234", 0.95, "raw"), candidate("1234", 0.7, "cleaned")],
      expectedAnswer: "1234",
    },
  ];

  for (const testCase of cases) {
    const result = select(testCase.policy, testCase.candidates);
    assert.equal(result.ambiguous, false, testCase.name);
    assert.equal(result.candidate?.value.answer ?? null, testCase.expectedAnswer, testCase.name);
  }
});

test("ambiguous evidence is fail-closed", () => {
  const result = select(
    { mode: "confidence-or-agreement", conflictResolution: "reject" },
    [
      candidate("1111", 0.6, "raw"),
      candidate("1111", 0.7, "cleaned"),
      candidate("2222", 0.65, "alternate"),
      candidate("2222", 0.66, "alternate-cleaned"),
    ],
  );
  assert.equal(result.candidate, null);
  assert.equal(result.ambiguous, true);
});

test("conflicting confidence and agreement obey the selected resolution", () => {
  const candidates = [
    candidate("1111", 0.7, "raw"),
    candidate("1111", 0.72, "cleaned"),
    candidate("2222", 0.95, "alternate"),
  ];
  const cases: Array<["reject" | "prefer-agreement" | "prefer-confidence", string | null]> = [
    ["reject", null],
    ["prefer-agreement", "1111"],
    ["prefer-confidence", "2222"],
  ];
  for (const [conflictResolution, expectedAnswer] of cases) {
    const result = select(
      { mode: "confidence-or-agreement", conflictResolution },
      candidates,
    );
    assert.equal(result.candidate?.value.answer ?? null, expectedAnswer, conflictResolution);
    assert.equal(result.ambiguous, conflictResolution === "reject", conflictResolution);
  }
});

test("contract creation and runtime selection share policy configuration validity", () => {
  const invalidPolicy = { mode: "agreement-only" } as const;
  assert.throws(
    () => assertSolveAcceptancePolicy(invalidPolicy, {
      challengeKind: "text-captcha",
      strategyCount: 1,
    }),
    /OCR agreement requires at least two distinct strategies/,
  );
  assert.throws(
    () => createHumanAssistanceContract({
      stageId: "captcha",
      title: "CAPTCHA",
      targets: [{
        id: "answer",
        label: "Answer",
        semanticId: "captcha.answer",
        modes: ["type"],
      }],
      contextRegions: [],
      completion: { mode: "inline", targetIds: ["answer"] },
      focus: { targetId: "answer", contextRegionIds: [] },
      challengeKind: "text-captcha",
      solveAcceptancePolicy: invalidPolicy,
    }, 1),
    /OCR agreement requires at least two distinct strategies/,
  );
});
