import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isValidatedCanonicalDatabase,
  runCanonicalSchemaRepair,
} from "./canonical-schema-lifecycle.ts";
import {
  HNCB_HUMAN_ATTESTED_V1_MANIFEST,
  assertCurrentManifest,
  createInitialHncbHumanAttestationEvent,
  getHncbHumanAttestedV1Manifest,
  isHncbHumanAttestedV1Active,
  isHncbHumanAttestedV1Manifest,
  manifestFingerprint,
  transitionHncbHumanAttestedV1Restoration,
  transitionHncbHumanAttestedV1Revocation,
  validEventAt,
  type HncbHumanAttestationEvent,
  type HncbHumanAttestedV1Manifest,
} from "./hncb-human-attestation-contract.ts";

export {
  HNCB_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  HNCB_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  HNCB_HUMAN_ATTESTED_V1_MANIFEST,
  getHncbHumanAttestedV1Manifest,
  hncbHumanAttestedIdentityEpochKey,
  isHncbHumanAttestedV1Manifest,
  isHncbHumanAttestedV1Active,
  type HncbHumanAttestationEvent,
  type HncbHumanAttestedV1Manifest,
  type HncbOpaqueToken,
} from "./hncb-human-attestation-contract.ts";

type StoredEventRow = {
  attestation_id?: string;
  evidence_version?: string | null;
  event_kind?: "attested" | "revoked";
  manifest_status?: "active" | "revoked" | null;
  event_at?: string;
  reason?: string | null;
  manifest_fingerprint?: `sha256:${string}`;
  event_sequence?: number | null;
};

function tableColumns(db: DatabaseSync): Set<string> {
  return new Set(
    (
      db.prepare("PRAGMA table_info(hncb_attestation_events)").all() as Array<{
        name?: string;
      }>
    ).flatMap((row) => (row.name ? [row.name] : [])),
  );
}

export function ensureHncbHumanAttestationEvents(db: DatabaseSync): void {
  if (isValidatedCanonicalDatabase(db)) {
    runCanonicalSchemaRepair(db, "canonical/attestation/hncb-events/v1");
    return;
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS hncb_attestation_events (" +
      "event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16), " +
      "attestation_id TEXT NOT NULL, evidence_version TEXT, " +
      "event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked')), " +
      "manifest_status TEXT, event_at TEXT NOT NULL, reason TEXT, " +
      "manifest_fingerprint TEXT NOT NULL, event_sequence INTEGER, " +
      "UNIQUE(attestation_id, event_kind, event_at)" +
      ")",
  );
  const columns = tableColumns(db);
  if (!columns.has("evidence_version"))
    db.exec(
      "ALTER TABLE hncb_attestation_events ADD COLUMN evidence_version TEXT",
    );
  if (!columns.has("manifest_status"))
    db.exec(
      "ALTER TABLE hncb_attestation_events ADD COLUMN manifest_status TEXT",
    );
  if (!columns.has("event_sequence"))
    db.exec(
      "ALTER TABLE hncb_attestation_events ADD COLUMN event_sequence INTEGER",
    );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_hncb_attestation_events_latest " +
      "ON hncb_attestation_events(attestation_id, event_sequence, event_at, event_id)",
  );
}

function readEventChain(
  db: DatabaseSync,
  attestationId = getHncbHumanAttestedV1Manifest().attestationId,
): HncbHumanAttestationEvent[] {
  ensureHncbHumanAttestationEvents(db);
  const rows = db
    .prepare(
      "SELECT attestation_id, evidence_version, event_kind, manifest_status, event_at, reason, manifest_fingerprint, event_sequence " +
        "FROM hncb_attestation_events WHERE attestation_id = ? ORDER BY event_sequence ASC, event_at ASC, rowid ASC",
    )
    .all(attestationId) as StoredEventRow[];
  if (rows.length === 0) return [];
  const currentManifest = getHncbHumanAttestedV1Manifest();
  assertCurrentManifest(currentManifest);
  const expectedFingerprint = manifestFingerprint(currentManifest);
  const chain: HncbHumanAttestationEvent[] = [];
  for (const [index, row] of rows.entries()) {
    const event: HncbHumanAttestationEvent = {
      attestationId: row.attestation_id ?? "",
      evidenceVersion: row.evidence_version ?? "",
      eventKind: row.event_kind as HncbHumanAttestationEvent["eventKind"],
      manifestStatus:
        row.manifest_status as HncbHumanAttestationEvent["manifestStatus"],
      eventAt: row.event_at ?? "",
      reason: row.reason ?? null,
      manifestFingerprint: row.manifest_fingerprint ?? ("" as `sha256:${string}`),
      sequence: Number(row.event_sequence),
    };
    const previous = chain.at(-1);
    if (
      event.attestationId !== currentManifest.attestationId ||
      event.evidenceVersion !== currentManifest.evidenceVersion ||
      event.manifestFingerprint !== expectedFingerprint ||
      event.sequence !== index + 1 ||
      !validEventAt(event.eventAt) ||
      (event.eventKind === "attested" && event.manifestStatus !== "active") ||
      (event.eventKind === "revoked" && event.manifestStatus !== "revoked") ||
      (event.eventKind === "revoked" && !event.reason?.trim()) ||
      (previous && event.eventAt < previous.eventAt) ||
      (index === 0 && event.eventKind !== "attested") ||
      (previous && event.eventKind === previous.eventKind)
    )
      throw new Error("HNCB attestation event chain is invalid.");
    chain.push(event);
  }
  return chain;
}

export function latestHncbHumanAttestationEvent(
  db: DatabaseSync,
  attestationId = HNCB_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
): HncbHumanAttestationEvent | null {
  const chain = readEventChain(db, attestationId);
  const latest = chain.at(-1) ?? null;
  if (!latest && !isHncbHumanAttestedV1Active())
    throw new Error("HNCB revoked attestation has no durable revocation event.");
  return latest;
}

function recordEvent(db: DatabaseSync, event: HncbHumanAttestationEvent): void {
  ensureHncbHumanAttestationEvents(db);
  const currentManifest = getHncbHumanAttestedV1Manifest();
  assertCurrentManifest(currentManifest);
  const chain = readEventChain(db);
  const previous = chain.at(-1);
  if (
    event.attestationId !== currentManifest.attestationId ||
    event.evidenceVersion !== currentManifest.evidenceVersion ||
    event.manifestFingerprint !== manifestFingerprint(currentManifest) ||
    event.sequence !== chain.length + 1 ||
    !validEventAt(event.eventAt) ||
    (event.eventKind === "revoked" && !event.reason?.trim()) ||
    (previous && event.eventAt < previous.eventAt) ||
    (event.eventKind === "attested" &&
      (event.manifestStatus !== "active" ||
        currentManifest.status !== "active")) ||
    (event.eventKind === "revoked" &&
      (event.manifestStatus !== "revoked" ||
        currentManifest.status !== "revoked")) ||
    (previous && event.eventKind === previous.eventKind)
  )
    throw new Error("HNCB attestation event does not match the immutable chain.");
  db.prepare(
    "INSERT INTO hncb_attestation_events(event_id, attestation_id, evidence_version, event_kind, manifest_status, event_at, reason, manifest_fingerprint, event_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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

export function recordHncbHumanAttestationEvent(
  db: DatabaseSync,
  event: HncbHumanAttestationEvent,
): void {
  recordEvent(db, event);
}

export function recordInitialHncbHumanAttestationIfMissing(
  db: DatabaseSync,
  observedAt?: string,
): void {
  if (!isHncbHumanAttestedV1Active())
    throw new Error("Cannot attest a revoked HNCB manifest.");
  if (latestHncbHumanAttestationEvent(db)) return;
  recordEvent(db, createInitialHncbHumanAttestationEvent(observedAt));
}

export function revokeHncbHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): HncbHumanAttestedV1Manifest {
  const latest = db ? latestHncbHumanAttestationEvent(db) : null;
  const transition = transitionHncbHumanAttestedV1Revocation(
    at,
    reason,
    latest,
  );
  if (db && transition.event) recordEvent(db, transition.event);
  return transition.manifest;
}

export function restoreHncbHumanAttestedV1(
  at: string,
  reason = "user-confirmed-restoration",
  db?: DatabaseSync,
): HncbHumanAttestedV1Manifest {
  const latest = db ? latestHncbHumanAttestationEvent(db) : null;
  const transition = transitionHncbHumanAttestedV1Restoration(
    at,
    reason,
    latest,
  );
  if (db && transition.event) recordEvent(db, transition.event);
  return transition.manifest;
}

export function isHncbHumanAttestationDurablyActive(db: DatabaseSync): boolean {
  if (!isHncbHumanAttestedV1Active()) return false;
  try {
    const latest = latestHncbHumanAttestationEvent(db);
    return (
      latest?.eventKind === "attested" && latest.manifestStatus === "active"
    );
  } catch {
    return false;
  }
}
