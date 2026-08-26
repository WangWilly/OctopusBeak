import assert from "node:assert/strict";
import {
  isClosedViewerSessionError,
  viewerScreenshotErrorKind,
  isNestedFrameElement,
  humanVerificationTargetAtPoint,
  focusHumanVerificationTarget,
  focusPointForViewerRect,
  inspectableFromElement,
  isInspectableTextTarget,
  normalizeHumanVerificationInput,
  normalizeViewerInput,
  normalizeViewerPoint,
  refreshTargetRect,
  selectAllShortcut,
  selectViewerPage,
  VIEWER_SCREENSHOT_OPTIONS,
  viewerRectContainsPoint,
  clickVerificationSelectionsOnPage,
} from "./automation-viewer.ts";
import type { HumanAssistanceContract } from "../human-assistance.ts";

assert.deepEqual(VIEWER_SCREENSHOT_OPTIONS, {
  type: "jpeg",
  quality: 72,
  animations: "disabled",
  scale: "css",
});

assert.equal(isClosedViewerSessionError(new Error("browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:57930")), true);
assert.equal(isClosedViewerSessionError(new Error("No CDP endpoint available for Libretto session ses-ist4.")), true);
assert.equal(isClosedViewerSessionError(new Error("Unsupported viewer input.")), false);
assert.equal(viewerScreenshotErrorKind(new Error("No CDP endpoint available for Libretto session ses-ist4.")), "unavailable");
assert.equal(viewerScreenshotErrorKind(new Error("browserType.connectOverCDP: socket hang up")), "transient");
assert.equal(viewerScreenshotErrorKind(new Error("Unexpected screenshot failure")), "failed");
assert.equal(isNestedFrameElement("IFRAME"), true);
assert.equal(isNestedFrameElement("FRAME"), true);
assert.equal(isNestedFrameElement("DIV"), false);

assert.deepEqual(
  normalizeViewerInput({ type: "click", x: 10.2, y: 20.8 }),
  { type: "click", x: 10, y: 21 },
);

assert.deepEqual(
  normalizeViewerInput({ type: "drag", x: 1, y: 2, toX: 100, toY: 80 }),
  { type: "drag", x: 1, y: 2, toX: 100, toY: 80 },
);

assert.deepEqual(
  normalizeViewerInput({ type: "type", text: "123456" }),
  { type: "type", text: "123456" },
);

assert.deepEqual(
  normalizeViewerInput({ type: "press", key: "Enter" }),
  { type: "press", key: "Enter" },
);

assert.deepEqual(
  normalizeViewerInput({ type: "press", key: "ArrowRight" }),
  { type: "press", key: "ArrowRight" },
);

assert.equal(selectAllShortcut("darwin"), "Meta+A");
assert.equal(selectAllShortcut("linux"), "Control+A");
assert.equal(selectAllShortcut("win32"), "Control+A");

assert.deepEqual(normalizeViewerPoint({ x: 4.4, y: 9.6 }), { x: 4, y: 10 });
assert.throws(() => normalizeViewerPoint({ x: 1 }));

assert.equal(isInspectableTextTarget({ tagName: "INPUT", type: "text", editable: false, disabled: false, readOnly: false }), true);
assert.equal(isInspectableTextTarget({ tagName: "TEXTAREA", type: "", editable: false, disabled: false, readOnly: false }), true);
assert.equal(isInspectableTextTarget({ tagName: "DIV", type: "", editable: true, disabled: false, readOnly: false }), true);
assert.equal(isInspectableTextTarget({ tagName: "INPUT", type: "checkbox", editable: false, disabled: false, readOnly: false }), false);
assert.equal(isInspectableTextTarget({ tagName: "INPUT", type: "text", editable: false, disabled: true, readOnly: false }), false);

const inspectableElementCalls: string[] = [];
const inspectableElement = {
  async evaluate() {
    inspectableElementCalls.push("evaluate");
    return {
      tagName: "INPUT",
      type: "text",
      editable: false,
      disabled: false,
      readOnly: false,
      visible: true,
      rect: { x: 700, y: 386, width: 96, height: 28 },
    };
  },
};
assert.deepEqual(
  await inspectableFromElement(inspectableElement as never),
  {
    tagName: "INPUT",
    type: "text",
    editable: false,
    disabled: false,
    readOnly: false,
    rect: { x: 700, y: 386, width: 96, height: 28 },
  },
);
assert.deepEqual(
  await inspectableFromElement(inspectableElement as never, { x: 10, y: 20 }),
  {
    tagName: "INPUT",
    type: "text",
    editable: false,
    disabled: false,
    readOnly: false,
    rect: { x: 710, y: 406, width: 96, height: 28 },
  },
);
assert.deepEqual(inspectableElementCalls, ["evaluate", "evaluate"]);

assert.throws(() => normalizeViewerInput({ type: "click", x: -1, y: 0 }));
assert.throws(() => normalizeViewerInput({ type: "drag", x: 0, y: 0, toX: 1 }));
assert.throws(() => normalizeViewerInput({ type: "type", text: "" }));
assert.throws(() => normalizeViewerInput({ type: "type", text: "x".repeat(129) }));
assert.throws(() => normalizeViewerInput({ type: "press", key: "" }));
assert.throws(() => normalizeViewerInput({ type: "press", key: "Meta+R" }));

const humanContract: HumanAssistanceContract = {
  schemaVersion: 1,
  version: 3,
  stageId: "captcha",
  title: "Complete CAPTCHA",
  targets: [{
    id: "captcha-input",
    label: "CAPTCHA input",
    semanticId: "captcha.input",
    modes: ["click", "type"],
    rect: { x: 700, y: 386, width: 96, height: 96 },
  }],
  contextRegions: [],
  completion: { mode: "inline", targetIds: ["captcha-input"], status: "pending" },
  focus: { targetId: "captcha-input", contextRegionIds: [] },
};

assert.equal(viewerRectContainsPoint(humanContract.targets[0]!.rect!, { x: 724, y: 400 }), true);
assert.equal(viewerRectContainsPoint(humanContract.targets[0]!.rect!, { x: 810, y: 400 }), false);
assert.deepEqual(
  focusPointForViewerRect(humanContract.targets[0]!.rect!),
  { x: 748, y: 434 },
);
assert.deepEqual(
  refreshTargetRect(humanContract, "captcha.input", { x: 700, y: 439, width: 96, height: 96 }),
  {
    stageId: "captcha",
    title: "Complete CAPTCHA",
    targets: [{ ...humanContract.targets[0]!, rect: { x: 700, y: 439, width: 96, height: 96 } }],
    contextRegions: [],
    completion: humanContract.completion,
    focus: humanContract.focus,
  },
);
assert.equal(
  refreshTargetRect(humanContract, "captcha.input", humanContract.targets[0]!.rect!),
  null,
);
const metadataContract: HumanAssistanceContract = {
  ...humanContract,
  challengeKind: "text-captcha",
  challengeImageRegion: {
    id: "challenge-image",
    label: "Challenge image",
    semanticId: "captcha.challenge-image",
    rect: { x: 800, y: 300, width: 120, height: 48 },
  },
  charset: "digits",
  imagePreprocessing: ["remove-interference-lines"],
  ocrPageSegmentationMode: "single-word",
  solverConfidenceThreshold: 0.8,
  expectedAnswerLength: 5,
  prompt: "Enter the digits shown.",
};
const refreshedMetadataContract = refreshTargetRect(
  metadataContract,
  "captcha.input",
  { x: 700, y: 440, width: 96, height: 96 },
);
assert.equal(refreshedMetadataContract?.challengeKind, "text-captcha");
assert.deepEqual(refreshedMetadataContract?.challengeImageRegion, metadataContract.challengeImageRegion);
assert.equal(refreshedMetadataContract?.charset, "digits");
assert.deepEqual(refreshedMetadataContract?.imagePreprocessing, [
  "remove-interference-lines",
]);
assert.equal(refreshedMetadataContract?.ocrPageSegmentationMode, "single-word");
assert.equal(refreshedMetadataContract?.solverConfidenceThreshold, 0.8);
assert.equal(refreshedMetadataContract?.expectedAnswerLength, 5);
assert.equal(refreshedMetadataContract?.prompt, "Enter the digits shown.");

const focusCalls: Array<[number, number]> = [];
await focusHumanVerificationTarget({
  evaluate: async () => false,
  mouse: {
    click: async (x: number, y: number) => {
      focusCalls.push([x, y]);
    },
  },
} as never, humanContract.targets[0]!);
assert.deepEqual(focusCalls, [[748, 434]]);
await focusHumanVerificationTarget({
  evaluate: async () => true,
  mouse: {
    click: async () => {
      throw new Error("Top-level DOM focus must not issue a pointer click.");
    },
  },
} as never, humanContract.targets[0]!);
await assert.rejects(
  () => focusHumanVerificationTarget({ evaluate: async () => false, mouse: { click: async () => {} } } as never, {
    ...humanContract.targets[0]!,
    modes: ["type"],
  }),
  /does not permit pointer focus/,
);
assert.equal(
  humanVerificationTargetAtPoint(humanContract, { x: 724, y: 400 })?.id,
  "captcha-input",
);
assert.equal(humanVerificationTargetAtPoint(humanContract, { x: 810, y: 400 }), null);
assert.deepEqual(
  normalizeHumanVerificationInput({
    type: "click",
    x: 724,
    y: 400,
    targetId: "captcha-input",
    contractVersion: 3,
  }, humanContract),
  { type: "click", x: 724, y: 400 },
);
assert.throws(
  () => normalizeHumanVerificationInput({
    type: "click",
    x: 810,
    y: 400,
    targetId: "captcha-input",
    contractVersion: 3,
  }, humanContract),
  /outside the declared human verification target/,
);
assert.throws(
  () => normalizeHumanVerificationInput({
    type: "drag",
    x: 724,
    y: 400,
    toX: 800,
    toY: 400,
    targetId: "captcha-input",
    contractVersion: 3,
  }, humanContract),
  /mode is not allowed/,
);
assert.throws(
  () => normalizeHumanVerificationInput({
    type: "click",
    x: 724,
    y: 400,
    targetId: "captcha-input",
    contractVersion: 2,
  }, humanContract),
  /contract is stale/,
);

assert.equal(selectViewerPage([
  { url: () => "https://first.example" },
  { url: () => "about:blank" },
  { url: () => "chrome://new-tab-page" },
  { url: () => "chrome-error://chromewebdata/" },
  { url: () => "devtools://devtools/bundled/inspector.html" },
  { url: () => "https://last.example" },
])?.url(), "https://last.example");

const selectionClicks: Array<[number, number]> = [];
await clickVerificationSelectionsOnPage({
  mouse: {
    click: async (x: number, y: number) => {
      selectionClicks.push([x, y]);
    },
  },
} as never, { x: 100, y: 200, width: 300, height: 200 }, [
  { x: 10, y: 20 },
  { x: 50.6, y: 80.4 },
]);
assert.deepEqual(selectionClicks, [[110, 220], [151, 280]]);
