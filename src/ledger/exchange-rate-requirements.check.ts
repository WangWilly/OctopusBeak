import assert from "node:assert/strict";
import { aggregateExchangeRateRequirements } from "./exchange-rate-requirements.ts";

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
