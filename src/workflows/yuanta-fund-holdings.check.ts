import assert from "node:assert/strict";
import { aggregateYuantaFundHoldingLots } from "./yuanta-fund-holdings.ts";
import type { YuantaCanonicalInvestmentRow } from "../ledger/canonical/yuanta-investment-adapters.ts";
const first: YuantaCanonicalInvestmentRow = {
  sourceRecordKey: "lot-one", producerSecurityId: "S001", securityName: "SANITIZED FUND",
  currency: "TWD", effectiveOn: "2026-09-08", quantity: { coefficient: "100", scale: 0 },
  valuation: { coefficient: "125", scale: 0, currency: "TWD" },
  effectiveTimeEvidence: { sourceField: "reference-nav-basis-date", components: [{ role: "reference-nav", sourceField: "NAV basis", value: "2026-09-08" }] },
};
const second = { ...first, sourceRecordKey: "lot-two", quantity: { coefficient: "125", scale: 3 }, valuation: { coefficient: "3125", scale: 4, currency: "TWD" } };
const aggregate = aggregateYuantaFundHoldingLots([first, second])[0]!;
assert.deepEqual(aggregate.quantity, { coefficient: "100125", scale: 3 });
assert.deepEqual(aggregate.valuation, { coefficient: "1253125", scale: 4, currency: "TWD" });
assert.deepEqual(aggregateYuantaFundHoldingLots([second, first])[0], aggregate);
assert.throws(() => aggregateYuantaFundHoldingLots([first, { ...second, currency: "USD" }]), /consistent source/u);
assert.throws(() => aggregateYuantaFundHoldingLots([first, { ...second, effectiveOn: "2026-09-09" }]), /consistent source/u);
assert.throws(() => aggregateYuantaFundHoldingLots([first, { ...second, effectiveTimeEvidence: { sourceField: "other-basis" } }]), /consistent source/u);
assert.throws(() => aggregateYuantaFundHoldingLots([first, first]), /consistent source/u);
assert.equal(aggregateYuantaFundHoldingLots([first, { ...second, producerSecurityId: "S002" }]).length, 2);
console.log("Yuanta fund holding aggregation checks passed");
