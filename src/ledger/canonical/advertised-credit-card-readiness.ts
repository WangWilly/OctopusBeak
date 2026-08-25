import { BANK_STATEMENT_CAPABILITIES } from "../../lib/automation/statement-selection.ts";
import { FUBON_CREDIT_CARD_CAPTURE_CONTRACT } from "./fubon-credit-card.ts";
import { getFubonCreditCardHumanAttestedV1Manifest } from "./fubon-credit-card-human-attestation.ts";

export type AdvertisedCanonicalCreditCardSourceId = "fubon";

export type AdvertisedCanonicalCreditCardReadinessEntry = {
  sourceId: AdvertisedCanonicalCreditCardSourceId;
  advertisedName: string;
  workflow: "fubon-credit-card-statements";
  authority: "fubon/credit-card/human-attested-v1";
  contractVersion: "fubon/credit-card/human-attested-v1";
  identity: "human-attested-independent-billing-account";
  cards: "subordinate-instruments";
  postingAndBilling: "posted-from-posting-date-billing-independent";
  statements: "issuer-settled-cycle-summary-pinned-membership";
  relations: "explicit-source-linkage-only";
  completeness: "six-billed-periods-plus-unbilled-terminal-grids";
  liveEvidence: "redacted-repeat-plus-human-attestation";
  blockers: readonly [];
};

export const ADVERTISED_CANONICAL_CREDIT_CARD_SOURCE_IDS = ["fubon"] as const;

const advertisedFubon = Object.values(BANK_STATEMENT_CAPABILITIES).find(
  (group) =>
    group.id === "fubon" &&
    group.statementTypes.some((statementType) => statementType.id === "credit_card"),
);
if (!advertisedFubon)
  throw new Error("Fubon credit-card workflow is not advertised by the source registry.");

export const ADVERTISED_CANONICAL_CREDIT_CARD_READINESS = [
  {
    sourceId: "fubon",
    advertisedName: advertisedFubon.label,
    workflow: "fubon-credit-card-statements",
    authority: FUBON_CREDIT_CARD_CAPTURE_CONTRACT.authorityRoute,
    contractVersion: FUBON_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion,
    identity: "human-attested-independent-billing-account",
    cards: "subordinate-instruments",
    postingAndBilling: "posted-from-posting-date-billing-independent",
    statements: "issuer-settled-cycle-summary-pinned-membership",
    relations: "explicit-source-linkage-only",
    completeness: "six-billed-periods-plus-unbilled-terminal-grids",
    liveEvidence: "redacted-repeat-plus-human-attestation",
    blockers: [],
  },
] as const satisfies readonly AdvertisedCanonicalCreditCardReadinessEntry[];

export function isAdvertisedCanonicalCreditCardEntryReleaseReady(
  entry: AdvertisedCanonicalCreditCardReadinessEntry,
): boolean {
  return (
    getFubonCreditCardHumanAttestedV1Manifest().status === "active" &&
    entry.authority === "fubon/credit-card/human-attested-v1" &&
    entry.contractVersion === "fubon/credit-card/human-attested-v1" &&
    entry.identity === "human-attested-independent-billing-account" &&
    entry.cards === "subordinate-instruments" &&
    entry.postingAndBilling === "posted-from-posting-date-billing-independent" &&
    entry.statements === "issuer-settled-cycle-summary-pinned-membership" &&
    entry.relations === "explicit-source-linkage-only" &&
    entry.completeness === "six-billed-periods-plus-unbilled-terminal-grids" &&
    entry.liveEvidence === "redacted-repeat-plus-human-attestation" &&
    entry.blockers.length === 0
  );
}

export function evaluateAdvertisedCanonicalCreditCardReadiness(
  entries: readonly AdvertisedCanonicalCreditCardReadinessEntry[] =
    ADVERTISED_CANONICAL_CREDIT_CARD_READINESS,
) {
  const unreadySourceIds = entries
    .filter((entry) => !isAdvertisedCanonicalCreditCardEntryReleaseReady(entry))
    .map((entry) => entry.sourceId);
  return {
    status: unreadySourceIds.length === 0 ? "release-ready" as const : "blocked" as const,
    releaseReady: unreadySourceIds.length === 0,
    advertisedSourceCount: entries.length,
    unreadySourceIds,
  };
}
