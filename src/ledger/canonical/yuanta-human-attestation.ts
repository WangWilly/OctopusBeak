import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  assertCurrentManifest,
  assertCurrentV2Manifest,
  currentManifest,
  currentV2Manifest,
  manifestFingerprint,
  setYuantaHumanAttestedV1Status,
  setYuantaHumanAttestedV2Status,
  validEventAt,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_QUERY_COVERAGE_VERSION,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_ROUTE,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_VERSION,
  YUANTA_HUMAN_ATTESTED_V1_MANIFEST,
  YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  getYuantaHumanAttestedV1Manifest,
  getYuantaHumanAttestedV2Manifest,
  isYuantaHumanAttestedV1Active,
  isYuantaHumanAttestedV1Manifest,
  isYuantaHumanAttestedV2Active,
  isYuantaHumanAttestedV2Manifest,
  yuantaHumanAttestedIdentityEpochKey,
  yuantaHumanAttestedV2IdentityEpochKey,
  type YuantaHumanAttestedV1Manifest,
  type YuantaHumanAttestedV2Manifest,
  type YuantaHumanAttestedManifest,
  type YuantaHumanAttestationEvent,
  type YuantaOpaqueToken,
} from "./yuanta-human-attestation-contract.ts";
import {
  isValidatedCanonicalDatabase,
  runCanonicalSchemaRepair,
} from "./canonical-schema-lifecycle.ts";

export {
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_QUERY_COVERAGE_VERSION,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_ROUTE,
  YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_VERSION,
  YUANTA_HUMAN_ATTESTED_V1_MANIFEST,
  YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  getYuantaHumanAttestedV1Manifest,
  getYuantaHumanAttestedV2Manifest,
  isYuantaHumanAttestedV1Active,
  isYuantaHumanAttestedV1Manifest,
  isYuantaHumanAttestedV2Active,
  isYuantaHumanAttestedV2Manifest,
  yuantaHumanAttestedIdentityEpochKey,
  yuantaHumanAttestedV2IdentityEpochKey,
};
export type {
  YuantaHumanAttestedV1Manifest,
  YuantaHumanAttestedV2Manifest,
  YuantaHumanAttestedManifest,
  YuantaHumanAttestationEvent,
};

function tableColumns(db: DatabaseSync): Set<string> {
  return new Set(
    (
      db
        .prepare("PRAGMA table_info(yuanta_attestation_events)")
        .all() as Array<{ name?: string }>
    ).flatMap((row) => (row.name ? [row.name] : [])),
  );
}

/** Generic canonical DB namespace; this is not a financial table family. */
export function ensureYuantaHumanAttestationEvents(db: DatabaseSync): void {
  if (isValidatedCanonicalDatabase(db)) {
    runCanonicalSchemaRepair(db, "canonical/attestation/yuanta-events/v1");
    return;
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS yuanta_attestation_events (" +
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
      "ALTER TABLE yuanta_attestation_events ADD COLUMN evidence_version TEXT",
    );
  if (!columns.has("manifest_status"))
    db.exec(
      "ALTER TABLE yuanta_attestation_events ADD COLUMN manifest_status TEXT",
    );
  if (!columns.has("event_sequence"))
    db.exec(
      "ALTER TABLE yuanta_attestation_events ADD COLUMN event_sequence INTEGER",
    );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_yuanta_attestation_events_latest " +
      "ON yuanta_attestation_events(attestation_id, event_sequence, event_at, event_id)",
  );
}

type StoredEventRow = {
  attestation_id?: string;
  evidence_version?: string | null;
  event_kind?: "attested" | "revoked";
  manifest_status?: "active" | "revoked" | null;
  event_at?: string;
  reason?: string | null;
  manifest_fingerprint?: YuantaOpaqueToken;
  event_sequence?: number | null;
};

function readEventChain(
  db: DatabaseSync,
  attestationId: string = currentManifest.attestationId,
): YuantaHumanAttestationEvent[] {
  ensureYuantaHumanAttestationEvents(db);
  const rows = db
    .prepare(
      "SELECT attestation_id, evidence_version, event_kind, manifest_status, " +
        "event_at, reason, manifest_fingerprint, event_sequence " +
        "FROM yuanta_attestation_events WHERE attestation_id = ? " +
        "ORDER BY event_sequence ASC, event_at ASC, rowid ASC",
    )
    .all(attestationId) as StoredEventRow[];
  if (rows.length === 0) return [];
  assertCurrentManifest(currentManifest);
  const expectedFingerprint = manifestFingerprint(currentManifest);
  const chain: YuantaHumanAttestationEvent[] = [];
  for (const [index, row] of rows.entries()) {
    const event: YuantaHumanAttestationEvent = {
      attestationId: row.attestation_id ?? "",
      evidenceVersion: row.evidence_version ?? "",
      eventKind: row.event_kind as YuantaHumanAttestationEvent["eventKind"],
      manifestStatus:
        row.manifest_status as YuantaHumanAttestationEvent["manifestStatus"],
      eventAt: row.event_at ?? "",
      reason: row.reason ?? null,
      manifestFingerprint: row.manifest_fingerprint ?? "",
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
      throw new Error("Yuanta attestation event chain is invalid.");
    chain.push(event);
  }
  return chain;
}

function nextEventSequence(db: DatabaseSync, attestationId: string): number {
  return readEventChain(db, attestationId).length + 1;
}

export function recordYuantaHumanAttestationEvent(
  db: DatabaseSync,
  event: YuantaHumanAttestationEvent,
): void {
  ensureYuantaHumanAttestationEvents(db);
  assertCurrentManifest(currentManifest);
  const chain = readEventChain(db, event.attestationId);
  const expectedSequence = chain.length + 1;
  const previous = chain.at(-1);
  if (
    event.attestationId !== currentManifest.attestationId ||
    event.evidenceVersion !== currentManifest.evidenceVersion ||
    event.manifestFingerprint !== manifestFingerprint(currentManifest) ||
    event.sequence !== expectedSequence ||
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
    throw new Error(
      "Yuanta attestation event does not match the immutable chain.",
    );
  db.prepare(
    "INSERT INTO yuanta_attestation_events(" +
      "event_id, attestation_id, evidence_version, event_kind, manifest_status, " +
      "event_at, reason, manifest_fingerprint, event_sequence" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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

export function latestYuantaHumanAttestationEvent(
  db: DatabaseSync,
  attestationId = YUANTA_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
): YuantaHumanAttestationEvent | null {
  const chain = readEventChain(db, attestationId);
  const latest = chain.at(-1) ?? null;
  if (!latest && currentManifest.status === "revoked")
    throw new Error(
      "Yuanta revoked attestation has no durable revocation event.",
    );
  return latest;
}

export function recordInitialYuantaHumanAttestationIfMissing(
  db: DatabaseSync,
  observedAt = YUANTA_HUMAN_ATTESTED_V1_MANIFEST.attestedAt +
    "T00:00:00.000+08:00",
): void {
  if (!isYuantaHumanAttestedV1Active())
    throw new Error("Cannot attest a revoked Yuanta manifest.");
  const latest = latestYuantaHumanAttestationEvent(db);
  if (latest) return;
  recordYuantaHumanAttestationEvent(db, {
    attestationId: currentManifest.attestationId,
    evidenceVersion: currentManifest.evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: "user-confirmed-yuanta-observed-human-attested-2026-08-21",
    manifestFingerprint: manifestFingerprint(currentManifest),
    sequence: 1,
  });
}

export function revokeYuantaHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): YuantaHumanAttestedV1Manifest {
  if (!validEventAt(at) || !reason.trim())
    throw new Error("Yuanta attestation revocation requires time and reason.");
  const latest = db ? latestYuantaHumanAttestationEvent(db) : null;
  if (latest?.eventKind === "revoked") {
    if (currentManifest.status === "active") {
      setYuantaHumanAttestedV1Status(
        "revoked",
        latest.eventAt,
        latest.reason,
      );
    }
    return currentManifest;
  }
  if (currentManifest.status === "revoked") return currentManifest;
  const revoked = setYuantaHumanAttestedV1Status(
    "revoked",
    at,
    reason.trim(),
  );
  if (db)
    recordYuantaHumanAttestationEvent(db, {
      attestationId: revoked.attestationId,
      evidenceVersion: revoked.evidenceVersion,
      eventKind: "revoked",
      manifestStatus: "revoked",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(revoked),
      sequence: nextEventSequence(db, revoked.attestationId),
    });
  return revoked;
}

export function restoreYuantaHumanAttestedV1(
  at: string,
  reason = "user-confirmed-restoration",
  db?: DatabaseSync,
): YuantaHumanAttestedV1Manifest {
  if (!validEventAt(at) || !reason.trim())
    throw new Error("Yuanta attestation restoration requires time and reason.");
  const latest = db ? latestYuantaHumanAttestationEvent(db) : null;
  if (currentManifest.status === "active" && latest?.eventKind !== "revoked")
    return currentManifest;
  const restored = setYuantaHumanAttestedV1Status("active", null, null);
  if (db)
    recordYuantaHumanAttestationEvent(db, {
      attestationId: restored.attestationId,
      evidenceVersion: restored.evidenceVersion,
      eventKind: "attested",
      manifestStatus: "active",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(restored),
      sequence: nextEventSequence(db, restored.attestationId),
    });
  return restored;
}

export function isYuantaHumanAttestationDurablyActive(
  db: DatabaseSync,
): boolean {
  if (!isYuantaHumanAttestedV1Active()) return false;
  try {
    const latest = latestYuantaHumanAttestationEvent(db);
    return (
      latest?.eventKind === "attested" && latest.manifestStatus === "active"
    );
  } catch {
    // A malformed, mismatched, or missing durable chain must fail closed.
    return false;
  }
}

function readV2EventChain(
  db: DatabaseSync,
  attestationId: string = currentV2Manifest.attestationId,
): YuantaHumanAttestationEvent[] {
  ensureYuantaHumanAttestationEvents(db);
  const rows = db
    .prepare(
      "SELECT attestation_id, evidence_version, event_kind, manifest_status, " +
        "event_at, reason, manifest_fingerprint, event_sequence " +
        "FROM yuanta_attestation_events WHERE attestation_id = ? " +
        "ORDER BY event_sequence ASC, event_at ASC, rowid ASC",
    )
    .all(attestationId) as StoredEventRow[];
  if (rows.length === 0) return [];
  assertCurrentV2Manifest(currentV2Manifest);
  const expectedFingerprint = manifestFingerprint(currentV2Manifest);
  const chain: YuantaHumanAttestationEvent[] = [];
  for (const [index, row] of rows.entries()) {
    const event: YuantaHumanAttestationEvent = {
      attestationId: row.attestation_id ?? "",
      evidenceVersion: row.evidence_version ?? "",
      eventKind: row.event_kind as YuantaHumanAttestationEvent["eventKind"],
      manifestStatus:
        row.manifest_status as YuantaHumanAttestationEvent["manifestStatus"],
      eventAt: row.event_at ?? "",
      reason: row.reason ?? null,
      manifestFingerprint: row.manifest_fingerprint ?? "",
      sequence: Number(row.event_sequence),
    };
    const previous = chain.at(-1);
    if (
      event.attestationId !== currentV2Manifest.attestationId ||
      event.evidenceVersion !== currentV2Manifest.evidenceVersion ||
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
      throw new Error("Yuanta v2 attestation event chain is invalid.");
    chain.push(event);
  }
  return chain;
}

function recordV2Event(
  db: DatabaseSync,
  event: YuantaHumanAttestationEvent,
): void {
  ensureYuantaHumanAttestationEvents(db);
  assertCurrentV2Manifest(currentV2Manifest);
  const chain = readV2EventChain(db, event.attestationId);
  const expectedSequence = chain.length + 1;
  const previous = chain.at(-1);
  if (
    event.attestationId !== currentV2Manifest.attestationId ||
    event.evidenceVersion !== currentV2Manifest.evidenceVersion ||
    event.manifestFingerprint !== manifestFingerprint(currentV2Manifest) ||
    event.sequence !== expectedSequence ||
    !validEventAt(event.eventAt) ||
    (event.eventKind === "revoked" && !event.reason?.trim()) ||
    (previous && event.eventAt < previous.eventAt) ||
    (event.eventKind === "attested" &&
      (event.manifestStatus !== "active" ||
        currentV2Manifest.status !== "active")) ||
    (event.eventKind === "revoked" &&
      (event.manifestStatus !== "revoked" ||
        currentV2Manifest.status !== "revoked")) ||
    (previous && event.eventKind === previous.eventKind)
  )
    throw new Error(
      "Yuanta v2 attestation event does not match the immutable chain.",
    );
  db.prepare(
    "INSERT INTO yuanta_attestation_events(" +
      "event_id, attestation_id, evidence_version, event_kind, manifest_status, " +
      "event_at, reason, manifest_fingerprint, event_sequence" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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

export function latestYuantaHumanAttestationEventV2(
  db: DatabaseSync,
  attestationId = YUANTA_HUMAN_ATTESTED_V2_MANIFEST.attestationId,
): YuantaHumanAttestationEvent | null {
  const chain = readV2EventChain(db, attestationId);
  const latest = chain.at(-1) ?? null;
  if (!latest && currentV2Manifest.status === "revoked")
    throw new Error(
      "Yuanta v2 revoked attestation has no durable revocation event.",
    );
  return latest;
}

export function recordInitialYuantaHumanAttestationV2IfMissing(
  db: DatabaseSync,
  observedAt = YUANTA_HUMAN_ATTESTED_V2_MANIFEST.attestedAt +
    "T00:00:00.000+08:00",
): void {
  if (!isYuantaHumanAttestedV2Active())
    throw new Error("Cannot attest a revoked Yuanta v2 manifest.");
  const latest = latestYuantaHumanAttestationEventV2(db);
  if (latest) return;
  recordV2Event(db, {
    attestationId: currentV2Manifest.attestationId,
    evidenceVersion: currentV2Manifest.evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: "user-confirmed-yuanta-observed-human-attested-2026-08-21",
    manifestFingerprint: manifestFingerprint(currentV2Manifest),
    sequence: 1,
  });
}

export function revokeYuantaHumanAttestedV2(
  at: string,
  reason: string,
  db?: DatabaseSync,
): YuantaHumanAttestedV2Manifest {
  if (!validEventAt(at) || !reason.trim())
    throw new Error(
      "Yuanta v2 attestation revocation requires time and reason.",
    );
  const latest = db ? latestYuantaHumanAttestationEventV2(db) : null;
  if (latest?.eventKind === "revoked") {
    if (currentV2Manifest.status === "active") {
      setYuantaHumanAttestedV2Status(
        "revoked",
        latest.eventAt,
        latest.reason,
      );
    }
    return currentV2Manifest;
  }
  if (currentV2Manifest.status === "revoked") return currentV2Manifest;
  const revoked = setYuantaHumanAttestedV2Status(
    "revoked",
    at,
    reason.trim(),
  );
  if (db)
    recordV2Event(db, {
      attestationId: revoked.attestationId,
      evidenceVersion: revoked.evidenceVersion,
      eventKind: "revoked",
      manifestStatus: "revoked",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(revoked),
      sequence: readV2EventChain(db, revoked.attestationId).length + 1,
    });
  return revoked;
}

export function restoreYuantaHumanAttestedV2(
  at: string,
  reason = "user-confirmed-restoration",
  db?: DatabaseSync,
): YuantaHumanAttestedV2Manifest {
  if (!validEventAt(at) || !reason.trim())
    throw new Error(
      "Yuanta v2 attestation restoration requires time and reason.",
    );
  const latest = db ? latestYuantaHumanAttestationEventV2(db) : null;
  if (currentV2Manifest.status === "active" && latest?.eventKind !== "revoked")
    return currentV2Manifest;
  const restored = setYuantaHumanAttestedV2Status("active", null, null);
  if (db)
    recordV2Event(db, {
      attestationId: restored.attestationId,
      evidenceVersion: restored.evidenceVersion,
      eventKind: "attested",
      manifestStatus: "active",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(restored),
      sequence: readV2EventChain(db, restored.attestationId).length + 1,
    });
  return restored;
}

export function isYuantaHumanAttestationV2DurablyActive(
  db: DatabaseSync,
): boolean {
  if (!isYuantaHumanAttestedV2Active()) return false;
  try {
    const latest = latestYuantaHumanAttestationEventV2(db);
    return (
      latest?.eventKind === "attested" && latest.manifestStatus === "active"
    );
  } catch {
    return false;
  }
}
