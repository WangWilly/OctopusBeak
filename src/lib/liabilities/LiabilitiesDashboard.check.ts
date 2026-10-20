import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AccountRowDto } from "../shared-ledger/types.ts";
import type { LiabilitiesPageDto } from "./types.ts";

const source = readFileSync(new URL("./LiabilitiesDashboard.svelte", import.meta.url), "utf8");

test("liabilities exposes canonical coverage gaps and keeps awaiting ahead of partial copy", () => {
  assert.match(source, /ProjectionStateBanner/);
  assert.match(source, /<ProjectionStateBanner projection=\{liabilities\} \/>/);
});

test("an incomplete liabilities total shows the incomplete copy in the card and the side value, never a figure", () => {
  assert.match(source, /\$: incomplete = totalIncomplete\(liabilities\.accounts\)/);
  assert.match(source, /: incomplete\s*\? \$t\.preview\.incomplete/);
  assert.match(source, /<PageTotalCard[\s\S]*?\{incomplete\}[\s\S]*?\{includesPreview\}/);
});

test("chart and list read the live page, as Assets does, so a visibility change drops preview rows", () => {
  assert.doesNotMatch(source, /blocks|ProgressiveBlock|resolveLiabilities/);
  assert.match(source, /localizeAccounts\(liabilities\.accounts, \$t\)/);
  assert.match(source, /accounts=\{liabilities\.accounts\}/);
});

test("margin exposure keeps an independent investment-kind filter", () => {
  assert.match(source, /let marginFilter: AccountKind \| "all" = "all"/);
  assert.match(source, /accounts=\{liabilities\.marginAccounts\}[\s\S]*mode="liability"[\s\S]*bind:filter=\{marginFilter\}/);
  assert.match(source, /liabilities\.marginAccounts\.length > 0/);

  const account = (id: string): AccountRowDto => ({
    id,
    label: id,
    institution: id,
    product: id,
    group: "liability",
    kind: "loan",
    typeLabel: id,
    amountLines: [],
    transactionCount: 0,
    assetPositionCount: 0,
    lastUpdated: null,
    valueAvailability: "available",
  });
});
