import assert from "node:assert/strict";
import {
  isClosedViewerSessionError,
  isNestedFrameElement,
  humanAssistanceCompletionSatisfied,
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
  shouldAutoResumeYuantaTradeCaptcha,
  shouldCheckYuantaTradeCompletion,
  VIEWER_SCREENSHOT_OPTIONS,
  viewerRectContainsPoint,
  YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR,
  YUANTA_TRADE_CAPTCHA_CHECKBOX_SELECTOR,
  YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR,
} from "./automation-viewer.ts";
import type { HumanAssistanceContract } from "../human-assistance.ts";
import {
  YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR as sharedChallengeSelector,
  YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR as sharedSubmitSelector,
} from "../yuanta-trade-captcha.ts";

assert.deepEqual(VIEWER_SCREENSHOT_OPTIONS, {
  type: "jpeg",
  quality: 72,
  animations: "disabled",
  scale: "css",
});

assert.equal(isClosedViewerSessionError(new Error("browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:57930")), true);
assert.equal(isClosedViewerSessionError(new Error("No CDP endpoint available for Libretto session ses-ist4.")), true);
assert.equal(isClosedViewerSessionError(new Error("Unsupported viewer input.")), false);
assert.equal(isNestedFrameElement("IFRAME"), true);
assert.equal(isNestedFrameElement("FRAME"), true);
assert.equal(isNestedFrameElement("DIV"), false);
assert.equal(YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR, sharedChallengeSelector);
assert.equal(YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR, sharedSubmitSelector);

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
assert.equal(
  humanAssistanceCompletionSatisfied("yuanta-trade.login.captcha-checkbox", {
    checkboxChecked: true,
    challengeVisible: true,
    challengeSubmitVisible: false,
  }),
  true,
);
assert.equal(
  humanAssistanceCompletionSatisfied("yuanta-trade.login.captcha-checkbox", {
    checkboxChecked: false,
    challengeVisible: true,
    challengeSubmitVisible: false,
  }),
  true,
);
assert.equal(
  shouldCheckYuantaTradeCompletion("click", "yuanta-trade.login.challenge-control"),
  false,
);
assert.equal(
  shouldCheckYuantaTradeCompletion("click", "yuanta-trade.login.challenge-submit"),
  true,
);
assert.equal(
  shouldCheckYuantaTradeCompletion("type", "yuanta-trade.login.challenge-submit"),
  false,
);
assert.equal(
  humanAssistanceCompletionSatisfied("yuanta-trade.login.challenge-control", {
    checkboxChecked: true,
    challengeVisible: true,
    challengeSubmitVisible: false,
  }),
  false,
);
assert.equal(
  humanAssistanceCompletionSatisfied("yuanta-trade.login.challenge-control", {
    checkboxChecked: true,
    challengeVisible: true,
    challengeSubmitVisible: true,
  }),
  false,
);
assert.equal(
  humanAssistanceCompletionSatisfied("yuanta-trade.login.challenge-control", {
    checkboxChecked: true,
    challengeVisible: false,
    challengeSubmitVisible: false,
  }),
  true,
);
assert.equal(
  humanAssistanceCompletionSatisfied("yuanta-trade.login.challenge-submit", {
    checkboxChecked: true,
    challengeVisible: false,
    challengeSubmitVisible: false,
  }),
  true,
);
assert.equal(
  humanAssistanceCompletionSatisfied("unknown.semantic-id", {
    checkboxChecked: true,
    challengeVisible: false,
    challengeSubmitVisible: false,
  }),
  false,
);
assert.equal(
  shouldAutoResumeYuantaTradeCaptcha({
    ...humanContract,
    stageId: "yuanta-trade-captcha-checkbox",
    completion: { mode: "independent", targetIds: ["captcha-input"], status: "verified" },
    targets: [{
      ...humanContract.targets[0]!,
      semanticId: "yuanta-trade.login.captcha-checkbox",
      modes: ["click"],
    }],
  }, "captcha-input", true),
  true,
);
assert.equal(
  shouldAutoResumeYuantaTradeCaptcha({
    ...humanContract,
    stageId: "yuanta-trade-captcha-checkbox",
    completion: { mode: "independent", targetIds: ["captcha-input"], status: "pending" },
    targets: [{
      ...humanContract.targets[0]!,
      semanticId: "yuanta-trade.login.captcha-checkbox",
      modes: ["click"],
    }],
  }, "captcha-input", false),
  false,
);
assert.equal(
  shouldAutoResumeYuantaTradeCaptcha({
    ...humanContract,
    completion: { mode: "independent", targetIds: ["captcha-input"], status: "verified" },
  }, "captcha-input", true),
  false,
);
assert.equal(YUANTA_TRADE_CAPTCHA_CHECKBOX_SELECTOR, "#chbYCaptchaV2");
assert.equal(
  YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR,
  "#modalYCaptchaV2, #captchaModal, .captcha-modal",
);
assert.equal(
  YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR,
  'button:has-text("驗證"), input[value*="驗"], [role="button"]:has-text("驗證"), a:has-text("驗證"), [aria-label*="驗"]',
);
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
