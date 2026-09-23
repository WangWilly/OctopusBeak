import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isValidatedCanonicalDatabase,
  runCanonicalSchemaRepair,
} from "./canonical-schema-lifecycle.ts";
import {
  assertPostHumanAttestedV1Manifest,
  freezePostHumanAttestationManifest,
  getPostHumanAttestedV1Manifest,
  isPostHumanAttestedV1Active,
  POST_HUMAN_ATTESTED_V1_MANIFEST,
  postHumanAttestationFingerprint,
  replacePostHumanAttestedV1Manifest,
  validPostHumanAttestationEventAt,
  type PostHumanAttestationEvent,
  type PostHumanAttestedV1Manifest,
} from "./post-human-attestation-contract.ts";

export {
  POST_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  POST_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  POST_HUMAN_ATTESTED_V1_MANIFEST,
  getPostHumanAttestedV1Manifest,
  isPostHumanAttestedV1Active,
  isPostHumanAttestedV1Manifest,
  postHumanAttestedIdentityEpochKey,
  type PostHumanAttestationEvent,
  type PostHumanAttestedV1Manifest,
} from "./post-human-attestation-contract.ts";

type PostOpaqueToken = `sha256:${string}`;
const fingerprint = postHumanAttestationFingerprint;
const validEventAt = validPostHumanAttestationEventAt;
export function ensurePostHumanAttestationEvents(db: DatabaseSync): void {
  if (isValidatedCanonicalDatabase(db)) {
    runCanonicalSchemaRepair(db, "canonical/attestation/post-events/v1");
    return;
  }
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
  assertPostHumanAttestedV1Manifest();
  const rows = db
    .prepare(
      "SELECT attestation_id,evidence_version,event_kind,manifest_status,event_at,reason,manifest_fingerprint,event_sequence " +
        "FROM post_attestation_events WHERE attestation_id = ? " +
        "ORDER BY event_sequence ASC,event_at ASC,rowid ASC",
    )
    .all(getPostHumanAttestedV1Manifest().attestationId) as StoredEvent[];
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
      event.attestationId !== getPostHumanAttestedV1Manifest().attestationId ||
      event.evidenceVersion !== getPostHumanAttestedV1Manifest().evidenceVersion ||
      event.manifestFingerprint !== fingerprint() ||
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
  if (!latest && getPostHumanAttestedV1Manifest().status === "revoked")
    throw new Error(
      "Post revoked attestation has no durable revocation event.",
    );
  return latest;
}

function recordEvent(db: DatabaseSync, event: PostHumanAttestationEvent): void {
  const chain = eventChain(db);
  const previous = chain.at(-1);
  if (
    event.attestationId !== getPostHumanAttestedV1Manifest().attestationId ||
    event.evidenceVersion !== getPostHumanAttestedV1Manifest().evidenceVersion ||
    event.manifestFingerprint !== fingerprint() ||
    event.sequence !== chain.length + 1 ||
    !validEventAt(event.eventAt) ||
    (event.eventKind === "attested" &&
      (event.manifestStatus !== "active" ||
        getPostHumanAttestedV1Manifest().status !== "active")) ||
    (event.eventKind === "revoked" &&
      (event.manifestStatus !== "revoked" ||
        getPostHumanAttestedV1Manifest().status !== "revoked" ||
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
    attestationId: getPostHumanAttestedV1Manifest().attestationId,
    evidenceVersion: getPostHumanAttestedV1Manifest().evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: "user-confirmed-post-observed-human-attested-2026-08-24",
    manifestFingerprint: fingerprint(),
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
  const currentManifest = getPostHumanAttestedV1Manifest();
  if (currentManifest.status === "revoked") return currentManifest;
  const revoked = freezePostHumanAttestationManifest({
    ...currentManifest,
    status: "revoked" as const,
    revokedAt: at,
    revocationReason: reason.trim(),
  });
  replacePostHumanAttestedV1Manifest(revoked);
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
  const currentManifest = getPostHumanAttestedV1Manifest();
  if (currentManifest.status === "active" && latest?.eventKind !== "revoked")
    return currentManifest;
  const restored = freezePostHumanAttestationManifest({
    ...currentManifest,
    status: "active" as const,
    revokedAt: null,
    revocationReason: null,
  });
  replacePostHumanAttestedV1Manifest(restored);
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
