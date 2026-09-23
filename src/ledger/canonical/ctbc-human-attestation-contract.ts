// Pure CTBC attestation contract and process-local manifest state. Database
// event persistence lives in ctbc-human-attestation.ts.
export type CtbcOpaqueToken = `sha256:${string}`;

export function freezeCtbcHumanAttestationManifest<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value))
    return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object") freezeCtbcHumanAttestationManifest(child, seen);
  }
  return Object.freeze(value);
}

export const CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE =
  "ctbc/domestic-deposit/human-attested-v1" as const;
export const CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION =
  "human-attested-v1" as const;
/** Explicitly confirmed by the user on 2026-08-24 for production activation. */
export const CTBC_HUMAN_ATTESTED_V1_CONFIRMED: boolean = true;

/** Observed contract; this does not claim a provider-guaranteed occurrence ID. */
export const CTBC_HUMAN_ATTESTED_V1_MANIFEST = freezeCtbcHumanAttestationManifest({
  attestationId: "ctbc-domestic-deposit-human-attested-v1",
  evidenceVersion: CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  authorityRoute: CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  status: "active",
  attestedAt: "2026-08-24",
  attestedBy: "user-confirmed-ctbc-observed-human-attested-2026-08-24",
  provenance: {
    kind: "user-confirmation",
    attestationContractFingerprint:
      "sha256:111ba05815bc0ac82156617c96e3538f81226c54fdbbe4f5b2325230690e9778",
    source: "CTBC domestic deposit observed human-attested contract",
  },
  authority: "personal-authenticated-session",
  currency: "TWD",
  providerGuaranteed: false,
  semantics: {
    posting: "posted-history-only",
    direction: "provider-debit-or-credit-exclusive-zero-sentinel",
    effectiveTime: "transaction-date-time-observed-Asia/Taipei",
    accountingDate: "provider-accounting-date-retained-separately",
    cancellation: "unsupported-reject",
    occurrence: "observed-composite-fence-not-provider-unique",
    completeness: "every-visible-range-terminal-next-key-empty",
    zeroResult: "provider-code-9201-only",
    withdrawal: "never-infer-missing-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type CtbcHumanAttestedV1Manifest = Omit<
  typeof CTBC_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type CtbcHumanAttestationEvent = {
  attestationId: string;
  evidenceVersion: string;
  eventKind: "attested" | "revoked";
  manifestStatus: "active" | "revoked";
  eventAt: string;
  reason: string | null;
  manifestFingerprint: CtbcOpaqueToken;
  sequence: number;
};

const VALIDATED_MANIFESTS = new WeakSet<object>();
let currentManifest: CtbcHumanAttestedV1Manifest =
  CTBC_HUMAN_ATTESTED_V1_MANIFEST;
VALIDATED_MANIFESTS.add(currentManifest);

export function ctbcHumanAttestationFingerprint(manifest = currentManifest): CtbcOpaqueToken {
  return manifest.provenance.attestationContractFingerprint as CtbcOpaqueToken;
}

export function ctbcHumanAttestedIdentityEpochKey(
  manifest: CtbcHumanAttestedV1Manifest = currentManifest,
): CtbcOpaqueToken {
  return `sha256:${Buffer.from(
    [
      "ctbc-human-attested-identity-epoch-v1",
      manifest.attestationId,
      manifest.evidenceVersion,
      manifest.provenance.attestationContractFingerprint,
    ].join("\0"),
  ).toString("base64url")}`;
}

export function isCtbcHumanAttestationDateTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function assertCtbcHumanAttestationManifest(): void {
  if (
    currentManifest.attestationId !==
      CTBC_HUMAN_ATTESTED_V1_MANIFEST.attestationId ||
    currentManifest.authorityRoute !==
      CTBC_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute ||
    currentManifest.provenance.attestationContractFingerprint !==
      CTBC_HUMAN_ATTESTED_V1_MANIFEST.provenance
        .attestationContractFingerprint ||
    currentManifest.providerGuaranteed !== false
  )
    throw new Error(
      "CTBC attestation manifest does not match the immutable contract.",
    );
}

export function getCtbcHumanAttestedV1Manifest(): CtbcHumanAttestedV1Manifest {
  return currentManifest;
}

export function isCtbcHumanAttestedV1Manifest(
  value: unknown,
): value is CtbcHumanAttestedV1Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_MANIFESTS.has(value) &&
    value === currentManifest
  );
}

export function isCtbcHumanAttestedV1Active(): boolean {
  return currentManifest.status === "active";
}


export function replaceCtbcHumanAttestedV1Manifest(
  manifest: CtbcHumanAttestedV1Manifest,
): void {
  currentManifest = manifest;
  VALIDATED_MANIFESTS.add(manifest);
}
