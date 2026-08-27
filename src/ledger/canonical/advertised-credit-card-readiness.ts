import { BANK_STATEMENT_CAPABILITIES } from "../../lib/automation/statement-selection.ts";
import { ESUN_CREDIT_CARD_CAPTURE_CONTRACT } from "./esun-credit-card.ts";
import { FUBON_CREDIT_CARD_CAPTURE_CONTRACT } from "./fubon-credit-card.ts";
import { YUANTA_CREDIT_CARD_CAPTURE_CONTRACT } from "./yuanta-credit-card.ts";
import { getEsunCreditCardHumanAttestedV2Manifest } from "./esun-credit-card-human-attestation.ts";
import { getFubonCreditCardHumanAttestedV2Manifest } from "./fubon-credit-card-human-attestation.ts";
import { getYuantaCreditCardHumanAttestedV1Manifest } from "./yuanta-credit-card-human-attestation.ts";

export type AdvertisedCanonicalCreditCardSourceId = "fubon" | "esun" | "yuanta";

export type AdvertisedCanonicalCreditCardReadinessEntry = {
  sourceId: AdvertisedCanonicalCreditCardSourceId;
  advertisedName: string;
  workflow:
    | "fubon-credit-card-statements"
    | "esun-credit-card-statements"
    | "yuanta-credit-card-statements";
  authority:
    | "fubon/credit-card/human-attested-v2"
    | "esun/credit-card/human-attested-v2"
    | "yuanta/credit-card/human-attested-v1";
  contractVersion:
    | "fubon/credit-card/human-attested-v2"
    | "esun/credit-card/human-attested-v2"
    | "yuanta/credit-card/human-attested-v1";
  identity: "human-attested-primary-cardholder-portfolio";
  cards: "subordinate-instruments";
  postingAndBilling: "posted-from-posting-date-billing-independent";
  statements: "issuer-settled-cycle-summary-pinned-membership";
  relations: "explicit-source-linkage-only";
  completeness:
    | "six-billed-periods-plus-unbilled-terminal-grids"
    | "default-one-year-combined-grid-page-one-maximum-page-size-card-counts"
    | "six-billed-months-plus-unbilled-terminal-no-pager";
  liveEvidence:
    | "redacted-repeat-plus-human-attestation"
    | "redacted-complete-grid-repeat-plus-human-attestation"
    | "redacted-six-billed-month-plus-unbilled-terminal-plus-human-attestation";
  blockers: readonly AdvertisedCanonicalCreditCardReadinessBlocker[];
};

export type AdvertisedCanonicalCreditCardReadinessBlocker =
  | "issuer-settled-cycle-summary-evidence-missing";

export const ADVERTISED_CANONICAL_CREDIT_CARD_SOURCE_IDS = [
  "fubon",
  "esun",
  "yuanta",
] as const;

const advertisedFubon = Object.values(BANK_STATEMENT_CAPABILITIES).find(
  (group) =>
    group.id === "fubon" &&
    group.statementTypes.some((statementType) => statementType.id === "credit_card"),
);
if (!advertisedFubon)
  throw new Error("Fubon credit-card workflow is not advertised by the source registry.");

const advertisedEsun = Object.values(BANK_STATEMENT_CAPABILITIES).find(
  (group) =>
    group.id === "esun" &&
    group.statementTypes.some((statementType) => statementType.id === "credit_card"),
);
if (!advertisedEsun)
  throw new Error("E.SUN credit-card workflow is not advertised by the source registry.");

const advertisedYuanta = Object.values(BANK_STATEMENT_CAPABILITIES).find(
  (group) =>
    group.id === "yuanta" &&
    group.statementTypes.some((statementType) => statementType.id === "credit_card"),
);
if (!advertisedYuanta)
  throw new Error("Yuanta credit-card workflow is not advertised by the source registry.");

export const ADVERTISED_CANONICAL_CREDIT_CARD_READINESS = [
  {
    sourceId: "fubon",
    advertisedName: advertisedFubon.label,
    workflow: "fubon-credit-card-statements",
    authority: FUBON_CREDIT_CARD_CAPTURE_CONTRACT.authorityRoute,
    contractVersion: FUBON_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion,
    identity: "human-attested-primary-cardholder-portfolio",
    cards: "subordinate-instruments",
    postingAndBilling: "posted-from-posting-date-billing-independent",
    statements: "issuer-settled-cycle-summary-pinned-membership",
    relations: "explicit-source-linkage-only",
    completeness: "six-billed-periods-plus-unbilled-terminal-grids",
    liveEvidence: "redacted-repeat-plus-human-attestation",
    blockers: [],
  },
  {
    sourceId: "esun",
    advertisedName: advertisedEsun.label,
    workflow: "esun-credit-card-statements",
    authority: ESUN_CREDIT_CARD_CAPTURE_CONTRACT.authorityRoute,
    contractVersion: ESUN_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion,
    identity: "human-attested-primary-cardholder-portfolio",
    cards: "subordinate-instruments",
    postingAndBilling: "posted-from-posting-date-billing-independent",
    statements: "issuer-settled-cycle-summary-pinned-membership",
    relations: "explicit-source-linkage-only",
    completeness: ESUN_CREDIT_CARD_CAPTURE_CONTRACT.completenessRule,
    liveEvidence: "redacted-complete-grid-repeat-plus-human-attestation",
    blockers: [],
  },
  {
    sourceId: "yuanta",
    advertisedName: advertisedYuanta.label,
    workflow: "yuanta-credit-card-statements",
    authority: YUANTA_CREDIT_CARD_CAPTURE_CONTRACT.authorityRoute,
    contractVersion: YUANTA_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion,
    identity: "human-attested-primary-cardholder-portfolio",
    cards: "subordinate-instruments",
    postingAndBilling: "posted-from-posting-date-billing-independent",
    statements: "issuer-settled-cycle-summary-pinned-membership",
    relations: "explicit-source-linkage-only",
    completeness: YUANTA_CREDIT_CARD_CAPTURE_CONTRACT.completenessRule,
    liveEvidence: "redacted-six-billed-month-plus-unbilled-terminal-plus-human-attestation",
    blockers: ["issuer-settled-cycle-summary-evidence-missing"],
  },
] as const satisfies readonly AdvertisedCanonicalCreditCardReadinessEntry[];

export function isAdvertisedCanonicalCreditCardEntryReleaseReady(
  entry: AdvertisedCanonicalCreditCardReadinessEntry,
): boolean {
  const sharedSemantics =
    entry.identity === "human-attested-primary-cardholder-portfolio" &&
    entry.cards === "subordinate-instruments" &&
    entry.postingAndBilling === "posted-from-posting-date-billing-independent" &&
    entry.statements === "issuer-settled-cycle-summary-pinned-membership" &&
    entry.relations === "explicit-source-linkage-only" &&
    entry.blockers.length === 0;
  if (!sharedSemantics) return false;

  switch (entry.sourceId) {
    case "fubon":
      return (
        getFubonCreditCardHumanAttestedV2Manifest().status === "active" &&
        entry.workflow === "fubon-credit-card-statements" &&
        entry.authority === FUBON_CREDIT_CARD_CAPTURE_CONTRACT.authorityRoute &&
        entry.contractVersion === FUBON_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion &&
        entry.completeness === "six-billed-periods-plus-unbilled-terminal-grids" &&
        entry.liveEvidence === "redacted-repeat-plus-human-attestation"
      );
    case "esun":
      return (
        getEsunCreditCardHumanAttestedV2Manifest().status === "active" &&
        entry.workflow === "esun-credit-card-statements" &&
        entry.authority === ESUN_CREDIT_CARD_CAPTURE_CONTRACT.authorityRoute &&
        entry.contractVersion === ESUN_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion &&
        entry.completeness === ESUN_CREDIT_CARD_CAPTURE_CONTRACT.completenessRule &&
        entry.liveEvidence === "redacted-complete-grid-repeat-plus-human-attestation"
      );
    case "yuanta":
      return (
        getYuantaCreditCardHumanAttestedV1Manifest().status === "active" &&
        entry.workflow === "yuanta-credit-card-statements" &&
        entry.authority === YUANTA_CREDIT_CARD_CAPTURE_CONTRACT.authorityRoute &&
        entry.contractVersion === YUANTA_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion &&
        entry.completeness === YUANTA_CREDIT_CARD_CAPTURE_CONTRACT.completenessRule &&
        entry.liveEvidence ===
          "redacted-six-billed-month-plus-unbilled-terminal-plus-human-attestation"
      );
    default:
      return false;
  }
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
