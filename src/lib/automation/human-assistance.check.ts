import assert from "node:assert/strict";
import test from "node:test";
import {
  createHumanAssistanceContract,
  type HumanAssistanceContractInput,
} from "./human-assistance.ts";

const base: HumanAssistanceContractInput = {
  stageId: "yuanta-bank-captcha",
  title: "Complete the CAPTCHA",
  targets: [
    {
      id: "captcha-input",
      label: "CAPTCHA input",
      semanticId: "yuanta-bank.login.captcha-input",
      modes: ["type"],
      rect: { x: 10, y: 20, width: 120, height: 24 },
    },
  ],
  contextRegions: [
    {
      id: "captcha-challenge",
      label: "CAPTCHA challenge",
      semanticId: "yuanta-bank.login.captcha-challenge",
      rect: { x: 0, y: 0, width: 200, height: 80 },
    },
  ],
  completion: { mode: "inline", targetIds: ["captcha-input"] },
  focus: { targetId: "captcha-input", contextRegionIds: ["captcha-challenge"] },
};

test("a challenge declaration carries its challenge kind and solver image region", () => {
  const contract = createHumanAssistanceContract({
    ...base,
    challengeKind: "text-captcha",
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "yuanta-bank.login.captcha-image",
      rect: { x: 0, y: 0, width: 200, height: 80 },
    },
  }, 1);

  assert.equal(contract.challengeKind, "text-captcha");
  assert.deepEqual(contract.challengeImageRegion, {
    id: "captcha-image",
    label: "CAPTCHA image",
    semanticId: "yuanta-bank.login.captcha-image",
    rect: { x: 0, y: 0, width: 200, height: 80 },
  });
});

test("a declaration that omits the challenge fields is still accepted", () => {
  const contract = createHumanAssistanceContract(base, 1);
  assert.equal(contract.challengeKind, undefined);
  assert.equal(contract.challengeImageRegion, undefined);
});

test("an unknown challenge kind is rejected with a clear error", () => {
  assert.throws(
    () => createHumanAssistanceContract({ ...base, challengeKind: "slider" as never }, 1),
    /unknown challenge kind slider/,
  );
});

test("an unresolvable solver image region is rejected with a clear error", () => {
  assert.throws(
    () => createHumanAssistanceContract({
      ...base,
      challengeImageRegion: {
        id: "captcha-image",
        label: "CAPTCHA image",
        semanticId: "yuanta-bank.login.captcha-image",
        rect: { x: 0, y: 0, width: 0, height: 0 },
      },
    }, 1),
    /challenge image region yuanta-bank\.login\.captcha-image cannot be resolved/,
  );
});

test("a challenge declaration carries its character set", () => {
  const contract = createHumanAssistanceContract({
    ...base,
    charset: "digits",
  }, 1);
  assert.equal(contract.charset, "digits");
});

test("a challenge declaration carries OCR segmentation and solver policy", () => {
  const contract = createHumanAssistanceContract({
    ...base,
    challengeKind: "text-captcha",
    ocrPageSegmentationMode: "single-word",
    solverConfidenceThreshold: 0.8,
  }, 1);
  assert.equal(contract.ocrPageSegmentationMode, "single-word");
  assert.equal(contract.solverConfidenceThreshold, 0.8);
});

test("a challenge declaration carries its expected answer length", () => {
  const contract = createHumanAssistanceContract({
    ...base,
    expectedAnswerLength: 5,
  }, 1);
  assert.equal(contract.expectedAnswerLength, 5);
});

test("invalid expected answer lengths are rejected", () => {
  for (const length of [0, -1, 1.5, 33, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createHumanAssistanceContract({
        ...base,
        expectedAnswerLength: length,
      }, 1),
      /expected answer length must be a positive integer no greater than 32/,
    );
  }
});

test("unknown OCR segmentation and unsafe solver thresholds are rejected", () => {
  assert.throws(
    () => createHumanAssistanceContract({
      ...base,
      ocrPageSegmentationMode: "provider-mode" as never,
    }, 1),
    /unknown OCR page segmentation mode provider-mode/,
  );
  for (const threshold of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createHumanAssistanceContract({
        ...base,
        solverConfidenceThreshold: threshold,
      }, 1),
      /solver confidence threshold must be finite and between 0 and 1/,
    );
  }
});

test("an unknown challenge character set is rejected with a clear error", () => {
  assert.throws(
    () => createHumanAssistanceContract({ ...base, charset: "hex" as never }, 1),
    /unknown challenge character set hex/,
  );
});

test("a challenge declaration carries its image preprocessing modes", () => {
  const contract = createHumanAssistanceContract({
    ...base,
    imagePreprocessing: ["remove-interference-lines"],
  }, 1);
  assert.deepEqual(contract.imagePreprocessing, ["remove-interference-lines"]);
});

test("a challenge declaration carries a bounded ordered OCR attempt plan", () => {
  const contract = createHumanAssistanceContract({
    ...base,
    challengeKind: "text-captcha",
    ocrAttemptPlan: [
      { ocrPageSegmentationMode: "single-word" },
      {
        imagePreprocessing: [],
        ocrOutputStage: "grayscale",
        ocrPageSegmentationMode: "single-line",
      },
      {
        imagePreprocessing: [],
        ocrOutputStage: "final",
        ocrPageSegmentationMode: "single-line",
      },
    ],
  }, 1);
  assert.deepEqual(contract.ocrAttemptPlan, [
    { ocrPageSegmentationMode: "single-word" },
    {
      imagePreprocessing: [],
      ocrOutputStage: "grayscale",
      ocrPageSegmentationMode: "single-line",
    },
    {
      imagePreprocessing: [],
      ocrOutputStage: "final",
      ocrPageSegmentationMode: "single-line",
    },
  ]);
});

test("duplicate or oversized OCR attempt plans are rejected", () => {
  assert.throws(
    () => createHumanAssistanceContract({
      ...base,
      ocrAttemptPlan: [{ ocrPageSegmentationMode: "single-word" }],
    }, 1),
    /OCR attempt plan requires a text CAPTCHA challenge/,
  );
  assert.throws(
    () => createHumanAssistanceContract({
      ...base,
      challengeKind: "text-captcha",
      ocrAttemptPlan: [
        { ocrPageSegmentationMode: "single-word" },
        { ocrPageSegmentationMode: "single-word" },
      ],
    }, 1),
    /OCR attempt plan strategies must be distinct/,
  );
  assert.throws(
    () => createHumanAssistanceContract({
      ...base,
      challengeKind: "text-captcha",
      ocrAttemptPlan: [
        { ocrPageSegmentationMode: "single-line" },
        { ocrOutputStage: "final" },
      ],
    }, 1),
    /OCR attempt plan strategies must be distinct/,
  );
  assert.throws(
    () => createHumanAssistanceContract({
      ...base,
      challengeKind: "text-captcha",
      ocrAttemptPlan: [
        { ocrPageSegmentationMode: "single-line" },
        { ocrPageSegmentationMode: "single-word" },
        { ocrPageSegmentationMode: "raw-line" },
        { ocrOutputStage: "grayscale" },
      ],
    }, 1),
    /OCR attempt plan cannot contain more than 3 strategies/,
  );
});

test("an unknown image preprocessing mode is rejected with a clear error", () => {
  assert.throws(
    () => createHumanAssistanceContract({
      ...base,
      imagePreprocessing: ["provider-magic" as never],
    }, 1),
    /unknown image preprocessing mode provider-magic/,
  );
});

test("a challenge declaration carries its prompt", () => {
  const contract = createHumanAssistanceContract({
    ...base,
    prompt: "選取包含紅綠燈的圖片",
  }, 1);
  assert.equal(contract.prompt, "選取包含紅綠燈的圖片");
});

test("an empty prompt is rejected with a clear error", () => {
  assert.throws(
    () => createHumanAssistanceContract({ ...base, prompt: "  " }, 1),
    /prompt must be non-empty/,
  );
});

test("a solver image region missing its geometry is rejected with a clear error", () => {
  assert.throws(
    () => createHumanAssistanceContract({
      ...base,
      challengeImageRegion: {
        id: "captcha-image",
        label: "CAPTCHA image",
        semanticId: "yuanta-bank.login.captcha-image",
        rect: null as never,
      },
    }, 1),
    /challenge image region yuanta-bank\.login\.captcha-image cannot be resolved/,
  );
});
