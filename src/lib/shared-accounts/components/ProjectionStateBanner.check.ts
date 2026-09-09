import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./ProjectionStateBanner.svelte", import.meta.url), "utf8");

test("projection state banner keeps awaiting and empty ahead of partial gaps", () => {
  assert.match(source, /projection\.coverage !== "complete"/);
  assert.match(source, /data-product-state=\{projection\.coverage\}/);
  assert.match(source, /safeSourceGapLabel\(gap\)/);
  assert.match(source, /sourceGapCounts\(projection\.sourceGaps\)/);
  assert.match(source, /currentPartial\(gapCounts\.currentValue, gapCounts\.sourceNotCollected\)/);
  assert.ok(source.indexOf('projection.availability === "awaiting"') < source.indexOf("projection.sourceGaps.length > 0"));
  assert.ok(source.indexOf('projection.availability === "empty"') < source.indexOf("projection.sourceGaps.length > 0"));
});
