export type HncbOpaqueToken = `sha256:${string}`;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object") deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

export const HNCB_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE =
  "hncb/domestic-deposit/human-attested-v1" as const;
export const HNCB_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION =
  "human-attested-v1" as const;

/**
 * This is an observed, user-confirmed contract. It deliberately does not
 * assert that HNCB guarantees occurrence identity, completeness, timezone,
 * cancellation handling, or shared-account authority.
 */
export const HNCB_HUMAN_ATTESTED_V1_MANIFEST = deepFreeze({
  attestationId: "hncb-domestic-deposit-human-attested-v1",
  evidenceVersion: HNCB_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  authorityRoute: HNCB_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  status: "active",
  attestedAt: "2026-08-23",
  attestedBy: "user-confirmed-hncb-observed-human-attested-2026-08-23",
  provenance: {
    kind: "user-confirmation",
    attestationContractFingerprint:
      "sha256:7a4fd7a0f22f4c5d933d5f3b5b5bf9ac52f1dd0e9d6b4d4d0d9ad4a1fcb5e3b1",
    source: "HNCB domestic deposit observed human-attested contract",
  },
  authority: "personal-authenticated-session",
  currency: "TWD",
  providerGuaranteed: false,
  semantics: {
    posting: "posted-history-only",
    direction: "export-outflow-or-inflow-exclusive",
    effectiveTime: "transaction-date-time-observed-Asia/Taipei",
    accountingDate: "export-accounting-date-retained-separately",
    cancellation: "unsupported-reject",
    occurrence: "observed-composite-fence-not-provider-unique",
    completeness: "exact-ui-range-terminal-export-observed",
    zeroResult: "provider-explicit-no-data-only",
    withdrawal: "never-infer-missing-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type HncbHumanAttestedV1Manifest = Omit<
  typeof HNCB_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type HncbHumanAttestationEvent = {
  attestationId: string;
  evidenceVersion: string;
  eventKind: "attested" | "revoked";
  manifestStatus: "active" | "revoked";
  eventAt: string;
  reason: string | null;
  manifestFingerprint: HncbOpaqueToken;
  sequence: number;
};

type HncbHumanAttestationStateTransition = Readonly<{
  manifest: HncbHumanAttestedV1Manifest;
  event: HncbHumanAttestationEvent | null;
}>;

const VALIDATED_MANIFESTS = new WeakSet<object>();
let currentManifest: HncbHumanAttestedV1Manifest =
  HNCB_HUMAN_ATTESTED_V1_MANIFEST;
VALIDATED_MANIFESTS.add(HNCB_HUMAN_ATTESTED_V1_MANIFEST);

export function manifestFingerprint(
  manifest: HncbHumanAttestedV1Manifest,
): HncbOpaqueToken {
  return manifest.provenance.attestationContractFingerprint as HncbOpaqueToken;
}

export function hncbHumanAttestedIdentityEpochKey(
  manifest: HncbHumanAttestedV1Manifest = currentManifest,
): HncbOpaqueToken {
  const value = [
    "hncb-human-attested-identity-epoch-v1",
    manifest.attestationId,
    manifest.evidenceVersion,
    manifest.provenance.attestationContractFingerprint,
  ].join("\u0000");
  return `sha256:${Buffer.from(value).toString("base64url")}`;
}

export function assertCurrentManifest(
  manifest: HncbHumanAttestedV1Manifest,
): void {
  if (
    manifest !== currentManifest ||
    manifest.attestationId !== HNCB_HUMAN_ATTESTED_V1_MANIFEST.attestationId ||
    manifest.evidenceVersion !==
      HNCB_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !==
      HNCB_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute ||
    manifest.provenance.attestationContractFingerprint !==
      HNCB_HUMAN_ATTESTED_V1_MANIFEST.provenance
        .attestationContractFingerprint ||
    manifest.providerGuaranteed !== false
  )
    throw new Error(
      "HNCB attestation manifest does not match the immutable contract.",
    );
}

export function validEventAt(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function getHncbHumanAttestedV1Manifest(): HncbHumanAttestedV1Manifest {
  return currentManifest;
}

export function isHncbHumanAttestedV1Manifest(
  value: unknown,
): value is HncbHumanAttestedV1Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_MANIFESTS.has(value) &&
    value === currentManifest
  );
}

export function isHncbHumanAttestedV1Active(): boolean {
  return currentManifest.status === "active";
}

export function transitionHncbHumanAttestedV1Revocation(
  at: string,
  reason: string,
  latest: HncbHumanAttestationEvent | null,
): HncbHumanAttestationStateTransition {
  if (!validEventAt(at) || !reason.trim())
    throw new Error("HNCB attestation revocation requires time and reason.");
  if (latest?.eventKind === "revoked") {
    if (currentManifest.status === "active") {
      const durable = deepFreeze({
        ...currentManifest,
        status: "revoked" as const,
        revokedAt: latest.eventAt,
        revocationReason: latest.reason,
      });
      currentManifest = durable;
      VALIDATED_MANIFESTS.add(durable);
    }
    return { manifest: currentManifest, event: null };
  }
  if (currentManifest.status === "revoked")
    return { manifest: currentManifest, event: null };
  const revoked = deepFreeze({
    ...currentManifest,
    status: "revoked" as const,
    revokedAt: at,
    revocationReason: reason.trim(),
  });
  currentManifest = revoked;
  VALIDATED_MANIFESTS.add(revoked);
  return {
    manifest: revoked,
    event: {
      attestationId: revoked.attestationId,
      evidenceVersion: revoked.evidenceVersion,
      eventKind: "revoked",
      manifestStatus: "revoked",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(revoked),
      sequence: latest ? latest.sequence + 1 : 1,
    },
  };
}

export function transitionHncbHumanAttestedV1Restoration(
  at: string,
  reason: string,
  latest: HncbHumanAttestationEvent | null,
): HncbHumanAttestationStateTransition {
  if (!validEventAt(at) || !reason.trim())
    throw new Error("HNCB attestation restoration requires time and reason.");
  if (currentManifest.status === "active" && latest?.eventKind !== "revoked")
    return { manifest: currentManifest, event: null };
  const restored = deepFreeze({
    ...currentManifest,
    status: "active" as const,
    revokedAt: null,
    revocationReason: null,
  });
  currentManifest = restored;
  VALIDATED_MANIFESTS.add(restored);
  return {
    manifest: restored,
    event: {
      attestationId: restored.attestationId,
      evidenceVersion: restored.evidenceVersion,
      eventKind: "attested",
      manifestStatus: "active",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(restored),
      sequence: latest ? latest.sequence + 1 : 1,
    },
  };
}

export function createInitialHncbHumanAttestationEvent(
  observedAt =
    HNCB_HUMAN_ATTESTED_V1_MANIFEST.attestedAt + "T00:00:00.000+08:00",
): HncbHumanAttestationEvent {
  if (!isHncbHumanAttestedV1Active())
    throw new Error("Cannot attest a revoked HNCB manifest.");
  assertCurrentManifest(currentManifest);
  return {
    attestationId: currentManifest.attestationId,
    evidenceVersion: currentManifest.evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: "user-confirmed-hncb-observed-human-attested-2026-08-23",
    manifestFingerprint: manifestFingerprint(currentManifest),
    sequence: 1,
  };
}
