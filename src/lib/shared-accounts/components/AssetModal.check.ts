import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./AssetModal.svelte", import.meta.url), "utf8");

test("position values preserve canonical exact values when present", () => {
  assert.match(source, /row\.valueExact/);
  assert.match(source, /formatPositionValue\(row\)/);
  assert.match(source, /exact: row\.valueExact \?\? undefined/);
});

test("quantity-only positions keep their explicit awaiting valuation state", () => {
  assert.match(source, /row\.value === null && !row\.valueExact/);
  assert.match(source, /positions\.valueAwaiting/);
});
