import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./ProjectionStateBanner.svelte", import.meta.url), "utf8");

test("projection state banner explains only awaiting and unavailable pages", () => {
  assert.match(source, /projection\.coverage === "awaiting" \|\| projection\.coverage === "unavailable"/);
  assert.match(source, /data-product-state=\{projection\.coverage\}/);
});

test("projection state banner leaves incomplete collection to the automation run details", () => {
  assert.doesNotMatch(source, /sourceGaps|currentPartial|projection-gap-list/);
});
