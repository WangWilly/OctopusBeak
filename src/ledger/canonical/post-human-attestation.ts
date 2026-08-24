import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type PostOpaqueToken = `sha256:${string}`;

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

export const POST_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE =
  "post/domestic-deposit/human-attested-v1" as const;
export const POST_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION =
  "human-attested-v1" as const;

/** User-confirmed 1A/2A/3A observations. No provider uniqueness is claimed. */
export const POST_HUMAN_ATTESTED_V1_MANIFEST = deepFreeze({
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

function fingerprint(manifest: PostHumanAttestedV1Manifest): PostOpaqueToken {
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
      fingerprint(manifest),
    ].join("\0"),
  ).toString("base64url")}`;
}

function assertManifest(manifest: PostHumanAttestedV1Manifest): void {
  if (
    manifest !== currentManifest ||
    manifest.attestationId !== POST_HUMAN_ATTESTED_V1_MANIFEST.attestationId ||
    manifest.evidenceVersion !==
      POST_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !==
      POST_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute ||
    fingerprint(manifest) !== fingerprint(POST_HUMAN_ATTESTED_V1_MANIFEST) ||
    manifest.providerGuaranteed !== false
  )
    throw new Error(
      "Post attestation manifest does not match the immutable contract.",
    );
}

function validEventAt(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) &&
    Number.isFinite(Date.parse(value))
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

export function ensurePostHumanAttestationEvents(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS post_attestation_events (
    event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
    attestation_id TEXT NOT NULL,
    evidence_version TEXT NOT NULL,
    event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked')),
    manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
    event_at TEXT NOT NULL,
    reason TEXT,
    manifest_fingerprint TEXT NOT NULL,
    event_sequence INTEGER NOT NULL,
    UNIQUE(attestation_id, event_kind, event_at)
  )`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_post_attestation_events_latest " +
      "ON post_attestation_events(attestation_id, event_sequence, event_at, event_id)",
  );
}

type StoredEvent = {
  attestation_id: string;
  evidence_version: string;
  event_kind: "attested" | "revoked";
  manifest_status: "active" | "revoked";
  event_at: string;
  reason: string | null;
  manifest_fingerprint: PostOpaqueToken;
  event_sequence: number;
};

function eventChain(db: DatabaseSync): PostHumanAttestationEvent[] {
  ensurePostHumanAttestationEvents(db);
  assertManifest(currentManifest);
  const rows = db
    .prepare(
      "SELECT attestation_id,evidence_version,event_kind,manifest_status,event_at,reason,manifest_fingerprint,event_sequence " +
        "FROM post_attestation_events WHERE attestation_id = ? " +
        "ORDER BY event_sequence ASC,event_at ASC,rowid ASC",
    )
    .all(currentManifest.attestationId) as StoredEvent[];
  const chain: PostHumanAttestationEvent[] = [];
  for (const [index, row] of rows.entries()) {
    const event: PostHumanAttestationEvent = {
      attestationId: row.attestation_id,
      evidenceVersion: row.evidence_version,
      eventKind: row.event_kind,
      manifestStatus: row.manifest_status,
      eventAt: row.event_at,
      reason: row.reason,
      manifestFingerprint: row.manifest_fingerprint,
      sequence: Number(row.event_sequence),
    };
    const previous = chain.at(-1);
    if (
      event.attestationId !== currentManifest.attestationId ||
      event.evidenceVersion !== currentManifest.evidenceVersion ||
      event.manifestFingerprint !== fingerprint(currentManifest) ||
      event.sequence !== index + 1 ||
      !validEventAt(event.eventAt) ||
      (index === 0 && event.eventKind !== "attested") ||
      (event.eventKind === "attested" && event.manifestStatus !== "active") ||
      (event.eventKind === "revoked" &&
        (event.manifestStatus !== "revoked" || !event.reason?.trim())) ||
      (previous &&
        (event.eventAt < previous.eventAt ||
          event.eventKind === previous.eventKind))
    )
      throw new Error("Post attestation event chain is invalid.");
    chain.push(event);
  }
  return chain;
}

export function latestPostHumanAttestationEvent(
  db: DatabaseSync,
): PostHumanAttestationEvent | null {
  const latest = eventChain(db).at(-1) ?? null;
  if (!latest && currentManifest.status === "revoked")
    throw new Error(
      "Post revoked attestation has no durable revocation event.",
    );
  return latest;
}

function recordEvent(db: DatabaseSync, event: PostHumanAttestationEvent): void {
  const chain = eventChain(db);
  const previous = chain.at(-1);
  if (
    event.attestationId !== currentManifest.attestationId ||
    event.evidenceVersion !== currentManifest.evidenceVersion ||
    event.manifestFingerprint !== fingerprint(currentManifest) ||
    event.sequence !== chain.length + 1 ||
    !validEventAt(event.eventAt) ||
    (event.eventKind === "attested" &&
      (event.manifestStatus !== "active" ||
        currentManifest.status !== "active")) ||
    (event.eventKind === "revoked" &&
      (event.manifestStatus !== "revoked" ||
        currentManifest.status !== "revoked" ||
        !event.reason?.trim())) ||
    (previous &&
      (event.eventAt < previous.eventAt ||
        event.eventKind === previous.eventKind))
  )
    throw new Error(
      "Post attestation event does not match the immutable chain.",
    );
  db.prepare(
    "INSERT INTO post_attestation_events(event_id,attestation_id,evidence_version,event_kind,manifest_status,event_at,reason,manifest_fingerprint,event_sequence) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    randomBytes(16),
    event.attestationId,
    event.evidenceVersion,
    event.eventKind,
    event.manifestStatus,
    event.eventAt,
    event.reason,
    event.manifestFingerprint,
    event.sequence,
  );
}

export function recordInitialPostHumanAttestationIfMissing(
  db: DatabaseSync,
  observedAt = `${POST_HUMAN_ATTESTED_V1_MANIFEST.attestedAt}T00:00:00+08:00`,
): void {
  if (!isPostHumanAttestedV1Active())
    throw new Error("Cannot attest a revoked Post manifest.");
  if (latestPostHumanAttestationEvent(db)) return;
  recordEvent(db, {
    attestationId: currentManifest.attestationId,
    evidenceVersion: currentManifest.evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: "user-confirmed-post-observed-human-attested-2026-08-24",
    manifestFingerprint: fingerprint(currentManifest),
    sequence: 1,
  });
}

export function revokePostHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): PostHumanAttestedV1Manifest {
  if (!validEventAt(at) || !reason.trim())
    throw new Error("Post attestation revocation requires time and reason.");
  const latest = db ? latestPostHumanAttestationEvent(db) : null;
  if (currentManifest.status === "revoked") return currentManifest;
  const revoked = deepFreeze({
    ...currentManifest,
    status: "revoked" as const,
    revokedAt: at,
    revocationReason: reason.trim(),
  });
  currentManifest = revoked;
  VALIDATED_MANIFESTS.add(revoked);
  if (db)
    recordEvent(db, {
      attestationId: revoked.attestationId,
      evidenceVersion: revoked.evidenceVersion,
      eventKind: "revoked",
      manifestStatus: "revoked",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: fingerprint(revoked),
      sequence: latest ? latest.sequence + 1 : 1,
    });
  return revoked;
}

export function restorePostHumanAttestedV1(
  at: string,
  reason = "user-confirmed-restoration",
  db?: DatabaseSync,
): PostHumanAttestedV1Manifest {
  if (!validEventAt(at) || !reason.trim())
    throw new Error("Post attestation restoration requires time and reason.");
  const latest = db ? latestPostHumanAttestationEvent(db) : null;
  if (currentManifest.status === "active" && latest?.eventKind !== "revoked")
    return currentManifest;
  const restored = deepFreeze({
    ...currentManifest,
    status: "active" as const,
    revokedAt: null,
    revocationReason: null,
  });
  currentManifest = restored;
  VALIDATED_MANIFESTS.add(restored);
  if (db)
    recordEvent(db, {
      attestationId: restored.attestationId,
      evidenceVersion: restored.evidenceVersion,
      eventKind: "attested",
      manifestStatus: "active",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: fingerprint(restored),
      sequence: latest ? latest.sequence + 1 : 1,
    });
  return restored;
}

export function isPostHumanAttestationDurablyActive(db: DatabaseSync): boolean {
  if (!isPostHumanAttestedV1Active()) return false;
  try {
    const latest = latestPostHumanAttestationEvent(db);
    return (
      latest?.eventKind === "attested" && latest.manifestStatus === "active"
    );
  } catch {
    return false;
  }
}
