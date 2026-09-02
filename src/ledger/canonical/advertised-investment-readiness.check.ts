import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVERTISED_INVESTMENT_READINESS,
  evaluateAdvertisedInvestmentReadiness,
} from "./advertised-investment-readiness.ts";

test("advertised fund and brokerage sources are release-ready after live contract validation", () => {
  assert.deepEqual(
    ADVERTISED_INVESTMENT_READINESS.map((entry) => entry.sourceId),
    ["yuanta-fund", "yuanta-trade"],
  );
  const gate = evaluateAdvertisedInvestmentReadiness();
  assert.deepEqual(gate.contractIncompleteSourceIds, []);
  assert.deepEqual(gate.pendingLiveValidationSourceIds, []);
  assert.equal(gate.status, "release-ready");
  assert.ok(ADVERTISED_INVESTMENT_READINESS.every((entry) => entry.blockers.length === 0));
});

test("an incomplete contract cannot become release-ready from live status alone", () => {
  const gate = evaluateAdvertisedInvestmentReadiness([
    {
      ...ADVERTISED_INVESTMENT_READINESS[0]!,
      contractComplete: false,
    },
  ]);
  assert.equal(gate.status, "blocked");
  assert.deepEqual(gate.contractIncompleteSourceIds, ["yuanta-fund"]);
});
