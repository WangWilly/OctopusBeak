import assert from "node:assert/strict";
import { BANK_STATEMENT_CAPABILITIES } from "../../lib/automation/statement-selection.ts";
import { ADVERTISED_DOMESTIC_DEPOSIT_SEMANTIC_BLOCKERS } from "./advertised-domestic-deposit-preflight.ts";
import {
  LINEBANK_DOMESTIC_DEPOSIT_CLEAN_HEADED_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_DIRECTION_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_REVALIDATION_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_OBSERVED_TIME_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_EVIDENCE,
} from "./linebank-domestic-deposit.ts";
import {
  ADVERTISED_DOMESTIC_DEPOSIT_READINESS,
  ADVERTISED_DOMESTIC_DEPOSIT_SOURCE_IDS,
  advertisedDomesticDepositSourceIds,
  assertAdvertisedDomesticDepositManifestCoverage,
  evaluateAdvertisedDomesticDepositReadiness,
  isAdvertisedDomesticDepositEntryReleaseReady,
  type AdvertisedDomesticDepositReadinessEntry,
} from "./advertised-domestic-deposit-readiness.ts";

const expectedSourceIds = [
  "fubon",
  "yuanta",
  "cathay",
  "hncb",
  "ctbc",
  "post",
  "sinopac",
  "linebank",
];
assert.deepEqual(
  advertisedDomesticDepositSourceIds(BANK_STATEMENT_CAPABILITIES),
  expectedSourceIds,
);
assert.deepEqual(ADVERTISED_DOMESTIC_DEPOSIT_SOURCE_IDS, expectedSourceIds);
assert.deepEqual(
  ADVERTISED_DOMESTIC_DEPOSIT_READINESS.map((entry) => entry.sourceId),
  expectedSourceIds,
);

// Capability filtering excludes credit-card and brokerage-only registry groups.
assert.deepEqual(
  advertisedDomesticDepositSourceIds({
    deposit: {
      id: "deposit",
      label: "Deposit",
      statementTypes: [{ id: "deposit" }],
    },
    card: {
      id: "card",
      label: "Card",
      statementTypes: [{ id: "credit_card" }],
    },
    brokerage: {
      id: "brokerage",
      label: "Brokerage",
      statementTypes: [{ id: "brokerage" }],
    },
  }),
  ["deposit"],
);

assert.throws(
  () =>
    assertAdvertisedDomesticDepositManifestCoverage(
      [...expectedSourceIds, "new-bank"],
      expectedSourceIds,
    ),
  /Missing advertised domestic source manifests: new-bank/,
);
assert.throws(
  () =>
    assertAdvertisedDomesticDepositManifestCoverage(
      expectedSourceIds.slice(0, 7),
      expectedSourceIds,
    ),
  /Non-advertised domestic source manifests: linebank/,
);

const cathay = ADVERTISED_DOMESTIC_DEPOSIT_READINESS.find(
  (entry) => entry.sourceId === "cathay",
);
assert.ok(cathay);
assert.equal(cathay.capability, "canonical-synthetic");
assert.equal(cathay.fixtureEvidence, "canonical-versioned-synthetic");
assert.equal(cathay.liveValidation, "pending");
assert.deepEqual(cathay.semanticBlockers, []);
assert.deepEqual(cathay.blockers, ["live-validation-pending"]);

const linebank = ADVERTISED_DOMESTIC_DEPOSIT_READINESS.find(
  (entry) => entry.sourceId === "linebank",
);
assert.ok(linebank);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_CLEAN_HEADED_EVIDENCE.manualAuthNavigation
    .liveValidation,
  "complete",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_DIRECTION_EVIDENCE.mappingStatus,
  "observed-versioned",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_DIRECTION_EVIDENCE.providerGuaranteed,
  false,
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_OBSERVED_TIME_EVIDENCE.semanticStatus,
  "observed-versioned",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_OBSERVED_TIME_EVIDENCE.providerGuaranteed,
  false,
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_REVALIDATION_EVIDENCE.validation
    .transport,
  "complete",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_REVALIDATION_EVIDENCE.validation
    .direction,
  "complete",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_HISTORICAL_REVALIDATION_EVIDENCE.canonicalAdmission,
  "blocked",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_EVIDENCE.matchingRuleVersion,
  "occurrence-v1",
);
assert.equal(
  LINEBANK_DOMESTIC_DEPOSIT_OCCURRENCE_MATCHING_EVIDENCE.providerGuaranteed,
  false,
);
assert.equal(linebank.liveValidation, "partial");
assert.equal(linebank.capability, "preflight-only");
assert.equal(isAdvertisedDomesticDepositEntryReleaseReady(linebank), false);
assert.ok(linebank.blockers.includes("live-validation-pending"));
assert.ok(linebank.blockers.includes("occurrence-identity-unproven"));
assert.ok(linebank.blockers.includes("direction-semantics-unproven"));
assert.ok(linebank.blockers.includes("posting-semantics-unproven"));
assert.ok(linebank.blockers.includes("effective-time-semantics-unproven"));
assert.ok(linebank.blockers.includes("completeness-semantics-unproven"));
assert.ok(linebank.blockers.includes("authority-semantics-unproven"));

for (const entry of ADVERTISED_DOMESTIC_DEPOSIT_READINESS) {
  assert.ok(entry.authority.length > 0, entry.sourceId);
  assert.ok(entry.contractVersion.length > 0, entry.sourceId);
  assert.equal(isAdvertisedDomesticDepositEntryReleaseReady(entry), false);
  if (entry.sourceId !== "cathay") {
    assert.equal(entry.capability, "preflight-only", entry.sourceId);
    assert.equal(
      entry.fixtureEvidence,
      "preflight-versioned-synthetic",
      entry.sourceId,
    );
    assert.deepEqual(
      new Set(entry.semanticBlockers),
      new Set(ADVERTISED_DOMESTIC_DEPOSIT_SEMANTIC_BLOCKERS),
      entry.sourceId,
    );
  }
}

assert.deepEqual(evaluateAdvertisedDomesticDepositReadiness(), {
  status: "blocked",
  releaseReady: false,
  advertisedSourceCount: 8,
  unreadySourceIds: expectedSourceIds,
});
assert.throws(
  () =>
    evaluateAdvertisedDomesticDepositReadiness(
      ADVERTISED_DOMESTIC_DEPOSIT_READINESS.slice(0, 7),
    ),
  /Missing advertised domestic source manifests: linebank/,
);
assert.throws(
  () =>
    evaluateAdvertisedDomesticDepositReadiness([
      ...ADVERTISED_DOMESTIC_DEPOSIT_READINESS,
      ADVERTISED_DOMESTIC_DEPOSIT_READINESS[0],
    ]),
  /Duplicate advertised domestic source readiness entry/,
);

const completeCathay: AdvertisedDomesticDepositReadinessEntry = {
  ...cathay,
  liveValidation: "complete",
  blockers: [],
};
assert.equal(
  isAdvertisedDomesticDepositEntryReleaseReady(completeCathay),
  true,
);
assert.equal(
  isAdvertisedDomesticDepositEntryReleaseReady({
    ...completeCathay,
    blockers: ["authority-semantics-unproven"],
  }),
  false,
);
