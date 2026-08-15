import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync(
  new URL("../src/lib/automation/AutomationDashboard.svelte", import.meta.url),
  "utf8",
);
const start = source.indexOf("function viewerPointFromTransformedImage");
assert.notEqual(start, -1, "the viewer must expose a transformed-image mapping helper");
const end = source.indexOf("\n  function floatingInputAnchor", start);
assert.notEqual(end, -1, "the viewer mapping helper must precede its anchor helper");
const helperSource = stripTypeScriptTypes(source.slice(start, end));
const viewerPointFromTransformedImage = new Function(
  `${helperSource}; return viewerPointFromTransformedImage;`,
)();

const geometry = {
  imageRect: { left: 35.979583740234375, top: 105.109375, width: 1200.5999755859375, height: 662.3999633789062 },
  clientWidth: 1044,
  clientHeight: 576,
  naturalWidth: 1366,
  naturalHeight: 768,
};

const target = { x: 589.03125, y: 487.5, width: 122, height: 35 };
for (const [clientX, clientY] of [[554, 526], [558, 528], [660, 553]]) {
  const point = viewerPointFromTransformedImage({ clientX, clientY }, geometry);
  assert.ok(point, `mapping should resolve (${clientX}, ${clientY})`);
  assert.ok(point.x >= target.x && point.x <= target.x + target.width, `x mapping for (${clientX}, ${clientY})`);
  assert.ok(point.y >= target.y && point.y <= target.y + target.height, `y mapping for (${clientX}, ${clientY})`);
}

