import { createHash } from "node:crypto";

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object") deepFreeze(child, seen);
  }
  return Object.freeze(value);
};

/** Current portfolio attestation contract.  Its authority route, attestation
 * identity, and evidence version advance together with the portfolio/
 * occurrence semantics. */
export const FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST = deepFreeze({
  attestationId: "fubon-credit-card-human-attested-v2",
  evidenceVersion: "fubon/credit-card/human-attested-v2",
  authorityRoute: "fubon/credit-card/human-attested-v2",
  status: "active",
  attestedAt: "2026-08-25T00:00:00.000Z",
  attestedBy: "human-confirmed-primary-cardholder-portfolio",
  provenance: {
    kind: "human-attestation",
    sourceCaptureFingerprint:
      "sha256:fubon-credit-card-live-repeat-evidence-v2",
    source: "Fubon redacted repeated billed-and-unbilled grid evidence",
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
      "fubon-source-connection-identity-epoch-credit-human-attested-portfolio-key",
    cards: "primary-card-instruments-under-attested-portfolio",
    posting: "posting-date-present-means-posted",
    billing: "billed-or-unbilled-independent-of-posting",
    transactionIdentity:
      "immutable-normalized-content-tuple-plus-contiguous-deterministic-occurrence-index",
    occurrenceOrdering:
      "complete-capture-deterministic-period-rank-source-identity-order-input-index-tie-break-human-attested-not-provider-guaranteed",
    statements: "one-consolidated-issuer-settled-cycle-summary-per-cycle",
    relations: "explicit-source-linkage-only",
    completeness:
      "six-billed-periods-plus-unbilled-unfiltered-terminal-grid-counts",
    withdrawal: "never-infer-from-missing-card-or-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type FubonCreditCardHumanAttestedV2Manifest = Omit<
  typeof FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type FubonCreditCardHumanAttestationEvent = {
  attestationId: string;
  evidenceVersion: string;
  eventKind: "attested" | "revoked" | "restored";
  manifestStatus: "active" | "revoked";
  eventAt: string;
  reason: string | null;
  manifestFingerprint: `sha256:${string}`;
  sequence: number;
};

type ManifestFingerprintInput = {
  attestationId: string;
  evidenceVersion: string;
  authorityRoute: string;
  provenance: { sourceCaptureFingerprint: string };
  semantics: {
    transactionIdentity: string;
    occurrenceOrdering: string;
    accountIdentity: string;
    cards: string;
    statements: string;
  };
  providerGuaranteed: boolean;
  occurrenceProviderGuaranteed: boolean;
};

/**
 * Compute the immutable contract fingerprint without including runtime
 * status.  The current contract includes its complete identity semantics.
 */
export function fubonCreditCardHumanAttestedManifestFingerprint(
  manifest: ManifestFingerprintInput,
): `sha256:${string}` {
  const fingerprintInput = {
    attestationId: manifest.attestationId,
    evidenceVersion: manifest.evidenceVersion,
    authorityRoute: manifest.authorityRoute,
    sourceCaptureFingerprint: manifest.provenance.sourceCaptureFingerprint,
    transactionIdentity: manifest.semantics.transactionIdentity,
    occurrenceOrdering: manifest.semantics.occurrenceOrdering,
    accountIdentity: manifest.semantics.accountIdentity,
    cards: manifest.semantics.cards,
    statements: manifest.semantics.statements,
    providerGuaranteed: manifest.providerGuaranteed,
    occurrenceProviderGuaranteed: manifest.occurrenceProviderGuaranteed,
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(fingerprintInput))
    .digest("base64url")}`;
}

export const manifestFingerprint = (): `sha256:${string}` =>
  fubonCreditCardHumanAttestedManifestFingerprint(
    FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  );

const VALIDATED_V2_MANIFESTS = new WeakSet<object>();
export let currentV2Manifest: FubonCreditCardHumanAttestedV2Manifest =
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST;
VALIDATED_V2_MANIFESTS.add(currentV2Manifest);

function validateManifest(
  manifest: FubonCreditCardHumanAttestedV2Manifest,
  contract: ManifestFingerprintInput,
): void {
  if (
    manifest.attestationId !== contract.attestationId ||
    manifest.evidenceVersion !== contract.evidenceVersion ||
    manifest.authorityRoute !== contract.authorityRoute ||
    manifest.stream !== "credit-card" ||
    manifest.accountType !== "credit" ||
    manifest.accountSubtype !== "credit_card" ||
    manifest.providerGuaranteed !== false ||
    manifest.occurrenceProviderGuaranteed !== false ||
    (manifest.status === "active" &&
      (manifest.revokedAt !== null || manifest.revocationReason !== null)) ||
    (manifest.status === "revoked" &&
      (!manifest.revokedAt || !manifest.revocationReason))
  )
    throw new Error(
      "Fubon credit-card attestation manifest does not match its immutable contract.",
    );
}

export function assertCurrentManifest(
  manifest: FubonCreditCardHumanAttestedV2Manifest,
): void {
  if (
    manifest !== currentV2Manifest ||
    !VALIDATED_V2_MANIFESTS.has(manifest) ||
    fubonCreditCardHumanAttestedManifestFingerprint(manifest) !==
      manifestFingerprint()
  )
    throw new Error(
      "Fubon credit-card attestation manifest is not the current validated version.",
    );
  validateManifest(manifest, FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST);
}

export function getFubonCreditCardHumanAttestedV2Manifest(): FubonCreditCardHumanAttestedV2Manifest {
  return currentV2Manifest;
}

export function isFubonCreditCardHumanAttestedV2Manifest(
  value: unknown,
): value is FubonCreditCardHumanAttestedV2Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_V2_MANIFESTS.has(value) &&
    value === currentV2Manifest
  );
}

export function isFubonCreditCardHumanAttestedV2Active(): boolean {
  return currentV2Manifest.status === "active";
}

/**
 * Human attestation supplies an opaque account key.  This validator is kept
 * next to the contract so callers cannot accidentally promote a card mask,
 * label, product, or other presentation value to account identity.
 */
export function isFubonCreditCardHumanAttestedAccountKey(
  value: unknown,
): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  if (!/^[A-Za-z][A-Za-z0-9._:-]{2,127}$/.test(value)) return false;
  if (/^\d+$/.test(value) || /\*/.test(value)) return false;
  if (
    /(?:^|[-_:])(card|mask)(?:$|[-_:])|(?:^|[-_:])(visa|mastercard|amex)(?:$|[-_:])|末(?:四碼|4碼)|正卡|附卡/i.test(
      value,
    )
  )
    return false;
  return true;
}

export function setCurrentManifestStatus(
  status: "active" | "revoked",
  at: string | null,
  reason: string | null,
): void {
  if (status === "active") {
    currentV2Manifest = FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST;
  } else {
    currentV2Manifest = deepFreeze({
      ...currentV2Manifest,
      status: "revoked" as const,
      revokedAt: at,
      revocationReason: reason,
    });
  }
  VALIDATED_V2_MANIFESTS.add(currentV2Manifest);
}
