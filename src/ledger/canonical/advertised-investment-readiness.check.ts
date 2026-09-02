import assert from "node:assert/strict";
import test from "node:test";
import { ADVERTISED_INVESTMENT_READINESS, evaluateAdvertisedInvestmentReadiness } from "./advertised-investment-readiness.ts";

test("every advertised fund and brokerage source has a complete canonical investment contract", () => {
  assert.deepEqual(ADVERTISED_INVESTMENT_READINESS.map((entry) => entry.sourceId), ["yuanta-fund", "yuanta-trade"]);
  const gate = evaluateAdvertisedInvestmentReadiness();
  assert.deepEqual(gate.contractIncompleteSourceIds, []);
  assert.deepEqual(gate.pendingLiveValidationSourceIds, ["yuanta-fund", "yuanta-trade"]);
  assert.equal(gate.status, "blocked");
});
