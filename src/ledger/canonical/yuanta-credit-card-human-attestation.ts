import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isValidatedCanonicalDatabase,
  runCanonicalSchemaRepair,
} from "./canonical-schema-lifecycle.ts";
import {
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  assertYuantaCreditCardHumanAttestedV1Manifest,
  assertYuantaCreditCardHumanAttestedV2Manifest,
  getYuantaCreditCardHumanAttestedV1Manifest,
  getYuantaCreditCardHumanAttestedV2Manifest,
  isYuantaCreditCardHumanAttestedAccountKey,
  isYuantaCreditCardHumanAttestedV1Active,
  isYuantaCreditCardHumanAttestedV1Manifest,
  isYuantaCreditCardHumanAttestedV2Active,
  isYuantaCreditCardHumanAttestedV2Manifest,
  setYuantaCreditCardHumanAttestedV1Status,
  setYuantaCreditCardHumanAttestedV2Status,
  yuantaCreditCardHumanAttestedV1ManifestFingerprint,
  yuantaCreditCardHumanAttestedV2ManifestFingerprint,
  type YuantaCreditCardHumanAttestedV1Manifest,
  type YuantaCreditCardHumanAttestedV2Manifest,
  type YuantaCreditCardHumanAttestationEvent,
} from "./yuanta-credit-card-human-attestation-contract.ts";

export * from "./yuanta-credit-card-human-attestation-contract.ts";

function tableExists(db: DatabaseSync): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 AS value FROM sqlite_master
         WHERE type = 'table' AND name = 'yuanta_credit_card_attestation_events'`,
      )
      .get(),
  );
}

export function ensureYuantaCreditCardHumanAttestationEvents(
  db: DatabaseSync,
): void {
  if (isValidatedCanonicalDatabase(db)) {
    runCanonicalSchemaRepair(db, "canonical/attestation/yuanta-credit-card-events/v1");
    return;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS yuanta_credit_card_attestation_events (
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
    CREATE INDEX IF NOT EXISTS idx_yuanta_credit_card_attestation_latest
      ON yuanta_credit_card_attestation_events(attestation_id, event_sequence);
  `);
}

type StoredEvent = {
  attestation_id?: string;
  evidence_version?: string;
  event_kind?: YuantaCreditCardHumanAttestationEvent["eventKind"];
  manifest_status?: YuantaCreditCardHumanAttestationEvent["manifestStatus"];
  event_at?: string;
  reason?: string | null;
  manifest_fingerprint?: `sha256:${string}`;
  event_sequence?: number;
};

function readEvents(db: DatabaseSync): YuantaCreditCardHumanAttestationEvent[] {
  ensureYuantaCreditCardHumanAttestationEvents(db);
  const rows = db
    .prepare(
      `SELECT attestation_id, evidence_version, event_kind, manifest_status,
              event_at, reason, manifest_fingerprint, event_sequence
       FROM yuanta_credit_card_attestation_events
       WHERE attestation_id = ? ORDER BY event_sequence ASC`,
    )
    .all(YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.attestationId) as StoredEvent[];
  if (rows.length === 0) return [];
  assertYuantaCreditCardHumanAttestedV1Manifest(getYuantaCreditCardHumanAttestedV1Manifest());
  const events: YuantaCreditCardHumanAttestationEvent[] = [];
  for (const [index, row] of rows.entries()) {
    const event: YuantaCreditCardHumanAttestationEvent = {
      attestationId: row.attestation_id ?? "",
      evidenceVersion: row.evidence_version ?? "",
      eventKind: row.event_kind ?? "attested",
      manifestStatus: row.manifest_status ?? "active",
      eventAt: row.event_at ?? "",
      reason: row.reason ?? null,
      manifestFingerprint: row.manifest_fingerprint ?? "sha256:",
      sequence: Number(row.event_sequence),
    };
    const previous = events.at(-1);
    if (
      event.attestationId !== getYuantaCreditCardHumanAttestedV1Manifest().attestationId ||
      event.evidenceVersion !== getYuantaCreditCardHumanAttestedV1Manifest().evidenceVersion ||
      event.manifestFingerprint !== yuantaCreditCardHumanAttestedV1ManifestFingerprint() ||
      event.sequence !== index + 1 ||
      !/^\d{4}-\d{2}-\d{2}T/.test(event.eventAt) ||
      (index === 0 && event.eventKind !== "attested") ||
      (previous && event.eventKind === previous.eventKind) ||
      (event.eventKind === "attested" && event.manifestStatus !== "active") ||
      (event.eventKind === "revoked" && event.manifestStatus !== "revoked") ||
      (event.eventKind === "restored" && event.manifestStatus !== "active") ||
      (event.eventKind !== "attested" && !event.reason?.trim())
    )
      throw new Error("Yuanta credit-card attestation event chain is invalid.");
    events.push(event);
  }
  return events;
}

function nextSequence(db: DatabaseSync): number {
  return readEvents(db).length + 1;
}

export function recordYuantaCreditCardHumanAttestationEvent(
  db: DatabaseSync,
  event: YuantaCreditCardHumanAttestationEvent,
): void {
  ensureYuantaCreditCardHumanAttestationEvents(db);
  assertYuantaCreditCardHumanAttestedV1Manifest(getYuantaCreditCardHumanAttestedV1Manifest());
  const previous = readEvents(db);
  if (
    event.attestationId !== getYuantaCreditCardHumanAttestedV1Manifest().attestationId ||
    event.evidenceVersion !== getYuantaCreditCardHumanAttestedV1Manifest().evidenceVersion ||
    event.manifestFingerprint !== yuantaCreditCardHumanAttestedV1ManifestFingerprint() ||
    event.sequence !== previous.length + 1 ||
    !/^\d{4}-\d{2}-\d{2}T/.test(event.eventAt) ||
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
      "Yuanta credit-card attestation event does not match its append-only contract.",
    );
  db.prepare(
    `INSERT INTO yuanta_credit_card_attestation_events(
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

export function latestYuantaCreditCardHumanAttestationEvent(
  db: DatabaseSync,
): YuantaCreditCardHumanAttestationEvent | null {
  return readEvents(db).at(-1) ?? null;
}

export function peekYuantaCreditCardHumanAttestationStatus(
  db: DatabaseSync,
): "active" | "revoked" | null {
  if (!tableExists(db)) return null;
  return latestYuantaCreditCardHumanAttestationEvent(db)?.manifestStatus ?? null;
}

export function recordInitialYuantaCreditCardHumanAttestationIfMissing(
  db: DatabaseSync,
  observedAt = YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.attestedAt,
): void {
  if (!isYuantaCreditCardHumanAttestedV1Active())
    throw new Error(
      "Cannot attest a revoked Yuanta credit-card manifest.",
    );
  if (latestYuantaCreditCardHumanAttestationEvent(db)) return;
  recordYuantaCreditCardHumanAttestationEvent(db, {
    attestationId: getYuantaCreditCardHumanAttestedV1Manifest().attestationId,
    evidenceVersion: getYuantaCreditCardHumanAttestedV1Manifest().evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: "user-confirmed-yuanta-credit-card-portfolio",
    manifestFingerprint: yuantaCreditCardHumanAttestedV1ManifestFingerprint(),
    sequence: 1,
  });
}

export function revokeYuantaCreditCardHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): YuantaCreditCardHumanAttestedV1Manifest {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || !reason.trim())
    throw new Error(
      "Yuanta credit-card attestation revocation requires time and reason.",
    );
  const current = getYuantaCreditCardHumanAttestedV1Manifest();
  if (current.status === "revoked") return current;
  const next = setYuantaCreditCardHumanAttestedV1Status(
    "revoked",
    at,
    reason.trim(),
  );
  if (db)
    recordYuantaCreditCardHumanAttestationEvent(db, {
      attestationId: next.attestationId,
      evidenceVersion: next.evidenceVersion,
      eventKind: "revoked",
      manifestStatus: "revoked",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: yuantaCreditCardHumanAttestedV1ManifestFingerprint(),
      sequence: nextSequence(db),
    });
  return next;
}

export function restoreYuantaCreditCardHumanAttestedV1(
  at: string,
  reason = "user-confirmed-restoration",
  db?: DatabaseSync,
): YuantaCreditCardHumanAttestedV1Manifest {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || !reason.trim())
    throw new Error(
      "Yuanta credit-card attestation restoration requires time and reason.",
    );
  const current = getYuantaCreditCardHumanAttestedV1Manifest();
  if (current.status === "active") return current;
  const next = setYuantaCreditCardHumanAttestedV1Status(
    "active",
    null,
    null,
  );
  if (db)
    recordYuantaCreditCardHumanAttestationEvent(db, {
      attestationId: next.attestationId,
      evidenceVersion: next.evidenceVersion,
      eventKind: "restored",
      manifestStatus: "active",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: yuantaCreditCardHumanAttestedV1ManifestFingerprint(),
      sequence: nextSequence(db),
    });
  return next;
}

export function isYuantaCreditCardHumanAttestationDurablyActive(
  db: DatabaseSync,
): boolean {
  if (!isYuantaCreditCardHumanAttestedV1Active()) return false;
  try {
    return latestYuantaCreditCardHumanAttestationEvent(db)?.manifestStatus ===
      "active";
  } catch {
    return false;
  }
}

function readV2Events(db: DatabaseSync): YuantaCreditCardHumanAttestationEvent[] {
  ensureYuantaCreditCardHumanAttestationEvents(db);
  const rows = db
    .prepare(
      `SELECT attestation_id, evidence_version, event_kind, manifest_status,
              event_at, reason, manifest_fingerprint, event_sequence
       FROM yuanta_credit_card_attestation_events
       WHERE attestation_id = ? ORDER BY event_sequence ASC`,
    )
    .all(YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestationId) as StoredEvent[];
  const events: YuantaCreditCardHumanAttestationEvent[] = [];
  for (const [index, row] of rows.entries()) {
    const event: YuantaCreditCardHumanAttestationEvent = {
      attestationId: row.attestation_id ?? "",
      evidenceVersion: row.evidence_version ?? "",
      eventKind: row.event_kind ?? "attested",
      manifestStatus: row.manifest_status ?? "active",
      eventAt: row.event_at ?? "",
      reason: row.reason ?? null,
      manifestFingerprint: row.manifest_fingerprint ?? "sha256:",
      sequence: Number(row.event_sequence),
    };
    const previous = events.at(-1);
    if (
      event.attestationId !== getYuantaCreditCardHumanAttestedV2Manifest().attestationId ||
      event.evidenceVersion !== getYuantaCreditCardHumanAttestedV2Manifest().evidenceVersion ||
      event.manifestFingerprint !== yuantaCreditCardHumanAttestedV2ManifestFingerprint() ||
      event.sequence !== index + 1 ||
      !/^\d{4}-\d{2}-\d{2}T/.test(event.eventAt) ||
      (index === 0 && event.eventKind !== "attested") ||
      (previous && event.eventKind === previous.eventKind) ||
      (event.eventKind === "attested" && event.manifestStatus !== "active") ||
      (event.eventKind === "revoked" && event.manifestStatus !== "revoked") ||
      (event.eventKind === "restored" && event.manifestStatus !== "active") ||
      (event.eventKind !== "attested" && !event.reason?.trim())
    )
      throw new Error("Yuanta credit-card v2 attestation event chain is invalid.");
    events.push(event);
  }
  if (rows.length > 0) assertYuantaCreditCardHumanAttestedV2Manifest(getYuantaCreditCardHumanAttestedV2Manifest());
  return events;
}

function nextV2Sequence(db: DatabaseSync): number {
  return readV2Events(db).length + 1;
}

export function recordYuantaCreditCardHumanAttestationV2Event(
  db: DatabaseSync,
  event: YuantaCreditCardHumanAttestationEvent,
): void {
  ensureYuantaCreditCardHumanAttestationEvents(db);
  assertYuantaCreditCardHumanAttestedV2Manifest(getYuantaCreditCardHumanAttestedV2Manifest());
  const previous = readV2Events(db);
  if (
    event.attestationId !== getYuantaCreditCardHumanAttestedV2Manifest().attestationId ||
    event.evidenceVersion !== getYuantaCreditCardHumanAttestedV2Manifest().evidenceVersion ||
    event.manifestFingerprint !== yuantaCreditCardHumanAttestedV2ManifestFingerprint() ||
    event.sequence !== previous.length + 1 ||
    !/^\d{4}-\d{2}-\d{2}T/.test(event.eventAt) ||
    (event.eventKind === "attested" &&
      (event.manifestStatus !== "active" || previous.length !== 0)) ||
    (event.eventKind === "revoked" &&
      (event.manifestStatus !== "revoked" || previous.at(-1)?.eventKind !== "attested")) ||
    (event.eventKind === "restored" &&
      (event.manifestStatus !== "active" || previous.at(-1)?.eventKind !== "revoked")) ||
    (event.eventKind !== "attested" && !event.reason?.trim())
  )
    throw new Error(
      "Yuanta credit-card v2 attestation event does not match its append-only contract.",
    );
  db.prepare(
    `INSERT INTO yuanta_credit_card_attestation_events(
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

export function latestYuantaCreditCardHumanAttestationV2Event(
  db: DatabaseSync,
): YuantaCreditCardHumanAttestationEvent | null {
  return readV2Events(db).at(-1) ?? null;
}

export function peekYuantaCreditCardHumanAttestationV2Status(
  db: DatabaseSync,
): "active" | "revoked" | null {
  if (!tableExists(db)) return null;
  return latestYuantaCreditCardHumanAttestationV2Event(db)?.manifestStatus ?? null;
}

export function recordInitialYuantaCreditCardHumanAttestationV2IfMissing(
  db: DatabaseSync,
  observedAt = YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestedAt,
): void {
  if (!isYuantaCreditCardHumanAttestedV2Active())
    throw new Error("Cannot attest a revoked Yuanta credit-card v2 manifest.");
  if (latestYuantaCreditCardHumanAttestationV2Event(db)) return;
  recordYuantaCreditCardHumanAttestationV2Event(db, {
    attestationId: getYuantaCreditCardHumanAttestedV2Manifest().attestationId,
    evidenceVersion: getYuantaCreditCardHumanAttestedV2Manifest().evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: "user-confirmed-yuanta-credit-card-portfolio-v2",
    manifestFingerprint: yuantaCreditCardHumanAttestedV2ManifestFingerprint(),
    sequence: 1,
  });
}

export function revokeYuantaCreditCardHumanAttestedV2(
  at: string,
  reason: string,
  db?: DatabaseSync,
): YuantaCreditCardHumanAttestedV2Manifest {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || !reason.trim())
    throw new Error(
      "Yuanta credit-card v2 attestation revocation requires time and reason.",
    );
  const current = getYuantaCreditCardHumanAttestedV2Manifest();
  if (current.status === "revoked") return current;
  const next = setYuantaCreditCardHumanAttestedV2Status(
    "revoked",
    at,
    reason.trim(),
  );
  if (db)
    recordYuantaCreditCardHumanAttestationV2Event(db, {
      attestationId: next.attestationId,
      evidenceVersion: next.evidenceVersion,
      eventKind: "revoked",
      manifestStatus: "revoked",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: yuantaCreditCardHumanAttestedV2ManifestFingerprint(),
      sequence: nextV2Sequence(db),
    });
  return next;
}

export function restoreYuantaCreditCardHumanAttestedV2(
  at: string,
  reason = "user-confirmed-restoration",
  db?: DatabaseSync,
): YuantaCreditCardHumanAttestedV2Manifest {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || !reason.trim())
    throw new Error(
      "Yuanta credit-card v2 attestation restoration requires time and reason.",
    );
  const current = getYuantaCreditCardHumanAttestedV2Manifest();
  if (current.status === "active") return current;
  const next = setYuantaCreditCardHumanAttestedV2Status(
    "active",
    null,
    null,
  );
  if (db)
    recordYuantaCreditCardHumanAttestationV2Event(db, {
      attestationId: next.attestationId,
      evidenceVersion: next.evidenceVersion,
      eventKind: "restored",
      manifestStatus: "active",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: yuantaCreditCardHumanAttestedV2ManifestFingerprint(),
      sequence: nextV2Sequence(db),
    });
  return next;
}

export function isYuantaCreditCardHumanAttestationV2DurablyActive(
  db: DatabaseSync,
): boolean {
  if (!isYuantaCreditCardHumanAttestedV2Active()) return false;
  try {
    return latestYuantaCreditCardHumanAttestationV2Event(db)?.manifestStatus ===
      "active";
  } catch {
    return false;
  }
}

export const getYuantaCreditCardHumanAttestationManifest =
  getYuantaCreditCardHumanAttestedV1Manifest;
export const isYuantaCreditCardHumanAttestationActive =
  isYuantaCreditCardHumanAttestedV1Active;
export const revokeYuantaCreditCardHumanAttestationV1 =
  revokeYuantaCreditCardHumanAttestedV1;
export const restoreYuantaCreditCardHumanAttestationV1 =
  restoreYuantaCreditCardHumanAttestedV1;
