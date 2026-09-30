type PostOpaqueToken = `sha256:${string}`;

export function freezePostHumanAttestationManifest<T>(
  value: T,
  seen = new WeakSet<object>(),
): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object")
      freezePostHumanAttestationManifest(child, seen);
  }
  return Object.freeze(value);
}

export const POST_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE =
  "post/domestic-deposit/human-attested-v1" as const;
export const POST_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION =
  "human-attested-v1" as const;

/** User-confirmed 1A/2A/3A observations. No provider uniqueness is claimed. */
export const POST_HUMAN_ATTESTED_V1_MANIFEST = freezePostHumanAttestationManifest({
  attestationId: "post-domestic-deposit-human-attested-v1",
  evidenceVersion: POST_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  authorityRoute: POST_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  status: "active",
  attestedAt: "2026-08-24",
  attestedBy: "user-confirmed-post-observed-human-attested-2026-08-24",
  provenance: {
    kind: "user-confirmation",
    attestationContractFingerprint:
      "sha256:5b2698c998f1335476ff1d0bc9009294afdbd18576fa728c20a0563fcdb30bf4",
    source: "Chunghwa Post domestic deposit observed human-attested contract",
  },
  authority: "personal-authenticated-session-all-visible-domestic-accounts",
  currency: "TWD",
  providerGuaranteed: false,
  semantics: {
    posting: "statement-item-posted-history",
    direction: "dr-flg-plus-inflow-minus-outflow",
    effectiveTime: "prs-date-effective-with-tx-time-Asia/Taipei",
    accountingDate: "prs-date",
    cancellation: "independent-row-no-original-link",
    occurrence: "local-composite-not-provider-unique",
    completeness: "accepted-range-terminal-http-200-nonempty-item",
    zeroResult: "unproven-reject",
    withdrawal: "never-infer-missing-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type PostHumanAttestedV1Manifest = Omit<
  typeof POST_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type PostHumanAttestationEvent = {
  attestationId: string;
  evidenceVersion: string;
  eventKind: "attested" | "revoked";
  manifestStatus: "active" | "revoked";
  eventAt: string;
  reason: string | null;
  manifestFingerprint: PostOpaqueToken;
  sequence: number;
};

const VALIDATED_MANIFESTS = new WeakSet<object>();
let currentManifest: PostHumanAttestedV1Manifest =
  POST_HUMAN_ATTESTED_V1_MANIFEST;
VALIDATED_MANIFESTS.add(POST_HUMAN_ATTESTED_V1_MANIFEST);

export function postHumanAttestationFingerprint(
  manifest: PostHumanAttestedV1Manifest = currentManifest,
): PostOpaqueToken {
  return manifest.provenance.attestationContractFingerprint as PostOpaqueToken;
}

export function postHumanAttestedIdentityEpochKey(
  manifest: PostHumanAttestedV1Manifest = currentManifest,
): PostOpaqueToken {
  return `sha256:${Buffer.from(
    [
      "post-human-attested-identity-epoch-v1",
      manifest.attestationId,
      manifest.evidenceVersion,
      postHumanAttestationFingerprint(manifest),
    ].join("\0"),
  ).toString("base64url")}`;
}

export function assertPostHumanAttestedV1Manifest(
  manifest: PostHumanAttestedV1Manifest = currentManifest,
): void {
  if (
    manifest !== currentManifest ||
    manifest.attestationId !== POST_HUMAN_ATTESTED_V1_MANIFEST.attestationId ||
    manifest.evidenceVersion !==
      POST_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !==
      POST_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute ||
    postHumanAttestationFingerprint(manifest) !==
      postHumanAttestationFingerprint(POST_HUMAN_ATTESTED_V1_MANIFEST) ||
    manifest.providerGuaranteed !== false
  )
    throw new Error(
      "Post attestation manifest does not match the immutable contract.",
    );
}

export function getPostHumanAttestedV1Manifest(): PostHumanAttestedV1Manifest {
  return currentManifest;
}

export function isPostHumanAttestedV1Manifest(
  value: unknown,
): value is PostHumanAttestedV1Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_MANIFESTS.has(value) &&
    value === currentManifest
  );
}

export function isPostHumanAttestedV1Active(): boolean {
  return currentManifest.status === "active";
}

/** Shared singleton updater used by the durable SQLite attestation adapter. */
export function replacePostHumanAttestedV1Manifest(
  manifest: PostHumanAttestedV1Manifest,
): void {
  currentManifest = manifest;
  VALIDATED_MANIFESTS.add(manifest);
}

export function validPostHumanAttestationEventAt(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) &&
    Number.isFinite(Date.parse(value));
}
