import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type CtbcOpaqueToken = `sha256:${string}`;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value))
    return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object") deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

export const CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE =
  "ctbc/domestic-deposit/human-attested-v1" as const;
export const CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION =
  "human-attested-v1" as const;
/** Explicitly confirmed by the user on 2026-08-24 for production activation. */
export const CTBC_HUMAN_ATTESTED_V1_CONFIRMED: boolean = true;

/** Observed contract; this does not claim a provider-guaranteed occurrence ID. */
export const CTBC_HUMAN_ATTESTED_V1_MANIFEST = deepFreeze({
  attestationId: "ctbc-domestic-deposit-human-attested-v1",
  evidenceVersion: CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION,
  authorityRoute: CTBC_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE,
  status: "active",
  attestedAt: "2026-08-24",
  attestedBy: "user-confirmed-ctbc-observed-human-attested-2026-08-24",
  provenance: {
    kind: "user-confirmation",
    attestationContractFingerprint:
      "sha256:111ba05815bc0ac82156617c96e3538f81226c54fdbbe4f5b2325230690e9778",
    source: "CTBC domestic deposit observed human-attested contract",
  },
  authority: "personal-authenticated-session",
  currency: "TWD",
  providerGuaranteed: false,
  semantics: {
    posting: "posted-history-only",
    direction: "provider-debit-or-credit-exclusive-zero-sentinel",
    effectiveTime: "transaction-date-time-observed-Asia/Taipei",
    accountingDate: "provider-accounting-date-retained-separately",
    cancellation: "unsupported-reject",
    occurrence: "observed-composite-fence-not-provider-unique",
    completeness: "every-visible-range-terminal-next-key-empty",
    zeroResult: "provider-code-9201-only",
    withdrawal: "never-infer-missing-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type CtbcHumanAttestedV1Manifest = Omit<
  typeof CTBC_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type CtbcHumanAttestationEvent = {
  attestationId: string;
  evidenceVersion: string;
  eventKind: "attested" | "revoked";
  manifestStatus: "active" | "revoked";
  eventAt: string;
  reason: string | null;
  manifestFingerprint: CtbcOpaqueToken;
  sequence: number;
};

const VALIDATED_MANIFESTS = new WeakSet<object>();
let currentManifest: CtbcHumanAttestedV1Manifest =
  CTBC_HUMAN_ATTESTED_V1_MANIFEST;
VALIDATED_MANIFESTS.add(currentManifest);

function fingerprint(manifest = currentManifest): CtbcOpaqueToken {
  return manifest.provenance.attestationContractFingerprint as CtbcOpaqueToken;
}

export function ctbcHumanAttestedIdentityEpochKey(
  manifest: CtbcHumanAttestedV1Manifest = currentManifest,
): CtbcOpaqueToken {
  return `sha256:${Buffer.from(
    [
      "ctbc-human-attested-identity-epoch-v1",
      manifest.attestationId,
      manifest.evidenceVersion,
      manifest.provenance.attestationContractFingerprint,
    ].join("\0"),
  ).toString("base64url")}`;
}

function validAt(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function assertManifest(): void {
  if (
    currentManifest.attestationId !==
      CTBC_HUMAN_ATTESTED_V1_MANIFEST.attestationId ||
    currentManifest.authorityRoute !==
      CTBC_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute ||
    currentManifest.provenance.attestationContractFingerprint !==
      CTBC_HUMAN_ATTESTED_V1_MANIFEST.provenance
        .attestationContractFingerprint ||
    currentManifest.providerGuaranteed !== false
  )
    throw new Error(
      "CTBC attestation manifest does not match the immutable contract.",
    );
}

export function getCtbcHumanAttestedV1Manifest(): CtbcHumanAttestedV1Manifest {
  return currentManifest;
}

export function isCtbcHumanAttestedV1Manifest(
  value: unknown,
): value is CtbcHumanAttestedV1Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_MANIFESTS.has(value) &&
    value === currentManifest
  );
}

export function isCtbcHumanAttestedV1Active(): boolean {
  return currentManifest.status === "active";
}

export function ensureCtbcHumanAttestationEvents(db: DatabaseSync): void {
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
  assertManifest();
  const rows = db
    .prepare(
      "SELECT attestation_id, evidence_version, event_kind, manifest_status, event_at, reason, manifest_fingerprint, event_sequence " +
        "FROM ctbc_attestation_events WHERE attestation_id = ? ORDER BY event_sequence ASC",
    )
    .all(currentManifest.attestationId) as Array<Record<string, unknown>>;
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
      event.attestationId !== currentManifest.attestationId ||
      event.evidenceVersion !== currentManifest.evidenceVersion ||
      event.manifestFingerprint !== fingerprint() ||
      event.sequence !== index + 1 ||
      !validAt(event.eventAt) ||
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
  if (!latest && currentManifest.status === "revoked")
    throw new Error(
      "CTBC revoked attestation has no durable revocation event.",
    );
  return latest;
}

function recordEvent(db: DatabaseSync, event: CtbcHumanAttestationEvent): void {
  const chain = readChain(db);
  const previous = chain.at(-1);
  if (
    event.attestationId !== currentManifest.attestationId ||
    event.evidenceVersion !== currentManifest.evidenceVersion ||
    event.manifestFingerprint !== fingerprint() ||
    event.sequence !== chain.length + 1 ||
    !validAt(event.eventAt) ||
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
    attestationId: currentManifest.attestationId,
    evidenceVersion: currentManifest.evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: currentManifest.attestedBy,
    manifestFingerprint: fingerprint(),
    sequence: 1,
  });
}

export function revokeCtbcHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): CtbcHumanAttestedV1Manifest {
  if (!validAt(at) || !reason.trim())
    throw new Error("CTBC attestation revocation requires time and reason.");
  const latest = db ? latestCtbcHumanAttestationEvent(db) : null;
  if (latest?.eventKind === "revoked") return currentManifest;
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
      manifestFingerprint: fingerprint(revoked),
      sequence: (latest?.sequence ?? 0) + 1,
    });
  return revoked;
}

export function restoreCtbcHumanAttestedV1(
  at: string,
  reason = "user-confirmed-restoration",
  db?: DatabaseSync,
): CtbcHumanAttestedV1Manifest {
  if (!validAt(at) || !reason.trim())
    throw new Error("CTBC attestation restoration requires time and reason.");
  const latest = db ? latestCtbcHumanAttestationEvent(db) : null;
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
      manifestFingerprint: fingerprint(restored),
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
