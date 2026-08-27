import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * E.SUN's credit-card page exposes a portfolio view and masked card keys, but
 * does not expose a provider account, transaction, or statement identifier.
 * This manifest therefore records an observed human-attested authority.  It
 * is deliberately not a provider guarantee and contains no account value,
 * card number, or response payload.
 */
const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === "object") deepFreeze(child, seen);
  }
  return Object.freeze(value);
};

export const ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE =
  "esun/credit-card/human-attested-v1" as const;
export const ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_VERSION =
  "esun/credit-card/human-attested-v1" as const;

export const ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST = deepFreeze({
  attestationId: "esun-credit-card-human-attested-v1",
  evidenceVersion: ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_VERSION,
  authorityRoute: ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE,
  status: "active",
  attestedAt: "2026-08-26T00:00:00.000Z",
  attestedBy: "user-confirmed-esun-credit-card-primary-cardholder-portfolio",
  provenance: {
    kind: "human-attestation",
    sourceCaptureFingerprint:
      "sha256:esun-credit-card-live-complete-grid-repeat-evidence-v1",
    source: "E.SUN redacted complete billed-and-unbilled grid evidence",
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
      "esun-source-connection-identity-epoch-credit-human-attested-portfolio-key",
    cards: "card-instruments-under-attested-portfolio-by-last-four-key",
    posting: "source-credit-card-records-are-posted;billing-status-is-independent",
    billing: "billed-or-unbilled-independent-of-posting",
    transactionIdentity:
      "immutable-normalized-content-tuple-plus-contiguous-deterministic-occurrence-index",
    occurrenceOrdering:
      "complete-one-year-grid-deterministic-source-identity-order-input-index-tie-break",
    statements: "explicit-settled-billed-period-evidence-only",
    relations: "explicit-source-linkage-only",
    completeness:
      "default-one-year-combined-grid-page-one-maximum-page-size-card-counts",
    withdrawal: "never-infer-from-missing-card-or-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type EsunCreditCardHumanAttestedV1Manifest = Omit<
  typeof ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type EsunCreditCardHumanAttestationEvent = {
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
let currentManifest: EsunCreditCardHumanAttestedV1Manifest =
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST;
VALIDATED_MANIFESTS.add(currentManifest);

function manifestFingerprint(
  manifest: EsunCreditCardHumanAttestedV1Manifest = currentManifest,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        attestationId: manifest.attestationId,
        evidenceVersion: manifest.evidenceVersion,
        authorityRoute: manifest.authorityRoute,
        sourceCaptureFingerprint: manifest.provenance.sourceCaptureFingerprint,
        semantics: manifest.semantics,
        providerGuaranteed: manifest.providerGuaranteed,
        occurrenceProviderGuaranteed: manifest.occurrenceProviderGuaranteed,
      }),
    )
    .digest("base64url")}`;
}

export function esunCreditCardHumanAttestedManifestFingerprint(): `sha256:${string}` {
  return manifestFingerprint();
}

function assertCurrentManifest(
  manifest: EsunCreditCardHumanAttestedV1Manifest,
): void {
  if (
    manifest !== currentManifest ||
    !VALIDATED_MANIFESTS.has(manifest) ||
    manifest.attestationId !==
      ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.attestationId ||
    manifest.evidenceVersion !==
      ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !==
      ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute ||
    manifest.providerGuaranteed !== false ||
    manifest.occurrenceProviderGuaranteed !== false
  )
    throw new Error(
      "E.SUN credit-card attestation manifest does not match the immutable contract.",
    );
}

export function getEsunCreditCardHumanAttestedV1Manifest(): EsunCreditCardHumanAttestedV1Manifest {
  return currentManifest;
}

export function isEsunCreditCardHumanAttestedV1Manifest(
  value: unknown,
): value is EsunCreditCardHumanAttestedV1Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_MANIFESTS.has(value) &&
    value === currentManifest
  );
}

export function isEsunCreditCardHumanAttestedV1Active(): boolean {
  return currentManifest.status === "active";
}

/**
 * Human attestation accepts only an opaque portfolio key.  A card mask,
 * product label, or card number must never be promoted to account identity.
 */
export function isEsunCreditCardHumanAttestedAccountKey(
  value: unknown,
): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  if (!/^[A-Za-z][A-Za-z0-9._:-]{2,127}$/u.test(value)) return false;
  if (/^\d+$/u.test(value) || /\*/u.test(value)) return false;
  if (
    /(?:^|[-_:])(card|mask|pan)(?:$|[-_:])|(?:^|[-_:])(visa|mastercard|amex)(?:$|[-_:])|末(?:四碼|4碼)|正卡|附卡/iu.test(
      value,
    )
  )
    return false;
  return true;
}

export function esunCreditCardHumanAttestedIdentityEpochKey(
  manifest: EsunCreditCardHumanAttestedV1Manifest = currentManifest,
): `sha256:${string}` {
  assertCurrentManifest(manifest);
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        "esun-credit-card-human-attested-identity-epoch-v1",
        manifest.attestationId,
        manifest.evidenceVersion,
        manifestFingerprint(manifest),
      ]),
    )
    .digest("base64url")}`;
}

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
  observedAt = ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.attestedAt,
): void {
  if (!isEsunCreditCardHumanAttestedV1Active())
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

export function revokeEsunCreditCardHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): EsunCreditCardHumanAttestedV1Manifest {
  if (!validEventAt(at) || !reason.trim())
    throw new Error("E.SUN credit-card attestation revocation requires time and reason.");
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
    recordEsunCreditCardHumanAttestationEvent(db, {
      attestationId: currentManifest.attestationId,
      evidenceVersion: currentManifest.evidenceVersion,
      eventKind: "revoked",
      manifestStatus: "revoked",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(),
      sequence: readEventChain(db).length + 1,
    });
  return currentManifest;
}

export function restoreEsunCreditCardHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): EsunCreditCardHumanAttestedV1Manifest {
  if (!validEventAt(at) || !reason.trim())
    throw new Error("E.SUN credit-card attestation restoration requires time and reason.");
  if (currentManifest.status === "active") return currentManifest;
  const restored = deepFreeze({
    ...currentManifest,
    status: "active" as const,
    revokedAt: null,
    revocationReason: null,
  });
  currentManifest = restored;
  VALIDATED_MANIFESTS.add(restored);
  if (db)
    recordEsunCreditCardHumanAttestationEvent(db, {
      attestationId: currentManifest.attestationId,
      evidenceVersion: currentManifest.evidenceVersion,
      eventKind: "restored",
      manifestStatus: "active",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(),
      sequence: readEventChain(db).length + 1,
    });
  return currentManifest;
}

export function isEsunCreditCardHumanAttestationDurablyActive(
  db: DatabaseSync,
): boolean {
  if (!isEsunCreditCardHumanAttestedV1Active()) return false;
  try {
    return latestEsunCreditCardHumanAttestationEvent(db)?.manifestStatus === "active";
  } catch {
    return false;
  }
}

export const getEsunCreditCardHumanAttestationManifest =
  getEsunCreditCardHumanAttestedV1Manifest;
export const isEsunCreditCardHumanAttestationActive =
  isEsunCreditCardHumanAttestedV1Active;
export const revokeEsunCreditCardHumanAttestationV1 =
  revokeEsunCreditCardHumanAttestedV1;
export const restoreEsunCreditCardHumanAttestationV1 =
  restoreEsunCreditCardHumanAttestedV1;
