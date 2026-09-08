import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./LiabilitiesDashboard.svelte", import.meta.url), "utf8");

test("liabilities exposes canonical coverage gaps and keeps awaiting ahead of partial copy", () => {
  assert.match(source, /liabilities\.coverage !== "complete"/);
  assert.match(source, /data-product-state=\{liabilities\.coverage\}/);
  assert.match(source, /gap\.label \?\? gap\.integrationNamespace \?\? gap\.sourceConnectionKey/);
  const stateExpression = source.slice(
    source.indexOf("$: currentStateLabel"),
    source.indexOf("\n\n  function buildMetrics", source.indexOf("$: currentStateLabel")),
  );
  assert.ok(stateExpression.indexOf('liabilities.availability === "awaiting"') < stateExpression.indexOf("liabilities.sourceGaps.length > 0"));
  assert.ok(stateExpression.indexOf('liabilities.availability === "empty"') < stateExpression.indexOf("liabilities.sourceGaps.length > 0"));
});

test("margin exposure keeps an independent investment-kind filter", () => {
  assert.match(source, /let marginFilter: AccountKind \| "all" = "all"/);
  assert.match(source, /accounts=\{liabilities\.marginAccounts\}[\s\S]*mode="liability"[\s\S]*bind:filter=\{marginFilter\}/);
  assert.match(source, /marginAccounts\.length > 0/);
});
