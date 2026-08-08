import assert from "node:assert/strict";
import {
  isClosedViewerSessionError,
  humanVerificationTargetAtPoint,
  isInspectableTextTarget,
  normalizeHumanVerificationInput,
  normalizeViewerInput,
  normalizeViewerPoint,
  selectInspectableTextTarget,
  selectAllShortcut,
  selectViewerPage,
  viewerRectContainsPoint,
} from "./automation-viewer.ts";
import type { HumanAssistanceContract } from "../human-assistance.ts";

assert.equal(isClosedViewerSessionError(new Error("browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:57930")), true);
assert.equal(isClosedViewerSessionError(new Error("No CDP endpoint available for Libretto session ses-ist4.")), true);
assert.equal(isClosedViewerSessionError(new Error("Unsupported viewer input.")), false);

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

assert.deepEqual(
  selectInspectableTextTarget([
    {
      tagName: "INPUT",
      type: "text",
      editable: false,
      disabled: false,
      readOnly: false,
      rect: { x: 700, y: 386, width: 96, height: 28 },
    },
  ], { x: 724, y: 400 }),
  {
    tagName: "INPUT",
    type: "text",
    editable: false,
    disabled: false,
    readOnly: false,
    rect: { x: 700, y: 386, width: 96, height: 28 },
  },
);

assert.equal(
  selectInspectableTextTarget([
    {
      tagName: "INPUT",
      type: "text",
      editable: false,
      disabled: false,
      readOnly: false,
      rect: { x: 700, y: 386, width: 96, height: 28 },
    },
  ], { x: 810, y: 400 }),
  null,
);

assert.equal(
  selectInspectableTextTarget([
    {
      tagName: "INPUT",
      type: "text",
      editable: false,
      disabled: false,
      readOnly: false,
      rect: { x: 700, y: 386, width: 96, height: 28 },
    },
  ], { x: 810, y: 426 }),
  null,
);

assert.equal(
  selectInspectableTextTarget([
    {
      tagName: "INPUT",
      type: "text",
      editable: false,
      disabled: false,
      readOnly: false,
      rect: { x: 700, y: 386, width: 96, height: 28 },
    },
  ], { x: 810, y: 460 }),
  null,
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
