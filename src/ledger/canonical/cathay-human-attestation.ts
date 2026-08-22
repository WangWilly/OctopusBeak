import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * The observed-human boundary for Cathay's domestic-deposit projection.
 *
 * This is an application attestation contract, not a provider guarantee.  In
 * particular, Cathay's sequence number and amount columns are accepted only
 * as the observed source semantics already implemented by the canonical
 * writer; this manifest does not claim that the bank promises permanent
 * occurrence identity.
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

export const CATHAY_HUMAN_ATTESTED_V1_MANIFEST = deepFreeze({
  attestationId: "cathay-domestic-deposit-human-attested-v1",
  evidenceVersion: "human-attested-v1",
  authorityRoute: "cathay/domestic-deposit/human-attested-v1",
  status: "active",
  attestedAt: "2026-08-22",
  attestedBy: "user-confirmed-cathay-observed-human-attested",
  provenance: {
    kind: "user-confirmation",
    // This is an immutable contract fingerprint, not a raw response or CSV
    // digest.  No account, description, amount, or credential is encoded.
    sourceCaptureFingerprint:
      "sha256:4f443b3c1b6d58ee57c4ac84a1e09e41b40a98f1c7d0d8b7bf5d8f5e3a0b6c21",
    source: "Cathay domestic deposit observed human-assisted capture",
  },
  authority: "personal-owned-accounts",
  currency: "TWD",
  providerGuaranteed: false,
  semantics: {
    posting: "provider-booked-history-with-accounting-date",
    direction: "expendAmt-outflow-incomeAmt-inflow",
    effectiveTime: "accounting-date-with-transaction-time-Asia/Taipei",
    cancellation: "explicit-status-only",
    occurrence: "observed-sequence-with-content-v1",
    completeness: "successful-response-with-account-count-and-details",
    zeroResult: "successful-complete-range-with-zero-details",
    withdrawal: "never-infer-missing-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type CathayHumanAttestedV1Manifest = Omit<
  typeof CATHAY_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type CathayHumanAttestationEvent = {
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
let currentManifest: CathayHumanAttestedV1Manifest =
  CATHAY_HUMAN_ATTESTED_V1_MANIFEST;
VALIDATED_MANIFESTS.add(CATHAY_HUMAN_ATTESTED_V1_MANIFEST);

function manifestFingerprint(
  manifest: CathayHumanAttestedV1Manifest,
): `sha256:${string}` {
  return manifest.provenance.sourceCaptureFingerprint;
}

function assertCurrentManifest(manifest: CathayHumanAttestedV1Manifest): void {
  if (
    manifest !== currentManifest ||
    manifest.attestationId !==
      CATHAY_HUMAN_ATTESTED_V1_MANIFEST.attestationId ||
    manifest.evidenceVersion !==
      CATHAY_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !==
      CATHAY_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute ||
    manifest.provenance.sourceCaptureFingerprint !==
      CATHAY_HUMAN_ATTESTED_V1_MANIFEST.provenance.sourceCaptureFingerprint ||
    manifest.providerGuaranteed !== false
  )
    throw new Error(
      "Cathay attestation manifest does not match the immutable contract.",
    );
}

export function getCathayHumanAttestedV1Manifest(): CathayHumanAttestedV1Manifest {
  return currentManifest;
}

export function isCathayHumanAttestedV1Manifest(
  value: unknown,
): value is CathayHumanAttestedV1Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_MANIFESTS.has(value) &&
    value === currentManifest
  );
}

export function isCathayHumanAttestedV1Active(): boolean {
  return currentManifest.status === "active";
}

export function revokeCathayHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): CathayHumanAttestedV1Manifest {
  if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(at) || !reason.trim())
    throw new Error("Cathay attestation revocation requires time and reason.");
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
    recordCathayHumanAttestationEvent(db, {
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

export function restoreCathayHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): CathayHumanAttestedV1Manifest {
  if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(at) || !reason.trim())
    throw new Error("Cathay attestation restoration requires time and reason.");
  if (currentManifest.status === "active") return currentManifest;
  const restored = deepFreeze({
    ...currentManifest,
    status: "active" as const,
    revokedAt: null,
    revocationReason: null,
  });
  currentManifest = restored;
  VALIDATED_MANIFESTS.add(restored);
  if (db) {
    recordCathayHumanAttestationEvent(db, {
      attestationId: restored.attestationId,
      evidenceVersion: restored.evidenceVersion,
      eventKind: "attested",
      manifestStatus: "active",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(restored),
      sequence: nextEventSequence(db, restored.attestationId),
    });
  }
  return restored;
}

function tableColumns(db: DatabaseSync): Set<string> {
  return new Set(
    (
      db
        .prepare("PRAGMA table_info(cathay_attestation_events)")
        .all() as Array<{
        name?: string;
      }>
    ).flatMap((row) => (row.name ? [row.name] : [])),
  );
}

/** Append-only durable event chain kept separate from canonical source rows. */
export function ensureCathayHumanAttestationEvents(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cathay_attestation_events (
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
      "ALTER TABLE cathay_attestation_events ADD COLUMN evidence_version TEXT",
    );
  if (!columns.has("manifest_status"))
    db.exec(
      "ALTER TABLE cathay_attestation_events ADD COLUMN manifest_status TEXT",
    );
  if (!columns.has("event_sequence"))
    db.exec(
      "ALTER TABLE cathay_attestation_events ADD COLUMN event_sequence INTEGER",
    );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cathay_attestation_events_latest
      ON cathay_attestation_events(attestation_id, event_sequence, event_at, event_id);
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
): CathayHumanAttestationEvent[] {
  ensureCathayHumanAttestationEvents(db);
  const rows = db
    .prepare(
      `SELECT attestation_id, evidence_version, event_kind, manifest_status,
              event_at, reason, manifest_fingerprint, event_sequence
       FROM cathay_attestation_events
       WHERE attestation_id = ?
       ORDER BY event_sequence ASC, event_at ASC, rowid ASC`,
    )
    .all(attestationId) as StoredEventRow[];
  if (rows.length === 0) return [];
  assertCurrentManifest(currentManifest);
  const expectedFingerprint = manifestFingerprint(currentManifest);
  const chain: CathayHumanAttestationEvent[] = [];
  for (const [index, row] of rows.entries()) {
    const event: CathayHumanAttestationEvent = {
      attestationId: row.attestation_id ?? "",
      evidenceVersion: row.evidence_version ?? "",
      eventKind: row.event_kind as CathayHumanAttestationEvent["eventKind"],
      manifestStatus:
        row.manifest_status as CathayHumanAttestationEvent["manifestStatus"],
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
        ((chain[index - 1]?.eventKind === "attested" &&
          event.eventKind !== "revoked") ||
          (chain[index - 1]?.eventKind === "revoked" &&
            event.eventKind !== "attested")))
    )
      throw new Error("Cathay attestation event chain is invalid.");
    chain.push(event);
  }
  return chain;
}

function nextEventSequence(db: DatabaseSync, attestationId: string): number {
  return readEventChain(db, attestationId).length + 1;
}

export function recordCathayHumanAttestationEvent(
  db: DatabaseSync,
  event: CathayHumanAttestationEvent,
): void {
  ensureCathayHumanAttestationEvents(db);
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
        currentManifest.status !== "active" ||
        (chain.length > 0 && chain.at(-1)?.eventKind !== "revoked"))) ||
    (event.eventKind === "revoked" &&
      (event.manifestStatus !== "revoked" ||
        currentManifest.status !== "revoked" ||
        chain.length !== 1 ||
        chain[0]?.eventKind !== "attested"))
  )
    throw new Error(
      "Cathay attestation event does not match the immutable chain.",
    );
  db.prepare(
    `INSERT INTO cathay_attestation_events(
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

export function latestCathayHumanAttestationEvent(
  db: DatabaseSync,
  attestationId = CATHAY_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
): CathayHumanAttestationEvent | null {
  const chain = readEventChain(db, attestationId);
  const latest = chain.at(-1) ?? null;
  if (
    latest &&
    ((currentManifest.status === "active" &&
      latest.manifestStatus !== "active") ||
      (currentManifest.status === "revoked" &&
        latest.manifestStatus !== "revoked"))
  )
    throw new Error("Cathay attestation state does not match its event chain.");
  if (!latest && currentManifest.status === "revoked")
    throw new Error(
      "Cathay revoked attestation has no durable revocation event.",
    );
  return latest;
}

export function recordInitialCathayHumanAttestationIfMissing(
  db: DatabaseSync,
  observedAt = `${CATHAY_HUMAN_ATTESTED_V1_MANIFEST.attestedAt}T00:00:00.000Z`,
): void {
  if (!isCathayHumanAttestedV1Active())
    throw new Error("Cannot attest a revoked Cathay manifest.");
  const latest = latestCathayHumanAttestationEvent(db);
  if (latest) return;
  recordCathayHumanAttestationEvent(db, {
    attestationId: CATHAY_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
    evidenceVersion: CATHAY_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: "user-confirmed-cathay-observed-human-assisted-capture",
    manifestFingerprint: manifestFingerprint(CATHAY_HUMAN_ATTESTED_V1_MANIFEST),
    sequence: 1,
  });
}

export function isCathayHumanAttestationDurablyActive(
  db: DatabaseSync,
): boolean {
  if (!isCathayHumanAttestedV1Active()) return false;
  const latest = latestCathayHumanAttestationEvent(db);
  return latest?.eventKind === "attested" && latest.manifestStatus === "active";
}
