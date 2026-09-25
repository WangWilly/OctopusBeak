import assert from "node:assert/strict";
import test from "node:test";
import { exchangeRateRequestFromOverview } from "./exchange-rate-requirements.ts";

test("exchange-rate request uses the earliest overview date and all foreign amounts", () => {
  assert.deepEqual(exchangeRateRequestFromOverview({
    dailyHistory: [
      {
        date: "2026-07-10",
        netAssets: [{ currency: "USD", value: 100 }],
        dailyChange: [],
        assets: [],
        liabilities: [],
        accountChanges: [],
        positionCount: 1,
      },
      {
        date: "2026-01-03",
        netAssets: [{ currency: "TWD", value: 100 }],
        dailyChange: [{ currency: "JPY", value: 2 }],
        assets: [],
        liabilities: [],
        accountChanges: [],
        positionCount: 1,
      },
    ],
  }), {
    requiredFrom: "2026-01-03",
    currencies: ["JPY", "USD"],
  });
});

test("empty overview produces an empty rate request", () => {
  assert.deepEqual(exchangeRateRequestFromOverview({ dailyHistory: [] }), {
    requiredFrom: null,
    currencies: [],
  });
});
