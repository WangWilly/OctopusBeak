import { createHash } from "node:crypto";

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object") deepFreeze(child, seen);
  }
  return Object.freeze(value);
};

/**
 * This is a user-confirmed source authority, not a provider identity claim.
 * Yuanta exposes masked card values and no stable transaction identifiers in
 * the observed credit-card response.  The account key is therefore derived
 * from the encrypted credential scope by the workflow and is never a card
 * number or a presentation label.
 */
export const YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE =
  "yuanta/credit-card/human-attested-v2" as const;
export const YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_VERSION =
  "yuanta/credit-card/human-attested-v2" as const;
export const YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST = deepFreeze({
  attestationId: "yuanta-credit-card-human-attested-v2",
  evidenceVersion: YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_VERSION,
  authorityRoute: YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
  status: "active",
  attestedAt: "2026-08-27T00:00:00.000+08:00",
  attestedBy: "user-confirmed-yuanta-credit-card-portfolio",
  provenance: {
    kind: "human-attestation",
    sourceCaptureFingerprint:
      "sha256:yuanta-credit-card-live-card-projection-and-history-detail-settled-summary-evidence-v2",
    source:
      "Yuanta redacted six billed-month plus unbilled terminal capture with issuer-settled summaries",
  },
  authority: "human-attested-primary-cardholder-portfolio",
  accountType: "credit",
  accountSubtype: "credit_card",
  stream: "credit-card",
  currency: "TWD",
  providerGuaranteed: false,
  occurrenceProviderGuaranteed: false,
  semantics: {
    accountIdentity:
      "yuanta-source-connection-identity-epoch-credential-account-fingerprint",
    cards:
      "card-instruments-by-managed-secret-hmac-of-first-six-plus-last-four-projection",
    posting: "posted-date-required",
    billing: "billed-or-unbilled-independent-of-posting",
    transactionIdentity:
      "immutable-normalized-content-tuple-plus-contiguous-exact-duplicate-ordinal",
    occurrenceOrdering:
      "complete-six-month-plus-unbilled-deterministic-source-order-human-attested-not-provider-guaranteed",
    statements:
      "issuer-settled-history-detail-close-due-total-minimum-with-period-and-prior-close-derived-cycle-start",
    relations: "explicit-source-linkage-only",
    completeness: "six-billed-months-plus-unbilled-terminal-no-pager",
    withdrawal: "never-infer-from-missing-card-or-row",
    settledSummaryPeriodAuthority:
      "history-detail.table.rwdTable[0].row[0].cell[0].period-label-to-row[1].cell[0].same-column-value-exact-human-attested-a",
    settledSummaryPeriodFormat:
      "human-attested-category-2-gregorian-year-month-slash-with-month-or-period-suffix",
    settledSummaryNonAuthoritativePeriodSources:
      "card-title-and-month-tab-non-authoritative",
    settledSummaryBalanceAuthority:
      "history-detail.table.rwdTable[0].balance-label-to-next-row.same-column-value-exact-human-attested-a",
    settledSummaryNonAuthoritativeBalanceSources:
      "paid-amount-and-text-fragment-non-authoritative",
    settledSummaryParserContract:
      "yuanta-credit-card.settled-summary-parser.v7-exact-period-balance-a",
    settledSummaryLiveEvidence:
      "six-issuer-history-detail-summaries-five-bounded-cycles-queryHistoryDetail-authority",
    settledSummaryAuthorityContract:
      "queryHistoryDetail-selected-billed-month-response-with-provider-posting-date-membership",
    settledSummaryExactFieldEvidence:
      "period-and-balance-next-row-same-column-exact-human-attested-a",
    settledSummaryCompletenessEvidence:
      "complete-range-seven-terminal-grids-six-history-summaries-unbilled-terminal",
    settledSummaryRepeatEvidence:
      "two-v2-captures-repeat-deduped-authority-with-provenance-retained",
    settledSummaryCurrentRoutePrecedence:
      "v2-complete-capture-supersedes-v1-current-view-only-history-retains-both",
    settledSummaryDiagnosticPage:
      "creditcardsummary-optional-non-authoritative-and-must-not-block",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type YuantaCreditCardHumanAttestedV2Manifest = Omit<
  typeof YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type YuantaCreditCardHumanAttestationEvent = {
  attestationId: string;
  evidenceVersion: string;
  eventKind: "attested" | "revoked" | "restored";
  manifestStatus: "active" | "revoked";
  eventAt: string;
  reason: string | null;
  manifestFingerprint: `sha256:${string}`;
  sequence: number;
};

/** The workflow may only pass an opaque, non-card account attestation key. */
export function isYuantaCreditCardHumanAttestedAccountKey(
  value: unknown,
): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  if (!/^[A-Za-z][A-Za-z0-9._:-]{2,127}$/u.test(value)) return false;
  if (/^\d+$/u.test(value) || /\*/u.test(value)) return false;
  return !/(?:^|[-_:])(card|mask|pan|visa|mastercard|amex)(?:$|[-_:])/iu.test(
    value,
  );
}

const VALIDATED_V2_MANIFESTS = new WeakSet<object>();
let currentV2Manifest: YuantaCreditCardHumanAttestedV2Manifest =
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST;
VALIDATED_V2_MANIFESTS.add(currentV2Manifest);

function manifestFingerprintV2(
  manifest: YuantaCreditCardHumanAttestedV2Manifest = currentV2Manifest,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        attestationId: manifest.attestationId,
        evidenceVersion: manifest.evidenceVersion,
        authorityRoute: manifest.authorityRoute,
        sourceCaptureFingerprint: manifest.provenance.sourceCaptureFingerprint,
        semantics: manifest.semantics,
        providerGuaranteed: manifest.providerGuaranteed,
        occurrenceProviderGuaranteed: manifest.occurrenceProviderGuaranteed,
      }),
    )
    .digest("base64url")}`;
}

export function yuantaCreditCardHumanAttestedV2ManifestFingerprint(
  manifest: YuantaCreditCardHumanAttestedV2Manifest = currentV2Manifest,
): `sha256:${string}` {
  return manifestFingerprintV2(manifest);
}

export function assertYuantaCreditCardHumanAttestedV2Manifest(
  manifest: YuantaCreditCardHumanAttestedV2Manifest,
): void {
  if (
    manifest !== currentV2Manifest ||
    !VALIDATED_V2_MANIFESTS.has(manifest) ||
    manifest.attestationId !== YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestationId ||
    manifest.evidenceVersion !== YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !== YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.authorityRoute ||
    manifest.providerGuaranteed !== false ||
    manifest.occurrenceProviderGuaranteed !== false
  )
    throw new Error(
      "Yuanta credit-card v2 attestation manifest does not match the immutable contract.",
    );
}

export function getYuantaCreditCardHumanAttestedV2Manifest(): YuantaCreditCardHumanAttestedV2Manifest {
  return currentV2Manifest;
}

export function isYuantaCreditCardHumanAttestedV2Manifest(
  value: unknown,
): value is YuantaCreditCardHumanAttestedV2Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_V2_MANIFESTS.has(value) &&
    value === currentV2Manifest
  );
}

export function isYuantaCreditCardHumanAttestedV2Active(): boolean {
  return currentV2Manifest.status === "active";
}

export function setYuantaCreditCardHumanAttestedV2Status(
  status: "active" | "revoked",
  at: string | null,
  reason: string | null,
): YuantaCreditCardHumanAttestedV2Manifest {
  currentV2Manifest = deepFreeze({
    ...currentV2Manifest,
    status,
    revokedAt: status === "revoked" ? at : null,
    revocationReason: status === "revoked" ? reason : null,
  });
  VALIDATED_V2_MANIFESTS.add(currentV2Manifest);
  return currentV2Manifest;
}
