import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object") deepFreeze(child, seen);
  }
  return Object.freeze(value);
};

export const YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE =
  "yuanta/credit-card/human-attested-v1" as const;
export const YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_VERSION =
  "yuanta/credit-card/human-attested-v1" as const;

/**
 * This is a user-confirmed source authority, not a provider identity claim.
 * Yuanta exposes masked card values and no stable transaction identifiers in
 * the observed credit-card response.  The account key is therefore derived
 * from the encrypted credential scope by the workflow and is never a card
 * number or a presentation label.
 */
export const YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST = deepFreeze({
  attestationId: "yuanta-credit-card-human-attested-v1",
  evidenceVersion: YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_VERSION,
  authorityRoute: YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE,
  status: "active",
  attestedAt: "2026-08-26T00:00:00.000+08:00",
  attestedBy: "user-confirmed-yuanta-credit-card-portfolio",
  provenance: {
    kind: "human-attestation",
    sourceCaptureFingerprint:
      "sha256:K7W0Lh8wT8mM3FqkKx8tR4zD4e5p7vJ2nB1sC6aQ9xE",
    source:
      "Yuanta redacted six billed-month plus unbilled terminal capture",
  },
  authority: "human-attested-primary-cardholder-portfolio",
  accountType: "credit",
  accountSubtype: "credit_card",
  stream: "credit-card",
  currency: "TWD",
  providerGuaranteed: false,
  occurrenceProviderGuaranteed: false,
  semantics: {
    accountIdentity:
      "yuanta-source-connection-identity-epoch-credential-account-fingerprint",
    cards: "last-four-card-instruments-under-attested-portfolio",
    posting: "posted-date-required",
    billing: "billed-or-unbilled-independent-of-posting",
    transactionIdentity:
      "immutable-normalized-content-tuple-plus-contiguous-exact-duplicate-ordinal",
    occurrenceOrdering:
      "complete-six-month-plus-unbilled-source-order-human-attested-not-provider-guaranteed",
    statements: "billed-month-settled-summary-only",
    relations: "explicit-source-linkage-only",
    completeness: "six-billed-months-plus-unbilled-terminal-no-pager",
    withdrawal: "never-infer-from-missing-card-or-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type YuantaCreditCardHumanAttestedV1Manifest = Omit<
  typeof YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type YuantaCreditCardHumanAttestationEvent = {
  attestationId: string;
  evidenceVersion: string;
  eventKind: "attested" | "revoked" | "restored";
  manifestStatus: "active" | "revoked";
  eventAt: string;
  reason: string | null;
  manifestFingerprint: `sha256:${string}`;
  sequence: number;
};

const VALIDATED_MANIFESTS = new WeakSet<object>();
let currentManifest: YuantaCreditCardHumanAttestedV1Manifest =
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST;
VALIDATED_MANIFESTS.add(currentManifest);

function manifestFingerprint(): `sha256:${string}` {
  return YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.provenance
    .sourceCaptureFingerprint as `sha256:${string}`;
}

function assertCurrentManifest(
  manifest: YuantaCreditCardHumanAttestedV1Manifest,
): void {
  if (
    manifest !== currentManifest ||
    !VALIDATED_MANIFESTS.has(manifest) ||
    manifest.attestationId !==
      YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.attestationId ||
    manifest.evidenceVersion !==
      YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !==
      YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute ||
    manifest.providerGuaranteed !== false ||
    manifest.occurrenceProviderGuaranteed !== false
  )
    throw new Error(
      "Yuanta credit-card attestation manifest does not match the immutable contract.",
    );
}

export function getYuantaCreditCardHumanAttestedV1Manifest(): YuantaCreditCardHumanAttestedV1Manifest {
  return currentManifest;
}

export function isYuantaCreditCardHumanAttestedV1Manifest(
  value: unknown,
): value is YuantaCreditCardHumanAttestedV1Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_MANIFESTS.has(value) &&
    value === currentManifest
  );
}

export function isYuantaCreditCardHumanAttestedV1Active(): boolean {
  return currentManifest.status === "active";
}

/** The workflow may only pass an opaque, non-card account attestation key. */
export function isYuantaCreditCardHumanAttestedAccountKey(
  value: unknown,
): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  if (!/^[A-Za-z][A-Za-z0-9._:-]{2,127}$/u.test(value)) return false;
  if (/^\d+$/u.test(value) || /\*/u.test(value)) return false;
  return !/(?:^|[-_:])(card|mask|pan|visa|mastercard|amex)(?:$|[-_:])/iu.test(
    value,
  );
}

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
  assertCurrentManifest(currentManifest);
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
      event.attestationId !== currentManifest.attestationId ||
      event.evidenceVersion !== currentManifest.evidenceVersion ||
      event.manifestFingerprint !== manifestFingerprint() ||
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
  assertCurrentManifest(currentManifest);
  const previous = readEvents(db);
  if (
    event.attestationId !== currentManifest.attestationId ||
    event.evidenceVersion !== currentManifest.evidenceVersion ||
    event.manifestFingerprint !== manifestFingerprint() ||
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
    attestationId: currentManifest.attestationId,
    evidenceVersion: currentManifest.evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: "user-confirmed-yuanta-credit-card-portfolio",
    manifestFingerprint: manifestFingerprint(),
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
  if (currentManifest.status === "revoked") return currentManifest;
  currentManifest = deepFreeze({
    ...currentManifest,
    status: "revoked" as const,
    revokedAt: at,
    revocationReason: reason.trim(),
  });
  VALIDATED_MANIFESTS.add(currentManifest);
  if (db)
    recordYuantaCreditCardHumanAttestationEvent(db, {
      attestationId: currentManifest.attestationId,
      evidenceVersion: currentManifest.evidenceVersion,
      eventKind: "revoked",
      manifestStatus: "revoked",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(),
      sequence: nextSequence(db),
    });
  return currentManifest;
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
  if (currentManifest.status === "active") return currentManifest;
  currentManifest = deepFreeze({
    ...currentManifest,
    status: "active" as const,
    revokedAt: null,
    revocationReason: null,
  });
  VALIDATED_MANIFESTS.add(currentManifest);
  if (db)
    recordYuantaCreditCardHumanAttestationEvent(db, {
      attestationId: currentManifest.attestationId,
      evidenceVersion: currentManifest.evidenceVersion,
      eventKind: "restored",
      manifestStatus: "active",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(),
      sequence: nextSequence(db),
    });
  return currentManifest;
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

export const getYuantaCreditCardHumanAttestationManifest =
  getYuantaCreditCardHumanAttestedV1Manifest;
export const isYuantaCreditCardHumanAttestationActive =
  isYuantaCreditCardHumanAttestedV1Active;
export const revokeYuantaCreditCardHumanAttestationV1 =
  revokeYuantaCreditCardHumanAttestedV1;
export const restoreYuantaCreditCardHumanAttestationV1 =
  restoreYuantaCreditCardHumanAttestedV1;
