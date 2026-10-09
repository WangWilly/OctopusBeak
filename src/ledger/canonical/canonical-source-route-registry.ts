import {
  CTBC_HUMAN_ATTESTED_V1_MANIFEST,
  ctbcHumanAttestationFingerprint,
} from "./ctbc-human-attestation-contract.ts";
import {
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_MANIFEST,
  esunCreditCardHumanAttestedManifestFingerprint,
} from "./esun-credit-card-human-attestation-contract.ts";
import {
  FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  manifestFingerprint as fubonHumanAttestationFingerprint,
} from "./fubon-human-attestation-contract.ts";
import {
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  fubonCreditCardHumanAttestedManifestFingerprint,
} from "./fubon-credit-card-human-attestation-contract.ts";
import {
  HNCB_HUMAN_ATTESTED_V1_MANIFEST,
  manifestFingerprint as hncbHumanAttestationFingerprint,
} from "./hncb-human-attestation-contract.ts";
import {
  POST_HUMAN_ATTESTED_V1_MANIFEST,
  postHumanAttestationFingerprint,
} from "./post-human-attestation-contract.ts";
import {
  SINOPAC_HUMAN_ATTESTED_V1_MANIFEST,
  sinopacHumanAttestedManifestFingerprint,
} from "./sinopac-human-attestation-contract.ts";
import {
  TDCC_NAMESPACE,
  TDCC_SETTLEMENT_BALANCE_CONTRACT,
  TDCC_SETTLEMENT_BALANCE_ROUTE,
  TDCC_SETTLEMENT_DEPOSIT_CONTRACT,
  TDCC_SETTLEMENT_DEPOSIT_ROUTE,
} from "./tdcc-settlement-contract.ts";
import { TDCC_INVESTMENT_CONTRACT, TDCC_INVESTMENT_ROUTE } from "./tdcc-investment-contract.ts";
import {
  YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  manifestFingerprint as yuantaHumanAttestationFingerprint,
} from "./yuanta-human-attestation-contract.ts";
import {
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  yuantaCreditCardHumanAttestedV2ManifestFingerprint,
} from "./yuanta-credit-card-human-attestation-contract.ts";

/**
 * The canonical source-route registry is intentionally closed.  A provider
 * adapter may select one of these reviewed declarations, but a capture cannot
 * create a new authority route by writing its first row.
 */
export type CanonicalSourceRouteRegistration = Readonly<{
  routeKey: string;
  integrationNamespace: string;
  stream: string;
  contractVersions: readonly string[];
  /**
   * The exact financial rule tuples admitted for this contract version.
   * Null posting/semantic fields identify observation-only evidence routes.
   */
  ruleCombinations?: readonly CanonicalSourceRuleCombination[];
  /** Immutable human-attestation evidence for PGlite's durable authority chain. */
  humanAttestation?: CanonicalSourceHumanAttestation;
  /**
   * The source-capture completeness rule may use a route-specific name even
   * when the persisted source-authority contract uses a shorter version.
   * When omitted, the contract versions are also the completeness versions.
   */
  completenessRuleVersions?: readonly string[];
  /** Non-ISO booked denominations this registered financial route may admit. */
  nonIsoFinancialDenominations?: readonly string[];
  /** Whether this source route requires or can optionally carry occurrence groups. */
  occurrenceGroups?: "required" | "optional";
  /** Query-inventory proof required when a route admits occurrence groups. */
  occurrenceGroupCoverage?: "queried-buckets";
}>;

export type CanonicalSourceRuleCombination = Readonly<{
  contractVersion: string;
  postingRuleVersion: string | null;
  semanticRuleVersion: string | null;
  effectiveTimeRuleVersion: string;
}>;

export type CanonicalSourceHumanAttestation = Readonly<{
  authorityRoute: string;
  attestationId: string;
  evidenceVersion: string;
  attestedAt: string;
  attestedBy: string;
  manifestFingerprint: `sha256:${string}`;
  providerGuaranteed: false;
  occurrenceProviderGuaranteed?: false;
  current: boolean;
  restoreEventKind: "attested" | "restored" | null;
}>;

type ImmutableHumanAttestationContract = Readonly<{
  authorityRoute: string;
  attestationId: string;
  evidenceVersion: string;
  attestedAt: string;
  attestedBy: string;
  status: "active";
  providerGuaranteed: false;
  occurrenceProviderGuaranteed?: false;
}>;

function attestationFromContract(
  contract: ImmutableHumanAttestationContract,
  manifestFingerprint: string,
  restoreEventKind: "attested" | "restored" | null,
): CanonicalSourceHumanAttestation {
  if (!manifestFingerprint.startsWith("sha256:"))
    throw new Error(`Human-attestation fingerprint for ${contract.authorityRoute} is invalid.`);
  return Object.freeze({
    authorityRoute: contract.authorityRoute,
    attestationId: contract.attestationId,
    evidenceVersion: contract.evidenceVersion,
    attestedAt: contract.attestedAt,
    attestedBy: contract.attestedBy,
    manifestFingerprint: manifestFingerprint as `sha256:${string}`,
    providerGuaranteed: contract.providerGuaranteed,
    ...(contract.occurrenceProviderGuaranteed === false
      ? { occurrenceProviderGuaranteed: false as const }
      : {}),
    current: true,
    restoreEventKind,
  });
}

const sameRuleTuple = (
  contractVersion: string,
  ruleVersion: string,
): CanonicalSourceRuleCombination => ({
  contractVersion,
  postingRuleVersion: ruleVersion,
  semanticRuleVersion: ruleVersion,
  effectiveTimeRuleVersion: ruleVersion,
});

const effectiveTimeOnly = (
  contractVersion: string,
  effectiveTimeRuleVersion: string,
): CanonicalSourceRuleCombination => ({
  contractVersion,
  postingRuleVersion: null,
  semanticRuleVersion: null,
  effectiveTimeRuleVersion,
});

const registrations: readonly CanonicalSourceRouteRegistration[] = ([
  // Source Capture contracts.
  {
    routeKey: "fubon/domestic-deposit/capture-evidence-v2",
    integrationNamespace: "fubon",
    stream: "domestic-deposit",
    contractVersions: ["capture-evidence-v2"],
  },
  {
    routeKey: "yuanta/domestic-deposit/capture-evidence-v1",
    integrationNamespace: "yuanta",
    stream: "domestic-deposit",
    contractVersions: ["capture-evidence-v1"],
  },
  {
    routeKey: "yuanta/domestic-deposit/capture-evidence-v2",
    integrationNamespace: "yuanta",
    stream: "domestic-deposit",
    contractVersions: ["capture-evidence-v2"],
  },
  {
    routeKey: "hncb/domestic-deposit/capture-evidence-v1",
    integrationNamespace: "hncb",
    stream: "domestic-deposit",
    contractVersions: ["capture-evidence-v1"],
  },
  {
    routeKey: "ctbc/domestic-deposit/capture-evidence-v2",
    integrationNamespace: "ctbc",
    stream: "domestic-deposit",
    contractVersions: ["capture-evidence-v2"],
  },
  {
    routeKey: "post/domestic-deposit/capture-evidence-v1",
    integrationNamespace: "post",
    stream: "domestic-deposit",
    contractVersions: ["capture-evidence-v1"],
  },
  {
    routeKey: "sinopac/domestic-deposit/capture-evidence-v1",
    integrationNamespace: "sinopac",
    stream: "domestic-deposit",
    contractVersions: ["capture-evidence-v1"],
  },
  {
    routeKey: "sinopac/foreign-currency/capture-evidence-v1",
    integrationNamespace: "sinopac",
    stream: "foreign-currency",
    contractVersions: ["capture-evidence-v1"],
  },

  // Human-attested financial contracts that share source persistence.
  {
    routeKey: "fubon/domestic-deposit/human-attested-v1",
    integrationNamespace: "fubon",
    stream: "domestic-deposit",
    contractVersions: ["human-attested-v1"],
    completenessRuleVersions: ["fubon/domestic-deposit/human-attested-v1"],
    occurrenceGroups: "required",
    ruleCombinations: [sameRuleTuple("human-attested-v1", "fubon/domestic-deposit/human-attested-v1")],
    humanAttestation: attestationFromContract(FUBON_HUMAN_ATTESTED_V1_MANIFEST, fubonHumanAttestationFingerprint(FUBON_HUMAN_ATTESTED_V1_MANIFEST), null),
  },
  {
    routeKey: "yuanta/domestic-deposit/human-attested-v2",
    integrationNamespace: "yuanta",
    stream: "domestic-deposit",
    contractVersions: ["human-attested-v2"],
    completenessRuleVersions: ["yuanta/domestic-deposit/human-attested-v2"],
    occurrenceGroups: "required",
    ruleCombinations: [sameRuleTuple("human-attested-v2", "yuanta/domestic-deposit/human-attested-v2")],
    humanAttestation: attestationFromContract(YUANTA_HUMAN_ATTESTED_V2_MANIFEST, yuantaHumanAttestationFingerprint(YUANTA_HUMAN_ATTESTED_V2_MANIFEST), "attested"),
  },
  {
    routeKey: "hncb/domestic-deposit/human-attested-v1",
    integrationNamespace: "hncb",
    stream: "domestic-deposit",
    contractVersions: ["human-attested-v1"],
    completenessRuleVersions: ["hncb/domestic-deposit/human-attested-v1"],
    occurrenceGroups: "required",
    ruleCombinations: [sameRuleTuple("human-attested-v1", "hncb/domestic-deposit/human-attested-v1")],
    humanAttestation: attestationFromContract(HNCB_HUMAN_ATTESTED_V1_MANIFEST, hncbHumanAttestationFingerprint(HNCB_HUMAN_ATTESTED_V1_MANIFEST), "attested"),
  },
  {
    routeKey: "ctbc/domestic-deposit/human-attested-v1",
    integrationNamespace: "ctbc",
    stream: "domestic-deposit",
    contractVersions: ["human-attested-v1"],
    completenessRuleVersions: ["ctbc/domestic-deposit/human-attested-v1"],
    occurrenceGroups: "required",
    ruleCombinations: [sameRuleTuple("human-attested-v1", "ctbc/domestic-deposit/human-attested-v1")],
    humanAttestation: attestationFromContract(CTBC_HUMAN_ATTESTED_V1_MANIFEST, ctbcHumanAttestationFingerprint(CTBC_HUMAN_ATTESTED_V1_MANIFEST), "attested"),
  },
  {
    routeKey: "post/domestic-deposit/human-attested-v1",
    integrationNamespace: "post",
    stream: "domestic-deposit",
    contractVersions: ["human-attested-v1"],
    completenessRuleVersions: ["post/domestic-deposit/human-attested-v1"],
    occurrenceGroups: "required",
    ruleCombinations: [sameRuleTuple("human-attested-v1", "post/domestic-deposit/human-attested-v1")],
    humanAttestation: attestationFromContract(POST_HUMAN_ATTESTED_V1_MANIFEST, postHumanAttestationFingerprint(POST_HUMAN_ATTESTED_V1_MANIFEST), "attested"),
  },
  {
    routeKey: "sinopac/domestic-deposit/human-attested-v1",
    integrationNamespace: "sinopac",
    stream: "domestic-deposit",
    contractVersions: ["human-attested-v1"],
    completenessRuleVersions: ["sinopac/domestic-deposit/human-attested-v1"],
    occurrenceGroups: "required",
    ruleCombinations: [sameRuleTuple("human-attested-v1", "sinopac/domestic-deposit/human-attested-v1")],
    humanAttestation: attestationFromContract(SINOPAC_HUMAN_ATTESTED_V1_MANIFEST, sinopacHumanAttestedManifestFingerprint(), "attested"),
  },
  {
    routeKey: "fubon/credit-card/human-attested-v2",
    integrationNamespace: "fubon",
    stream: "credit-card",
    contractVersions: ["fubon/credit-card/human-attested-v2"],
    ruleCombinations: [sameRuleTuple("fubon/credit-card/human-attested-v2", "fubon/credit-card/human-attested-v2")],
    humanAttestation: attestationFromContract(FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST, fubonCreditCardHumanAttestedManifestFingerprint(FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST), "restored"),
    occurrenceGroups: "required",
    occurrenceGroupCoverage: "queried-buckets",
  },
  {
    routeKey: "esun/credit-card/human-attested-v4",
    integrationNamespace: "esun",
    stream: "credit-card",
    contractVersions: ["esun/credit-card/human-attested-v4"],
    ruleCombinations: [sameRuleTuple("esun/credit-card/human-attested-v4", "esun/credit-card/human-attested-v4")],
    humanAttestation: attestationFromContract(ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_MANIFEST, esunCreditCardHumanAttestedManifestFingerprint(ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_MANIFEST), "restored"),
    occurrenceGroups: "required",
    occurrenceGroupCoverage: "queried-buckets",
  },
  {
    routeKey: "yuanta/credit-card/human-attested-v2",
    integrationNamespace: "yuanta",
    stream: "credit-card",
    contractVersions: ["yuanta/credit-card/human-attested-v2"],
    ruleCombinations: [sameRuleTuple("yuanta/credit-card/human-attested-v2", "yuanta/credit-card/human-attested-v2")],
    humanAttestation: attestationFromContract(YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST, yuantaCreditCardHumanAttestedV2ManifestFingerprint(YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST), "restored"),
    occurrenceGroups: "required",
    occurrenceGroupCoverage: "queried-buckets",
  },
  {
    routeKey: "yuanta/credit-card/current-used-credit-v1",
    integrationNamespace: "yuanta",
    stream: "credit-card",
    contractVersions: ["yuanta/credit-card/current-used-credit-v1"],
    ruleCombinations: [effectiveTimeOnly("yuanta/credit-card/current-used-credit-v1", "yuanta/credit-card/current-used-credit-v1")],
  },
  {
    routeKey: "esun/credit-card/current-used-credit-v1",
    integrationNamespace: "esun",
    stream: "credit-card",
    contractVersions: ["esun/credit-card/current-used-credit-v1"],
    ruleCombinations: [effectiveTimeOnly("esun/credit-card/current-used-credit-v1", "esun/credit-card/current-used-credit-v1")],
  },
  {
    routeKey: "esun/credit-card/current-used-credit-v2",
    integrationNamespace: "esun",
    stream: "credit-card",
    contractVersions: ["esun/credit-card/current-used-credit-v2"],
    ruleCombinations: [effectiveTimeOnly("esun/credit-card/current-used-credit-v2", "esun/credit-card/current-used-credit-v2")],
  },
  {
    routeKey: "fubon/credit-card/current-used-credit-v1",
    integrationNamespace: "fubon",
    stream: "credit-card",
    contractVersions: ["fubon/credit-card/current-used-credit-v1"],
    ruleCombinations: [effectiveTimeOnly("fubon/credit-card/current-used-credit-v1", "fubon/credit-card/current-used-credit-v1")],
  },
  {
    routeKey: "cathay/domestic-deposit/v1",
    integrationNamespace: "cathay",
    stream: "domestic-deposit",
    contractVersions: ["v1"],
    completenessRuleVersions: ["cathay/domestic-deposit/v1"],
    ruleCombinations: [sameRuleTuple("v1", "cathay/domestic-deposit/v1")],
  },
  {
    routeKey: "cathay/foreign-currency/deposit/v1",
    integrationNamespace: "cathay",
    stream: "foreign-currency-deposit",
    contractVersions: ["foreign-currency/cathay/v1"],
    ruleCombinations: [sameRuleTuple("foreign-currency/cathay/v1", "foreign-currency/cathay/v1")],
  },
  {
    routeKey: "cathay/domestic-deposit/current-balance-v1",
    integrationNamespace: "cathay",
    stream: "domestic-deposit",
    contractVersions: ["cathay/current-deposit-balance-v1"],
    ruleCombinations: [effectiveTimeOnly("cathay/current-deposit-balance-v1", "cathay/current-deposit-balance-v1")],
  },
  {
    routeKey: "cathay/foreign-currency/current-balance-v1",
    integrationNamespace: "cathay",
    stream: "foreign-currency-deposit",
    contractVersions: ["cathay/current-deposit-balance-v1"],
    ruleCombinations: [effectiveTimeOnly("cathay/current-deposit-balance-v1", "cathay/current-deposit-balance-v1")],
  },
  {
    routeKey: "ctbc/domestic-deposit/current-balance-v1",
    integrationNamespace: "ctbc",
    stream: "domestic-deposit",
    contractVersions: ["ctbc/current-deposit-balance-v1"],
    ruleCombinations: [effectiveTimeOnly("ctbc/current-deposit-balance-v1", "ctbc/current-deposit-balance-v1")],
  },
  {
    routeKey: "linebank/domestic-deposit/current-balance-v1",
    integrationNamespace: "linebank",
    stream: "domestic-deposit",
    contractVersions: ["linebank/current-deposit-balance-v1"],
    ruleCombinations: [effectiveTimeOnly("linebank/current-deposit-balance-v1", "linebank/current-deposit-balance-v1")],
  },
  {
    routeKey: "linebank/foreign-currency/deposit/v1",
    integrationNamespace: "linebank",
    stream: "foreign-currency-deposit",
    contractVersions: ["foreign-currency/linebank/v1"],
    ruleCombinations: [sameRuleTuple("foreign-currency/linebank/v1", "foreign-currency/linebank/v1")],
  },
  {
    routeKey: "linebank/domestic-deposit/human-attested-v13",
    integrationNamespace: "linebank",
    stream: "domestic-deposit",
    contractVersions: ["human-attested-v13"],
    completenessRuleVersions: ["linebank/domestic-deposit/human-attested-v13"],
    ruleCombinations: [sameRuleTuple("human-attested-v13", "linebank/domestic-deposit/human-attested-v13")],
  },
  {
    routeKey: "yuanta/foreign-currency/deposit/human-attested-v2",
    integrationNamespace: "yuanta",
    stream: "foreign-currency-deposit",
    contractVersions: ["foreign-currency/yuanta/human-attested-v2"],
    ruleCombinations: [sameRuleTuple("foreign-currency/yuanta/human-attested-v2", "foreign-currency/yuanta/human-attested-v2")],
    occurrenceGroups: "required",
  },
  {
    routeKey: "yuanta/domestic-deposit/current-balance-v1",
    integrationNamespace: "yuanta",
    stream: "domestic-deposit",
    contractVersions: ["yuanta/current-deposit-balance-v1"],
    ruleCombinations: [effectiveTimeOnly("yuanta/current-deposit-balance-v1", "yuanta/current-deposit-balance-v1")],
  },
  {
    routeKey: "yuanta/foreign-currency/current-balance-v1",
    integrationNamespace: "yuanta",
    stream: "foreign-currency-deposit",
    contractVersions: ["yuanta/current-deposit-balance-v1"],
    ruleCombinations: [effectiveTimeOnly("yuanta/current-deposit-balance-v1", "yuanta/current-deposit-balance-v1")],
  },
  {
    routeKey: "fubon/domestic-deposit/current-balance-v1",
    integrationNamespace: "fubon",
    stream: "domestic-deposit",
    contractVersions: ["fubon/current-deposit-balance-v1"],
    ruleCombinations: [effectiveTimeOnly("fubon/current-deposit-balance-v1", "fubon/current-deposit-balance-v1")],
  },
  {
    routeKey: "hncb/domestic-deposit/current-balance-v1",
    integrationNamespace: "hncb",
    stream: "domestic-deposit",
    contractVersions: ["hncb/current-deposit-balance-v1"],
    ruleCombinations: [effectiveTimeOnly("hncb/current-deposit-balance-v1", "hncb/current-deposit-balance-v1")],
  },
  {
    routeKey: "hncb/domestic-deposit/current-balance-overview-v1",
    integrationNamespace: "hncb",
    stream: "domestic-deposit",
    contractVersions: ["hncb/current-deposit-balance-overview-v1"],
    ruleCombinations: [effectiveTimeOnly("hncb/current-deposit-balance-overview-v1", "hncb/current-deposit-balance-overview-v1")],
  },
  {
    routeKey: "sinopac/domestic-deposit/current-balance-v1",
    integrationNamespace: "sinopac",
    stream: "domestic-deposit",
    contractVersions: ["sinopac/current-deposit-balance-v1"],
    ruleCombinations: [effectiveTimeOnly("sinopac/current-deposit-balance-v1", "sinopac/current-deposit-balance-v1")],
  },
  {
    routeKey: "sinopac/foreign-currency/current-balance-v1",
    integrationNamespace: "sinopac",
    stream: "foreign-currency-deposit",
    contractVersions: ["sinopac/current-deposit-balance-v1"],
    ruleCombinations: [effectiveTimeOnly("sinopac/current-deposit-balance-v1", "sinopac/current-deposit-balance-v1")],
  },
  {
    routeKey: "post/domestic-deposit/current-balance-v1",
    integrationNamespace: "post",
    stream: "domestic-deposit",
    contractVersions: ["post/current-deposit-balance-v1"],
    ruleCombinations: [effectiveTimeOnly("post/current-deposit-balance-v1", "post/current-deposit-balance-v1")],
  },
  {
    routeKey: "sinopac/foreign-currency/deposit/human-attested-v1",
    integrationNamespace: "sinopac",
    stream: "foreign-currency-deposit",
    contractVersions: ["foreign-currency/sinopac/human-attested-v1"],
    ruleCombinations: [sameRuleTuple("foreign-currency/sinopac/human-attested-v1", "foreign-currency/sinopac/human-attested-v1")],
    occurrenceGroups: "required",
  },

  {
    routeKey: TDCC_SETTLEMENT_DEPOSIT_ROUTE,
    integrationNamespace: TDCC_NAMESPACE,
    stream: "domestic-deposit",
    contractVersions: [TDCC_SETTLEMENT_DEPOSIT_CONTRACT],
    completenessRuleVersions: [TDCC_SETTLEMENT_DEPOSIT_ROUTE],
    ruleCombinations: [sameRuleTuple(TDCC_SETTLEMENT_DEPOSIT_CONTRACT, TDCC_SETTLEMENT_DEPOSIT_ROUTE)],
    occurrenceGroups: "required",
  },
  {
    routeKey: TDCC_SETTLEMENT_BALANCE_ROUTE,
    integrationNamespace: TDCC_NAMESPACE,
    stream: "domestic-deposit",
    contractVersions: [TDCC_SETTLEMENT_BALANCE_CONTRACT],
    ruleCombinations: [effectiveTimeOnly(TDCC_SETTLEMENT_BALANCE_CONTRACT, TDCC_SETTLEMENT_BALANCE_CONTRACT)],
  },

  // E-Invoice canonical capture.  This route is provider-neutral because the
  // Taiwan E-Invoice authority is the contract boundary; connection identity
  // and subject scope remain per provider login/subject in each capture.
  {
    routeKey: "einvoice/personal-invoices/canonical-v1",
    integrationNamespace: "einvoice",
    stream: "personal-invoices",
    contractVersions: ["einvoice/personal-invoices/canonical-v1"],
    completenessRuleVersions: ["einvoice/personal-invoices/completeness-v1"],
  },

  // Investment and loan writers retain the same canonical source envelope.
  {
    routeKey: "yuanta-fund/investment/canonical-v1",
    integrationNamespace: "yuanta-fund",
    stream: "investment",
    contractVersions: ["yuanta-fund/investment/canonical-v1"],
    ruleCombinations: [sameRuleTuple("yuanta-fund/investment/canonical-v1", "yuanta-fund/investment/canonical-v1")],
    occurrenceGroups: "required",
  },
  {
    routeKey: "yuanta-trade/investment/canonical-v1",
    integrationNamespace: "yuanta-trade",
    stream: "investment",
    contractVersions: ["yuanta-trade/investment/canonical-v1"],
    ruleCombinations: [sameRuleTuple("yuanta-trade/investment/canonical-v1", "yuanta-trade/investment/canonical-v1")],
    occurrenceGroups: "required",
  },
  {
    routeKey: "maicoin/investment/canonical-v1",
    integrationNamespace: "maicoin",
    stream: "investment",
    contractVersions: ["maicoin/investment/canonical-v1"],
    ruleCombinations: [sameRuleTuple("maicoin/investment/canonical-v1", "maicoin/investment/canonical-v1")],
    nonIsoFinancialDenominations: ["USDT"],
  },
  {
    routeKey: TDCC_INVESTMENT_ROUTE,
    integrationNamespace: TDCC_NAMESPACE,
    stream: "investment",
    contractVersions: [TDCC_INVESTMENT_CONTRACT],
    ruleCombinations: [sameRuleTuple(TDCC_INVESTMENT_CONTRACT, TDCC_INVESTMENT_CONTRACT)],
  },
  {
    routeKey: "yuanta-fund/investment/margin-credit-canonical-v1",
    integrationNamespace: "yuanta-fund",
    stream: "investment-margin",
    contractVersions: ["yuanta-fund/investment/margin-credit-canonical-v1"],
    ruleCombinations: [effectiveTimeOnly("yuanta-fund/investment/margin-credit-canonical-v1", "yuanta-fund/investment/margin-credit-canonical-v1")],
  },
  {
    routeKey: "yuanta-trade/investment/margin-credit-canonical-v1",
    integrationNamespace: "yuanta-trade",
    stream: "investment-margin",
    contractVersions: ["yuanta-trade/investment/margin-credit-canonical-v1"],
    ruleCombinations: [effectiveTimeOnly("yuanta-trade/investment/margin-credit-canonical-v1", "yuanta-trade/investment/margin-credit-canonical-v1")],
  },
  {
    routeKey: "fubon/loan/canonical-v2",
    integrationNamespace: "fubon",
    stream: "loan",
    contractVersions: ["loan/canonical/v2.fubon"],
    ruleCombinations: [
      {
        contractVersion: "loan/canonical/v2.fubon",
        postingRuleVersion: "fubon/loan/canonical-v2",
        semanticRuleVersion: "fubon/loan/canonical-v2",
        effectiveTimeRuleVersion: "fubon/loan/canonical-v2",
      },
      effectiveTimeOnly("loan/canonical/v2.fubon", "loan/canonical/v2.fubon"),
    ],
    occurrenceGroups: "required",
  },
  {
    routeKey: "yuanta/loan/canonical-v1",
    integrationNamespace: "yuanta",
    stream: "loan",
    contractVersions: ["loan/canonical/v1.yuanta"],
    ruleCombinations: [
      {
        contractVersion: "loan/canonical/v1.yuanta",
        postingRuleVersion: "yuanta/loan/canonical-v1",
        semanticRuleVersion: "yuanta/loan/canonical-v1",
        effectiveTimeRuleVersion: "yuanta/loan/canonical-v1",
      },
      effectiveTimeOnly("loan/canonical/v1.yuanta", "loan/canonical/v1.yuanta"),
    ],
    occurrenceGroups: "required",
  },
  {
    routeKey: "fubon/loan/counterpart-deposit-v1",
    integrationNamespace: "fubon",
    stream: "domestic-deposit",
    contractVersions: ["loan/counterpart/v1.fubon"],
    ruleCombinations: [{
      contractVersion: "loan/counterpart/v1.fubon",
      postingRuleVersion: "fubon/loan/counterpart-deposit-v1",
      semanticRuleVersion: "fubon/loan/counterpart-deposit-v1",
      effectiveTimeRuleVersion: "fubon/loan/counterpart-deposit-v1",
    }],
  },
  {
    routeKey: "yuanta/loan/counterpart-deposit-v1",
    integrationNamespace: "yuanta",
    stream: "domestic-deposit",
    contractVersions: ["loan/counterpart/v1.yuanta"],
    ruleCombinations: [{
      contractVersion: "loan/counterpart/v1.yuanta",
      postingRuleVersion: "yuanta/loan/counterpart-deposit-v1",
      semanticRuleVersion: "yuanta/loan/counterpart-deposit-v1",
      effectiveTimeRuleVersion: "yuanta/loan/counterpart-deposit-v1",
    }],
  },

  // LineBank's preflight capture records the reviewed account/range inventory
  // before a financial capture is admitted.
  {
    routeKey: "linebank/domestic-deposit/preflight-v4",
    integrationNamespace: "linebank",
    stream: "domestic-deposit",
    contractVersions: ["preflight-v4"],
  },
] as readonly CanonicalSourceRouteRegistration[]).map((registration) =>
  Object.freeze({
    ...registration,
    contractVersions: Object.freeze([...registration.contractVersions]),
    ...(registration.ruleCombinations
      ? {
          ruleCombinations: Object.freeze(
            registration.ruleCombinations.map((combination) =>
              Object.freeze({ ...combination }),
            ),
          ),
        }
      : {}),
    ...(registration.nonIsoFinancialDenominations
      ? {
          nonIsoFinancialDenominations: Object.freeze([
            ...registration.nonIsoFinancialDenominations,
          ]),
        }
      : {}),
    ...(registration.humanAttestation
      ? { humanAttestation: Object.freeze({ ...registration.humanAttestation }) }
      : {}),
    ...("completenessRuleVersions" in registration && registration.completenessRuleVersions
      ? {
          completenessRuleVersions: Object.freeze([
            ...registration.completenessRuleVersions,
          ]),
        }
      : {}),
  }),
);

export const CANONICAL_SOURCE_ROUTE_REGISTRY = Object.freeze(
  registrations,
);

function validateRegistry(registry: readonly CanonicalSourceRouteRegistration[]): void {
  const routes = new Set<string>();
  for (const registration of registry) {
    if (!registration.routeKey || !registration.integrationNamespace || !registration.stream)
      throw new Error("Canonical source route registrations require a route, namespace, and stream.");
    if (routes.has(registration.routeKey))
      throw new Error(`Canonical source route ${registration.routeKey} is registered more than once.`);
    routes.add(registration.routeKey);
    if (registration.contractVersions.length === 0 ||
        new Set(registration.contractVersions).size !== registration.contractVersions.length)
      throw new Error(`Canonical source route ${registration.routeKey} requires unique contract versions.`);
    if (registration.humanAttestation?.authorityRoute !== undefined &&
        registration.humanAttestation.authorityRoute !== registration.routeKey)
      throw new Error(`Human-attestation route does not match ${registration.routeKey}.`);
    const combinations = new Set<string>();
    for (const combination of registration.ruleCombinations ?? []) {
      if (!registration.contractVersions.includes(combination.contractVersion) ||
          !combination.effectiveTimeRuleVersion ||
          ((combination.postingRuleVersion === null) !==
            (combination.semanticRuleVersion === null)))
        throw new Error(`Canonical source route ${registration.routeKey} has an invalid rule combination.`);
      const key = [
        combination.contractVersion,
        combination.postingRuleVersion ?? "",
        combination.semanticRuleVersion ?? "",
        combination.effectiveTimeRuleVersion,
      ].join("\0");
      if (combinations.has(key))
        throw new Error(`Canonical source route ${registration.routeKey} repeats a rule combination.`);
      combinations.add(key);
    }
  }
}

validateRegistry(CANONICAL_SOURCE_ROUTE_REGISTRY);

const byRoute = new Map(
  CANONICAL_SOURCE_ROUTE_REGISTRY.map((registration) => [
    registration.routeKey,
    registration,
  ]),
);

export function canonicalSourceRouteRegistration(
  routeKey: string,
): CanonicalSourceRouteRegistration | undefined {
  return byRoute.get(routeKey);
}

export function canonicalSourceRuleCombinations(
  routeKey: string,
  contractVersion: string,
): readonly CanonicalSourceRuleCombination[] {
  return canonicalSourceRouteRegistration(routeKey)?.ruleCombinations?.filter(
    (combination) => combination.contractVersion === contractVersion,
  ) ?? [];
}

export function canonicalSourceRuleCombination(
  routeKey: string,
  contractVersion: string,
  postingRuleVersion: string,
  semanticRuleVersion: string,
  effectiveTimeRuleVersion: string,
): CanonicalSourceRuleCombination | undefined {
  return canonicalSourceRuleCombinations(routeKey, contractVersion).find(
    (combination) =>
      combination.postingRuleVersion === postingRuleVersion &&
      combination.semanticRuleVersion === semanticRuleVersion &&
      combination.effectiveTimeRuleVersion === effectiveTimeRuleVersion,
  );
}

export function canonicalSourceEffectiveTimeRule(
  routeKey: string,
  contractVersion: string,
  effectiveTimeRuleVersion: string,
): CanonicalSourceRuleCombination | undefined {
  return canonicalSourceRuleCombinations(routeKey, contractVersion).find(
    (combination) =>
      combination.effectiveTimeRuleVersion === effectiveTimeRuleVersion,
  );
}

export function canonicalSourceRouteCompletenessRuleVersions(
  routeKey: string,
): readonly string[] {
  const registration = canonicalSourceRouteRegistration(routeKey);
  return registration?.completenessRuleVersions ?? registration?.contractVersions ?? [];
}
