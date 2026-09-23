import assert from "node:assert/strict";
import {
  aggregateExchangeRateRequirements,
  exchangeRateRequestFromOverview,
} from "./exchange-rate-requirements.ts";

assert.deepEqual(aggregateExchangeRateRequirements([
  {
    component: "later",
    requiredFrom: "2026-07-10",
    currencies: ["USD", "TWD"],
  },
  {
    component: "earlier",
    requiredFrom: "2026-01-03",
    currencies: ["JPY", "USD", "UNKNOWN"],
  },
]), {
  requiredFrom: "2026-01-03",
  currencies: ["JPY", "USD"],
});

assert.deepEqual(aggregateExchangeRateRequirements([]), {
  requiredFrom: null,
  currencies: [],
});

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
