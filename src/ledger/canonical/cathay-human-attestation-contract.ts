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

export const CATHAY_HUMAN_ATTESTED_V1_MANIFEST = deepFreeze({
  attestationId: "cathay-domestic-deposit-human-attested-v1",
  evidenceVersion: "human-attested-v1",
  authorityRoute: "cathay/domestic-deposit/human-attested-v1",
  status: "active",
  attestedAt: "2026-08-22",
  attestedBy: "user-confirmed-cathay-observed-human-attested",
  provenance: {
    kind: "user-confirmation",
    sourceCaptureFingerprint:
      "sha256:4f443b3c1b6d58ee57c4ac84a1e09e41b40a98f1c7d0d8b7bf5d8f5e3a0b6c21",
    source: "Cathay domestic deposit observed human-assisted capture",
  },
  authority: "personal-owned-accounts",
  currency: "TWD",
  providerGuaranteed: false,
  semantics: {
    posting: "provider-booked-history-with-accounting-date",
    direction: "expendAmt-outflow-incomeAmt-inflow",
    effectiveTime: "accounting-date-with-transaction-time-Asia/Taipei",
    cancellation: "explicit-status-only",
    occurrence: "observed-sequence-with-content-v1",
    completeness: "successful-response-with-account-count-and-details",
    zeroResult: "successful-complete-range-with-zero-details",
    withdrawal: "never-infer-missing-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type CathayHumanAttestedV1Manifest = Omit<
  typeof CATHAY_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type CathayHumanAttestationEvent = Readonly<{
  attestationId: string;
  evidenceVersion: string;
  eventKind: "attested" | "revoked";
  manifestStatus: "active" | "revoked";
  eventAt: string;
  reason: string | null;
  manifestFingerprint: `sha256:${string}`;
  sequence: number;
}>;

export function cathayHumanAttestedManifestFingerprint(): `sha256:${string}` {
  return CATHAY_HUMAN_ATTESTED_V1_MANIFEST.provenance
    .sourceCaptureFingerprint as `sha256:${string}`;
}

export function getCathayHumanAttestedV1Manifest(): CathayHumanAttestedV1Manifest {
  return CATHAY_HUMAN_ATTESTED_V1_MANIFEST;
}

export function isCathayHumanAttestedV1Active(): boolean {
  return CATHAY_HUMAN_ATTESTED_V1_MANIFEST.status === "active";
}
