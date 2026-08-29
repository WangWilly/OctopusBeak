import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVERTISED_FOREIGN_CURRENCY_DEPOSIT_READINESS,
  ADVERTISED_FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS,
  evaluateAdvertisedForeignCurrencyDepositReadiness,
} from "./advertised-domestic-deposit-readiness.ts";

test("all advertised foreign-currency deposit integrations have complete versioned contracts", () => {
  assert.deepEqual(ADVERTISED_FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS, [
    "yuanta",
    "cathay",
    "sinopac",
    "linebank",
  ]);
  assert.equal(ADVERTISED_FOREIGN_CURRENCY_DEPOSIT_READINESS.length, 4);
  assert.equal(
    (
      ADVERTISED_FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS as readonly string[]
    ).includes("sinopac"),
    true,
  );
  assert.equal(
    evaluateAdvertisedForeignCurrencyDepositReadiness().releaseReady,
    true,
  );
  assert.deepEqual(
    evaluateAdvertisedForeignCurrencyDepositReadiness().unreadySourceIds,
    [],
  );
  for (const entry of ADVERTISED_FOREIGN_CURRENCY_DEPOSIT_READINESS) {
    assert.match(entry.contractVersion, /^foreign-currency\//);
    assert.equal(entry.fixtureEvidence, "canonical-versioned-synthetic");
    assert.deepEqual(entry.blockers, []);
  }
});
