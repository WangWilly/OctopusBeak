import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isValidatedCanonicalDatabase,
  runCanonicalSchemaRepair,
} from "./canonical-schema-lifecycle.ts";

type SinopacOpaqueToken = `sha256:${string}`;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object") deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

export const SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE =
  "sinopac/domestic-deposit/human-attested-v1" as const;
export const SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION =
  "human-attested-v1" as const;

/**
 * This is an observed, user-confirmed contract.  It deliberately does not
 * assert that SINOPAC guarantees occurrence identity, completeness, timezone,
 * cancellation handling, or shared-account authority.
 */
export const SINOPAC_HUMAN_ATTESTED_V1_MANIFEST = deepFreeze({
  attestationId: "sinopac-domestic-deposit-human-attested-v1",
  evidenceVersion: SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  authorityRoute: SINOPAC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  status: "active",
  attestedAt: "2026-08-23",
  attestedBy: "user-confirmed-sinopac-observed-human-attested-2026-08-23",
  provenance: {
    kind: "user-confirmation",
    attestationContractFingerprint:
      "sha256:ec011375014d525e074d9928cb78ed72355048652a655548904ff9ae3c4d90a1",
    source: "SINOPAC domestic deposit observed human-attested contract",
  },
  authority: "personal-authenticated-session",
  currency: "TWD",
  providerGuaranteed: false,
  semantics: {
    posting: "posted-history-only",
    direction: "export-outflow-or-inflow-exclusive",
    effectiveTime: "transaction-date-time-observed-Asia/Taipei",
    accountingDate: "provider-accounting-date-retained-separately",
    cancellation: "unsupported-reject",
    occurrence: "observed-composite-fence-not-provider-unique",
    completeness: "bounded-terminal-query-observed",
    zeroResult: "provider-explicit-no-data-only",
    withdrawal: "never-infer-missing-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type SinopacHumanAttestedV1Manifest = Omit<
  typeof SINOPAC_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type SinopacHumanAttestationEvent = {
  attestationId: string;
  evidenceVersion: string;
  eventKind: "attested" | "revoked";
  manifestStatus: "active" | "revoked";
  eventAt: string;
  reason: string | null;
  manifestFingerprint: SinopacOpaqueToken;
  sequence: number;
};

const VALIDATED_MANIFESTS = new WeakSet<object>();
let currentManifest: SinopacHumanAttestedV1Manifest =
  SINOPAC_HUMAN_ATTESTED_V1_MANIFEST;
VALIDATED_MANIFESTS.add(SINOPAC_HUMAN_ATTESTED_V1_MANIFEST);

function manifestFingerprint(
  manifest: SinopacHumanAttestedV1Manifest,
): SinopacOpaqueToken {
  return manifest.provenance
    .attestationContractFingerprint as SinopacOpaqueToken;
}

export function sinopacHumanAttestedIdentityEpochKey(
  manifest: SinopacHumanAttestedV1Manifest = currentManifest,
): SinopacOpaqueToken {
  const value = [
    "sinopac-human-attested-identity-epoch-v1",
    manifest.attestationId,
    manifest.evidenceVersion,
    manifest.provenance.attestationContractFingerprint,
  ].join("\u0000");
  return `sha256:${Buffer.from(value).toString("base64url")}`;
}

function assertCurrentManifest(manifest: SinopacHumanAttestedV1Manifest): void {
  if (
    manifest !== currentManifest ||
    manifest.attestationId !==
      SINOPAC_HUMAN_ATTESTED_V1_MANIFEST.attestationId ||
    manifest.evidenceVersion !==
      SINOPAC_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !==
      SINOPAC_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute ||
    manifest.provenance.attestationContractFingerprint !==
      SINOPAC_HUMAN_ATTESTED_V1_MANIFEST.provenance
        .attestationContractFingerprint ||
    manifest.providerGuaranteed !== false
  )
    throw new Error(
      "SINOPAC attestation manifest does not match the immutable contract.",
    );
}

function validEventAt(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function getSinopacHumanAttestedV1Manifest(): SinopacHumanAttestedV1Manifest {
  return currentManifest;
}

export function isSinopacHumanAttestedV1Manifest(
  value: unknown,
): value is SinopacHumanAttestedV1Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_MANIFESTS.has(value) &&
    value === currentManifest
  );
}

export function isSinopacHumanAttestedV1Active(): boolean {
  return currentManifest.status === "active";
}

function tableColumns(db: DatabaseSync): Set<string> {
  return new Set(
    (
      db
        .prepare("PRAGMA table_info(sinopac_attestation_events)")
        .all() as Array<{
        name?: string;
      }>
    ).flatMap((row) => (row.name ? [row.name] : [])),
  );
}

export function ensureSinopacHumanAttestationEvents(db: DatabaseSync): void {
  if (isValidatedCanonicalDatabase(db)) {
    runCanonicalSchemaRepair(db, "canonical/attestation/sinopac-events/v1");
    return;
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS sinopac_attestation_events (" +
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
      "ALTER TABLE sinopac_attestation_events ADD COLUMN evidence_version TEXT",
    );
  if (!columns.has("manifest_status"))
    db.exec(
      "ALTER TABLE sinopac_attestation_events ADD COLUMN manifest_status TEXT",
    );
  if (!columns.has("event_sequence"))
    db.exec(
      "ALTER TABLE sinopac_attestation_events ADD COLUMN event_sequence INTEGER",
    );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_sinopac_attestation_events_latest " +
      "ON sinopac_attestation_events(attestation_id, event_sequence, event_at, event_id)",
  );
}

type StoredEventRow = {
  attestation_id?: string;
  evidence_version?: string | null;
  event_kind?: "attested" | "revoked";
  manifest_status?: "active" | "revoked" | null;
  event_at?: string;
  reason?: string | null;
  manifest_fingerprint?: SinopacOpaqueToken;
  event_sequence?: number | null;
};

function readEventChain(
  db: DatabaseSync,
  attestationId = currentManifest.attestationId,
): SinopacHumanAttestationEvent[] {
  ensureSinopacHumanAttestationEvents(db);
  const rows = db
    .prepare(
      "SELECT attestation_id, evidence_version, event_kind, manifest_status, event_at, reason, manifest_fingerprint, event_sequence " +
        "FROM sinopac_attestation_events WHERE attestation_id = ? ORDER BY event_sequence ASC, event_at ASC, rowid ASC",
    )
    .all(attestationId) as StoredEventRow[];
  if (rows.length === 0) return [];
  assertCurrentManifest(currentManifest);
  const expectedFingerprint = manifestFingerprint(currentManifest);
  const chain: SinopacHumanAttestationEvent[] = [];
  for (const [index, row] of rows.entries()) {
    const event: SinopacHumanAttestationEvent = {
      attestationId: row.attestation_id ?? "",
      evidenceVersion: row.evidence_version ?? "",
      eventKind: row.event_kind as SinopacHumanAttestationEvent["eventKind"],
      manifestStatus:
        row.manifest_status as SinopacHumanAttestationEvent["manifestStatus"],
      eventAt: row.event_at ?? "",
      reason: row.reason ?? null,
      manifestFingerprint:
        row.manifest_fingerprint ?? ("" as SinopacOpaqueToken),
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
      throw new Error("SINOPAC attestation event chain is invalid.");
    chain.push(event);
  }
  return chain;
}

export function latestSinopacHumanAttestationEvent(
  db: DatabaseSync,
  attestationId = SINOPAC_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
): SinopacHumanAttestationEvent | null {
  const chain = readEventChain(db, attestationId);
  const latest = chain.at(-1) ?? null;
  if (!latest && currentManifest.status === "revoked")
    throw new Error(
      "SINOPAC revoked attestation has no durable revocation event.",
    );
  return latest;
}

function recordEvent(
  db: DatabaseSync,
  event: SinopacHumanAttestationEvent,
): void {
  ensureSinopacHumanAttestationEvents(db);
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
    throw new Error(
      "SINOPAC attestation event does not match the immutable chain.",
    );
  db.prepare(
    "INSERT INTO sinopac_attestation_events(event_id, attestation_id, evidence_version, event_kind, manifest_status, event_at, reason, manifest_fingerprint, event_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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

export function recordSinopacHumanAttestationEvent(
  db: DatabaseSync,
  event: SinopacHumanAttestationEvent,
): void {
  recordEvent(db, event);
}

export function recordInitialSinopacHumanAttestationIfMissing(
  db: DatabaseSync,
  observedAt = SINOPAC_HUMAN_ATTESTED_V1_MANIFEST.attestedAt +
    "T00:00:00.000+08:00",
): void {
  if (!isSinopacHumanAttestedV1Active())
    throw new Error("Cannot attest a revoked SINOPAC manifest.");
  if (latestSinopacHumanAttestationEvent(db)) return;
  recordEvent(db, {
    attestationId: currentManifest.attestationId,
    evidenceVersion: currentManifest.evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: "user-confirmed-sinopac-observed-human-attested-2026-08-23",
    manifestFingerprint: manifestFingerprint(currentManifest),
    sequence: 1,
  });
}

export function revokeSinopacHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): SinopacHumanAttestedV1Manifest {
  if (!validEventAt(at) || !reason.trim())
    throw new Error("SINOPAC attestation revocation requires time and reason.");
  const latest = db ? latestSinopacHumanAttestationEvent(db) : null;
  if (latest?.eventKind === "revoked") {
    if (currentManifest.status === "active") {
      const durable = deepFreeze({
        ...currentManifest,
        status: "revoked" as const,
        revokedAt: latest.eventAt,
        revocationReason: latest.reason,
      });
      currentManifest = durable;
      VALIDATED_MANIFESTS.add(durable);
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
    recordEvent(db, {
      attestationId: revoked.attestationId,
      evidenceVersion: revoked.evidenceVersion,
      eventKind: "revoked",
      manifestStatus: "revoked",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(revoked),
      sequence: latest ? latest.sequence + 1 : 1,
    });
  return revoked;
}

export function restoreSinopacHumanAttestedV1(
  at: string,
  reason = "user-confirmed-restoration",
  db?: DatabaseSync,
): SinopacHumanAttestedV1Manifest {
  if (!validEventAt(at) || !reason.trim())
    throw new Error(
      "SINOPAC attestation restoration requires time and reason.",
    );
  const latest = db ? latestSinopacHumanAttestationEvent(db) : null;
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
    recordEvent(db, {
      attestationId: restored.attestationId,
      evidenceVersion: restored.evidenceVersion,
      eventKind: "attested",
      manifestStatus: "active",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(restored),
      sequence: latest ? latest.sequence + 1 : 1,
    });
  return restored;
}

export function isSinopacHumanAttestationDurablyActive(
  db: DatabaseSync,
): boolean {
  if (!isSinopacHumanAttestedV1Active()) return false;
  try {
    const latest = latestSinopacHumanAttestationEvent(db);
    return (
      latest?.eventKind === "attested" && latest.manifestStatus === "active"
    );
  } catch {
    return false;
  }
}
