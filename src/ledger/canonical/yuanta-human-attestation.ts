import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type YuantaOpaqueToken = string;

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object") deepFreeze(child, seen);
  }
  return Object.freeze(value);
};

export const YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE =
  "yuanta/domestic-deposit/human-attested-v1" as const;
export const YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION =
  "human-attested-v1" as const;

/**
 * Version two records the observed Yuanta zero-sentinel amount rule.  The
 * previous v1 contract remains readable, but is no longer the active
 * production authority for new captures.
 */
export const YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_ROUTE =
  "yuanta/domestic-deposit/human-attested-v2" as const;
export const YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_VERSION =
  "human-attested-v2" as const;

/**
 * This is an observed-user authority, not a provider guarantee. The
 * fingerprint identifies the attested contract/observation lineage only; it
 * deliberately excludes dates, filenames, labels, row contents, and account
 * values.
 */
export const YUANTA_HUMAN_ATTESTED_V1_MANIFEST = deepFreeze({
  attestationId: "yuanta-domestic-deposit-human-attested-v1",
  evidenceVersion: YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  authorityRoute: YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  status: "active",
  attestedAt: "2026-08-21",
  attestedBy: "user-confirmed-yuanta-observed-human-attested-2026-08-21",
  provenance: {
    kind: "user-confirmation",
    /** Immutable contract/live-attestation fingerprint; not a CSV hash. */
    attestationContractFingerprint:
      "sha256:e3615c1a8f886ca9edeb057b8005131c8ccdbcf0d757c6fce9ae90f5bd95ef86",
    source: "Yuanta domestic deposit observed human-attested contract",
  },
  authority: "personal-authenticated-session",
  currency: "TWD",
  providerGuaranteed: false,
  semantics: {
    posting: "posted-history-only",
    direction: "CSV-outflow-or-inflow-exclusive",
    effectiveTime: "transaction-date-time-Asia/Taipei",
    accountingDate: "retained-source-evidence",
    cancellation: "unsupported-reject",
    occurrence:
      "account-date-time-direction-amount-balance-description-note-check",
    completeness: "exact-ui-range-terminal-download",
    zeroResult: "provider-explicit-no-data-only",
    withdrawal: "never-infer-missing-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export const YUANTA_HUMAN_ATTESTED_V2_MANIFEST = deepFreeze({
  attestationId: "yuanta-domestic-deposit-human-attested-v2",
  evidenceVersion: YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_VERSION,
  authorityRoute: YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V2_ROUTE,
  status: "active",
  attestedAt: "2026-08-21",
  attestedBy: "user-confirmed-yuanta-observed-human-attested-2026-08-21",
  provenance: {
    kind: "user-confirmation",
    /** Immutable contract/live-attestation fingerprint; not a CSV hash. */
    attestationContractFingerprint:
      "sha256:9cde6f1c4f35e4f4d2ef634cf6bc1e7b4869b1a0c1e5e7c2f1a4a9e1bd5d4c63",
    source: "Yuanta domestic deposit observed human-attested contract",
  },
  authority: "personal-authenticated-session",
  currency: "TWD",
  providerGuaranteed: false,
  semantics: {
    posting: "posted-history-only",
    direction: "CSV-outflow-or-inflow-exclusive-zero-sentinel",
    effectiveTime: "transaction-date-time-Asia/Taipei",
    accountingDate: "retained-source-evidence",
    cancellation: "unsupported-reject",
    occurrence:
      "account-date-time-direction-amount-balance-description-note-check",
    completeness: "exact-ui-range-terminal-download",
    zeroResult: "provider-explicit-no-data-only",
    withdrawal: "never-infer-missing-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type YuantaHumanAttestedV1Manifest = Omit<
  typeof YUANTA_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type YuantaHumanAttestedV2Manifest = Omit<
  typeof YUANTA_HUMAN_ATTESTED_V2_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type YuantaHumanAttestedManifest =
  YuantaHumanAttestedV1Manifest | YuantaHumanAttestedV2Manifest;

export type YuantaHumanAttestationEvent = {
  attestationId: string;
  evidenceVersion: string;
  eventKind: "attested" | "revoked";
  manifestStatus: "active" | "revoked";
  eventAt: string;
  reason: string | null;
  manifestFingerprint: YuantaOpaqueToken;
  sequence: number;
};

const VALIDATED_MANIFESTS = new WeakSet<object>();
let currentManifest: YuantaHumanAttestedV1Manifest =
  YUANTA_HUMAN_ATTESTED_V1_MANIFEST;
let currentV2Manifest: YuantaHumanAttestedV2Manifest =
  YUANTA_HUMAN_ATTESTED_V2_MANIFEST;
VALIDATED_MANIFESTS.add(YUANTA_HUMAN_ATTESTED_V1_MANIFEST);
VALIDATED_MANIFESTS.add(YUANTA_HUMAN_ATTESTED_V2_MANIFEST);

function manifestFingerprint(
  manifest: YuantaHumanAttestedManifest,
): YuantaOpaqueToken {
  return manifest.provenance.attestationContractFingerprint;
}

/**
 * The identity epoch is a contract epoch. It is intentionally independent
 * of observation time, CSV filename, account label, and content digest.
 */
export function yuantaHumanAttestedIdentityEpochKey(
  manifest: YuantaHumanAttestedV1Manifest = currentManifest,
): YuantaOpaqueToken {
  const value = [
    "yuanta-human-attested-identity-epoch-v1",
    manifest.attestationId,
    manifest.evidenceVersion,
    manifest.provenance.attestationContractFingerprint,
  ].join("\u0000");
  return "sha256:" + Buffer.from(value).toString("base64url");
}

export function yuantaHumanAttestedV2IdentityEpochKey(
  manifest: YuantaHumanAttestedV2Manifest = currentV2Manifest,
): YuantaOpaqueToken {
  const value = [
    "yuanta-human-attested-identity-epoch-v2",
    manifest.attestationId,
    manifest.evidenceVersion,
    manifest.provenance.attestationContractFingerprint,
  ].join("\u0000");
  return "sha256:" + Buffer.from(value).toString("base64url");
}

function assertCurrentManifest(manifest: YuantaHumanAttestedV1Manifest): void {
  if (
    manifest !== currentManifest ||
    manifest.attestationId !==
      YUANTA_HUMAN_ATTESTED_V1_MANIFEST.attestationId ||
    manifest.evidenceVersion !==
      YUANTA_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !==
      YUANTA_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute ||
    manifest.provenance.attestationContractFingerprint !==
      YUANTA_HUMAN_ATTESTED_V1_MANIFEST.provenance
        .attestationContractFingerprint ||
    manifest.providerGuaranteed !== false
  )
    throw new Error(
      "Yuanta attestation manifest does not match the immutable contract.",
    );
}

function validEventAt(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function getYuantaHumanAttestedV1Manifest(): YuantaHumanAttestedV1Manifest {
  return currentManifest;
}

export function isYuantaHumanAttestedV1Manifest(
  value: unknown,
): value is YuantaHumanAttestedV1Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_MANIFESTS.has(value) &&
    value === currentManifest
  );
}

export function isYuantaHumanAttestedV1Active(): boolean {
  return currentManifest.status === "active";
}

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
      const durableRevocation = deepFreeze({
        ...currentManifest,
        status: "revoked" as const,
        revokedAt: latest.eventAt,
        revocationReason: latest.reason,
      });
      currentManifest = durableRevocation;
      VALIDATED_MANIFESTS.add(durableRevocation);
    }
    return currentManifest;
  }
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
  const restored = deepFreeze({
    ...currentManifest,
    status: "active" as const,
    revokedAt: null,
    revocationReason: null,
  });
  currentManifest = restored;
  VALIDATED_MANIFESTS.add(restored);
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

function assertCurrentV2Manifest(
  manifest: YuantaHumanAttestedV2Manifest,
): void {
  if (
    manifest !== currentV2Manifest ||
    manifest.attestationId !==
      YUANTA_HUMAN_ATTESTED_V2_MANIFEST.attestationId ||
    manifest.evidenceVersion !==
      YUANTA_HUMAN_ATTESTED_V2_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !==
      YUANTA_HUMAN_ATTESTED_V2_MANIFEST.authorityRoute ||
    manifest.provenance.attestationContractFingerprint !==
      YUANTA_HUMAN_ATTESTED_V2_MANIFEST.provenance
        .attestationContractFingerprint ||
    manifest.providerGuaranteed !== false
  )
    throw new Error(
      "Yuanta v2 attestation manifest does not match the immutable contract.",
    );
}

export function getYuantaHumanAttestedV2Manifest(): YuantaHumanAttestedV2Manifest {
  return currentV2Manifest;
}

export function isYuantaHumanAttestedV2Manifest(
  value: unknown,
): value is YuantaHumanAttestedV2Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_MANIFESTS.has(value) &&
    value === currentV2Manifest
  );
}

export function isYuantaHumanAttestedV2Active(): boolean {
  return currentV2Manifest.status === "active";
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
      const durableRevocation = deepFreeze({
        ...currentV2Manifest,
        status: "revoked" as const,
        revokedAt: latest.eventAt,
        revocationReason: latest.reason,
      });
      currentV2Manifest = durableRevocation;
      VALIDATED_MANIFESTS.add(durableRevocation);
    }
    return currentV2Manifest;
  }
  if (currentV2Manifest.status === "revoked") return currentV2Manifest;
  const revoked = deepFreeze({
    ...currentV2Manifest,
    status: "revoked" as const,
    revokedAt: at,
    revocationReason: reason.trim(),
  });
  currentV2Manifest = revoked;
  VALIDATED_MANIFESTS.add(revoked);
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
  const restored = deepFreeze({
    ...currentV2Manifest,
    status: "active" as const,
    revokedAt: null,
    revocationReason: null,
  });
  currentV2Manifest = restored;
  VALIDATED_MANIFESTS.add(restored);
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
