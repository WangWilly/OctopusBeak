import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./AssetsDashboard.svelte", import.meta.url), "utf8");

test("assets exposes canonical coverage gaps and keeps awaiting ahead of partial copy", () => {
  assert.match(source, /ProjectionStateBanner/);
  assert.match(source, /<ProjectionStateBanner projection=\{assets\} \/>/);
});

test("the assets list reads its accounts, covered accounts, and per-account rows from the live page", () => {
  assert.doesNotMatch(source, /blocks|ProgressiveBlock|resolveAssets/);
  for (const field of ["accounts", "coveredAccounts", "positionsByAccount", "transactionsByAccount", "dailyHistoryByAccount"])
    assert.match(source, new RegExp(`${field}=\\{assets\\.${field}\\}`));
});

test("the total, side figure and chart mark manual and preview data with markers", () => {
  assert.match(source, /sideProvenance=\{!isEmpty && summary\.state === "ready" \? summary\.totalProvenance : NO_PROVENANCE\}/);
  assert.match(source, /<PageTotalCard[\s\S]*?provenance=\{summary\.state === "ready" \? summary\.provenance : NO_PROVENANCE\}/);
  assert.match(source, /<OriginMarkers provenance=\{stackedChart\.provenance\} align="end" \/>/);
});
