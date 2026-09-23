import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isValidatedCanonicalDatabase,
  runCanonicalSchemaRepair,
} from "./canonical-schema-lifecycle.ts";

import {
  assertCurrentManifest,
  currentManifest,
  FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  isFubonHumanAttestedV1Active,
  manifestFingerprint,
  revokeFubonHumanAttestedV1State,
  type FubonHumanAttestationEvent,
  type FubonHumanAttestedV1Manifest,
} from "./fubon-human-attestation-contract.ts";
export {
  FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  getFubonHumanAttestedV1Manifest,
  isFubonHumanAttestedV1Active,
  isFubonHumanAttestedV1Manifest,
} from "./fubon-human-attestation-contract.ts";
export type {
  FubonHumanAttestationEvent,
  FubonHumanAttestedV1Manifest,
} from "./fubon-human-attestation-contract.ts";

/**
 * Revocation is append-only. Existing canonical history is intentionally left
 * untouched; future admissions fail closed after the new event is observed.
 */
export function revokeFubonHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): FubonHumanAttestedV1Manifest {
  const wasRevoked = currentManifest.status === "revoked";
  const revoked = revokeFubonHumanAttestedV1State(at, reason);
  if (db && !wasRevoked) {
    recordFubonHumanAttestationEvent(db, {
      attestationId: revoked.attestationId,
      evidenceVersion: revoked.evidenceVersion,
      eventKind: "revoked",
      manifestStatus: "revoked",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(revoked),
      sequence: nextEventSequence(db, revoked.attestationId),
    });
  }
  return revoked;
}

function tableColumns(db: DatabaseSync): Set<string> {
  return new Set(
    (
      db.prepare("PRAGMA table_info(fubon_attestation_events)").all() as Array<{
        name?: string;
      }>
    ).flatMap((row) => (row.name ? [row.name] : [])),
  );
}

/** Durable append-only event spine in the shared schema namespace. */
export function ensureFubonHumanAttestationEvents(db: DatabaseSync): void {
  if (isValidatedCanonicalDatabase(db)) {
    runCanonicalSchemaRepair(db, "canonical/attestation/fubon-events/v1");
    return;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS fubon_attestation_events (
      event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
      attestation_id TEXT NOT NULL,
      evidence_version TEXT,
      event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked')),
      manifest_status TEXT,
      event_at TEXT NOT NULL,
      reason TEXT,
      manifest_fingerprint TEXT NOT NULL,
      event_sequence INTEGER,
      UNIQUE(attestation_id, event_kind, event_at)
    );
  `);
  const columns = tableColumns(db);
  if (!columns.has("evidence_version"))
    db.exec(
      "ALTER TABLE fubon_attestation_events ADD COLUMN evidence_version TEXT",
    );
  if (!columns.has("manifest_status"))
    db.exec(
      "ALTER TABLE fubon_attestation_events ADD COLUMN manifest_status TEXT",
    );
  if (!columns.has("event_sequence"))
    db.exec(
      "ALTER TABLE fubon_attestation_events ADD COLUMN event_sequence INTEGER",
    );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fubon_attestation_events_latest
      ON fubon_attestation_events(attestation_id, event_sequence, event_at, event_id);
  `);
}

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

function readEventChain(
  db: DatabaseSync,
  attestationId: string = currentManifest.attestationId,
): FubonHumanAttestationEvent[] {
  const rows = db
    .prepare(
      `SELECT attestation_id, evidence_version, event_kind, manifest_status,
              event_at, reason, manifest_fingerprint, event_sequence
       FROM fubon_attestation_events
       WHERE attestation_id = ?
       ORDER BY event_sequence ASC, event_at ASC, rowid ASC`,
    )
    .all(attestationId) as StoredEventRow[];
  if (rows.length === 0) return [];
  assertCurrentManifest(currentManifest);
  const expectedFingerprint = manifestFingerprint(currentManifest);
  const chain: FubonHumanAttestationEvent[] = [];
  for (const [index, row] of rows.entries()) {
    const event: FubonHumanAttestationEvent = {
      attestationId: row.attestation_id ?? "",
      evidenceVersion: row.evidence_version ?? "",
      eventKind: row.event_kind as FubonHumanAttestationEvent["eventKind"],
      manifestStatus:
        row.manifest_status as FubonHumanAttestationEvent["manifestStatus"],
      eventAt: row.event_at ?? "",
      reason: row.reason ?? null,
      manifestFingerprint:
        row.manifest_fingerprint ?? ("" as `sha256:${string}`),
      sequence: Number(row.event_sequence),
    };
    if (
      event.attestationId !== currentManifest.attestationId ||
      event.evidenceVersion !== currentManifest.evidenceVersion ||
      event.manifestFingerprint !== expectedFingerprint ||
      event.sequence !== index + 1 ||
      !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(event.eventAt) ||
      (event.eventKind === "attested" && event.manifestStatus !== "active") ||
      (event.eventKind === "revoked" && event.manifestStatus !== "revoked") ||
      (event.eventKind === "revoked" && !event.reason?.trim()) ||
      (index > 0 && event.eventAt < (chain[index - 1]?.eventAt ?? "")) ||
      (index === 0 && event.eventKind !== "attested") ||
      (index > 0 &&
        (event.eventKind !== "revoked" ||
          chain[index - 1]?.eventKind !== "attested"))
    )
      throw new Error("Fubon attestation event chain is invalid.");
    chain.push(event);
  }
  return chain;
}

function nextEventSequence(db: DatabaseSync, attestationId: string): number {
  ensureFubonHumanAttestationEvents(db);
  return readEventChain(db, attestationId).length + 1;
}

export function recordFubonHumanAttestationEvent(
  db: DatabaseSync,
  event: FubonHumanAttestationEvent,
): void {
  ensureFubonHumanAttestationEvents(db);
  assertCurrentManifest(currentManifest);
  const chain = readEventChain(db, event.attestationId);
  const expectedSequence = chain.length + 1;
  if (
    event.attestationId !== currentManifest.attestationId ||
    event.evidenceVersion !== currentManifest.evidenceVersion ||
    event.manifestFingerprint !== manifestFingerprint(currentManifest) ||
    event.sequence !== expectedSequence ||
    !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(event.eventAt) ||
    (event.eventKind === "revoked" && !event.reason?.trim()) ||
    (chain.length > 0 && event.eventAt < (chain.at(-1)?.eventAt ?? "")) ||
    (event.eventKind === "attested" &&
      (event.manifestStatus !== "active" ||
        currentManifest.status !== "active")) ||
    (event.eventKind === "revoked" &&
      (event.manifestStatus !== "revoked" ||
        currentManifest.status !== "revoked")) ||
    (event.eventKind === "attested" && chain.length !== 0) ||
    (event.eventKind === "revoked" &&
      (chain.length !== 1 || chain[0]?.eventKind !== "attested"))
  )
    throw new Error(
      "Fubon attestation event does not match the immutable chain.",
    );
  db.prepare(
    `INSERT INTO fubon_attestation_events(
      event_id, attestation_id, evidence_version, event_kind, manifest_status,
      event_at, reason, manifest_fingerprint, event_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

export function latestFubonHumanAttestationEvent(
  db: DatabaseSync,
  attestationId = FUBON_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
): FubonHumanAttestationEvent | null {
  ensureFubonHumanAttestationEvents(db);
  const chain = readEventChain(db, attestationId);
  const latest = chain.at(-1) ?? null;
  if (
    latest &&
    ((currentManifest.status === "active" &&
      latest.manifestStatus !== "active") ||
      (currentManifest.status === "revoked" &&
        latest.manifestStatus !== "revoked"))
  )
    throw new Error("Fubon attestation state does not match its event chain.");
  if (!latest && currentManifest.status === "revoked")
    throw new Error(
      "Fubon revoked attestation has no durable revocation event.",
    );
  return latest;
}

export function recordInitialFubonHumanAttestationIfMissing(
  db: DatabaseSync,
  observedAt = `${FUBON_HUMAN_ATTESTED_V1_MANIFEST.attestedAt}T00:00:00.000Z`,
): void {
  if (!isFubonHumanAttestedV1Active())
    throw new Error("Cannot attest a revoked Fubon manifest.");
  const latest = latestFubonHumanAttestationEvent(
    db,
    FUBON_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
  );
  if (latest) return;
  recordFubonHumanAttestationEvent(db, {
    attestationId: FUBON_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
    evidenceVersion: FUBON_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: "user-confirmed-1A-2A-3A",
    manifestFingerprint: manifestFingerprint(FUBON_HUMAN_ATTESTED_V1_MANIFEST),
    sequence: 1,
  });
}

export function isFubonHumanAttestationDurablyActive(
  db: DatabaseSync,
): boolean {
  if (!isFubonHumanAttestedV1Active()) return false;
  const latest = latestFubonHumanAttestationEvent(db);
  return latest?.eventKind === "attested" && latest.manifestStatus === "active";
}
