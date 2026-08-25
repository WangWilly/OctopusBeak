import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVERTISED_CANONICAL_CREDIT_CARD_READINESS,
  ADVERTISED_CANONICAL_CREDIT_CARD_SOURCE_IDS,
  evaluateAdvertisedCanonicalCreditCardReadiness,
} from "./advertised-credit-card-readiness.ts";

test("Fubon is the first release-ready canonical credit-card source", () => {
  assert.deepEqual(ADVERTISED_CANONICAL_CREDIT_CARD_SOURCE_IDS, ["fubon"]);
  assert.equal(ADVERTISED_CANONICAL_CREDIT_CARD_READINESS.length, 1);
  assert.deepEqual(evaluateAdvertisedCanonicalCreditCardReadiness(), {
    status: "release-ready",
    releaseReady: true,
    advertisedSourceCount: 1,
    unreadySourceIds: [],
  });
  const entry = ADVERTISED_CANONICAL_CREDIT_CARD_READINESS[0];
  assert.equal(entry.identity, "human-attested-independent-billing-account");
  assert.equal(entry.cards, "subordinate-instruments");
  assert.equal(entry.statements, "issuer-settled-cycle-summary-pinned-membership");
  assert.equal(entry.relations, "explicit-source-linkage-only");
  assert.deepEqual(entry.blockers, []);
});
