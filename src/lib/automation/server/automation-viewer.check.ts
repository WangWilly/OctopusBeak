import assert from "node:assert/strict";
import {
  viewerScreenshotErrorKind,
  isNestedFrameElement,
  focusHumanVerificationTarget,
  focusPointForViewerRect,
  normalizeHumanVerificationInput,
  normalizeViewerInput,
  viewerRectContainsPoint,
  clickVerificationSelectionsOnPage,
} from "./automation-viewer.ts";
import type { HumanAssistanceContract } from "../human-assistance.ts";

const unavailableAppViewerError = new Error("No active App browser page is available for this workflow run.");
assert.equal(viewerScreenshotErrorKind(unavailableAppViewerError), "unavailable");
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
