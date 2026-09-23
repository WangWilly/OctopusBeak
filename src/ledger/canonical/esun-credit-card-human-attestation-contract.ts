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

export const ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE =
  "esun/credit-card/human-attested-v1" as const;
export const ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_VERSION =
  "esun/credit-card/human-attested-v1" as const;
export const ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE =
  "esun/credit-card/human-attested-v2" as const;
export const ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_VERSION =
  "esun/credit-card/human-attested-v2" as const;

export const ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST = deepFreeze({
  attestationId: "esun-credit-card-human-attested-v1",
  evidenceVersion: ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_VERSION,
  authorityRoute: ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE,
  status: "active",
  attestedAt: "2026-08-26T00:00:00.000Z",
  attestedBy: "user-confirmed-esun-credit-card-primary-cardholder-portfolio",
  provenance: {
    kind: "human-attestation",
    sourceCaptureFingerprint:
      "sha256:esun-credit-card-live-complete-grid-repeat-evidence-v1",
    source: "E.SUN redacted complete billed-and-unbilled grid evidence",
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
    cards: "card-instruments-under-attested-portfolio-by-last-four-key",
    posting: "source-credit-card-records-are-posted;billing-status-is-independent",
    billing: "billed-or-unbilled-independent-of-posting",
    transactionIdentity:
      "immutable-normalized-content-tuple-plus-contiguous-deterministic-occurrence-index",
    occurrenceOrdering:
      "complete-one-year-grid-deterministic-source-identity-order-input-index-tie-break",
    statements: "explicit-settled-billed-period-evidence-only",
    relations: "explicit-source-linkage-only",
    completeness:
      "default-one-year-combined-grid-page-one-maximum-page-size-card-counts",
    withdrawal: "never-infer-from-missing-card-or-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export const ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST = deepFreeze({
  ...ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  attestationId: "esun-credit-card-human-attested-v2",
  evidenceVersion: ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_VERSION,
  authorityRoute: ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
  attestedAt: "2026-08-27T00:00:00.000Z",
  provenance: {
    kind: "human-attestation",
    sourceCaptureFingerprint:
      "sha256:esun-credit-card-live-masked-projection-and-statement-evidence-v2",
    source: "E.SUN redacted masked-card and issuer-settled statement evidence",
  },
  semantics: {
    ...ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.semantics,
    cards:
      "card-instruments-by-managed-secret-hmac-of-masked-first-four-plus-last-four-projection",
    statements:
      "issuer-settled-cycle-close-due-total-minimum-with-prior-close-derived-cycle-start",
  },
} as const);

export type EsunCreditCardHumanAttestedV1Manifest = Omit<
  typeof ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type EsunCreditCardHumanAttestedV2Manifest = Omit<
  typeof ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
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
let currentManifest: EsunCreditCardHumanAttestedV2Manifest =
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST;
VALIDATED_MANIFESTS.add(currentManifest);

function manifestFingerprint(
  manifest: EsunCreditCardHumanAttestedV2Manifest = currentManifest,
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

export function esunCreditCardHumanAttestedManifestFingerprint(): `sha256:${string}` {
  return manifestFingerprint();
}

function assertCurrentManifest(
  manifest: EsunCreditCardHumanAttestedV2Manifest,
): void {
  if (
    manifest !== currentManifest ||
    !VALIDATED_MANIFESTS.has(manifest) ||
    manifest.attestationId !==
      ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestationId ||
    manifest.evidenceVersion !==
      ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !==
      ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.authorityRoute ||
    manifest.providerGuaranteed !== false ||
    manifest.occurrenceProviderGuaranteed !== false
  )
    throw new Error(
      "E.SUN credit-card attestation manifest does not match the immutable contract.",
    );
}

export function getEsunCreditCardHumanAttestedV2Manifest(): EsunCreditCardHumanAttestedV2Manifest {
  return currentManifest;
}

export function isEsunCreditCardHumanAttestedV2Manifest(
  value: unknown,
): value is EsunCreditCardHumanAttestedV2Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_MANIFESTS.has(value) &&
    value === currentManifest
  );
}

export function isEsunCreditCardHumanAttestedV2Active(): boolean {
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
  manifest: EsunCreditCardHumanAttestedV2Manifest = currentManifest,
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

function validEventAt(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

/** Mutate the shared in-memory manifest; the legacy wrapper optionally records the durable event. */
export function revokeEsunCreditCardHumanAttestedV2InMemory(
  at: string,
  reason: string,
): EsunCreditCardHumanAttestedV2Manifest {
  if (!validEventAt(at) || !reason.trim())
    throw new Error("E.SUN credit-card attestation revocation requires time and reason.");
  if (currentManifest.status === "revoked") return currentManifest;
  const revoked = deepFreeze({
    ...currentManifest,
    status: "revoked" as const,
    revokedAt: at,
    revocationReason: reason.trim(),
  });
  currentManifest = revoked;
  VALIDATED_MANIFESTS.add(revoked);
  return currentManifest;
}

/** Mutate the shared in-memory manifest; the legacy wrapper optionally records the durable event. */
export function restoreEsunCreditCardHumanAttestedV2InMemory(
  at: string,
  reason: string,
): EsunCreditCardHumanAttestedV2Manifest {
  if (!validEventAt(at) || !reason.trim())
    throw new Error("E.SUN credit-card attestation restoration requires time and reason.");
  if (currentManifest.status === "active") return currentManifest;
  const restored = deepFreeze({
    ...currentManifest,
    status: "active" as const,
    revokedAt: null,
    revocationReason: null,
  });
  currentManifest = restored;
  VALIDATED_MANIFESTS.add(restored);
  return currentManifest;
}

// Internal live bindings let the SQLite wrapper read and mutate this same state.
export {
  currentManifest as currentEsunManifestForStorage,
  assertCurrentManifest as assertEsunManifestForStorage,
  manifestFingerprint as fingerprintEsunManifestForStorage,
};
