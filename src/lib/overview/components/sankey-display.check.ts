import assert from "node:assert/strict";
import test from "node:test";
import { displayOverviewSankeyGraph } from "./sankey-display.ts";

const graph = {
  nodes: [
    { id: "account", label: "Account", level: 2 as const, tone: "asset" as const },
    { id: "position", label: "Position", level: 3 as const, tone: "asset" as const },
  ],
  links: [{
    source: "account",
    target: "position",
    value: 39505.92,
    tone: "asset" as const,
    currency: "USD",
    exact: { coefficient: "123456", scale: 2 },
    convertedExact: { coefficient: "3950592", scale: 2 },
    conversion: {
      fromCurrency: "USD",
      toCurrency: "TWD",
      rateDate: "2026-08-31",
      twdPerUnit: 32,
      convertedExact: { coefficient: "3950592", scale: 2 },
    },
  }],
};

const rates = [
  { rateDate: "2026-08-31", currency: "USD", twdPerUnit: 32 },
  { rateDate: "2026-08-30", currency: "JPY", twdPerUnit: 0.23 },
];

test("Sankey target-currency conversion keeps exact value and both FX traces", () => {
  const displayed = displayOverviewSankeyGraph(graph, "JPY", rates);
  const link = displayed.links[0]!;
  assert.equal(link.currency, "JPY");
  assert.ok(Math.abs(link.value - (39505.92 / 0.23)) < 0.000001);
  assert.deepEqual(link.conversion, {
    fromCurrency: "USD",
    toCurrency: "JPY",
    rateDate: "2026-08-31",
    twdPerUnit: 32,
    targetRateDate: "2026-08-30",
    targetTwdPerUnit: 0.23,
    convertedExact: link.exact,
  });
});

test("Sankey selecting the source currency clears stale conversion metadata", () => {
  const displayed = displayOverviewSankeyGraph(graph, "USD", rates);
  assert.equal(displayed.links[0]?.currency, "USD");
  assert.deepEqual(displayed.links[0]?.exact, { coefficient: "123456", scale: 2 });
  assert.equal(displayed.links[0]?.conversion, undefined);
});
