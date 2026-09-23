import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  assertCtbcHumanAttestationManifest,
  ctbcHumanAttestationFingerprint,
  freezeCtbcHumanAttestationManifest,
  getCtbcHumanAttestedV1Manifest,
  isCtbcHumanAttestationDateTime,
  isCtbcHumanAttestedV1Active,
  replaceCtbcHumanAttestedV1Manifest,
  CTBC_HUMAN_ATTESTED_V1_MANIFEST,
  type CtbcHumanAttestationEvent,
  type CtbcHumanAttestedV1Manifest,
  type CtbcOpaqueToken,
} from "./ctbc-human-attestation-contract.ts";
import {
  isValidatedCanonicalDatabase,
  runCanonicalSchemaRepair,
} from "./canonical-schema-lifecycle.ts";
export {
  CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  CTBC_HUMAN_ATTESTED_V1_CONFIRMED,
  CTBC_HUMAN_ATTESTED_V1_MANIFEST,
  ctbcHumanAttestedIdentityEpochKey,
  getCtbcHumanAttestedV1Manifest,
  isCtbcHumanAttestedV1Manifest,
  isCtbcHumanAttestedV1Active,
  type CtbcHumanAttestedV1Manifest,
  type CtbcHumanAttestationEvent,
  type CtbcOpaqueToken,
} from "./ctbc-human-attestation-contract.ts";

export function ensureCtbcHumanAttestationEvents(db: DatabaseSync): void {
  if (isValidatedCanonicalDatabase(db)) {
    runCanonicalSchemaRepair(db, "canonical/attestation/ctbc-events/v1");
    return;
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS ctbc_attestation_events (" +
      "event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16), " +
      "attestation_id TEXT NOT NULL, evidence_version TEXT NOT NULL, " +
      "event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked')), " +
      "manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')), " +
      "event_at TEXT NOT NULL, reason TEXT, manifest_fingerprint TEXT NOT NULL, " +
      "event_sequence INTEGER NOT NULL, UNIQUE(attestation_id, event_sequence))",
  );
}

function readChain(db: DatabaseSync): CtbcHumanAttestationEvent[] {
  ensureCtbcHumanAttestationEvents(db);
  assertCtbcHumanAttestationManifest();
  const rows = db
    .prepare(
      "SELECT attestation_id, evidence_version, event_kind, manifest_status, event_at, reason, manifest_fingerprint, event_sequence " +
        "FROM ctbc_attestation_events WHERE attestation_id = ? ORDER BY event_sequence ASC",
    )
    .all(getCtbcHumanAttestedV1Manifest().attestationId) as Array<Record<string, unknown>>;
  const chain: CtbcHumanAttestationEvent[] = [];
  for (const [index, row] of rows.entries()) {
    const event = {
      attestationId: String(row.attestation_id ?? ""),
      evidenceVersion: String(row.evidence_version ?? ""),
      eventKind: row.event_kind as "attested" | "revoked",
      manifestStatus: row.manifest_status as "active" | "revoked",
      eventAt: String(row.event_at ?? ""),
      reason: row.reason === null ? null : String(row.reason ?? ""),
      manifestFingerprint: String(
        row.manifest_fingerprint ?? "",
      ) as CtbcOpaqueToken,
      sequence: Number(row.event_sequence),
    };
    const previous = chain.at(-1);
    if (
      event.attestationId !== getCtbcHumanAttestedV1Manifest().attestationId ||
      event.evidenceVersion !== getCtbcHumanAttestedV1Manifest().evidenceVersion ||
      event.manifestFingerprint !== ctbcHumanAttestationFingerprint() ||
      event.sequence !== index + 1 ||
      !isCtbcHumanAttestationDateTime(event.eventAt) ||
      event.manifestStatus !==
        (event.eventKind === "attested" ? "active" : "revoked") ||
      (event.eventKind === "revoked" && !event.reason?.trim()) ||
      (index === 0 && event.eventKind !== "attested") ||
      (previous &&
        (event.eventAt < previous.eventAt ||
          event.eventKind === previous.eventKind))
    )
      throw new Error("CTBC attestation event chain is invalid.");
    chain.push(event);
  }
  return chain;
}

export function latestCtbcHumanAttestationEvent(
  db: DatabaseSync,
): CtbcHumanAttestationEvent | null {
  const latest = readChain(db).at(-1) ?? null;
  if (!latest && getCtbcHumanAttestedV1Manifest().status === "revoked")
    throw new Error(
      "CTBC revoked attestation has no durable revocation event.",
    );
  return latest;
}

function recordEvent(db: DatabaseSync, event: CtbcHumanAttestationEvent): void {
  const chain = readChain(db);
  const previous = chain.at(-1);
  if (
    event.attestationId !== getCtbcHumanAttestedV1Manifest().attestationId ||
    event.evidenceVersion !== getCtbcHumanAttestedV1Manifest().evidenceVersion ||
    event.manifestFingerprint !== ctbcHumanAttestationFingerprint() ||
    event.sequence !== chain.length + 1 ||
    !isCtbcHumanAttestationDateTime(event.eventAt) ||
    event.manifestStatus !==
      (event.eventKind === "attested" ? "active" : "revoked") ||
    (event.eventKind === "revoked" && !event.reason?.trim()) ||
    (previous &&
      (event.eventAt < previous.eventAt ||
        event.eventKind === previous.eventKind))
  )
    throw new Error(
      "CTBC attestation event does not match the immutable chain.",
    );
  db.prepare(
    "INSERT INTO ctbc_attestation_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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

export function recordInitialCtbcHumanAttestationIfMissing(
  db: DatabaseSync,
  observedAt = `${CTBC_HUMAN_ATTESTED_V1_MANIFEST.attestedAt}T00:00:00+08:00`,
): void {
  if (!isCtbcHumanAttestedV1Active())
    throw new Error("Cannot attest a revoked CTBC manifest.");
  if (latestCtbcHumanAttestationEvent(db)) return;
  recordEvent(db, {
    attestationId: getCtbcHumanAttestedV1Manifest().attestationId,
    evidenceVersion: getCtbcHumanAttestedV1Manifest().evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: getCtbcHumanAttestedV1Manifest().attestedBy,
    manifestFingerprint: ctbcHumanAttestationFingerprint(),
    sequence: 1,
  });
}

export function revokeCtbcHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): CtbcHumanAttestedV1Manifest {
  if (!isCtbcHumanAttestationDateTime(at) || !reason.trim())
    throw new Error("CTBC attestation revocation requires time and reason.");
  const latest = db ? latestCtbcHumanAttestationEvent(db) : null;
  if (latest?.eventKind === "revoked") return getCtbcHumanAttestedV1Manifest();
  const revoked = freezeCtbcHumanAttestationManifest({
    ...getCtbcHumanAttestedV1Manifest(),
    status: "revoked" as const,
    revokedAt: at,
    revocationReason: reason.trim(),
  });
  replaceCtbcHumanAttestedV1Manifest(revoked);
  if (db)
    recordEvent(db, {
      attestationId: revoked.attestationId,
      evidenceVersion: revoked.evidenceVersion,
      eventKind: "revoked",
      manifestStatus: "revoked",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: ctbcHumanAttestationFingerprint(revoked),
      sequence: (latest?.sequence ?? 0) + 1,
    });
  return revoked;
}

export function restoreCtbcHumanAttestedV1(
  at: string,
  reason = "user-confirmed-restoration",
  db?: DatabaseSync,
): CtbcHumanAttestedV1Manifest {
  if (!isCtbcHumanAttestationDateTime(at) || !reason.trim())
    throw new Error("CTBC attestation restoration requires time and reason.");
  const latest = db ? latestCtbcHumanAttestationEvent(db) : null;
  if (getCtbcHumanAttestedV1Manifest().status === "active" && latest?.eventKind !== "revoked")
    return getCtbcHumanAttestedV1Manifest();
  const restored = freezeCtbcHumanAttestationManifest({
    ...getCtbcHumanAttestedV1Manifest(),
    status: "active" as const,
    revokedAt: null,
    revocationReason: null,
  });
  replaceCtbcHumanAttestedV1Manifest(restored);
  if (db)
    recordEvent(db, {
      attestationId: restored.attestationId,
      evidenceVersion: restored.evidenceVersion,
      eventKind: "attested",
      manifestStatus: "active",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: ctbcHumanAttestationFingerprint(restored),
      sequence: (latest?.sequence ?? 0) + 1,
    });
  return restored;
}

export function isCtbcHumanAttestationDurablyActive(db: DatabaseSync): boolean {
  if (!isCtbcHumanAttestedV1Active()) return false;
  try {
    const latest = latestCtbcHumanAttestationEvent(db);
    return (
      latest?.eventKind === "attested" && latest.manifestStatus === "active"
    );
  } catch {
    return false;
  }
}
