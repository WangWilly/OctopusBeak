import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./AssetsDashboard.svelte", import.meta.url), "utf8");

test("assets exposes canonical coverage gaps and keeps awaiting ahead of partial copy", () => {
  assert.match(source, /assets\.coverage !== "complete"/);
  assert.match(source, /data-product-state=\{assets\.coverage\}/);
  assert.match(source, /gap\.label \?\? gap\.integrationNamespace \?\? gap\.sourceConnectionKey/);
  const stateExpression = source.slice(
    source.indexOf("$: currentStateLabel"),
    source.indexOf("\n\n  function buildMetrics", source.indexOf("$: currentStateLabel")),
  );
  assert.ok(stateExpression.indexOf('assets.availability === "awaiting"') < stateExpression.indexOf("assets.sourceGaps.length > 0"));
  assert.ok(stateExpression.indexOf('assets.availability === "empty"') < stateExpression.indexOf("assets.sourceGaps.length > 0"));
});

test("assets keeps current-only history wired to the shared account views", () => {
  assert.match(source, /dailyHistoryByAccount=\{assets\.dailyHistoryByAccount\}/);
  assert.match(source, /positionsByAccount=\{assets\.positionsByAccount\}/);
  assert.match(source, /transactionsByAccount=\{assets\.transactionsByAccount\}/);
});
