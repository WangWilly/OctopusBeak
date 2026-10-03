import { createHash } from "node:crypto";

/**
 * E.SUN's credit-card page exposes a portfolio view and masked card keys, but
 * does not expose a provider account, transaction, or statement identifier.
 * This manifest therefore records an observed human-attested authority.  It
 * is deliberately not a provider guarantee and contains no account value,
 * card number, or response payload.
 */
const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object") deepFreeze(child, seen);
  }
  return Object.freeze(value);
};

export const ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_ROUTE =
  "esun/credit-card/human-attested-v4" as const;
export const ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_VERSION =
  "esun/credit-card/human-attested-v4" as const;

/** Live review found the bank's bounded timeline can contain 12 or 13 months. */
export const ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_MANIFEST = deepFreeze({
  attestationId: "esun-credit-card-human-attested-v4",
  evidenceVersion: ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_VERSION,
  authorityRoute: ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_ROUTE,
  status: "active",
  attestedAt: "2026-09-30T00:00:00.000Z",
  attestedBy: "user-confirmed-esun-terminal-twelve-or-thirteen-month-timeline",
  provenance: {
    kind: "human-attestation",
    sourceCaptureFingerprint:
      "sha256:esun-credit-card-terminal-cursor-four-twelve-or-thirteen-month-timeline-v4",
    source: "E.SUN paginated timeline and issuer bill summaries observed on September 24 and 30",
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
      "esun-source-connection-identity-epoch-credit-human-attested-portfolio-key",
    cards:
      "card-instruments-by-managed-secret-hmac-of-masked-first-four-plus-last-four-projection",
    posting: "source-credit-card-records-are-posted;billing-status-is-independent",
    billing: "billed-or-unbilled-independent-of-posting",
    transactionIdentity:
      "immutable-normalized-content-tuple-plus-contiguous-deterministic-occurrence-index",
    occurrenceOrdering:
      "complete-one-year-grid-deterministic-source-identity-order-input-index-tie-break",
    statements:
      "issuer-settled-cycle-close-due-total-minimum-with-prior-close-derived-cycle-start",
    relations: "explicit-source-linkage-only",
    completeness:
      "bank-last-year-timeline-current-month-through-twelve-or-thirteen-contiguous-months-terminal-cursor-four-card-counts",
    withdrawal: "never-infer-from-missing-card-or-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type EsunCreditCardHumanAttestedV4Manifest = Omit<
  typeof ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type EsunCreditCardHumanAttestationEvent = {
  attestationId: string;
  evidenceVersion: string;
  eventKind: "attested" | "revoked" | "restored";
  manifestStatus: "active" | "revoked";
  eventAt: string;
  reason: string | null;
  manifestFingerprint: `sha256:${string}`;
  sequence: number;
};

const VALIDATED_MANIFESTS = new WeakSet<object>();
const currentManifest: EsunCreditCardHumanAttestedV4Manifest =
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_MANIFEST;
VALIDATED_MANIFESTS.add(currentManifest);

function manifestFingerprint(
  manifest: EsunCreditCardHumanAttestedV4Manifest = currentManifest,
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

export function esunCreditCardHumanAttestedManifestFingerprint(
  manifest: EsunCreditCardHumanAttestedV4Manifest = currentManifest,
): `sha256:${string}` {
  return manifestFingerprint(manifest);
}

function assertCurrentManifest(
  manifest: EsunCreditCardHumanAttestedV4Manifest,
): void {
  if (
    manifest !== currentManifest ||
    !VALIDATED_MANIFESTS.has(manifest) ||
    manifest.attestationId !==
      ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_MANIFEST.attestationId ||
    manifest.evidenceVersion !==
      ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !==
      ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_MANIFEST.authorityRoute ||
    manifest.providerGuaranteed !== false ||
    manifest.occurrenceProviderGuaranteed !== false
  )
    throw new Error(
      "E.SUN credit-card attestation manifest does not match the immutable contract.",
    );
}

export function getEsunCreditCardHumanAttestedV4Manifest(): EsunCreditCardHumanAttestedV4Manifest {
  return currentManifest;
}

export function isEsunCreditCardHumanAttestedV4Manifest(
  value: unknown,
): value is EsunCreditCardHumanAttestedV4Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_MANIFESTS.has(value) &&
    value === currentManifest
  );
}

export function isEsunCreditCardHumanAttestedV4Active(): boolean {
  return currentManifest.status === "active";
}

/**
 * Human attestation accepts only an opaque portfolio key.  A card mask,
 * product label, or card number must never be promoted to account identity.
 */
export function isEsunCreditCardHumanAttestedAccountKey(
  value: unknown,
): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  if (!/^[A-Za-z][A-Za-z0-9._:-]{2,127}$/u.test(value)) return false;
  if (/^\d+$/u.test(value) || /\*/u.test(value)) return false;
  if (
    /(?:^|[-_:])(card|mask|pan)(?:$|[-_:])|(?:^|[-_:])(visa|mastercard|amex)(?:$|[-_:])|末(?:四碼|4碼)|正卡|附卡/iu.test(
      value,
    )
  )
    return false;
  return true;
}

export function esunCreditCardHumanAttestedIdentityEpochKey(
  manifest: EsunCreditCardHumanAttestedV4Manifest = currentManifest,
): `sha256:${string}` {
  assertCurrentManifest(manifest);
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        "esun-credit-card-human-attested-identity-epoch-v1",
        manifest.attestationId,
        manifest.evidenceVersion,
        manifestFingerprint(manifest),
      ]),
    )
    .digest("base64url")}`;
}
