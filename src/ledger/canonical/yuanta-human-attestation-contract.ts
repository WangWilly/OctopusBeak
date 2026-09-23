// Pure Yuanta human-attestation contracts and in-memory authority state.
export type YuantaOpaqueToken = string;

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

export const YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE =
  "yuanta/domestic-deposit/human-attested-v1" as const;
export const YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION =
  "human-attested-v1" as const;

/**
 * The active contract supersedes the v1/v2 observation contracts. Existing
 * V2-named exports remain as compatibility entry points for callers while
 * their evidence version and attestation identity identify the new v3
 * contract. The authority route remains stable because it is a registered
 * canonical writer route.
 */
export const YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_ROUTE =
  "yuanta/domestic-deposit/human-attested-v2" as const;
export const YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_VERSION =
  "human-attested-v2" as const;
export const YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_QUERY_COVERAGE_VERSION =
  "yuanta/domestic-deposit/query-range/accounting-date-v1" as const;

/**
 * This is an observed-user authority, not a provider guarantee. The
 * fingerprint identifies the attested contract/observation lineage only; it
 * deliberately excludes dates, filenames, labels, row contents, and account
 * values.
 */
export const YUANTA_HUMAN_ATTESTED_V1_MANIFEST = deepFreeze({
  attestationId: "yuanta-domestic-deposit-human-attested-v1",
  evidenceVersion: YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  authorityRoute: YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  status: "active",
  attestedAt: "2026-08-21",
  attestedBy: "user-confirmed-yuanta-observed-human-attested-2026-08-21",
  provenance: {
    kind: "user-confirmation",
    /** Immutable contract/live-attestation fingerprint; not a CSV hash. */
    attestationContractFingerprint:
      "sha256:e3615c1a8f886ca9edeb057b8005131c8ccdbcf0d757c6fce9ae90f5bd95ef86",
    source: "Yuanta domestic deposit observed human-attested contract",
  },
  authority: "personal-authenticated-session",
  currency: "TWD",
  providerGuaranteed: false,
  semantics: {
    posting: "posted-history-only",
    direction: "CSV-outflow-or-inflow-exclusive",
    effectiveTime: "transaction-date-time-Asia/Taipei",
    accountingDate: "retained-source-evidence",
    cancellation: "unsupported-reject",
    occurrence:
      "account-date-time-direction-amount-balance-description-note-check",
    completeness: "exact-ui-range-terminal-download",
    zeroResult: "provider-explicit-no-data-only",
    withdrawal: "never-infer-missing-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export const YUANTA_HUMAN_ATTESTED_V2_MANIFEST = deepFreeze({
  attestationId: "yuanta-domestic-deposit-human-attested-v3",
  evidenceVersion: YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_VERSION,
  authorityRoute: YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_ROUTE,
  status: "active",
  attestedAt: "2026-08-21",
  attestedBy: "user-confirmed-yuanta-observed-human-attested-2026-08-21",
  provenance: {
    kind: "user-confirmation",
    /** Immutable contract/live-attestation fingerprint; not a CSV hash. */
    attestationContractFingerprint:
      "sha256:23b68bf37380e5a9c284abb34ca76d713f5748efcb207dce54c62f2261a407de",
    source: "Yuanta domestic deposit observed human-attested contract",
  },
  authority: "personal-authenticated-session",
  currency: "TWD",
  providerGuaranteed: false,
  semantics: {
    posting: "posted-history-only",
    direction: "CSV-outflow-or-inflow-exclusive-zero-sentinel",
    effectiveTime: "transaction-date-time-Asia/Taipei",
    queryCoverage: "accounting-date-bounded",
    queryCoverageVersion:
      YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_QUERY_COVERAGE_VERSION,
    accountingDate: "query-range-membership",
    cancellation: "unsupported-reject",
    occurrence:
      "account-date-time-direction-amount-balance-description-note-check",
    completeness: "exact-ui-range-terminal-download",
    zeroResult: "provider-explicit-no-data-only",
    withdrawal: "never-infer-missing-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type YuantaHumanAttestedV1Manifest = Omit<
  typeof YUANTA_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type YuantaHumanAttestedV2Manifest = Omit<
  typeof YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type YuantaHumanAttestedManifest =
  YuantaHumanAttestedV1Manifest | YuantaHumanAttestedV2Manifest;

export type YuantaHumanAttestationEvent = {
  attestationId: string;
  evidenceVersion: string;
  eventKind: "attested" | "revoked";
  manifestStatus: "active" | "revoked";
  eventAt: string;
  reason: string | null;
  manifestFingerprint: YuantaOpaqueToken;
  sequence: number;
};

const VALIDATED_MANIFESTS = new WeakSet<object>();
export let currentManifest: YuantaHumanAttestedV1Manifest =
  YUANTA_HUMAN_ATTESTED_V1_MANIFEST;
export let currentV2Manifest: YuantaHumanAttestedV2Manifest =
  YUANTA_HUMAN_ATTESTED_V2_MANIFEST;
VALIDATED_MANIFESTS.add(YUANTA_HUMAN_ATTESTED_V1_MANIFEST);
VALIDATED_MANIFESTS.add(YUANTA_HUMAN_ATTESTED_V2_MANIFEST);

export function manifestFingerprint(
  manifest: YuantaHumanAttestedManifest,
): YuantaOpaqueToken {
  return manifest.provenance.attestationContractFingerprint;
}

/**
 * Query coverage is not an account identity invariant. Keep the identity
 * epoch seed stable when the human-attested query-range contract is revised.
 * The seed below is the v2 epoch that was already used by admitted captures.
 */
const YUANTA_DOMESTIC_DEPOSIT_IDENTITY_EPOCH_SEED = [
  "yuanta-human-attested-identity-epoch-v2",
  "yuanta-domestic-deposit-human-attested-v2",
  "human-attested-v2",
  "sha256:9cde6f1c4f35e4f4d2ef634cf6bc1e7b4869b1a0c1e5e7c2f1a4a9e1bd5d4c63",
] as const;

/**
 * The identity epoch is the source identity contract epoch. It is
 * intentionally independent of non-identity query coverage, observation
 * time, CSV filename, account label, and content digest.
 */
export function yuantaHumanAttestedIdentityEpochKey(
  manifest: YuantaHumanAttestedV1Manifest = currentManifest,
): YuantaOpaqueToken {
  const value = [
    "yuanta-human-attested-identity-epoch-v1",
    manifest.attestationId,
    manifest.evidenceVersion,
    manifest.provenance.attestationContractFingerprint,
  ].join("\u0000");
  return "sha256:" + Buffer.from(value).toString("base64url");
}

export function yuantaHumanAttestedV2IdentityEpochKey(
  _manifest: YuantaHumanAttestedV2Manifest = currentV2Manifest,
): YuantaOpaqueToken {
  const value = YUANTA_DOMESTIC_DEPOSIT_IDENTITY_EPOCH_SEED.join("\u0000");
  return "sha256:" + Buffer.from(value).toString("base64url");
}

export function assertCurrentManifest(manifest: YuantaHumanAttestedV1Manifest): void {
  if (
    manifest !== currentManifest ||
    manifest.attestationId !==
      YUANTA_HUMAN_ATTESTED_V1_MANIFEST.attestationId ||
    manifest.evidenceVersion !==
      YUANTA_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !==
      YUANTA_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute ||
    manifest.provenance.attestationContractFingerprint !==
      YUANTA_HUMAN_ATTESTED_V1_MANIFEST.provenance
        .attestationContractFingerprint ||
    manifest.providerGuaranteed !== false
  )
    throw new Error(
      "Yuanta attestation manifest does not match the immutable contract.",
    );
}

export function assertCurrentV2Manifest(
  manifest: YuantaHumanAttestedV2Manifest,
): void {
  if (
    manifest !== currentV2Manifest ||
    manifest.attestationId !==
      YUANTA_HUMAN_ATTESTED_V2_MANIFEST.attestationId ||
    manifest.evidenceVersion !==
      YUANTA_HUMAN_ATTESTED_V2_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !==
      YUANTA_HUMAN_ATTESTED_V2_MANIFEST.authorityRoute ||
    manifest.provenance.attestationContractFingerprint !==
      YUANTA_HUMAN_ATTESTED_V2_MANIFEST.provenance
        .attestationContractFingerprint ||
    manifest.providerGuaranteed !== false
  )
    throw new Error(
      "Yuanta v2 attestation manifest does not match the immutable contract.",
    );
}

export function validEventAt(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function getYuantaHumanAttestedV1Manifest(): YuantaHumanAttestedV1Manifest {
  return currentManifest;
}

export function isYuantaHumanAttestedV1Manifest(
  value: unknown,
): value is YuantaHumanAttestedV1Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_MANIFESTS.has(value) &&
    value === currentManifest
  );
}

export function isYuantaHumanAttestedV1Active(): boolean {
  return currentManifest.status === "active";
}

export function getYuantaHumanAttestedV2Manifest(): YuantaHumanAttestedV2Manifest {
  return currentV2Manifest;
}

export function isYuantaHumanAttestedV2Manifest(
  value: unknown,
): value is YuantaHumanAttestedV2Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_MANIFESTS.has(value) &&
    value === currentV2Manifest
  );
}

export function isYuantaHumanAttestedV2Active(): boolean {
  return currentV2Manifest.status === "active";
}



/** Update only the mutable authority status while keeping the contract immutable. */
export function setYuantaHumanAttestedV1Status(
  status: "active" | "revoked",
  revokedAt: string | null,
  revocationReason: string | null,
): YuantaHumanAttestedV1Manifest {
  const next = deepFreeze({
    ...currentManifest,
    status,
    revokedAt: status === "active" ? null : revokedAt,
    revocationReason: status === "active" ? null : revocationReason,
  });
  currentManifest = next;
  VALIDATED_MANIFESTS.add(next);
  return next;
}

export function setYuantaHumanAttestedV2Status(
  status: "active" | "revoked",
  revokedAt: string | null,
  revocationReason: string | null,
): YuantaHumanAttestedV2Manifest {
  const next = deepFreeze({
    ...currentV2Manifest,
    status,
    revokedAt: status === "active" ? null : revokedAt,
    revocationReason: status === "active" ? null : revocationReason,
  });
  currentV2Manifest = next;
  VALIDATED_MANIFESTS.add(next);
  return next;
}
