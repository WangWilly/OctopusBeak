import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVERTISED_INVESTMENT_READINESS,
  evaluateAdvertisedInvestmentReadiness,
} from "./advertised-investment-readiness.ts";

test("advertised fund and brokerage sources remain blocked until executable live contracts are validated", () => {
  assert.deepEqual(
    ADVERTISED_INVESTMENT_READINESS.map((entry) => entry.sourceId),
    ["yuanta-fund", "yuanta-trade"],
  );
  const gate = evaluateAdvertisedInvestmentReadiness();
  assert.deepEqual(gate.contractIncompleteSourceIds, [
    "yuanta-fund",
    "yuanta-trade",
  ]);
  assert.deepEqual(gate.pendingLiveValidationSourceIds, [
    "yuanta-fund",
    "yuanta-trade",
  ]);
  assert.equal(gate.status, "blocked");
});
