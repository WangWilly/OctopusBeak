import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./AssetsDashboard.svelte", import.meta.url), "utf8");

test("assets exposes canonical coverage gaps and keeps awaiting ahead of partial copy", () => {
  assert.match(source, /ProjectionStateBanner/);
  assert.match(source, /<ProjectionStateBanner projection=\{assets\} \/>/);
});

test("assets keeps current-only history wired to the shared account views", () => {
  assert.match(source, /dailyHistoryByAccount=\{assets\.dailyHistoryByAccount\}/);
  assert.match(source, /positionsByAccount=\{assets\.positionsByAccount\}/);
  assert.match(source, /transactionsByAccount=\{assets\.transactionsByAccount\}/);
});
