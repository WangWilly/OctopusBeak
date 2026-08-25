import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * The first Fubon credit-card contract is deliberately human-attested.  The
 * live source exposes independently billed primary cards but no account-level
 * identifier. This manifest therefore gives each human-attested opaque account
 * key its meaning; card masks, labels, and product names only route captured
 * rows to that attestation and never participate in account identity.
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
    statements: "issuer-settled-cycle-summary-only",
    relations: "explicit-source-linkage-only",
    completeness:
      "six-billed-periods-plus-unbilled-unfiltered-terminal-grid-counts",
    withdrawal: "never-infer-from-missing-card-or-row",
  },
  revokedAt: null,
  revocationReason: null,
} as const);

export type FubonCreditCardHumanAttestedV1Manifest = Omit<
  typeof FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

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

const manifestFingerprint = (): `sha256:${string}` =>
  `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        attestationId:
          FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
        evidenceVersion:
          FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion,
        authorityRoute:
          FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute,
        sourceCaptureFingerprint:
          FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.provenance
            .sourceCaptureFingerprint,
      }),
    )
    .digest("base64url")}`;

const VALIDATED_MANIFESTS = new WeakSet<object>();
let currentManifest: FubonCreditCardHumanAttestedV1Manifest = deepFreeze({
  ...FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
}) as FubonCreditCardHumanAttestedV1Manifest;
// Keep the initial manifest reference stable.  The attestation is an
// immutable contract; revocation/restoration replace the manifest object with
// a new frozen state and append an event rather than mutating this object.
currentManifest = FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST;
VALIDATED_MANIFESTS.add(currentManifest);

function validateManifest(
  manifest: FubonCreditCardHumanAttestedV1Manifest,
): void {
  if (
    manifest.attestationId !==
      FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.attestationId ||
    manifest.evidenceVersion !==
      FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !==
      FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.authorityRoute ||
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
  manifest: FubonCreditCardHumanAttestedV1Manifest,
): void {
  if (
    manifest !== currentManifest ||
    !VALIDATED_MANIFESTS.has(manifest) ||
    manifestFingerprint() !== manifestFingerprint()
  )
    throw new Error(
      "Fubon credit-card attestation manifest is not the current validated version.",
    );
  validateManifest(manifest);
}

export function getFubonCreditCardHumanAttestedV1Manifest(): FubonCreditCardHumanAttestedV1Manifest {
  return currentManifest;
}

export function isFubonCreditCardHumanAttestedV1Manifest(
  value: unknown,
): value is FubonCreditCardHumanAttestedV1Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_MANIFESTS.has(value) &&
    value === currentManifest
  );
}

export function isFubonCreditCardHumanAttestedV1Active(): boolean {
  return currentManifest.status === "active";
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
  attestationId = FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
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
  assertCurrentManifest(currentManifest);
  const expected = manifestFingerprint();
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
      event.attestationId !== currentManifest.attestationId ||
      event.evidenceVersion !== currentManifest.evidenceVersion ||
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
  assertCurrentManifest(currentManifest);
  const previous = readEvents(db);
  if (
    event.attestationId !== currentManifest.attestationId ||
    event.evidenceVersion !== currentManifest.evidenceVersion ||
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

export function recordInitialFubonCreditCardHumanAttestationIfMissing(
  db: DatabaseSync,
  observedAt: string = FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.attestedAt,
): void {
  if (!isFubonCreditCardHumanAttestedV1Active())
    throw new Error("Cannot attest a revoked Fubon credit-card manifest.");
  if (latestFubonCreditCardHumanAttestationEvent(db)) return;
  recordFubonCreditCardHumanAttestationEvent(db, {
    attestationId:
      FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.attestationId,
    evidenceVersion:
      FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: "human-confirmed-independent-primary-card-billing-accounts",
    manifestFingerprint: manifestFingerprint(),
    sequence: 1,
  });
}

export function revokeFubonCreditCardHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): FubonCreditCardHumanAttestedV1Manifest {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || !reason.trim())
    throw new Error("Fubon credit-card attestation revocation requires time and reason.");
  if (currentManifest.status === "revoked") return currentManifest;
  currentManifest = deepFreeze({
    ...currentManifest,
    status: "revoked" as const,
    revokedAt: at,
    revocationReason: reason.trim(),
  });
  VALIDATED_MANIFESTS.add(currentManifest);
  if (db)
    recordFubonCreditCardHumanAttestationEvent(db, {
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

export function restoreFubonCreditCardHumanAttestedV1(
  at: string,
  reason: string,
  db?: DatabaseSync,
): FubonCreditCardHumanAttestedV1Manifest {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || !reason.trim())
    throw new Error("Fubon credit-card attestation restore requires time and reason.");
  if (currentManifest.status === "active") return currentManifest;
  currentManifest = deepFreeze({
    ...FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
    status: "active" as const,
    revokedAt: null,
    revocationReason: null,
  });
  VALIDATED_MANIFESTS.add(currentManifest);
  if (db)
    recordFubonCreditCardHumanAttestationEvent(db, {
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

export function isFubonCreditCardHumanAttestationDurablyActive(
  db: DatabaseSync,
): boolean {
  if (!isFubonCreditCardHumanAttestedV1Active()) return false;
  const latest = latestFubonCreditCardHumanAttestationEvent(db);
  return latest?.manifestStatus === "active";
}

export const getFubonCreditCardHumanAttestationManifest =
  getFubonCreditCardHumanAttestedV1Manifest;
export const isFubonCreditCardHumanAttestationActive =
  isFubonCreditCardHumanAttestedV1Active;
export const revokeFubonCreditCardHumanAttestationV1 =
  revokeFubonCreditCardHumanAttestedV1;
export const restoreFubonCreditCardHumanAttestationV1 =
  restoreFubonCreditCardHumanAttestedV1;
