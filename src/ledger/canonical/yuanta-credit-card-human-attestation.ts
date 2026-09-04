import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isValidatedCanonicalDatabase,
  runCanonicalSchemaRepair,
} from "./canonical-schema-lifecycle.ts";

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

/**
 * v2 is a new authority route because settled statement summaries and the
 * first-six/last-four instrument projection are materially stronger semantics
 * than the historical v1 capture.  v1 remains immutable for historical
 * captures and is intentionally not silently reinterpreted as v2.
 */
export const YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE =
  "yuanta/credit-card/human-attested-v2" as const;
export const YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_VERSION =
  "yuanta/credit-card/human-attested-v2" as const;
export const YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST = deepFreeze({
  ...YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  attestationId: "yuanta-credit-card-human-attested-v2",
  evidenceVersion: YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_VERSION,
  authorityRoute: YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE,
  attestedAt: "2026-08-27T00:00:00.000+08:00",
  provenance: {
    kind: "human-attestation",
    sourceCaptureFingerprint:
      "sha256:yuanta-credit-card-live-card-projection-and-history-detail-settled-summary-evidence-v2",
    source:
      "Yuanta redacted six billed-month plus unbilled terminal capture with issuer-settled summaries",
  },
  semantics: {
    ...YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST.semantics,
    cards:
      "card-instruments-by-managed-secret-hmac-of-first-six-plus-last-four-projection",
    statements:
      "issuer-settled-history-detail-close-due-total-minimum-with-period-and-prior-close-derived-cycle-start",
    settledSummaryPeriodAuthority:
      "history-detail.table.rwdTable[0].row[0].cell[0].period-label-to-row[1].cell[0].same-column-value-exact-human-attested-a",
    settledSummaryPeriodFormat:
      "human-attested-category-2-gregorian-year-month-slash-with-month-or-period-suffix",
    settledSummaryNonAuthoritativePeriodSources:
      "card-title-and-month-tab-non-authoritative",
    settledSummaryBalanceAuthority:
      "history-detail.table.rwdTable[0].balance-label-to-next-row.same-column-value-exact-human-attested-a",
    settledSummaryNonAuthoritativeBalanceSources:
      "paid-amount-and-text-fragment-non-authoritative",
    settledSummaryParserContract:
      "yuanta-credit-card.settled-summary-parser.v7-exact-period-balance-a",
    settledSummaryLiveEvidence:
      "six-issuer-history-detail-summaries-five-bounded-cycles-queryHistoryDetail-authority",
    settledSummaryAuthorityContract:
      "queryHistoryDetail-selected-billed-month-response-with-provider-posting-date-membership",
    settledSummaryExactFieldEvidence:
      "period-and-balance-next-row-same-column-exact-human-attested-a",
    settledSummaryCompletenessEvidence:
      "complete-range-seven-terminal-grids-six-history-summaries-unbilled-terminal",
    settledSummaryRepeatEvidence:
      "two-v2-captures-repeat-deduped-authority-with-provenance-retained",
    settledSummaryCurrentRoutePrecedence:
      "v2-complete-capture-supersedes-v1-current-view-only-history-retains-both",
    settledSummaryDiagnosticPage:
      "creditcardsummary-optional-non-authoritative-and-must-not-block",
    occurrenceOrdering:
      "complete-six-month-plus-unbilled-deterministic-source-order-human-attested-not-provider-guaranteed",
  },
} as const);

export type YuantaCreditCardHumanAttestedV1Manifest = Omit<
  typeof YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST,
  "status" | "revokedAt" | "revocationReason"
> & {
  status: "active" | "revoked";
  revokedAt: string | null;
  revocationReason: string | null;
};

export type YuantaCreditCardHumanAttestedV2Manifest = Omit<
  typeof YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
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
  if (isValidatedCanonicalDatabase(db)) {
    runCanonicalSchemaRepair(db, "canonical/attestation/yuanta-credit-card-events/v1");
    return;
  }
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

const VALIDATED_V2_MANIFESTS = new WeakSet<object>();
let currentV2Manifest: YuantaCreditCardHumanAttestedV2Manifest =
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST;
VALIDATED_V2_MANIFESTS.add(currentV2Manifest);

function manifestFingerprintV2(
  manifest: YuantaCreditCardHumanAttestedV2Manifest = currentV2Manifest,
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

export function yuantaCreditCardHumanAttestedV2ManifestFingerprint(): `sha256:${string}` {
  return manifestFingerprintV2();
}

function assertCurrentV2Manifest(
  manifest: YuantaCreditCardHumanAttestedV2Manifest,
): void {
  if (
    manifest !== currentV2Manifest ||
    !VALIDATED_V2_MANIFESTS.has(manifest) ||
    manifest.attestationId !== YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestationId ||
    manifest.evidenceVersion !== YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.evidenceVersion ||
    manifest.authorityRoute !== YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.authorityRoute ||
    manifest.providerGuaranteed !== false ||
    manifest.occurrenceProviderGuaranteed !== false
  )
    throw new Error(
      "Yuanta credit-card v2 attestation manifest does not match the immutable contract.",
    );
}

export function getYuantaCreditCardHumanAttestedV2Manifest(): YuantaCreditCardHumanAttestedV2Manifest {
  return currentV2Manifest;
}

export function isYuantaCreditCardHumanAttestedV2Manifest(
  value: unknown,
): value is YuantaCreditCardHumanAttestedV2Manifest {
  return (
    value !== null &&
    typeof value === "object" &&
    VALIDATED_V2_MANIFESTS.has(value) &&
    value === currentV2Manifest
  );
}

export function isYuantaCreditCardHumanAttestedV2Active(): boolean {
  return currentV2Manifest.status === "active";
}

function readV2Events(db: DatabaseSync): YuantaCreditCardHumanAttestationEvent[] {
  ensureYuantaCreditCardHumanAttestationEvents(db);
  const rows = db
    .prepare(
      `SELECT attestation_id, evidence_version, event_kind, manifest_status,
              event_at, reason, manifest_fingerprint, event_sequence
       FROM yuanta_credit_card_attestation_events
       WHERE attestation_id = ? ORDER BY event_sequence ASC`,
    )
    .all(YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestationId) as StoredEvent[];
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
      event.attestationId !== currentV2Manifest.attestationId ||
      event.evidenceVersion !== currentV2Manifest.evidenceVersion ||
      event.manifestFingerprint !== manifestFingerprintV2() ||
      event.sequence !== index + 1 ||
      !/^\d{4}-\d{2}-\d{2}T/.test(event.eventAt) ||
      (index === 0 && event.eventKind !== "attested") ||
      (previous && event.eventKind === previous.eventKind) ||
      (event.eventKind === "attested" && event.manifestStatus !== "active") ||
      (event.eventKind === "revoked" && event.manifestStatus !== "revoked") ||
      (event.eventKind === "restored" && event.manifestStatus !== "active") ||
      (event.eventKind !== "attested" && !event.reason?.trim())
    )
      throw new Error("Yuanta credit-card v2 attestation event chain is invalid.");
    events.push(event);
  }
  if (rows.length > 0) assertCurrentV2Manifest(currentV2Manifest);
  return events;
}

function nextV2Sequence(db: DatabaseSync): number {
  return readV2Events(db).length + 1;
}

export function recordYuantaCreditCardHumanAttestationV2Event(
  db: DatabaseSync,
  event: YuantaCreditCardHumanAttestationEvent,
): void {
  ensureYuantaCreditCardHumanAttestationEvents(db);
  assertCurrentV2Manifest(currentV2Manifest);
  const previous = readV2Events(db);
  if (
    event.attestationId !== currentV2Manifest.attestationId ||
    event.evidenceVersion !== currentV2Manifest.evidenceVersion ||
    event.manifestFingerprint !== manifestFingerprintV2() ||
    event.sequence !== previous.length + 1 ||
    !/^\d{4}-\d{2}-\d{2}T/.test(event.eventAt) ||
    (event.eventKind === "attested" &&
      (event.manifestStatus !== "active" || previous.length !== 0)) ||
    (event.eventKind === "revoked" &&
      (event.manifestStatus !== "revoked" || previous.at(-1)?.eventKind !== "attested")) ||
    (event.eventKind === "restored" &&
      (event.manifestStatus !== "active" || previous.at(-1)?.eventKind !== "revoked")) ||
    (event.eventKind !== "attested" && !event.reason?.trim())
  )
    throw new Error(
      "Yuanta credit-card v2 attestation event does not match its append-only contract.",
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

export function latestYuantaCreditCardHumanAttestationV2Event(
  db: DatabaseSync,
): YuantaCreditCardHumanAttestationEvent | null {
  return readV2Events(db).at(-1) ?? null;
}

export function peekYuantaCreditCardHumanAttestationV2Status(
  db: DatabaseSync,
): "active" | "revoked" | null {
  if (!tableExists(db)) return null;
  return latestYuantaCreditCardHumanAttestationV2Event(db)?.manifestStatus ?? null;
}

export function recordInitialYuantaCreditCardHumanAttestationV2IfMissing(
  db: DatabaseSync,
  observedAt = YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.attestedAt,
): void {
  if (!isYuantaCreditCardHumanAttestedV2Active())
    throw new Error("Cannot attest a revoked Yuanta credit-card v2 manifest.");
  if (latestYuantaCreditCardHumanAttestationV2Event(db)) return;
  recordYuantaCreditCardHumanAttestationV2Event(db, {
    attestationId: currentV2Manifest.attestationId,
    evidenceVersion: currentV2Manifest.evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt: observedAt,
    reason: "user-confirmed-yuanta-credit-card-portfolio-v2",
    manifestFingerprint: manifestFingerprintV2(),
    sequence: 1,
  });
}

export function revokeYuantaCreditCardHumanAttestedV2(
  at: string,
  reason: string,
  db?: DatabaseSync,
): YuantaCreditCardHumanAttestedV2Manifest {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || !reason.trim())
    throw new Error("Yuanta credit-card v2 attestation revocation requires time and reason.");
  if (currentV2Manifest.status === "revoked") return currentV2Manifest;
  currentV2Manifest = deepFreeze({
    ...currentV2Manifest,
    status: "revoked" as const,
    revokedAt: at,
    revocationReason: reason.trim(),
  });
  VALIDATED_V2_MANIFESTS.add(currentV2Manifest);
  if (db)
    recordYuantaCreditCardHumanAttestationV2Event(db, {
      attestationId: currentV2Manifest.attestationId,
      evidenceVersion: currentV2Manifest.evidenceVersion,
      eventKind: "revoked",
      manifestStatus: "revoked",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprintV2(),
      sequence: nextV2Sequence(db),
    });
  return currentV2Manifest;
}

export function restoreYuantaCreditCardHumanAttestedV2(
  at: string,
  reason = "user-confirmed-restoration",
  db?: DatabaseSync,
): YuantaCreditCardHumanAttestedV2Manifest {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || !reason.trim())
    throw new Error("Yuanta credit-card v2 attestation restoration requires time and reason.");
  if (currentV2Manifest.status === "active") return currentV2Manifest;
  currentV2Manifest = deepFreeze({
    ...currentV2Manifest,
    status: "active" as const,
    revokedAt: null,
    revocationReason: null,
  });
  VALIDATED_V2_MANIFESTS.add(currentV2Manifest);
  if (db)
    recordYuantaCreditCardHumanAttestationV2Event(db, {
      attestationId: currentV2Manifest.attestationId,
      evidenceVersion: currentV2Manifest.evidenceVersion,
      eventKind: "restored",
      manifestStatus: "active",
      eventAt: at,
      reason: reason.trim(),
      manifestFingerprint: manifestFingerprintV2(),
      sequence: nextV2Sequence(db),
    });
  return currentV2Manifest;
}

export function isYuantaCreditCardHumanAttestationV2DurablyActive(
  db: DatabaseSync,
): boolean {
  if (!isYuantaCreditCardHumanAttestedV2Active()) return false;
  try {
    return latestYuantaCreditCardHumanAttestationV2Event(db)?.manifestStatus ===
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
