import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isValidatedCanonicalDatabase,
  runCanonicalSchemaRepair,
} from "./canonical-schema-lifecycle.ts";
import {
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  fubonCreditCardHumanAttestedLegacyV1ManifestFingerprint,
  getFubonCreditCardHumanAttestedV2Manifest,
  isFubonCreditCardHumanAttestedV2Active,
  assertCurrentManifest,
  currentV1Manifest,
  currentV2Manifest,
  manifestFingerprint,
  setCurrentManifestStatus,
  type FubonCreditCardHumanAttestedV1Manifest,
  type FubonCreditCardHumanAttestedV2Manifest,
  type FubonCreditCardHumanAttestationEvent,
} from "./fubon-credit-card-human-attestation-contract.ts";

export {
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_LEGACY_V1_MANIFEST,
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_LEGACY_MANIFEST,
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  fubonCreditCardHumanAttestedLegacyV1ManifestFingerprint,
  fubonCreditCardHumanAttestedManifestFingerprint,
  getFubonCreditCardHumanAttestedV1Manifest,
  getFubonCreditCardHumanAttestedV2Manifest,
  isFubonCreditCardHumanAttestedAccountKey,
  isFubonCreditCardHumanAttestedV1Active,
  isFubonCreditCardHumanAttestedV1Manifest,
  isFubonCreditCardHumanAttestedV2Active,
  isFubonCreditCardHumanAttestedV2Manifest,
} from "./fubon-credit-card-human-attestation-contract.ts";
export type {
  FubonCreditCardHumanAttestedV1Manifest,
  FubonCreditCardHumanAttestedV2Manifest,
  FubonCreditCardHumanAttestationEvent,
} from "./fubon-credit-card-human-attestation-contract.ts";

function tableColumns(db: DatabaseSync): Set<string> {
  return new Set(
    (
      db
        .prepare("PRAGMA table_info(fubon_credit_card_attestation_events)")
        .all() as Array<{ name?: string }>
    ).flatMap((row) => (row.name ? [row.name] : [])),
  );
}

export function ensureFubonCreditCardHumanAttestationEvents(
  db: DatabaseSync,
): void {
  if (isValidatedCanonicalDatabase(db)) {
    runCanonicalSchemaRepair(db, "canonical/attestation/fubon-credit-card-events/v1");
    return;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS fubon_credit_card_attestation_events (
      event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
      attestation_id TEXT NOT NULL,
      evidence_version TEXT NOT NULL,
      event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked','restored')),
      manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
      event_at TEXT NOT NULL,
      reason TEXT,
      manifest_fingerprint TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      UNIQUE(attestation_id, event_sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_fubon_credit_card_attestation_latest
      ON fubon_credit_card_attestation_events(attestation_id, event_sequence);
  `);
  const columns = tableColumns(db);
  if (!columns.has("manifest_status"))
    db.exec(
      "ALTER TABLE fubon_credit_card_attestation_events ADD COLUMN manifest_status TEXT",
    );
}

type StoredEvent = {
  attestation_id?: string;
  evidence_version?: string;
  event_kind?: "attested" | "revoked" | "restored";
  manifest_status?: "active" | "revoked";
  event_at?: string;
  reason?: string | null;
  manifest_fingerprint?: `sha256:${string}`;
  event_sequence?: number;
};

function readEvents(
  db: DatabaseSync,
  attestationId: string = FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestationId,
): FubonCreditCardHumanAttestationEvent[] {
  ensureFubonCreditCardHumanAttestationEvents(db);
  const rows = db
    .prepare(
      `SELECT attestation_id, evidence_version, event_kind, manifest_status,
              event_at, reason, manifest_fingerprint, event_sequence
       FROM fubon_credit_card_attestation_events
       WHERE attestation_id = ?
       ORDER BY event_sequence ASC`,
    )
    .all(attestationId) as StoredEvent[];
  if (rows.length === 0) return [];
  const isLegacyV1 =
    attestationId === FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.attestationId;
  if (
    !isLegacyV1 &&
    attestationId !== FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestationId
  )
    throw new Error("Fubon credit-card attestation version is unsupported.");
  if (!isLegacyV1) assertCurrentManifest(currentV2Manifest);
  const expectedManifest = isLegacyV1
    ? FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST
    : currentV2Manifest;
  const expected = isLegacyV1
    ? fubonCreditCardHumanAttestedLegacyV1ManifestFingerprint()
    : manifestFingerprint();
  const result: FubonCreditCardHumanAttestationEvent[] = [];
  for (const [index, row] of rows.entries()) {
    const event: FubonCreditCardHumanAttestationEvent = {
      attestationId: row.attestation_id ?? "",
      evidenceVersion: row.evidence_version ?? "",
      eventKind: row.event_kind as FubonCreditCardHumanAttestationEvent["eventKind"],
      manifestStatus:
        row.manifest_status as FubonCreditCardHumanAttestationEvent["manifestStatus"],
      eventAt: row.event_at ?? "",
      reason: row.reason ?? null,
      manifestFingerprint: row.manifest_fingerprint ?? ("" as `sha256:${string}`),
      sequence: Number(row.event_sequence),
    };
    if (
      event.attestationId !== expectedManifest.attestationId ||
      event.evidenceVersion !== expectedManifest.evidenceVersion ||
      event.manifestFingerprint !== expected ||
      event.sequence !== index + 1 ||
      !/^\d{4}-\d{2}-\d{2}T/.test(event.eventAt) ||
      (index === 0 && event.eventKind !== "attested") ||
      (index > 0 &&
        !(
          (event.eventKind === "revoked" &&
            result[index - 1]?.eventKind === "attested") ||
          (event.eventKind === "restored" &&
            result[index - 1]?.eventKind === "revoked")
        )) ||
      (event.eventKind === "attested" && event.manifestStatus !== "active") ||
      (event.eventKind === "revoked" && event.manifestStatus !== "revoked") ||
      (event.eventKind === "restored" && event.manifestStatus !== "active") ||
      (event.eventKind !== "attested" && !event.reason?.trim())
    )
      throw new Error("Fubon credit-card attestation event chain is invalid.");
    result.push(event);
  }
  return result;
}

function nextSequence(db: DatabaseSync): number {
  return readEvents(db).length + 1;
}

export function recordFubonCreditCardHumanAttestationEvent(
  db: DatabaseSync,
  event: FubonCreditCardHumanAttestationEvent,
): void {
  ensureFubonCreditCardHumanAttestationEvents(db);
  assertCurrentManifest(currentV2Manifest);
  const previous = readEvents(db);
  if (
    event.attestationId !== currentV2Manifest.attestationId ||
    event.evidenceVersion !== currentV2Manifest.evidenceVersion ||
    event.manifestFingerprint !== manifestFingerprint() ||
    event.sequence !== previous.length + 1 ||
    (event.eventKind === "attested" &&
      (event.manifestStatus !== "active" || previous.length !== 0)) ||
    (event.eventKind === "revoked" &&
      (event.manifestStatus !== "revoked" ||
        previous.at(-1)?.eventKind !== "attested")) ||
    (event.eventKind === "restored" &&
      (event.manifestStatus !== "active" ||
        previous.at(-1)?.eventKind !== "revoked")) ||
    (event.eventKind !== "attested" && !event.reason?.trim())
  )
    throw new Error(
      "Fubon credit-card attestation event does not match its append-only contract.",
    );
  db.prepare(
    `INSERT INTO fubon_credit_card_attestation_events(
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

export function latestFubonCreditCardHumanAttestationEvent(
  db: DatabaseSync,
): FubonCreditCardHumanAttestationEvent | null {
  const events = readEvents(db);
  return events.at(-1) ?? null;
}

/** Explicit migration/audit reader for the immutable original v1 event chain. */
export function latestFubonCreditCardHumanAttestationLegacyV1Event(
  db: DatabaseSync,
): FubonCreditCardHumanAttestationEvent | null {
  const events = readEvents(
    db,
    FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
  );
  return events.at(-1) ?? null;
}

export function peekFubonCreditCardHumanAttestationStatus(
  db: DatabaseSync,
): "active" | "revoked" | null {
  const exists = db
    .prepare(
      `SELECT 1 AS value FROM sqlite_master
       WHERE type = 'table' AND name = 'fubon_credit_card_attestation_events'`,
    )
    .get() as { value?: number } | undefined;
  if (!exists) return null;
  return latestFubonCreditCardHumanAttestationEvent(db)?.manifestStatus ?? null;
}

export function recordInitialFubonCreditCardHumanAttestationIfMissing(
  db: DatabaseSync,
  observedAt: string = FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestedAt,
): void {
  if (!isFubonCreditCardHumanAttestedV2Active())
    throw new Error("Cannot attest a revoked Fubon credit-card manifest.");
  if (latestFubonCreditCardHumanAttestationEvent(db)) return;
  recordFubonCreditCardHumanAttestationEvent(db, {
    attestationId: FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestationId,
    evidenceVersion: FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: "human-confirmed-primary-cardholder-portfolio",
    manifestFingerprint: manifestFingerprint(),
    sequence: 1,
  });
}


export function revokeFubonCreditCardHumanAttestedV2(
  at: string,
  reason: string,
  db?: DatabaseSync,
): FubonCreditCardHumanAttestedV2Manifest {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || !reason.trim())
    throw new Error("Fubon credit-card attestation revocation requires time and reason.");
  if (currentV2Manifest.status === "revoked") {
    if (db && latestFubonCreditCardHumanAttestationEvent(db)?.manifestStatus === "active")
      recordFubonCreditCardHumanAttestationEvent(db, {
        attestationId: currentV2Manifest.attestationId,
        evidenceVersion: currentV2Manifest.evidenceVersion,
        eventKind: "revoked",
        manifestStatus: "revoked",
        eventAt: at,
        reason: reason.trim(),
        manifestFingerprint: manifestFingerprint(),
        sequence: nextSequence(db),
      });
    return currentV2Manifest;
  }
  setCurrentManifestStatus("revoked", at, reason.trim());
  if (db)
    recordFubonCreditCardHumanAttestationEvent(db, {
      attestationId: currentV2Manifest.attestationId,
      evidenceVersion: currentV2Manifest.evidenceVersion,
      eventKind: "revoked",
      manifestStatus: "revoked",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(),
      sequence: nextSequence(db),
    });
  return currentV2Manifest;
}

export function revokeFubonCreditCardHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): FubonCreditCardHumanAttestedV1Manifest {
  revokeFubonCreditCardHumanAttestedV2(at, reason, db);
  return currentV1Manifest;
}

export function restoreFubonCreditCardHumanAttestedV2(
  at: string,
  reason: string,
  db?: DatabaseSync,
): FubonCreditCardHumanAttestedV2Manifest {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || !reason.trim())
    throw new Error("Fubon credit-card attestation restore requires time and reason.");
  if (currentV2Manifest.status === "active") {
    if (db && latestFubonCreditCardHumanAttestationEvent(db)?.manifestStatus === "revoked")
      recordFubonCreditCardHumanAttestationEvent(db, {
        attestationId: currentV2Manifest.attestationId,
        evidenceVersion: currentV2Manifest.evidenceVersion,
        eventKind: "restored",
        manifestStatus: "active",
        eventAt: at,
        reason: reason.trim(),
        manifestFingerprint: manifestFingerprint(),
        sequence: nextSequence(db),
      });
    return currentV2Manifest;
  }
  setCurrentManifestStatus("active", null, null);
  if (db)
    recordFubonCreditCardHumanAttestationEvent(db, {
      attestationId: currentV2Manifest.attestationId,
      evidenceVersion: currentV2Manifest.evidenceVersion,
      eventKind: "restored",
      manifestStatus: "active",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(),
      sequence: nextSequence(db),
    });
  return currentV2Manifest;
}

export function restoreFubonCreditCardHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): FubonCreditCardHumanAttestedV1Manifest {
  restoreFubonCreditCardHumanAttestedV2(at, reason, db);
  return currentV1Manifest;
}

export function isFubonCreditCardHumanAttestationDurablyActive(
  db: DatabaseSync,
): boolean {
  if (!isFubonCreditCardHumanAttestedV2Active()) return false;
  const latest = latestFubonCreditCardHumanAttestationEvent(db);
  return latest?.manifestStatus === "active";
}

export const getFubonCreditCardHumanAttestationManifest =
  getFubonCreditCardHumanAttestedV2Manifest;
export const isFubonCreditCardHumanAttestationActive =
  isFubonCreditCardHumanAttestedV2Active;
export const revokeFubonCreditCardHumanAttestationV1 =
  revokeFubonCreditCardHumanAttestedV1;
export const restoreFubonCreditCardHumanAttestationV1 =
  restoreFubonCreditCardHumanAttestedV1;
export const revokeFubonCreditCardHumanAttestationV2 =
  revokeFubonCreditCardHumanAttestedV2;
export const restoreFubonCreditCardHumanAttestationV2 =
  restoreFubonCreditCardHumanAttestedV2;
// Version-explicit wrappers make the migration boundary obvious to new
// admission/read callers while preserving the original public names.
export function latestFubonCreditCardHumanAttestationEventV2(
  db: DatabaseSync,
  attestationId = FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestationId,
): FubonCreditCardHumanAttestationEvent | null {
  return readEvents(db, attestationId).at(-1) ?? null;
}

export function recordInitialFubonCreditCardHumanAttestationV2IfMissing(
  db: DatabaseSync,
  observedAt?: string,
): void {
  recordInitialFubonCreditCardHumanAttestationIfMissing(db, observedAt);
}

export function isFubonCreditCardHumanAttestationV2DurablyActive(
  db: DatabaseSync,
): boolean {
  return isFubonCreditCardHumanAttestationDurablyActive(db);
}

export function recordFubonCreditCardHumanAttestationEventV2(
  db: DatabaseSync,
  event: FubonCreditCardHumanAttestationEvent,
): void {
  recordFubonCreditCardHumanAttestationEvent(db, event);
}
