import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isValidatedCanonicalDatabase,
  runCanonicalSchemaRepair,
} from "./canonical-schema-lifecycle.ts";

/**
 * The first Fubon credit-card contract is deliberately human-attested.  The
 * live source exposed independently billed primary cards but no account-level
 * identifier. This v1 manifest is kept byte-for-byte compatible with that
 * original contract: its independent billing-account and observed-order
 * semantics are historical evidence and must not be silently rewritten as the
 * current portfolio contract.
 *
 * The current v2 portfolio contract is defined independently below.  Keeping
 * the two manifests separate is important: a v1 event written before the
 * portfolio/deterministic-occurrence semantics changed is historical evidence,
 * not a v2 event with a stale fingerprint.
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

export const FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST = deepFreeze({
  attestationId: "fubon-credit-card-human-attested-v1",
  evidenceVersion: "fubon/credit-card/human-attested-v1",
  authorityRoute: "fubon/credit-card/human-attested-v1",
  status: "active",
  attestedAt: "2026-08-25T00:00:00.000Z",
  attestedBy: "human-confirmed-independent-primary-card-billing-accounts",
  provenance: {
    kind: "human-attestation",
    sourceCaptureFingerprint:
      "sha256:fubon-credit-card-live-repeat-evidence-v1",
    source: "Fubon redacted repeated billed-and-unbilled grid evidence",
  },
  authority: "human-attested-independent-primary-card-billing-account",
  accountType: "credit",
  accountSubtype: "credit_card",
  stream: "credit-card",
  currency: "TWD",
  providerGuaranteed: false,
  occurrenceProviderGuaranteed: false,
  semantics: {
    accountIdentity:
      "fubon-source-connection-identity-epoch-credit-human-attested-account-key",
    cards: "card-instruments-under-attested-account",
    posting: "posting-date-present-means-posted",
    billing: "billed-or-unbilled-independent-of-posting",
    transactionIdentity:
      "immutable-normalized-content-tuple-plus-contiguous-observed-occurrence-index",
    occurrenceOrdering:
      "complete-capture-observed-source-order-human-attested-not-provider-guaranteed",
    statements: "issuer-settled-cycle-summary-only",
    relations: "explicit-source-linkage-only",
    completeness:
      "six-billed-periods-plus-unbilled-unfiltered-terminal-grid-counts",
    withdrawal: "never-infer-from-missing-card-or-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

/** Current portfolio attestation contract.  Its authority route, attestation
 * identity, and evidence version advance together with the portfolio/
 * occurrence semantics. */
export const FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST = deepFreeze({
  attestationId: "fubon-credit-card-human-attested-v2",
  evidenceVersion: "fubon/credit-card/human-attested-v2",
  authorityRoute: "fubon/credit-card/human-attested-v2",
  status: "active",
  attestedAt: "2026-08-25T00:00:00.000Z",
  attestedBy: "human-confirmed-primary-cardholder-portfolio",
  provenance: {
    kind: "human-attestation",
    sourceCaptureFingerprint:
      "sha256:fubon-credit-card-live-repeat-evidence-v2",
    source: "Fubon redacted repeated billed-and-unbilled grid evidence",
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
      "fubon-source-connection-identity-epoch-credit-human-attested-portfolio-key",
    cards: "primary-card-instruments-under-attested-portfolio",
    posting: "posting-date-present-means-posted",
    billing: "billed-or-unbilled-independent-of-posting",
    transactionIdentity:
      "immutable-normalized-content-tuple-plus-contiguous-deterministic-occurrence-index",
    occurrenceOrdering:
      "complete-capture-deterministic-period-rank-source-identity-order-input-index-tie-break-human-attested-not-provider-guaranteed",
    statements: "one-consolidated-issuer-settled-cycle-summary-per-cycle",
    relations: "explicit-source-linkage-only",
    completeness:
      "six-billed-periods-plus-unbilled-unfiltered-terminal-grid-counts",
    withdrawal: "never-infer-from-missing-card-or-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

/** The named legacy alias is intentionally the exact original v1 contract. */
export const FUBON_CREDIT_CARD_HUMAN_ATTESTED_LEGACY_V1_MANIFEST =
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST;
// Also expose the version-first spelling for migration callers.
export const FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_LEGACY_MANIFEST =
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_LEGACY_V1_MANIFEST;

export type FubonCreditCardHumanAttestedV1Manifest = Omit<
  typeof FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type FubonCreditCardHumanAttestedV2Manifest = Omit<
  typeof FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

type FubonCreditCardHumanAttestedManifest =
  | FubonCreditCardHumanAttestedV1Manifest
  | FubonCreditCardHumanAttestedV2Manifest;

export type FubonCreditCardHumanAttestationEvent = {
  attestationId: string;
  evidenceVersion: string;
  eventKind: "attested" | "revoked" | "restored";
  manifestStatus: "active" | "revoked";
  eventAt: string;
  reason: string | null;
  manifestFingerprint: `sha256:${string}`;
  sequence: number;
};

type ManifestFingerprintInput = {
  attestationId: string;
  evidenceVersion: string;
  authorityRoute: string;
  provenance: { sourceCaptureFingerprint: string };
  semantics: {
    transactionIdentity: string;
    occurrenceOrdering: string;
    accountIdentity: string;
    cards: string;
    statements: string;
  };
  providerGuaranteed: boolean;
  occurrenceProviderGuaranteed: boolean;
};

/**
 * Compute the immutable contract fingerprint without including runtime
 * status.  The compact option is the original v1 algorithm; v2 uses the
 * expanded semantic shape.
 */
export function fubonCreditCardHumanAttestedManifestFingerprint(
  manifest: ManifestFingerprintInput,
  options: { includeExpandedSemantics?: boolean } = {},
): `sha256:${string}` {
  const fingerprintInput = {
    attestationId: manifest.attestationId,
    evidenceVersion: manifest.evidenceVersion,
    authorityRoute: manifest.authorityRoute,
    sourceCaptureFingerprint: manifest.provenance.sourceCaptureFingerprint,
    transactionIdentity: manifest.semantics.transactionIdentity,
    occurrenceOrdering: manifest.semantics.occurrenceOrdering,
    ...(options.includeExpandedSemantics === false
      ? {}
      : {
          accountIdentity: manifest.semantics.accountIdentity,
          cards: manifest.semantics.cards,
          statements: manifest.semantics.statements,
        }),
    providerGuaranteed: manifest.providerGuaranteed,
    occurrenceProviderGuaranteed: manifest.occurrenceProviderGuaranteed,
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(fingerprintInput))
    .digest("base64url")}`;
}

/** Fingerprint used by the original v1 event chain during migration. */
export const fubonCreditCardHumanAttestedLegacyV1ManifestFingerprint = () =>
  fubonCreditCardHumanAttestedManifestFingerprint(
    FUBON_CREDIT_CARD_HUMAN_ATTESTED_LEGACY_V1_MANIFEST,
    { includeExpandedSemantics: false },
  );

const manifestFingerprint = (): `sha256:${string}` =>
  fubonCreditCardHumanAttestedManifestFingerprint(
    FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
  );

const VALIDATED_V1_MANIFESTS = new WeakSet<object>();
const VALIDATED_V2_MANIFESTS = new WeakSet<object>();
// V1 remains a read-only compatibility view for the capture contract.  The
// durable event chain has its own v2 identity and is the source of truth for
// current admission/read status.
let currentV1Manifest: FubonCreditCardHumanAttestedV1Manifest =
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST;
let currentV2Manifest: FubonCreditCardHumanAttestedV2Manifest =
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST;
VALIDATED_V1_MANIFESTS.add(currentV1Manifest);
VALIDATED_V2_MANIFESTS.add(currentV2Manifest);

function validateManifest(
  manifest: FubonCreditCardHumanAttestedManifest,
  contract: ManifestFingerprintInput,
): void {
  if (
    manifest.attestationId !== contract.attestationId ||
    manifest.evidenceVersion !== contract.evidenceVersion ||
    manifest.authorityRoute !== contract.authorityRoute ||
    manifest.stream !== "credit-card" ||
    manifest.accountType !== "credit" ||
    manifest.accountSubtype !== "credit_card" ||
    manifest.providerGuaranteed !== false ||
    manifest.occurrenceProviderGuaranteed !== false ||
    (manifest.status === "active" &&
      (manifest.revokedAt !== null || manifest.revocationReason !== null)) ||
    (manifest.status === "revoked" &&
      (!manifest.revokedAt || !manifest.revocationReason))
  )
    throw new Error(
      "Fubon credit-card attestation manifest does not match its immutable contract.",
    );
}

function assertCurrentManifest(
  manifest: FubonCreditCardHumanAttestedV2Manifest,
): void {
  if (
    manifest !== currentV2Manifest ||
    !VALIDATED_V2_MANIFESTS.has(manifest) ||
    fubonCreditCardHumanAttestedManifestFingerprint(manifest) !==
      manifestFingerprint()
  )
    throw new Error(
      "Fubon credit-card attestation manifest is not the current validated version.",
    );
  validateManifest(manifest, FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST);
}

export function getFubonCreditCardHumanAttestedV1Manifest(): FubonCreditCardHumanAttestedV1Manifest {
  return currentV1Manifest;
}

export function getFubonCreditCardHumanAttestedV2Manifest(): FubonCreditCardHumanAttestedV2Manifest {
  return currentV2Manifest;
}

export function isFubonCreditCardHumanAttestedV1Manifest(
  value: unknown,
): value is FubonCreditCardHumanAttestedV1Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_V1_MANIFESTS.has(value) &&
    value === currentV1Manifest
  );
}

export function isFubonCreditCardHumanAttestedV2Manifest(
  value: unknown,
): value is FubonCreditCardHumanAttestedV2Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_V2_MANIFESTS.has(value) &&
    value === currentV2Manifest
  );
}

export function isFubonCreditCardHumanAttestedV1Active(): boolean {
  // Existing capture admission imports the v1-named predicate.  Delegate it
  // to the current v2 state so that compatibility callers cannot accidentally
  // bypass the new attestation chain.
  return isFubonCreditCardHumanAttestedV2Active();
}

export function isFubonCreditCardHumanAttestedV2Active(): boolean {
  return currentV2Manifest.status === "active";
}

/**
 * Human attestation supplies an opaque account key.  This validator is kept
 * next to the contract so callers cannot accidentally promote a card mask,
 * label, product, or other presentation value to account identity.
 */
export function isFubonCreditCardHumanAttestedAccountKey(
  value: unknown,
): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  if (!/^[A-Za-z][A-Za-z0-9._:-]{2,127}$/.test(value)) return false;
  if (/^\d+$/.test(value) || /\*/.test(value)) return false;
  if (
    /(?:^|[-_:])(card|mask)(?:$|[-_:])|(?:^|[-_:])(visa|mastercard|amex)(?:$|[-_:])|末(?:四碼|4碼)|正卡|附卡/i.test(
      value,
    )
  )
    return false;
  return true;
}

function tableColumns(db: DatabaseSync): Set<string> {
  return new Set(
    (
      db
        .prepare("PRAGMA table_info(fubon_credit_card_attestation_events)")
        .all() as Array<{ name?: string }>
    ).flatMap((row) => (row.name ? [row.name] : [])),
  );
}

export function ensureFubonCreditCardHumanAttestationEvents(
  db: DatabaseSync,
): void {
  if (isValidatedCanonicalDatabase(db)) {
    runCanonicalSchemaRepair(db, "canonical/attestation/fubon-credit-card-events/v1");
    return;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS fubon_credit_card_attestation_events (
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
    CREATE INDEX IF NOT EXISTS idx_fubon_credit_card_attestation_latest
      ON fubon_credit_card_attestation_events(attestation_id, event_sequence);
  `);
  const columns = tableColumns(db);
  if (!columns.has("manifest_status"))
    db.exec(
      "ALTER TABLE fubon_credit_card_attestation_events ADD COLUMN manifest_status TEXT",
    );
}

type StoredEvent = {
  attestation_id?: string;
  evidence_version?: string;
  event_kind?: "attested" | "revoked" | "restored";
  manifest_status?: "active" | "revoked";
  event_at?: string;
  reason?: string | null;
  manifest_fingerprint?: `sha256:${string}`;
  event_sequence?: number;
};

function readEvents(
  db: DatabaseSync,
  attestationId: string = FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestationId,
): FubonCreditCardHumanAttestationEvent[] {
  ensureFubonCreditCardHumanAttestationEvents(db);
  const rows = db
    .prepare(
      `SELECT attestation_id, evidence_version, event_kind, manifest_status,
              event_at, reason, manifest_fingerprint, event_sequence
       FROM fubon_credit_card_attestation_events
       WHERE attestation_id = ?
       ORDER BY event_sequence ASC`,
    )
    .all(attestationId) as StoredEvent[];
  if (rows.length === 0) return [];
  const isLegacyV1 =
    attestationId === FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.attestationId;
  if (
    !isLegacyV1 &&
    attestationId !== FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestationId
  )
    throw new Error("Fubon credit-card attestation version is unsupported.");
  if (!isLegacyV1) assertCurrentManifest(currentV2Manifest);
  const expectedManifest = isLegacyV1
    ? FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST
    : currentV2Manifest;
  const expected = isLegacyV1
    ? fubonCreditCardHumanAttestedLegacyV1ManifestFingerprint()
    : manifestFingerprint();
  const result: FubonCreditCardHumanAttestationEvent[] = [];
  for (const [index, row] of rows.entries()) {
    const event: FubonCreditCardHumanAttestationEvent = {
      attestationId: row.attestation_id ?? "",
      evidenceVersion: row.evidence_version ?? "",
      eventKind: row.event_kind as FubonCreditCardHumanAttestationEvent["eventKind"],
      manifestStatus:
        row.manifest_status as FubonCreditCardHumanAttestationEvent["manifestStatus"],
      eventAt: row.event_at ?? "",
      reason: row.reason ?? null,
      manifestFingerprint: row.manifest_fingerprint ?? ("" as `sha256:${string}`),
      sequence: Number(row.event_sequence),
    };
    if (
      event.attestationId !== expectedManifest.attestationId ||
      event.evidenceVersion !== expectedManifest.evidenceVersion ||
      event.manifestFingerprint !== expected ||
      event.sequence !== index + 1 ||
      !/^\d{4}-\d{2}-\d{2}T/.test(event.eventAt) ||
      (index === 0 && event.eventKind !== "attested") ||
      (index > 0 &&
        !(
          (event.eventKind === "revoked" &&
            result[index - 1]?.eventKind === "attested") ||
          (event.eventKind === "restored" &&
            result[index - 1]?.eventKind === "revoked")
        )) ||
      (event.eventKind === "attested" && event.manifestStatus !== "active") ||
      (event.eventKind === "revoked" && event.manifestStatus !== "revoked") ||
      (event.eventKind === "restored" && event.manifestStatus !== "active") ||
      (event.eventKind !== "attested" && !event.reason?.trim())
    )
      throw new Error("Fubon credit-card attestation event chain is invalid.");
    result.push(event);
  }
  return result;
}

function nextSequence(db: DatabaseSync): number {
  return readEvents(db).length + 1;
}

export function recordFubonCreditCardHumanAttestationEvent(
  db: DatabaseSync,
  event: FubonCreditCardHumanAttestationEvent,
): void {
  ensureFubonCreditCardHumanAttestationEvents(db);
  assertCurrentManifest(currentV2Manifest);
  const previous = readEvents(db);
  if (
    event.attestationId !== currentV2Manifest.attestationId ||
    event.evidenceVersion !== currentV2Manifest.evidenceVersion ||
    event.manifestFingerprint !== manifestFingerprint() ||
    event.sequence !== previous.length + 1 ||
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
      "Fubon credit-card attestation event does not match its append-only contract.",
    );
  db.prepare(
    `INSERT INTO fubon_credit_card_attestation_events(
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

export function latestFubonCreditCardHumanAttestationEvent(
  db: DatabaseSync,
): FubonCreditCardHumanAttestationEvent | null {
  const events = readEvents(db);
  return events.at(-1) ?? null;
}

/** Explicit migration/audit reader for the immutable original v1 event chain. */
export function latestFubonCreditCardHumanAttestationLegacyV1Event(
  db: DatabaseSync,
): FubonCreditCardHumanAttestationEvent | null {
  const events = readEvents(
    db,
    FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
  );
  return events.at(-1) ?? null;
}

export function peekFubonCreditCardHumanAttestationStatus(
  db: DatabaseSync,
): "active" | "revoked" | null {
  const exists = db
    .prepare(
      `SELECT 1 AS value FROM sqlite_master
       WHERE type = 'table' AND name = 'fubon_credit_card_attestation_events'`,
    )
    .get() as { value?: number } | undefined;
  if (!exists) return null;
  return latestFubonCreditCardHumanAttestationEvent(db)?.manifestStatus ?? null;
}

export function recordInitialFubonCreditCardHumanAttestationIfMissing(
  db: DatabaseSync,
  observedAt: string = FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestedAt,
): void {
  if (!isFubonCreditCardHumanAttestedV2Active())
    throw new Error("Cannot attest a revoked Fubon credit-card manifest.");
  if (latestFubonCreditCardHumanAttestationEvent(db)) return;
  recordFubonCreditCardHumanAttestationEvent(db, {
    attestationId: FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestationId,
    evidenceVersion: FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: "human-confirmed-primary-cardholder-portfolio",
    manifestFingerprint: manifestFingerprint(),
    sequence: 1,
  });
}

function setCurrentManifestStatus(
  status: "active" | "revoked",
  at: string | null,
  reason: string | null,
): void {
  if (status === "active") {
    currentV2Manifest = FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST;
    currentV1Manifest = FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST;
  } else {
    currentV2Manifest = deepFreeze({
      ...currentV2Manifest,
      status: "revoked" as const,
      revokedAt: at,
      revocationReason: reason,
    });
    currentV1Manifest = deepFreeze({
      ...currentV1Manifest,
      status: "revoked" as const,
      revokedAt: at,
      revocationReason: reason,
    });
  }
  VALIDATED_V2_MANIFESTS.add(currentV2Manifest);
  VALIDATED_V1_MANIFESTS.add(currentV1Manifest);
}

export function revokeFubonCreditCardHumanAttestedV2(
  at: string,
  reason: string,
  db?: DatabaseSync,
): FubonCreditCardHumanAttestedV2Manifest {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || !reason.trim())
    throw new Error("Fubon credit-card attestation revocation requires time and reason.");
  if (currentV2Manifest.status === "revoked") {
    if (db && latestFubonCreditCardHumanAttestationEvent(db)?.manifestStatus === "active")
      recordFubonCreditCardHumanAttestationEvent(db, {
        attestationId: currentV2Manifest.attestationId,
        evidenceVersion: currentV2Manifest.evidenceVersion,
        eventKind: "revoked",
        manifestStatus: "revoked",
        eventAt: at,
        reason: reason.trim(),
        manifestFingerprint: manifestFingerprint(),
        sequence: nextSequence(db),
      });
    return currentV2Manifest;
  }
  setCurrentManifestStatus("revoked", at, reason.trim());
  if (db)
    recordFubonCreditCardHumanAttestationEvent(db, {
      attestationId: currentV2Manifest.attestationId,
      evidenceVersion: currentV2Manifest.evidenceVersion,
      eventKind: "revoked",
      manifestStatus: "revoked",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(),
      sequence: nextSequence(db),
    });
  return currentV2Manifest;
}

export function revokeFubonCreditCardHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): FubonCreditCardHumanAttestedV1Manifest {
  revokeFubonCreditCardHumanAttestedV2(at, reason, db);
  return currentV1Manifest;
}

export function restoreFubonCreditCardHumanAttestedV2(
  at: string,
  reason: string,
  db?: DatabaseSync,
): FubonCreditCardHumanAttestedV2Manifest {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || !reason.trim())
    throw new Error("Fubon credit-card attestation restore requires time and reason.");
  if (currentV2Manifest.status === "active") {
    if (db && latestFubonCreditCardHumanAttestationEvent(db)?.manifestStatus === "revoked")
      recordFubonCreditCardHumanAttestationEvent(db, {
        attestationId: currentV2Manifest.attestationId,
        evidenceVersion: currentV2Manifest.evidenceVersion,
        eventKind: "restored",
        manifestStatus: "active",
        eventAt: at,
        reason: reason.trim(),
        manifestFingerprint: manifestFingerprint(),
        sequence: nextSequence(db),
      });
    return currentV2Manifest;
  }
  setCurrentManifestStatus("active", null, null);
  if (db)
    recordFubonCreditCardHumanAttestationEvent(db, {
      attestationId: currentV2Manifest.attestationId,
      evidenceVersion: currentV2Manifest.evidenceVersion,
      eventKind: "restored",
      manifestStatus: "active",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprint(),
      sequence: nextSequence(db),
    });
  return currentV2Manifest;
}

export function restoreFubonCreditCardHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): FubonCreditCardHumanAttestedV1Manifest {
  restoreFubonCreditCardHumanAttestedV2(at, reason, db);
  return currentV1Manifest;
}

export function isFubonCreditCardHumanAttestationDurablyActive(
  db: DatabaseSync,
): boolean {
  if (!isFubonCreditCardHumanAttestedV2Active()) return false;
  const latest = latestFubonCreditCardHumanAttestationEvent(db);
  return latest?.manifestStatus === "active";
}

export const getFubonCreditCardHumanAttestationManifest =
  getFubonCreditCardHumanAttestedV2Manifest;
export const isFubonCreditCardHumanAttestationActive =
  isFubonCreditCardHumanAttestedV2Active;
export const revokeFubonCreditCardHumanAttestationV1 =
  revokeFubonCreditCardHumanAttestedV1;
export const restoreFubonCreditCardHumanAttestationV1 =
  restoreFubonCreditCardHumanAttestedV1;
export const revokeFubonCreditCardHumanAttestationV2 =
  revokeFubonCreditCardHumanAttestedV2;
export const restoreFubonCreditCardHumanAttestationV2 =
  restoreFubonCreditCardHumanAttestedV2;
// Version-explicit wrappers make the migration boundary obvious to new
// admission/read callers while preserving the original public names.
export function latestFubonCreditCardHumanAttestationEventV2(
  db: DatabaseSync,
  attestationId = FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestationId,
): FubonCreditCardHumanAttestationEvent | null {
  return readEvents(db, attestationId).at(-1) ?? null;
}

export function recordInitialFubonCreditCardHumanAttestationV2IfMissing(
  db: DatabaseSync,
  observedAt?: string,
): void {
  recordInitialFubonCreditCardHumanAttestationIfMissing(db, observedAt);
}

export function isFubonCreditCardHumanAttestationV2DurablyActive(
  db: DatabaseSync,
): boolean {
  return isFubonCreditCardHumanAttestationDurablyActive(db);
}

export function recordFubonCreditCardHumanAttestationEventV2(
  db: DatabaseSync,
  event: FubonCreditCardHumanAttestationEvent,
): void {
  recordFubonCreditCardHumanAttestationEvent(db, event);
}
