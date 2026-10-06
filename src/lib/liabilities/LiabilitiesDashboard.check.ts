import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AccountRowDto } from "../shared-ledger/types.ts";
import type { LiabilitiesPageDto } from "./types.ts";
import { resolveLiabilitiesDetails } from "../shared-shell/progressive-dashboard-data.ts";

const source = readFileSync(new URL("./LiabilitiesDashboard.svelte", import.meta.url), "utf8");

test("liabilities exposes canonical coverage gaps and keeps awaiting ahead of partial copy", () => {
  assert.match(source, /ProjectionStateBanner/);
  assert.match(source, /<ProjectionStateBanner projection=\{liabilities\} \/>/);
});

test("margin exposure keeps an independent investment-kind filter", () => {
  assert.match(source, /let marginFilter: AccountKind \| "all" = "all"/);
  assert.match(source, /accounts=\{detailsDataBlock\.marginAccounts\}[\s\S]*mode="liability"[\s\S]*bind:filter=\{marginFilter\}/);
  assert.match(source, /detailsDataBlock\.marginAccounts\.length > 0/);

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
  const fallback = {
    availability: "available",
    coverage: "complete",
    sourceGaps: [],
    importedAt: null,
    accounts: [],
    marginAccounts: [account("fallback")],
    transactionsByAccount: {},
    dailyHistoryByAccount: {},
    dailyHistory: [],
    exchangeRates: [],
  } as LiabilitiesPageDto;
  const block = { marginAccounts: [account("block")], transactionsByAccount: { block: [] } };
  assert.equal(resolveLiabilitiesDetails(fallback, block).marginAccounts[0]?.id, "block");
  assert.equal(resolveLiabilitiesDetails(fallback).marginAccounts[0]?.id, "fallback");
  assert.match(source, /resolveLiabilitiesDetails\(liabilities, detailsBlock\)/);
});
