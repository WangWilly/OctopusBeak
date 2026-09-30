import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AccountRowDto } from "../shared-ledger/types.ts";
import type { AssetsPageDto } from "./types.ts";
import { resolveAssetsList } from "../shared-shell/progressive-dashboard-data.ts";

const source = readFileSync(new URL("./AssetsDashboard.svelte", import.meta.url), "utf8");

test("assets exposes canonical coverage gaps and keeps awaiting ahead of partial copy", () => {
  assert.match(source, /ProjectionStateBanner/);
  assert.match(source, /<ProjectionStateBanner projection=\{assets\} \/>/);
});

test("assets settled list block overrides the route fallback for shared account views", () => {
  const account = (id: string): AccountRowDto => ({
    id,
    label: id,
    institution: id,
    product: id,
    group: "asset",
    kind: "bank",
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
    accounts: [account("fallback")],
    positionsByAccount: {},
    transactionsByAccount: {},
    dailyHistoryByAccount: {},
    dailyHistory: [],
  } as AssetsPageDto;
  const block = {
    accounts: [account("block")],
    positionsByAccount: { block: [] },
    transactionsByAccount: { block: [] },
    dailyHistoryByAccount: { block: [] },
  };
  assert.equal(resolveAssetsList(fallback, block).accounts[0]?.id, "block");
  assert.deepEqual(resolveAssetsList(fallback, block).positionsByAccount, { block: [] });
  assert.equal(resolveAssetsList(fallback).accounts[0]?.id, "fallback");
  assert.match(source, /resolveAssetsList\(assets, listBlock\)/);
  assert.match(source, /positionsByAccount=\{listDataBlock\.positionsByAccount\}/);
  assert.match(source, /transactionsByAccount=\{listDataBlock\.transactionsByAccount\}/);
  assert.match(source, /dailyHistoryByAccount=\{listDataBlock\.dailyHistoryByAccount\}/);
});
