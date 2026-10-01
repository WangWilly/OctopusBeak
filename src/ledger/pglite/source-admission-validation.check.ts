import assert from "node:assert/strict";
import test from "node:test";
import { validatePGliteCanonicalFinancialFact } from "./source-admission-validation.ts";

function investmentFact(currency: string, postingRuleVersion: string) {
  return {
    sourceOccurrenceKey: `sha256:${"a".repeat(64)}`,
    sourceSequence: "trade-1",
    amount: { coefficient: "1250", scale: 2 },
    currency,
    direction: "outflow" as const,
    postingStatus: "posted" as const,
    postingOrigin: "provider_booked_history",
    postingBasis: "statement-posted-history",
    postingRuleVersion,
    description: "trade",
    economicStatus: "normal" as const,
    administrativeState: "active" as const,
    semanticRuleVersion: postingRuleVersion,
    effectiveOn: "2026-09-22",
    transactionDateTimeLocal: "2026-09-22T00:00:00",
    timeZone: "Asia/Taipei" as const,
    timePrecision: "date" as const,
    timeOrigin: "defaulted_local_midnight" as const,
    effectiveTimeBasis: "source-reported" as const,
    effectiveTimeRuleVersion: postingRuleVersion,
    utcInstantUtcUs: Date.parse("2026-09-21T16:00:00.000Z") * 1000,
  };
}

test("MAX USDT trade cash is admitted under its controlled investment route", () => {
  assert.doesNotThrow(() => validatePGliteCanonicalFinancialFact(
    investmentFact("USDT", "maicoin/investment/canonical-v1"),
    "maicoin/investment/canonical-v1",
  ));
  assert.throws(() => validatePGliteCanonicalFinancialFact(
    investmentFact("USDT", "yuanta-fund/investment/canonical-v1"),
    "yuanta-fund/investment/canonical-v1",
  ));
  assert.throws(() => validatePGliteCanonicalFinancialFact(
    investmentFact("USDT", "maicoin/investment/canonical-v1"),
    "yuanta-fund/investment/canonical-v1",
  ));
});
