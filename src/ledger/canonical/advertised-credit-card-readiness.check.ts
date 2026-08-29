import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVERTISED_CANONICAL_CREDIT_CARD_READINESS,
  ADVERTISED_CANONICAL_CREDIT_CARD_SOURCE_IDS,
  evaluateAdvertisedCanonicalCreditCardReadiness,
  isAdvertisedCanonicalCreditCardEntryReleaseReady,
  type AdvertisedCanonicalCreditCardReadinessEntry,
} from "./advertised-credit-card-readiness.ts";
import { getYuantaCreditCardHumanAttestedV2Manifest } from "./yuanta-credit-card-human-attestation.ts";

test("advertised canonical credit-card sources are independently release-ready", () => {
  assert.deepEqual(ADVERTISED_CANONICAL_CREDIT_CARD_SOURCE_IDS, [
    "fubon",
    "esun",
    "yuanta",
  ]);
  assert.equal(ADVERTISED_CANONICAL_CREDIT_CARD_READINESS.length, 3);
  assert.deepEqual(evaluateAdvertisedCanonicalCreditCardReadiness(), {
    status: "release-ready",
    releaseReady: true,
    advertisedSourceCount: 3,
    unreadySourceIds: [],
  });
  const entry = ADVERTISED_CANONICAL_CREDIT_CARD_READINESS[0];
  assert.equal(entry.authority, "fubon/credit-card/human-attested-v2");
  assert.equal(entry.contractVersion, "fubon/credit-card/human-attested-v2");
  assert.equal(entry.identity, "human-attested-primary-cardholder-portfolio");
  assert.equal(entry.cards, "subordinate-instruments");
  assert.equal(entry.statements, "issuer-settled-cycle-summary-pinned-membership");
  assert.equal(entry.relations, "explicit-source-linkage-only");
  assert.deepEqual(entry.blockers, []);

  const historicalV1 = {
    ...entry,
    authority: "fubon/credit-card/human-attested-v1",
    contractVersion: "fubon/credit-card/human-attested-v1",
  } as unknown as AdvertisedCanonicalCreditCardReadinessEntry;
  assert.equal(
    isAdvertisedCanonicalCreditCardEntryReleaseReady(historicalV1),
    false,
    "v1 remains historical and cannot be advertised as the current route",
  );

  const esun = ADVERTISED_CANONICAL_CREDIT_CARD_READINESS.find(
    ({ sourceId }) => sourceId === "esun",
  );
  const yuanta = ADVERTISED_CANONICAL_CREDIT_CARD_READINESS.find(
    ({ sourceId }) => sourceId === "yuanta",
  );
  assert.ok(esun);
  assert.ok(yuanta);
  assert.deepEqual(esun.blockers, []);
  assert.equal(isAdvertisedCanonicalCreditCardEntryReleaseReady(esun), true);
  assert.equal(esun.authority, "esun/credit-card/human-attested-v2");
  assert.deepEqual(yuanta.blockers, []);
  assert.equal(isAdvertisedCanonicalCreditCardEntryReleaseReady(yuanta), true);
  assert.equal(
    getYuantaCreditCardHumanAttestedV2Manifest().semantics.settledSummaryLiveEvidence,
    "six-issuer-history-detail-summaries-five-bounded-cycles-queryHistoryDetail-authority",
  );
  assert.equal(
    getYuantaCreditCardHumanAttestedV2Manifest().semantics.settledSummaryAuthorityContract,
    "queryHistoryDetail-selected-billed-month-response-with-provider-posting-date-membership",
  );
  assert.equal(
    getYuantaCreditCardHumanAttestedV2Manifest().semantics.settledSummaryExactFieldEvidence,
    "period-and-balance-next-row-same-column-exact-human-attested-a",
  );
  assert.equal(
    getYuantaCreditCardHumanAttestedV2Manifest().semantics.settledSummaryPeriodAuthority,
    "history-detail.table.rwdTable[0].row[0].cell[0].period-label-to-row[1].cell[0].same-column-value-exact-human-attested-a",
  );
  assert.equal(
    getYuantaCreditCardHumanAttestedV2Manifest().semantics.settledSummaryPeriodFormat,
    "human-attested-category-2-gregorian-year-month-slash-with-month-or-period-suffix",
  );
  assert.equal(
    getYuantaCreditCardHumanAttestedV2Manifest().semantics.settledSummaryBalanceAuthority,
    "history-detail.table.rwdTable[0].balance-label-to-next-row.same-column-value-exact-human-attested-a",
  );
  assert.equal(
    getYuantaCreditCardHumanAttestedV2Manifest().semantics.settledSummaryCompletenessEvidence,
    "complete-range-seven-terminal-grids-six-history-summaries-unbilled-terminal",
  );
  assert.equal(
    getYuantaCreditCardHumanAttestedV2Manifest().semantics.settledSummaryRepeatEvidence,
    "two-v2-captures-repeat-deduped-authority-with-provenance-retained",
  );
  assert.equal(
    getYuantaCreditCardHumanAttestedV2Manifest().semantics.settledSummaryCurrentRoutePrecedence,
    "v2-complete-capture-supersedes-v1-current-view-only-history-retains-both",
  );
  assert.equal(
    getYuantaCreditCardHumanAttestedV2Manifest().semantics.settledSummaryDiagnosticPage,
    "creditcardsummary-optional-non-authoritative-and-must-not-block",
  );

  assert.deepEqual(evaluateAdvertisedCanonicalCreditCardReadiness(), {
    status: "release-ready",
    releaseReady: true,
    advertisedSourceCount: 3,
    unreadySourceIds: [],
  });

  const unblockedYuanta = {
    ...yuanta,
    blockers: [],
  } as unknown as AdvertisedCanonicalCreditCardReadinessEntry;
  assert.equal(isAdvertisedCanonicalCreditCardEntryReleaseReady(unblockedYuanta), true);
  const revokedEsun = {
    ...esun,
    authority: "esun/credit-card/revoked" as const,
  } as unknown as AdvertisedCanonicalCreditCardReadinessEntry;
  assert.equal(isAdvertisedCanonicalCreditCardEntryReleaseReady(revokedEsun), false);
  assert.deepEqual(
    evaluateAdvertisedCanonicalCreditCardReadiness([
      entry,
      revokedEsun,
      unblockedYuanta,
    ]),
    {
      status: "blocked",
      releaseReady: false,
      advertisedSourceCount: 3,
      unreadySourceIds: ["esun"],
    },
  );
  assert.equal(isAdvertisedCanonicalCreditCardEntryReleaseReady(entry), true);
  assert.equal(isAdvertisedCanonicalCreditCardEntryReleaseReady(unblockedYuanta), true);
});
