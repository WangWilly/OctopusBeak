import assert from "node:assert/strict";
import test from "node:test";
import { buildOverviewSankeyGraph } from "./overview-sankey.ts";
import type { RawPosition } from "$lib/shared-ledger/server/accounts.ts";

const fundPosition: RawPosition = {
  id: "fund-a",
  accountId: "fund-1",
  label: "Fund account",
  institution: "Bank",
  product: "Fund",
  group: "investment",
  kind: "fund",
  typeLabel: "Fund",
  currency: "USD",
  value: 100,
  asOfDate: "2026-07-22",
  importedAt: "2026-07-22T00:00:00.000Z",
  positionDetail: { symbol: "FUND-A", name: "Fund A", units: "1", value: 100, currency: "USD", change: "--" },
};

const creditCardPosition: RawPosition = {
  ...fundPosition,
  id: "card-1",
  accountId: "card-1",
  label: "Credit card",
  group: "liability",
  kind: "credit-card",
  typeLabel: "Credit card",
  currency: "TWD",
  value: 800,
  positionDetail: null,
};

test("builds converted asset and liability flows", () => {
  assert.deepEqual(
    buildOverviewSankeyGraph([fundPosition, creditCardPosition], new Map([["USD", 32]]))?.links,
    [
      { source: "root:asset", target: "kind:asset:fund", value: 3200, tone: "asset" },
      { source: "kind:asset:fund", target: "account:asset:fund:fund-1", value: 3200, tone: "asset" },
      { source: "account:asset:fund:fund-1", target: "position:asset:fund-1:fund-a", value: 3200, tone: "asset" },
      { source: "root:liability", target: "kind:liability:credit-card", value: 800, tone: "liability" },
      { source: "kind:liability:credit-card", target: "account:liability:credit-card:card-1", value: 800, tone: "liability" },
    ],
  );
});

test("omits the graph when an included currency lacks a current rate", () => {
  assert.equal(buildOverviewSankeyGraph([fundPosition], new Map()), null);
});
