import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isValidatedCanonicalDatabase,
  runCanonicalSchemaRepair,
} from "./canonical-schema-lifecycle.ts";
import {
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  assertEsunManifestForStorage as assertCurrentManifest,
  currentEsunManifestForStorage as currentManifest,
  fingerprintEsunManifestForStorage as manifestFingerprint,
  getEsunCreditCardHumanAttestedV2Manifest,
  isEsunCreditCardHumanAttestedV2Active,
  revokeEsunCreditCardHumanAttestedV2InMemory,
  restoreEsunCreditCardHumanAttestedV2InMemory,
  type EsunCreditCardHumanAttestationEvent,
  type EsunCreditCardHumanAttestedV2Manifest,
} from "./esun-credit-card-human-attestation-contract.ts";

export * from "./esun-credit-card-human-attestation-contract.ts";

function tableColumns(db: DatabaseSync): Set<string> {
  return new Set(
    (
      db
        .prepare("PRAGMA table_info(esun_credit_card_attestation_events)")
        .all() as Array<{ name?: string }>
    ).flatMap((row) => (row.name ? [row.name] : [])),
  );
}

export function ensureEsunCreditCardHumanAttestationEvents(
  db: DatabaseSync,
): void {
  if (isValidatedCanonicalDatabase(db)) {
    runCanonicalSchemaRepair(db, "canonical/attestation/esun-credit-card-events/v1");
    return;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS esun_credit_card_attestation_events (
      event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
      attestation_id TEXT NOT NULL,
      evidence_version TEXT,
      event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked','restored')),
      manifest_status TEXT,
      event_at TEXT NOT NULL,
      reason TEXT,
      manifest_fingerprint TEXT NOT NULL,
      event_sequence INTEGER,
      UNIQUE(attestation_id, event_sequence)
    );
  `);
  const columns = tableColumns(db);
  if (!columns.has("evidence_version"))
    db.exec(
      "ALTER TABLE esun_credit_card_attestation_events ADD COLUMN evidence_version TEXT",
    );
  if (!columns.has("manifest_status"))
    db.exec(
      "ALTER TABLE esun_credit_card_attestation_events ADD COLUMN manifest_status TEXT",
    );
  if (!columns.has("event_sequence"))
    db.exec(
      "ALTER TABLE esun_credit_card_attestation_events ADD COLUMN event_sequence INTEGER",
    );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_esun_credit_card_attestation_latest
      ON esun_credit_card_attestation_events(attestation_id, event_sequence, event_at, event_id);
  `);
}

type StoredEvent = {
  attestation_id?: string;
  evidence_version?: string | null;
  event_kind?: "attested" | "revoked" | "restored";
  manifest_status?: "active" | "revoked" | null;
  event_at?: string;
  reason?: string | null;
  manifest_fingerprint?: `sha256:${string}`;
  event_sequence?: number | null;
};

function validEventAt(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function readEventChain(
  db: DatabaseSync,
  attestationId = currentManifest.attestationId,
): EsunCreditCardHumanAttestationEvent[] {
  ensureEsunCreditCardHumanAttestationEvents(db);
  const rows = db
    .prepare(
      `SELECT attestation_id, evidence_version, event_kind, manifest_status,
              event_at, reason, manifest_fingerprint, event_sequence
       FROM esun_credit_card_attestation_events
       WHERE attestation_id = ?
       ORDER BY event_sequence ASC, event_at ASC, rowid ASC`,
    )
    .all(attestationId) as StoredEvent[];
  if (rows.length === 0) return [];
  assertCurrentManifest(currentManifest);
  const expected = manifestFingerprint();
  const chain: EsunCreditCardHumanAttestationEvent[] = [];
  for (const [index, row] of rows.entries()) {
    const event: EsunCreditCardHumanAttestationEvent = {
      attestationId: row.attestation_id ?? "",
      evidenceVersion: row.evidence_version ?? "",
      eventKind: row.event_kind as EsunCreditCardHumanAttestationEvent["eventKind"],
      manifestStatus:
        row.manifest_status as EsunCreditCardHumanAttestationEvent["manifestStatus"],
      eventAt: row.event_at ?? "",
      reason: row.reason ?? null,
      manifestFingerprint: row.manifest_fingerprint ?? ("" as `sha256:${string}`),
      sequence: Number(row.event_sequence),
    };
    const previous = chain.at(-1);
    if (
      event.attestationId !== currentManifest.attestationId ||
      event.evidenceVersion !== currentManifest.evidenceVersion ||
      event.manifestFingerprint !== expected ||
      event.sequence !== index + 1 ||
      !validEventAt(event.eventAt) ||
      (index === 0 && event.eventKind !== "attested") ||
      (event.eventKind === "attested" && event.manifestStatus !== "active") ||
      (event.eventKind === "revoked" && event.manifestStatus !== "revoked") ||
      (event.eventKind === "restored" && event.manifestStatus !== "active") ||
      (event.eventKind !== "attested" && !event.reason?.trim()) ||
      (previous && event.eventAt < previous.eventAt) ||
      (previous && event.eventKind === previous.eventKind)
    )
      throw new Error("E.SUN credit-card attestation event chain is invalid.");
    chain.push(event);
  }
  return chain;
}

export function latestEsunCreditCardHumanAttestationEvent(
  db: DatabaseSync,
): EsunCreditCardHumanAttestationEvent | null {
  return readEventChain(db).at(-1) ?? null;
}

export function recordEsunCreditCardHumanAttestationEvent(
  db: DatabaseSync,
  event: EsunCreditCardHumanAttestationEvent,
): void {
  ensureEsunCreditCardHumanAttestationEvents(db);
  assertCurrentManifest(currentManifest);
  const previous = readEventChain(db);
  if (
    event.attestationId !== currentManifest.attestationId ||
    event.evidenceVersion !== currentManifest.evidenceVersion ||
    event.manifestFingerprint !== manifestFingerprint() ||
    event.sequence !== previous.length + 1 ||
    !validEventAt(event.eventAt) ||
    (event.eventKind === "attested" &&
      (event.manifestStatus !== "active" || previous.length !== 0)) ||
    (event.eventKind === "revoked" &&
      (event.manifestStatus !== "revoked" ||
        previous.at(-1)?.eventKind !== "attested" &&
          previous.at(-1)?.eventKind !== "restored")) ||
    (event.eventKind === "restored" &&
      (event.manifestStatus !== "active" ||
        previous.at(-1)?.eventKind !== "revoked")) ||
    (event.eventKind !== "attested" && !event.reason?.trim()) ||
    (previous.at(-1) && event.eventAt < previous.at(-1)!.eventAt)
  )
    throw new Error(
      "E.SUN credit-card attestation event does not match the append-only contract.",
    );
  db.prepare(
    `INSERT INTO esun_credit_card_attestation_events(
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

export function recordInitialEsunCreditCardHumanAttestationIfMissing(
  db: DatabaseSync,
  observedAt = ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestedAt,
): void {
  if (!isEsunCreditCardHumanAttestedV2Active())
    throw new Error("Cannot attest a revoked E.SUN credit-card manifest.");
  if (latestEsunCreditCardHumanAttestationEvent(db)) return;
  recordEsunCreditCardHumanAttestationEvent(db, {
    attestationId: currentManifest.attestationId,
    evidenceVersion: currentManifest.evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: "user-confirmed-esun-credit-card-primary-cardholder-portfolio",
    manifestFingerprint: manifestFingerprint(),
    sequence: 1,
  });
}


export function revokeEsunCreditCardHumanAttestedV2(
  at: string,
  reason: string,
  db?: DatabaseSync,
): EsunCreditCardHumanAttestedV2Manifest {
  const before = currentManifest;
  const next = revokeEsunCreditCardHumanAttestedV2InMemory(at, reason);
  if (db && next !== before)
    recordEsunCreditCardHumanAttestationEvent(db, {
      attestationId: next.attestationId,
      evidenceVersion: next.evidenceVersion,
      eventKind: "revoked",
      manifestStatus: "revoked",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(),
      sequence: readEventChain(db).length + 1,
    });
  return next;
}

export function restoreEsunCreditCardHumanAttestedV2(
  at: string,
  reason: string,
  db?: DatabaseSync,
): EsunCreditCardHumanAttestedV2Manifest {
  const before = currentManifest;
  const next = restoreEsunCreditCardHumanAttestedV2InMemory(at, reason);
  if (db && next !== before)
    recordEsunCreditCardHumanAttestationEvent(db, {
      attestationId: next.attestationId,
      evidenceVersion: next.evidenceVersion,
      eventKind: "restored",
      manifestStatus: "active",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(),
      sequence: readEventChain(db).length + 1,
    });
  return next;
}

export function isEsunCreditCardHumanAttestationDurablyActive(
  db: DatabaseSync,
): boolean {
  if (!isEsunCreditCardHumanAttestedV2Active()) return false;
  try {
    return latestEsunCreditCardHumanAttestationEvent(db)?.manifestStatus === "active";
  } catch {
    return false;
  }
}

export const getEsunCreditCardHumanAttestationManifest =
  getEsunCreditCardHumanAttestedV2Manifest;
export const isEsunCreditCardHumanAttestationActive =
  isEsunCreditCardHumanAttestedV2Active;
export const revokeEsunCreditCardHumanAttestationV2 =
  revokeEsunCreditCardHumanAttestedV2;
export const restoreEsunCreditCardHumanAttestationV2 =
  restoreEsunCreditCardHumanAttestedV2;
