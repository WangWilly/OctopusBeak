import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * The user-confirmed boundary for the first Fubon financial projection.
 *
 * This manifest is deliberately narrower than a provider contract: it covers
 * personally-owned TWD domestic accounts, records the observed semantics the
 * user accepted, and explicitly refuses to claim a provider-guaranteed
 * occurrence identifier. FX, shared/joint, and unknown-authority accounts
 * remain source-only until a separate attestation is introduced.
 */
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

export const FUBON_HUMAN_ATTESTED_V1_MANIFEST = deepFreeze({
  attestationId: "fubon-domestic-deposit-human-attested-v1",
  evidenceVersion: "human-attested-v1",
  authorityRoute: "fubon/domestic-deposit/human-attested-v1",
  status: "active",
  attestedAt: "2026-08-21",
  attestedBy: "user-confirmed-1A-2A-3A",
  provenance: {
    kind: "user-confirmation",
    sourceCaptureFingerprint:
      "sha256:1758d3b97375cf82f7d6619482d57b5e16bb4f236d44834043b606bd28af26b8",
    source: "Fubon deposit telemetry repeat-and-zero capture",
  },
  authority: "personal-owned-accounts",
  currency: "TWD",
  providerGuaranteed: false,
  semantics: {
    posting: "posted-history-only",
    direction: "cell-3-outflow-cell-4-inflow",
    effectiveTime: "accounting-date-plus-transaction-time-Asia/Taipei",
    cancellation: "explicit-none-only",
    occurrence: "observed-composite-v1",
    completeness: "requested-range-all-terminal-pages",
    zeroResult: "provider-explicit-no-data-only",
    withdrawal: "never-infer-missing-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type FubonHumanAttestedV1Manifest = Omit<
  typeof FUBON_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type FubonHumanAttestationEvent = {
  attestationId: string;
  evidenceVersion: string;
  eventKind: "attested" | "revoked";
  manifestStatus: "active" | "revoked";
  eventAt: string;
  reason: string | null;
  manifestFingerprint: `sha256:${string}`;
  sequence: number;
};

const VALIDATED_MANIFESTS = new WeakSet<object>();
let currentManifest: FubonHumanAttestedV1Manifest =
  FUBON_HUMAN_ATTESTED_V1_MANIFEST;
VALIDATED_MANIFESTS.add(FUBON_HUMAN_ATTESTED_V1_MANIFEST);

function manifestFingerprint(
  manifest: FubonHumanAttestedV1Manifest,
): `sha256:${string}` {
  return manifest.provenance.sourceCaptureFingerprint;
}

function assertCurrentManifest(manifest: FubonHumanAttestedV1Manifest): void {
  if (
    manifest !== currentManifest ||
    manifest.attestationId !== FUBON_HUMAN_ATTESTED_V1_MANIFEST.attestationId ||
    manifest.evidenceVersion !==
      FUBON_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !==
      FUBON_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute ||
    manifest.provenance.sourceCaptureFingerprint !==
      FUBON_HUMAN_ATTESTED_V1_MANIFEST.provenance.sourceCaptureFingerprint ||
    manifest.providerGuaranteed !== false
  )
    throw new Error(
      "Fubon attestation manifest does not match the immutable contract.",
    );
}

export function getFubonHumanAttestedV1Manifest(): FubonHumanAttestedV1Manifest {
  return currentManifest;
}

export function isFubonHumanAttestedV1Manifest(
  value: unknown,
): value is FubonHumanAttestedV1Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_MANIFESTS.has(value) &&
    value === currentManifest
  );
}

export function isFubonHumanAttestedV1Active(): boolean {
  return currentManifest.status === "active";
}

/**
 * Revocation is append-only. Existing canonical history is intentionally left
 * untouched; future admissions fail closed after the new event is observed.
 */
export function revokeFubonHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): FubonHumanAttestedV1Manifest {
  if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(at) || !reason.trim())
    throw new Error("Fubon attestation revocation requires time and reason.");
  if (currentManifest.status === "revoked") return currentManifest;
  const revoked = deepFreeze({
    ...currentManifest,
    status: "revoked" as const,
    revokedAt: at,
    revocationReason: reason.trim(),
  });
  currentManifest = revoked;
  VALIDATED_MANIFESTS.add(revoked);
  if (db) {
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
