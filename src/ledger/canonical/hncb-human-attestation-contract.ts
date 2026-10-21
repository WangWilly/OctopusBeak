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

export function manifestFingerprint(
  manifest: HncbHumanAttestedV1Manifest,
): HncbOpaqueToken {
  return manifest.provenance.attestationContractFingerprint as HncbOpaqueToken;
}

export function hncbHumanAttestedIdentityEpochKey(
  manifest: HncbHumanAttestedV1Manifest = HNCB_HUMAN_ATTESTED_V1_MANIFEST,
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
    manifest !== HNCB_HUMAN_ATTESTED_V1_MANIFEST ||
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

export function isHncbHumanAttestedV1Manifest(
  value: unknown,
): value is HncbHumanAttestedV1Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    value === HNCB_HUMAN_ATTESTED_V1_MANIFEST
  );
}

