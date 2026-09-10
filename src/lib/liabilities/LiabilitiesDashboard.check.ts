import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./LiabilitiesDashboard.svelte", import.meta.url), "utf8");

test("liabilities exposes canonical coverage gaps and keeps awaiting ahead of partial copy", () => {
  assert.match(source, /ProjectionStateBanner/);
  assert.match(source, /<ProjectionStateBanner projection=\{liabilities\} \/>/);
});

test("margin exposure keeps an independent investment-kind filter", () => {
  assert.match(source, /let marginFilter: AccountKind \| "all" = "all"/);
  assert.match(source, /accounts=\{liabilities\.marginAccounts\}[\s\S]*mode="liability"[\s\S]*bind:filter=\{marginFilter\}/);
  assert.match(source, /marginAccounts\.length > 0/);
});
