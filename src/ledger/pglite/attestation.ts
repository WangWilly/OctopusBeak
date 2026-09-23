import { randomUUID } from "node:crypto";
import type { PGliteTransaction } from "./transaction.ts";
import {
  PGLITE_ATTESTATION_TABLES,
  type PGliteAttestationTableName,
} from "./attestation-sql.ts";

export type PGliteAttestationFingerprint = `sha256:${string}`;

export type PGliteHumanAttestationProvider =
  | "cathay"
  | "ctbc"
  | "esun"
  | "fubon"
  | "hncb"
  | "post"
  | "sinopac"
  | "yuanta";

export type PGliteHumanAttestationStream =
  | "domestic-deposit"
  | "credit-card";

export type PGliteHumanAttestationRestoreEventKind =
  | "attested"
  | "restored"
  | null;

/**
 * Immutable worker-local authority metadata.
 *
 * Runtime status is intentionally absent.  It is derived from the durable
 * event chain, so a child request cannot make a revoked contract look active
 * by sending a forged `status` field.
 */
export type PGliteHumanAttestationManifest = Readonly<{
  provider: PGliteHumanAttestationProvider;
  stream: PGliteHumanAttestationStream;
  authorityRoute: string;
  attestationId: string;
  evidenceVersion: string;
  attestedAt: string;
  attestedBy: string;
  manifestFingerprint: PGliteAttestationFingerprint;
  tableName: PGliteAttestationTableName;
  providerGuaranteed: false;
  occurrenceProviderGuaranteed?: false;
  /** Whether this route is the current contract for a provider stream. */
  current: boolean;
  /** The provider-specific event kind used when a revoked contract is restored. */
  restoreEventKind: PGliteHumanAttestationRestoreEventKind;
}>;

/** Typed route metadata accepted at the worker boundary. */
export type PGliteHumanAttestationRouteMetadata = Readonly<{
  authorityRoute: string;
  attestationId?: string;
  evidenceVersion?: string;
  manifestFingerprint?: string;
  /** Optional copied flags are checked for false; status is never consulted. */
  providerGuaranteed?: unknown;
  occurrenceProviderGuaranteed?: unknown;
  status?: unknown;
}>;

export type PGliteHumanAttestationAdmissionMetadata =
  PGliteHumanAttestationRouteMetadata &
    Readonly<{
      /** Unknown routes are source-only only when this is not set to true. */
      required?: boolean;
    }>;

export type PGliteHumanAttestationManifestInput = Readonly<{
  authorityRoute: string;
  attestationId: string;
  evidenceVersion: string;
  manifestFingerprint: string;
  providerGuaranteed?: unknown;
  occurrenceProviderGuaranteed?: unknown;
  /** Accepted for compatibility, but deliberately ignored for authority. */
  status?: unknown;
}>;

export type PGliteHumanAttestationEventKind =
  | "attested"
  | "revoked"
  | "restored";

export type PGliteHumanAttestationManifestStatus = "active" | "revoked";

export type PGliteHumanAttestationEvent = Readonly<{
  attestationId: string;
  evidenceVersion: string;
  eventKind: PGliteHumanAttestationEventKind;
  manifestStatus: PGliteHumanAttestationManifestStatus;
  eventAt: string;
  reason: string;
  manifestFingerprint: PGliteAttestationFingerprint;
  sequence: number;
}>;

export type PGliteHumanAttestationStatus = Readonly<{
  authorityRoute: string;
  attestationId: string;
  evidenceVersion: string;
  manifestFingerprint: PGliteAttestationFingerprint;
  status: "uninitialized" | PGliteHumanAttestationManifestStatus;
  latestEvent: PGliteHumanAttestationEvent | null;
  sequence: number;
}>;

export type PGliteHumanAttestationRevokeCommand =
  PGliteHumanAttestationRouteMetadata & Readonly<{
    at: string;
    reason: string;
  }>;

export type PGliteHumanAttestationRestoreCommand =
  PGliteHumanAttestationRouteMetadata & Readonly<{
    at: string;
    reason: string;
  }>;

export type PGliteHumanAttestationErrorCode =
  | "unknown-route"
  | "manifest-mismatch"
  | "invalid-manifest"
  | "chain-invalid"
  | "inactive"
  | "not-initialized"
  | "restore-unsupported"
  | "invalid-command";

export class PGliteHumanAttestationError extends Error {
  readonly code: PGliteHumanAttestationErrorCode;

  constructor(
    code: PGliteHumanAttestationErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PGliteHumanAttestationError";
    this.code = code;
  }
}

function manifest(
  value: Omit<PGliteHumanAttestationManifest, "providerGuaranteed"> & {
    providerGuaranteed?: false;
  },
): PGliteHumanAttestationManifest {
  return Object.freeze({
    ...value,
    providerGuaranteed: false,
  });
}

/**
 * The local authority registry is intentionally duplicated from the pure
 * contract metadata in canonical/*.  Importing the SQLite modules here would
 * pull a synchronous database engine into the worker bundle.
 */
export const PGLITE_HUMAN_ATTESTATION_MANIFESTS = Object.freeze([
  manifest({
    provider: "cathay",
    stream: "domestic-deposit",
    authorityRoute: "cathay/domestic-deposit/human-attested-v1",
    attestationId: "cathay-domestic-deposit-human-attested-v1",
    evidenceVersion: "human-attested-v1",
    attestedAt: "2026-08-22",
    attestedBy: "user-confirmed-cathay-observed-human-attested",
    manifestFingerprint:
      "sha256:4f443b3c1b6d58ee57c4ac84a1e09e41b40a98f1c7d0d8b7bf5d8f5e3a0b6c21",
    tableName: "cathay_attestation_events",
    current: true,
    restoreEventKind: "attested",
  }),
  manifest({
    provider: "ctbc",
    stream: "domestic-deposit",
    authorityRoute: "ctbc/domestic-deposit/human-attested-v1",
    attestationId: "ctbc-domestic-deposit-human-attested-v1",
    evidenceVersion: "human-attested-v1",
    attestedAt: "2026-08-24",
    attestedBy: "user-confirmed-ctbc-observed-human-attested-2026-08-24",
    manifestFingerprint:
      "sha256:111ba05815bc0ac82156617c96e3538f81226c54fdbbe4f5b2325230690e9778",
    tableName: "ctbc_attestation_events",
    current: true,
    restoreEventKind: "attested",
  }),
  manifest({
    provider: "esun",
    stream: "credit-card",
    authorityRoute: "esun/credit-card/human-attested-v1",
    attestationId: "esun-credit-card-human-attested-v1",
    evidenceVersion: "esun/credit-card/human-attested-v1",
    attestedAt: "2026-08-26T00:00:00.000Z",
    attestedBy: "user-confirmed-esun-credit-card-primary-cardholder-portfolio",
    manifestFingerprint:
      "sha256:-_DQC8HqYl6kXBD9AeWFHRxQVNhaT0T0sIpIRyaGTR4",
    tableName: "esun_credit_card_attestation_events",
    current: false,
    occurrenceProviderGuaranteed: false,
    restoreEventKind: "restored",
  }),
  manifest({
    provider: "esun",
    stream: "credit-card",
    authorityRoute: "esun/credit-card/human-attested-v2",
    attestationId: "esun-credit-card-human-attested-v2",
    evidenceVersion: "esun/credit-card/human-attested-v2",
    attestedAt: "2026-08-27T00:00:00.000Z",
    attestedBy: "user-confirmed-esun-credit-card-primary-cardholder-portfolio",
    manifestFingerprint:
      "sha256:gY7YH5F676w3tHxCKKor5THe5kZIOGpkUcKGFYLx1Z4",
    tableName: "esun_credit_card_attestation_events",
    current: true,
    occurrenceProviderGuaranteed: false,
    restoreEventKind: "restored",
  }),
  manifest({
    provider: "fubon",
    stream: "credit-card",
    authorityRoute: "fubon/credit-card/human-attested-v1",
    attestationId: "fubon-credit-card-human-attested-v1",
    evidenceVersion: "fubon/credit-card/human-attested-v1",
    attestedAt: "2026-08-25T00:00:00.000Z",
    attestedBy: "human-confirmed-independent-primary-card-billing-accounts",
    manifestFingerprint:
      "sha256:XqhyMo4ijyxMcjTnM8vgcBHDG-Pzn_omnM7DVWp5lLc",
    tableName: "fubon_credit_card_attestation_events",
    current: false,
    occurrenceProviderGuaranteed: false,
    restoreEventKind: "restored",
  }),
  manifest({
    provider: "fubon",
    stream: "credit-card",
    authorityRoute: "fubon/credit-card/human-attested-v2",
    attestationId: "fubon-credit-card-human-attested-v2",
    evidenceVersion: "fubon/credit-card/human-attested-v2",
    attestedAt: "2026-08-25T00:00:00.000Z",
    attestedBy: "human-confirmed-primary-cardholder-portfolio",
    manifestFingerprint:
      "sha256:ieTzCkwR2SP6gNT4ZNlF8gahKrpc8kYFKtwSTP-_PLY",
    tableName: "fubon_credit_card_attestation_events",
    current: true,
    occurrenceProviderGuaranteed: false,
    restoreEventKind: "restored",
  }),
  manifest({
    provider: "fubon",
    stream: "domestic-deposit",
    authorityRoute: "fubon/domestic-deposit/human-attested-v1",
    attestationId: "fubon-domestic-deposit-human-attested-v1",
    evidenceVersion: "human-attested-v1",
    attestedAt: "2026-08-21",
    attestedBy: "user-confirmed-1A-2A-3A",
    manifestFingerprint:
      "sha256:1758d3b97375cf82f7d6619482d57b5e16bb4f236d44834043b606bd28af26b8",
    tableName: "fubon_attestation_events",
    current: true,
    restoreEventKind: null,
  }),
  manifest({
    provider: "hncb",
    stream: "domestic-deposit",
    authorityRoute: "hncb/domestic-deposit/human-attested-v1",
    attestationId: "hncb-domestic-deposit-human-attested-v1",
    evidenceVersion: "human-attested-v1",
    attestedAt: "2026-08-23",
    attestedBy: "user-confirmed-hncb-observed-human-attested-2026-08-23",
    manifestFingerprint:
      "sha256:7a4fd7a0f22f4c5d933d5f3b5b5bf9ac52f1dd0e9d6b4d4d0d9ad4a1fcb5e3b1",
    tableName: "hncb_attestation_events",
    current: true,
    restoreEventKind: "attested",
  }),
  manifest({
    provider: "post",
    stream: "domestic-deposit",
    authorityRoute: "post/domestic-deposit/human-attested-v1",
    attestationId: "post-domestic-deposit-human-attested-v1",
    evidenceVersion: "human-attested-v1",
    attestedAt: "2026-08-24",
    attestedBy: "user-confirmed-post-observed-human-attested-2026-08-24",
    manifestFingerprint:
      "sha256:5b2698c998f1335476ff1d0bc9009294afdbd18576fa728c20a0563fcdb30bf4",
    tableName: "post_attestation_events",
    current: true,
    restoreEventKind: "attested",
  }),
  manifest({
    provider: "sinopac",
    stream: "domestic-deposit",
    authorityRoute: "sinopac/domestic-deposit/human-attested-v1",
    attestationId: "sinopac-domestic-deposit-human-attested-v1",
    evidenceVersion: "human-attested-v1",
    attestedAt: "2026-08-23",
    attestedBy: "user-confirmed-sinopac-observed-human-attested-2026-08-23",
    manifestFingerprint:
      "sha256:ec011375014d525e074d9928cb78ed72355048652a655548904ff9ae3c4d90a1",
    tableName: "sinopac_attestation_events",
    current: true,
    restoreEventKind: "attested",
  }),
  manifest({
    provider: "yuanta",
    stream: "credit-card",
    authorityRoute: "yuanta/credit-card/human-attested-v1",
    attestationId: "yuanta-credit-card-human-attested-v1",
    evidenceVersion: "yuanta/credit-card/human-attested-v1",
    attestedAt: "2026-08-26T00:00:00.000+08:00",
    attestedBy: "user-confirmed-yuanta-credit-card-portfolio",
    manifestFingerprint:
      "sha256:K7W0Lh8wT8mM3FqkKx8tR4zD4e5p7vJ2nB1sC6aQ9xE",
    tableName: "yuanta_credit_card_attestation_events",
    current: false,
    occurrenceProviderGuaranteed: false,
    restoreEventKind: "restored",
  }),
  manifest({
    provider: "yuanta",
    stream: "credit-card",
    authorityRoute: "yuanta/credit-card/human-attested-v2",
    attestationId: "yuanta-credit-card-human-attested-v2",
    evidenceVersion: "yuanta/credit-card/human-attested-v2",
    attestedAt: "2026-08-27T00:00:00.000+08:00",
    attestedBy: "user-confirmed-yuanta-credit-card-portfolio",
    manifestFingerprint:
      "sha256:hDf7LDFMLfJMUHk5uGhA8rCscjhOLggZVAs6OzYf-YE",
    tableName: "yuanta_credit_card_attestation_events",
    current: true,
    occurrenceProviderGuaranteed: false,
    restoreEventKind: "restored",
  }),
  manifest({
    provider: "yuanta",
    stream: "domestic-deposit",
    authorityRoute: "yuanta/domestic-deposit/human-attested-v1",
    attestationId: "yuanta-domestic-deposit-human-attested-v1",
    evidenceVersion: "human-attested-v1",
    attestedAt: "2026-08-21",
    attestedBy: "user-confirmed-yuanta-observed-human-attested-2026-08-21",
    manifestFingerprint:
      "sha256:e3615c1a8f886ca9edeb057b8005131c8ccdbcf0d757c6fce9ae90f5bd95ef86",
    tableName: "yuanta_attestation_events",
    current: false,
    restoreEventKind: "attested",
  }),
  manifest({
    provider: "yuanta",
    stream: "domestic-deposit",
    authorityRoute: "yuanta/domestic-deposit/human-attested-v2",
    attestationId: "yuanta-domestic-deposit-human-attested-v3",
    evidenceVersion: "human-attested-v2",
    attestedAt: "2026-08-21",
    attestedBy: "user-confirmed-yuanta-observed-human-attested-2026-08-21",
    manifestFingerprint:
      "sha256:23b68bf37380e5a9c284abb34ca76d713f5748efcb207dce54c62f2261a407de",
    tableName: "yuanta_attestation_events",
    current: true,
    restoreEventKind: "attested",
  }),
] as const);

export type PGliteHumanAttestationRouteKey =
  (typeof PGLITE_HUMAN_ATTESTATION_MANIFESTS)[number]["authorityRoute"];

export const PGLITE_HUMAN_ATTESTATION_ROUTE_REGISTRY: Readonly<
  Record<string, PGliteHumanAttestationManifest>
> = Object.freeze(
  Object.fromEntries(
    PGLITE_HUMAN_ATTESTATION_MANIFESTS.map((entry) => [
      entry.authorityRoute,
      entry,
    ]),
  ),
);

/** Explicit inventory alias used by baseline and admission integration. */
export const PGLITE_HUMAN_ATTESTATION_CONTRACT_INVENTORY =
  PGLITE_HUMAN_ATTESTATION_MANIFESTS;

function fail(
  code: PGliteHumanAttestationErrorCode,
  message: string,
): never {
  throw new PGliteHumanAttestationError(code, message);
}

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    fail("invalid-manifest", `${label} is required.`);
  return value;
}

function routeFor(
  metadata: PGliteHumanAttestationRouteMetadata,
): PGliteHumanAttestationManifest {
  const authorityRoute = nonEmptyText(metadata?.authorityRoute, "Authority route");
  const known = Object.prototype.hasOwnProperty.call(
    PGLITE_HUMAN_ATTESTATION_ROUTE_REGISTRY,
    authorityRoute,
  )
    ? PGLITE_HUMAN_ATTESTATION_ROUTE_REGISTRY[authorityRoute]
    : undefined;
  if (!known)
    fail(
      "unknown-route",
      `No local human-attestation contract is registered for ${authorityRoute}.`,
    );
  if (
    metadata.attestationId !== undefined &&
    metadata.attestationId !== known.attestationId
  )
    fail("manifest-mismatch", "Attestation ID does not match the local contract.");
  if (
    metadata.evidenceVersion !== undefined &&
    metadata.evidenceVersion !== known.evidenceVersion
  )
    fail(
      "manifest-mismatch",
      "Attestation evidence version does not match the local contract.",
    );
  if (
    metadata.manifestFingerprint !== undefined &&
    metadata.manifestFingerprint !== known.manifestFingerprint
  )
    fail(
      "manifest-mismatch",
      "Attestation manifest fingerprint does not match the local contract.",
    );
  if (
    metadata.providerGuaranteed !== undefined &&
    metadata.providerGuaranteed !== false
  )
    fail("manifest-mismatch", "Human-attestation provider guarantees must be false.");
  if (
    metadata.occurrenceProviderGuaranteed !== undefined &&
    metadata.occurrenceProviderGuaranteed !== false
  )
    fail(
      "manifest-mismatch",
      "Human-attestation occurrence guarantees must be false.",
    );
  return known;
}

/** Validate a serialized manifest against the worker's immutable registry. */
export function assertPGliteHumanAttestationManifest(
  input: PGliteHumanAttestationManifestInput,
): PGliteHumanAttestationManifest {
  if (!input || typeof input !== "object")
    fail("invalid-manifest", "A human-attestation manifest is required.");
  nonEmptyText(input.attestationId, "Attestation ID");
  nonEmptyText(input.evidenceVersion, "Attestation evidence version");
  nonEmptyText(input.manifestFingerprint, "Attestation manifest fingerprint");
  return routeFor(input);
}

/** Validate typed route metadata against the known local authority registry. */
export function assertPGliteHumanAttestationRoute(
  metadata: PGliteHumanAttestationRouteMetadata,
): PGliteHumanAttestationManifest {
  return routeFor(metadata);
}

export function getPGliteHumanAttestationRoute(
  authorityRoute: string,
): PGliteHumanAttestationManifest | undefined {
  return Object.prototype.hasOwnProperty.call(
    PGLITE_HUMAN_ATTESTATION_ROUTE_REGISTRY,
    authorityRoute,
  )
    ? PGLITE_HUMAN_ATTESTATION_ROUTE_REGISTRY[authorityRoute]
    : undefined;
}

export function requirePGliteHumanAttestationRoute(
  authorityRoute: string,
): PGliteHumanAttestationManifest {
  return routeFor({ authorityRoute });
}

/** Source-only routes have no entry in this registry and remain admissible. */
export function isPGliteHumanAttestationRoute(authorityRoute: string): boolean {
  return getPGliteHumanAttestationRoute(authorityRoute) !== undefined;
}

type EventRow = Readonly<{
  attestation_id?: unknown;
  evidence_version?: unknown;
  event_kind?: unknown;
  manifest_status?: unknown;
  event_at?: unknown;
  reason?: unknown;
  manifest_fingerprint?: unknown;
  event_sequence?: unknown;
}>;

function validEventAt(
  value: string,
  contract?: PGliteHumanAttestationManifest,
): boolean {
  return (
    (contract?.stream === "credit-card"
      ? /^\d{4}-\d{2}-\d{2}T/u.test(value)
      : /^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(value)) &&
    Number.isFinite(Date.parse(value))
  );
}

function eventAtMillis(value: string): number {
  return Date.parse(value);
}

function numberValue(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    fail("chain-invalid", `${label} is not a safe integer.`);
  return result;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") fail("chain-invalid", `${label} is invalid.`);
  return value;
}

function eventFromRow(row: EventRow): PGliteHumanAttestationEvent {
  const eventKind = stringValue(row.event_kind, "Attestation event kind");
  const manifestStatus = stringValue(
    row.manifest_status,
    "Attestation manifest status",
  );
  const fingerprint = stringValue(
    row.manifest_fingerprint,
    "Attestation manifest fingerprint",
  );
  if (
    eventKind !== "attested" &&
    eventKind !== "revoked" &&
    eventKind !== "restored"
  )
    fail("chain-invalid", "Attestation event kind is invalid.");
  if (manifestStatus !== "active" && manifestStatus !== "revoked")
    fail("chain-invalid", "Attestation manifest status is invalid.");
  if (!/^sha256:.+/u.test(fingerprint))
    fail("chain-invalid", "Attestation manifest fingerprint is invalid.");
  const reason = row.reason === null || row.reason === undefined
    ? ""
    : stringValue(row.reason, "Attestation event reason");
  return {
    attestationId: stringValue(row.attestation_id, "Attestation ID"),
    evidenceVersion: stringValue(row.evidence_version, "Attestation evidence version"),
    eventKind,
    manifestStatus,
    eventAt: stringValue(row.event_at, "Attestation event time"),
    reason,
    manifestFingerprint: fingerprint as PGliteAttestationFingerprint,
    sequence: numberValue(row.event_sequence, "Attestation event sequence"),
  };
}

function validateChain(
  contract: PGliteHumanAttestationManifest,
  events: readonly PGliteHumanAttestationEvent[],
): void {
  let previous: PGliteHumanAttestationEvent | undefined;
  for (const [index, event] of events.entries()) {
    if (
      event.attestationId !== contract.attestationId ||
      event.evidenceVersion !== contract.evidenceVersion ||
      event.manifestFingerprint !== contract.manifestFingerprint ||
      event.sequence !== index + 1 ||
      !validEventAt(event.eventAt, contract) ||
      !event.reason.trim()
    )
      fail("chain-invalid", "Human-attestation event chain is invalid.");
    if (
      (event.eventKind === "attested" && event.manifestStatus !== "active") ||
      (event.eventKind === "revoked" && event.manifestStatus !== "revoked") ||
      (event.eventKind === "restored" && event.manifestStatus !== "active")
    )
      fail("chain-invalid", "Human-attestation event status is invalid.");
    if (!previous) {
      if (event.eventKind !== "attested")
        fail("chain-invalid", "Human-attestation chain must start attested.");
    } else {
      if (eventAtMillis(event.eventAt) < eventAtMillis(previous.eventAt))
        fail("chain-invalid", "Human-attestation event time is not monotonic.");
      if (event.eventKind === "revoked" && previous.manifestStatus !== "active")
        fail("chain-invalid", "Human-attestation revocation is out of order.");
      if (event.eventKind === "restored") {
        if (
          contract.restoreEventKind !== "restored" ||
          previous.manifestStatus !== "revoked"
        )
          fail("chain-invalid", "Human-attestation restoration is unsupported or out of order.");
      }
      if (event.eventKind === "attested") {
        if (
          contract.restoreEventKind !== "attested" ||
          previous.manifestStatus !== "revoked"
        )
          fail("chain-invalid", "Human-attestation attestation transition is out of order.");
      }
    }
    previous = event;
  }
}

function uuidBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
}

function commandTime(
  at: unknown,
  contract?: PGliteHumanAttestationManifest,
): string {
  const value = nonEmptyText(at, "Attestation event time");
  if (!validEventAt(value, contract))
    fail("invalid-command", "Attestation event time is invalid.");
  return value;
}

function commandReason(reason: unknown): string {
  const value = nonEmptyText(reason, "Attestation event reason").trim();
  if (!value) fail("invalid-command", "Attestation event reason is required.");
  return value;
}

async function readChainRows(
  transaction: PGliteTransaction,
  contract: PGliteHumanAttestationManifest,
): Promise<readonly PGliteHumanAttestationEvent[]> {
  const result = await transaction.query<EventRow>(
    `SELECT attestation_id, evidence_version, event_kind, manifest_status,
            event_at, reason, manifest_fingerprint, event_sequence
       FROM ${contract.tableName}
      WHERE attestation_id = $1
      ORDER BY event_sequence ASC, event_at ASC, event_id ASC`,
    [contract.attestationId],
  );
  const events = result.rows.map(eventFromRow);
  validateChain(contract, events);
  return events;
}

/** Read and validate the complete durable chain for a known route. */
export async function readPGliteHumanAttestationChain(
  transaction: PGliteTransaction,
  metadata: PGliteHumanAttestationRouteMetadata,
): Promise<readonly PGliteHumanAttestationEvent[]> {
  return readChainRows(transaction, routeFor(metadata));
}

export async function getPGliteHumanAttestationStatus(
  transaction: PGliteTransaction,
  metadata: PGliteHumanAttestationRouteMetadata,
): Promise<PGliteHumanAttestationStatus> {
  const contract = routeFor(metadata);
  const events = await readChainRows(transaction, contract);
  const latestEvent = events.at(-1) ?? null;
  return Object.freeze({
    authorityRoute: contract.authorityRoute,
    attestationId: contract.attestationId,
    evidenceVersion: contract.evidenceVersion,
    manifestFingerprint: contract.manifestFingerprint,
    status: latestEvent?.manifestStatus ?? "uninitialized",
    latestEvent,
    sequence: latestEvent?.sequence ?? 0,
  });
}

/** Financial admission uses this fail-closed assertion inside its own transaction. */
export async function assertPGliteHumanAttestationActive(
  transaction: PGliteTransaction,
  metadata: PGliteHumanAttestationRouteMetadata,
): Promise<PGliteHumanAttestationStatus> {
  const status = await getPGliteHumanAttestationStatus(transaction, metadata);
  if (status.status !== "active")
    throw new PGliteHumanAttestationError(
      "inactive",
      `Human-attestation authority ${status.authorityRoute} is ${status.status}; financial admission is blocked.`,
    );
  return status;
}

/**
 * Admission helper for mixed source/financial streams.  A route absent from
 * the local registry remains source-only by default.  Callers that know an
 * unknown route is supposed to require financial attestation must set
 * `required: true`, which fails closed instead of silently defaulting active.
 */
export async function assertPGliteHumanAttestationIfRequired(
  transaction: PGliteTransaction,
  metadata: PGliteHumanAttestationAdmissionMetadata,
): Promise<PGliteHumanAttestationStatus | null> {
  const contract = getPGliteHumanAttestationRoute(metadata.authorityRoute);
  if (!contract) {
    if (metadata.required === true)
      fail(
        "unknown-route",
        `Required human-attestation authority ${metadata.authorityRoute} is not registered locally.`,
      );
    return null;
  }
  return assertPGliteHumanAttestationActive(transaction, metadata);
}

async function insertEvent(
  transaction: PGliteTransaction,
  contract: PGliteHumanAttestationManifest,
  event: PGliteHumanAttestationEvent,
): Promise<PGliteHumanAttestationEvent> {
  await transaction.query(
    `INSERT INTO ${contract.tableName}(
       event_id, attestation_id, evidence_version, event_kind, manifest_status,
       event_at, reason, manifest_fingerprint, event_sequence
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      uuidBytes(),
      event.attestationId,
      event.evidenceVersion,
      event.eventKind,
      event.manifestStatus,
      event.eventAt,
      event.reason,
      event.manifestFingerprint,
      event.sequence,
    ],
  );
  return event;
}

/**
 * Append the first active event if and only if the durable chain is empty.
 * This must be called by the same caller-owned transaction as the financial
 * capture that relies on the attestation.
 */
export async function recordInitialPGliteHumanAttestationIfMissing(
  transaction: PGliteTransaction,
  metadata: PGliteHumanAttestationRouteMetadata,
  observedAt?: string,
): Promise<PGliteHumanAttestationEvent> {
  const contract = routeFor(metadata);
  const existing = await readChainRows(transaction, contract);
  const latest = existing.at(-1);
  if (latest?.manifestStatus === "revoked")
    fail(
      "inactive",
      `Cannot re-attest revoked human-attestation authority ${contract.authorityRoute}; use its explicit restore command when supported.`,
    );
  if (latest) return latest;
  const eventAt = commandTime(observedAt ?? contract.attestedAt, contract);
  return insertEvent(transaction, contract, {
    attestationId: contract.attestationId,
    evidenceVersion: contract.evidenceVersion,
    eventKind: "attested",
    manifestStatus: "active",
    eventAt,
    reason: contract.attestedBy,
    manifestFingerprint: contract.manifestFingerprint,
    sequence: 1,
  });
}

/** Append a durable revocation event; repeated revocations are idempotent. */
export async function revokePGliteHumanAttestationInTransaction(
  transaction: PGliteTransaction,
  command: PGliteHumanAttestationRevokeCommand,
): Promise<PGliteHumanAttestationEvent> {
  const contract = routeFor(command);
  const eventAt = commandTime(command.at, contract);
  const reason = commandReason(command.reason);
  const events = await readChainRows(transaction, contract);
  const latest = events.at(-1);
  if (!latest)
    fail(
      "not-initialized",
      `Cannot revoke uninitialized human-attestation authority ${contract.authorityRoute}.`,
    );
  if (latest.manifestStatus === "revoked") return latest;
  if (eventAtMillis(eventAt) < eventAtMillis(latest.eventAt))
    fail("invalid-command", "Attestation revocation time must be monotonic.");
  return insertEvent(transaction, contract, {
    attestationId: contract.attestationId,
    evidenceVersion: contract.evidenceVersion,
    eventKind: "revoked",
    manifestStatus: "revoked",
    eventAt,
    reason,
    manifestFingerprint: contract.manifestFingerprint,
    sequence: latest.sequence + 1,
  });
}

/**
 * Provider-specific restoration is retained where the original contract had
 * a restoration operation.  Routes with no restoration contract fail closed.
 */
export async function restorePGliteHumanAttestationInTransaction(
  transaction: PGliteTransaction,
  command: PGliteHumanAttestationRestoreCommand,
): Promise<PGliteHumanAttestationEvent> {
  const contract = routeFor(command);
  const eventAt = commandTime(command.at, contract);
  const reason = commandReason(command.reason);
  if (!contract.restoreEventKind)
    fail(
      "restore-unsupported",
      `Human-attestation authority ${contract.authorityRoute} cannot be restored.`,
    );
  const events = await readChainRows(transaction, contract);
  const latest = events.at(-1);
  if (!latest)
    fail(
      "not-initialized",
      `Cannot restore uninitialized human-attestation authority ${contract.authorityRoute}.`,
    );
  if (latest.manifestStatus === "active") return latest;
  if (eventAtMillis(eventAt) < eventAtMillis(latest.eventAt))
    fail("invalid-command", "Attestation restoration time must be monotonic.");
  return insertEvent(transaction, contract, {
    attestationId: contract.attestationId,
    evidenceVersion: contract.evidenceVersion,
    eventKind: contract.restoreEventKind,
    manifestStatus: "active",
    eventAt,
    reason,
    manifestFingerprint: contract.manifestFingerprint,
    sequence: latest.sequence + 1,
  });
}

// Descriptive aliases used by worker command adapters.
export const recordPGliteHumanAttestationInitialInTransaction =
  recordInitialPGliteHumanAttestationIfMissing;
export const revokePGliteHumanAttestation =
  revokePGliteHumanAttestationInTransaction;
export const restorePGliteHumanAttestation =
  restorePGliteHumanAttestationInTransaction;

export { PGLITE_ATTESTATION_TABLES };
