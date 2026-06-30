import assert from "node:assert/strict";
import { normalizeViewerInput, selectViewerPage } from "./automation-viewer.ts";

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

assert.equal(selectViewerPage([
  { url: () => "https://first.example" },
  { url: () => "about:blank" },
  { url: () => "chrome://new-tab-page" },
  { url: () => "chrome-error://chromewebdata/" },
  { url: () => "devtools://devtools/bundled/inspector.html" },
  { url: () => "https://last.example" },
])?.url(), "https://last.example");
