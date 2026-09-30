const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== "object" || seen.has(value))
    return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object") deepFreeze(child, seen);
  }
  return Object.freeze(value);
};

export const SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE =
  "sinopac/domestic-deposit/human-attested-v1" as const;
export const SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION =
  "human-attested-v1" as const;

export const SINOPAC_HUMAN_ATTESTED_V1_MANIFEST = deepFreeze({
  attestationId: "sinopac-domestic-deposit-human-attested-v1",
  evidenceVersion: SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  authorityRoute: SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  status: "active",
  attestedAt: "2026-08-23",
  attestedBy: "user-confirmed-sinopac-observed-human-attested-2026-08-23",
  provenance: {
    kind: "user-confirmation",
    attestationContractFingerprint:
      "sha256:ec011375014d525e074d9928cb78ed72355048652a655548904ff9ae3c4d90a1",
    source: "SINOPAC domestic deposit observed human-attested contract",
  },
  authority: "personal-authenticated-session",
  currency: "TWD",
  providerGuaranteed: false,
  semantics: {
    posting: "posted-history-only",
    direction: "export-outflow-or-inflow-exclusive",
    effectiveTime: "transaction-date-time-observed-Asia/Taipei",
    accountingDate: "provider-accounting-date-retained-separately",
    cancellation: "unsupported-reject",
    occurrence: "observed-composite-fence-not-provider-unique",
    completeness: "bounded-terminal-query-observed",
    zeroResult: "provider-explicit-no-data-only",
    withdrawal: "never-infer-missing-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type SinopacHumanAttestedV1Manifest = Omit<
  typeof SINOPAC_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type SinopacHumanAttestationEvent = Readonly<{
  attestationId: string;
  evidenceVersion: string;
  eventKind: "attested" | "revoked";
  manifestStatus: "active" | "revoked";
  eventAt: string;
  reason: string | null;
  manifestFingerprint: `sha256:${string}`;
  sequence: number;
}>;

export function sinopacHumanAttestedIdentityEpochKey(
  manifest: SinopacHumanAttestedV1Manifest = SINOPAC_HUMAN_ATTESTED_V1_MANIFEST,
): `sha256:${string}` {
  const value = [
    "sinopac-human-attested-identity-epoch-v1",
    manifest.attestationId,
    manifest.evidenceVersion,
    manifest.provenance.attestationContractFingerprint,
  ].join("\u0000");
  return `sha256:${Buffer.from(value).toString("base64url")}`;
}

export function sinopacHumanAttestedManifestFingerprint(): `sha256:${string}` {
  return SINOPAC_HUMAN_ATTESTED_V1_MANIFEST.provenance
    .attestationContractFingerprint as `sha256:${string}`;
}
