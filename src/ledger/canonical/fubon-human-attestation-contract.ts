/**
 * The user-confirmed boundary for the first Fubon financial projection.
 *
 * This module owns the runtime manifest brand and revocation state so both
 * the PGlite adapter and the legacy durable SQLite event writer share one
 * attestation singleton without loading SQLite in the enabled path.
 */
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

export const FUBON_HUMAN_ATTESTED_V1_MANIFEST = deepFreeze({
  attestationId: "fubon-domestic-deposit-human-attested-v1",
  evidenceVersion: "human-attested-v1",
  authorityRoute: "fubon/domestic-deposit/human-attested-v1",
  status: "active",
  attestedAt: "2026-08-21",
  attestedBy: "user-confirmed-1A-2A-3A",
  provenance: {
    kind: "user-confirmation",
    sourceCaptureFingerprint:
      "sha256:1758d3b97375cf82f7d6619482d57b5e16bb4f236d44834043b606bd28af26b8",
    source: "Fubon deposit telemetry repeat-and-zero capture",
  },
  authority: "personal-owned-accounts",
  currency: "TWD",
  providerGuaranteed: false,
  semantics: {
    posting: "posted-history-only",
    direction: "cell-3-outflow-cell-4-inflow",
    effectiveTime: "accounting-date-plus-transaction-time-Asia/Taipei",
    cancellation: "explicit-none-only",
    occurrence: "observed-composite-v1",
    completeness: "requested-range-all-terminal-pages",
    zeroResult: "provider-explicit-no-data-only",
    withdrawal: "never-infer-missing-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type FubonHumanAttestedV1Manifest = Omit<
  typeof FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};


export function manifestFingerprint(
  manifest: FubonHumanAttestedV1Manifest,
): `sha256:${string}` {
  return manifest.provenance.sourceCaptureFingerprint;
}

export function assertCurrentManifest(
  manifest: FubonHumanAttestedV1Manifest,
): void {
  if (
    manifest !== FUBON_HUMAN_ATTESTED_V1_MANIFEST ||
    manifest.attestationId !== FUBON_HUMAN_ATTESTED_V1_MANIFEST.attestationId ||
    manifest.evidenceVersion !==
      FUBON_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !==
      FUBON_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute ||
    manifest.provenance.sourceCaptureFingerprint !==
      FUBON_HUMAN_ATTESTED_V1_MANIFEST.provenance.sourceCaptureFingerprint ||
    manifest.providerGuaranteed !== false
  )
    throw new Error(
      "Fubon attestation manifest does not match the immutable contract.",
    );
}

export function isFubonHumanAttestedV1Manifest(
  value: unknown,
): value is FubonHumanAttestedV1Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    value === FUBON_HUMAN_ATTESTED_V1_MANIFEST
  );
}

