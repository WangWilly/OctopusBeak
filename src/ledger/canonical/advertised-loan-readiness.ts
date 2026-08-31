import { BANK_STATEMENT_CAPABILITIES } from "../../lib/automation/statement-selection.ts";
import type { StatementSelectionGroup } from "../../lib/automation/statement-selection.ts";
import {
  FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1,
} from "./fubon-loan.ts";
import {
  YUANTA_LOAN_LIVE_VALIDATION_ATTESTATION_V1,
} from "./yuanta-loan.ts";
import {
  ADVERTISED_LOAN_SOURCE_IDS as CONTRACT_LOAN_SOURCE_IDS,
  FUBON_LOAN_AUTHORITY_ROUTE,
  FUBON_LOAN_CONTRACT_VERSION,
  LOAN_CONTRACT_FIXTURES,
  YUANTA_LOAN_AUTHORITY_ROUTE,
  YUANTA_LOAN_CONTRACT_VERSION,
  admitCanonicalLoanCapture,
  advertisedLoanSourceIds,
  type LoanCaptureInput,
  type LoanSourceId,
} from "./loan-financial.ts";

export {
  FUBON_LOAN_AUTHORITY_ROUTE,
  FUBON_LOAN_CONTRACT_VERSION,
  LOAN_CONTRACT_FIXTURES,
  YUANTA_LOAN_AUTHORITY_ROUTE,
  YUANTA_LOAN_CONTRACT_VERSION,
  admitCanonicalLoanCapture,
  type LoanCaptureInput,
  type LoanSourceId,
} from "./loan-financial.ts";

/**
 * Loan is an advertised statement type on precisely these two integrations.
 * Keep this assertion tied to the settings capability registry so a newly
 * advertised provider cannot silently bypass the canonical contract.
 */
export const ADVERTISED_LOAN_SOURCE_IDS = Object.freeze(
  advertisedLoanSourceIds(
    BANK_STATEMENT_CAPABILITIES as unknown as Record<
      string,
      StatementSelectionGroup
    >,
  ),
);

export function assertAdvertisedLoanManifestCoverage(
  registrySourceIds: readonly string[],
  manifestSourceIds: readonly string[],
): void {
  const registry = new Set(registrySourceIds);
  const manifests = new Set(manifestSourceIds);
  const missing = registrySourceIds.filter((sourceId) => !manifests.has(sourceId));
  const removed = manifestSourceIds.filter((sourceId) => !registry.has(sourceId));
  if (missing.length > 0 || removed.length > 0)
    throw new Error(
      [
        missing.length > 0 ? `Missing advertised loan manifests: ${missing.join(", ")}` : "",
        removed.length > 0 ? `Non-advertised loan manifests: ${removed.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    );
}

if (
  ADVERTISED_LOAN_SOURCE_IDS.length !== CONTRACT_LOAN_SOURCE_IDS.length ||
  !CONTRACT_LOAN_SOURCE_IDS.every((sourceId) =>
    ADVERTISED_LOAN_SOURCE_IDS.includes(sourceId),
  )
) {
  throw new Error("Advertised loan source coverage is incomplete.");
}
export type AdvertisedLoanReadinessBlocker = "live-validation-pending";

export type AdvertisedLoanReadinessEntry = {
  sourceId: LoanSourceId;
  advertisedName: string;
  workflow: "fubonLoanStatements" | "yuantaLoanStatements";
  authority: string;
  contractVersion: string;
  fixtureEvidence:
    | "canonical-versioned-synthetic"
    | "canonical-versioned-live-attested";
  accountBoundary: "source-scoped-loan-account";
  amountDirection: "source-coded-loan-boundary";
  optionalFacts: "source-distinguished-only";
  balanceEvidence: "source-reported-effective-time";
  relationEvidence: "explicit-source-linkage-only";
  completeness: "terminal-complete-range";
  contractComplete: true;
  liveValidation: "pending" | "complete";
  blockers: readonly AdvertisedLoanReadinessBlocker[];
};

const MANIFESTS: Record<
  LoanSourceId,
  {
    authority: string;
    contractVersion: string;
    workflow: AdvertisedLoanReadinessEntry["workflow"];
    liveAttestation: {
      status: "pending" | "verified-live-run";
      financialValuesRetained: boolean;
      authenticationSecretsRetained: boolean;
      rawSourcePayloadRetained: boolean;
    };
  }
> = {
  fubon: {
    authority: FUBON_LOAN_AUTHORITY_ROUTE,
    contractVersion: FUBON_LOAN_CONTRACT_VERSION,
    workflow: "fubonLoanStatements",
    liveAttestation: FUBON_LOAN_LIVE_VALIDATION_ATTESTATION_V1,
  },
  yuanta: {
    authority: YUANTA_LOAN_AUTHORITY_ROUTE,
    contractVersion: YUANTA_LOAN_CONTRACT_VERSION,
    workflow: "yuantaLoanStatements",
    liveAttestation: YUANTA_LOAN_LIVE_VALIDATION_ATTESTATION_V1,
  },
};

assertAdvertisedLoanManifestCoverage(
  ADVERTISED_LOAN_SOURCE_IDS,
  Object.keys(MANIFESTS),
);

export const ADVERTISED_LOAN_READINESS: readonly AdvertisedLoanReadinessEntry[] =
  Object.freeze(
    ADVERTISED_LOAN_SOURCE_IDS.map((sourceId): AdvertisedLoanReadinessEntry => {
      const advertised = Object.values(BANK_STATEMENT_CAPABILITIES).find(
        (group) => group.id === sourceId,
      );
      if (!advertised) throw new Error(`Missing advertised loan source ${sourceId}.`);
      const manifest = MANIFESTS[sourceId];
      // Import-time fixture admission is a deliberate contract tripwire. It
      // proves each readiness row has a real versioned, sanitized fixture.
      admitCanonicalLoanCapture(LOAN_CONTRACT_FIXTURES[sourceId]);
      const liveVerified =
        manifest.liveAttestation.status === "verified-live-run" &&
        manifest.liveAttestation.financialValuesRetained === false &&
        manifest.liveAttestation.authenticationSecretsRetained === false &&
        manifest.liveAttestation.rawSourcePayloadRetained === false;
      return {
        sourceId,
        advertisedName: advertised.label,
        workflow: manifest.workflow,
        authority: manifest.authority,
        contractVersion: manifest.contractVersion,
        fixtureEvidence: liveVerified
          ? ("canonical-versioned-live-attested" as const)
          : ("canonical-versioned-synthetic" as const),
        accountBoundary: "source-scoped-loan-account" as const,
        amountDirection: "source-coded-loan-boundary" as const,
        optionalFacts: "source-distinguished-only" as const,
        balanceEvidence: "source-reported-effective-time" as const,
        relationEvidence: "explicit-source-linkage-only" as const,
        completeness: "terminal-complete-range" as const,
        contractComplete: true as const,
        liveValidation: liveVerified ? ("complete" as const) : ("pending" as const),
        blockers: liveVerified ? [] : ["live-validation-pending"],
      };
    }),
  );

export type AdvertisedLoanReadinessGate = {
  status: "blocked" | "release-ready";
  releaseReady: boolean;
  advertisedSourceCount: number;
  unreadySourceIds: LoanSourceId[];
  pendingLiveValidationSourceIds: LoanSourceId[];
  entries: readonly AdvertisedLoanReadinessEntry[];
};

export function isAdvertisedLoanEntryContractReady(
  entry: AdvertisedLoanReadinessEntry,
): boolean {
  return (
    entry.contractComplete === true &&
    (entry.fixtureEvidence === "canonical-versioned-synthetic" ||
      entry.fixtureEvidence === "canonical-versioned-live-attested") &&
    entry.accountBoundary === "source-scoped-loan-account" &&
    entry.amountDirection === "source-coded-loan-boundary" &&
    entry.optionalFacts === "source-distinguished-only" &&
    entry.balanceEvidence === "source-reported-effective-time" &&
    entry.relationEvidence === "explicit-source-linkage-only" &&
    entry.completeness === "terminal-complete-range"
  );
}

export function isAdvertisedLoanEntryReleaseReady(
  entry: AdvertisedLoanReadinessEntry,
): boolean {
  return (
    isAdvertisedLoanEntryContractReady(entry) &&
    entry.liveValidation === "complete" &&
    entry.blockers.length === 0
  );
}

export function evaluateAdvertisedLoanReadiness(
  entries: readonly AdvertisedLoanReadinessEntry[] = ADVERTISED_LOAN_READINESS,
): AdvertisedLoanReadinessGate {
  const unreadySourceIds = entries
    .filter((entry) => !isAdvertisedLoanEntryContractReady(entry))
    .map((entry) => entry.sourceId);
  const pendingLiveValidationSourceIds = entries
    .filter((entry) => entry.blockers.includes("live-validation-pending"))
    .map((entry) => entry.sourceId);
  return {
    status:
      unreadySourceIds.length === 0 && pendingLiveValidationSourceIds.length === 0
        ? "release-ready"
        : "blocked",
    releaseReady:
      unreadySourceIds.length === 0 && pendingLiveValidationSourceIds.length === 0,
    advertisedSourceCount: entries.length,
    unreadySourceIds,
    pendingLiveValidationSourceIds,
    entries,
  };
}

export type { LoanCaptureInput as CanonicalLoanCaptureInput };
