import { createHash, randomBytes } from "node:crypto";
import { withCanonicalWriterQueue } from "./canonical-runtime.ts";
import {
  requireCanonicalSourceText,
  requireCanonicalSourceToken,
  stableCanonicalSourceJson,
  type CanonicalSourceEvidence,
  type CanonicalSourceRecord,
} from "./canonical-source-evidence.ts";
import {
  assertValidatedCanonicalDatabase,
} from "./canonical-schema-lifecycle.ts";
import {
  validateCanonicalSourceStore,
  type CanonicalSourceCommitResult,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";
import { canonicalSourceRouteRegistration } from "./canonical-source-route-registry.ts";

/** The pre-admission shape submitted by a provider adapter. */
export type CanonicalSourceCaptureAdmissionRequest = CanonicalSourceEvidence;

type EmbeddedCanonicalSourceRecord = CanonicalSourceRecord & {
  readonly recordKind?: string;
};

/** The only result exposed by Source Capture Admission. */
export type CanonicalSourceCaptureAdmissionReceipt = Readonly<{
  captureId: string;
  knowledgePoint: number;
}>;

export type CanonicalSourceCaptureAdmissionFailureReason =
  | "invalid-evidence"
  | "capture-overwrite"
  | "occurrence-conflict"
  | "authority-route-unregistered"
  | "authority-route-drift"
  | "invalid-transaction-capability"
  | "empty-batch"
  | "infrastructure";

/** Stable, machine-readable failure from the Source Capture Admission seam. */
export class CanonicalSourceCaptureAdmissionError extends Error {
  readonly reason: CanonicalSourceCaptureAdmissionFailureReason;
  readonly code: CanonicalSourceCaptureAdmissionFailureReason;

  constructor(
    reason: CanonicalSourceCaptureAdmissionFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CanonicalSourceCaptureAdmissionError";
    this.reason = reason;
    this.code = reason;
  }
}

const CANONICAL_SOURCE_RUNTIME_BRAND = Symbol(
  "canonical-source-runtime-validated-v8",
);
const SOURCE_DATE = /^\d{8}$/;
const FORBIDDEN_SOURCE_KEY_PARTS = new Set([
  "raw",
  "header",
  "headers",
  "cookie",
  "cookies",
  "password",
  "secret",
  "credential",
  "credentials",
  "token",
  "tokens",
]);

function isForbiddenSourceKey(key: string): boolean {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((part) => FORBIDDEN_SOURCE_KEY_PARTS.has(part));
}

type RuntimeValidatedSourceEvidence = CanonicalSourceEvidence & {
  readonly [CANONICAL_SOURCE_RUNTIME_BRAND]: true;
};

class CanonicalSourceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalSourceConflictError";
  }
}

function requireSourceDate(
  value: unknown,
  label: string,
  format: "YYYYMMDD" | "YYYY-MM-DD" = "YYYYMMDD",
): string {
  const text = requireCanonicalSourceText(value, label);
  const normalized = format === "YYYY-MM-DD" ? text.replaceAll("-", "") : text;
  if (
    (format === "YYYYMMDD" && !SOURCE_DATE.test(text)) ||
    (format === "YYYY-MM-DD" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !SOURCE_DATE.test(normalized)))
  )
    throw new Error(`${label} must be ${format}.`);
  const date = new Date(
    Date.UTC(
      Number(normalized.slice(0, 4)),
      Number(normalized.slice(4, 6)) - 1,
      Number(normalized.slice(6, 8)),
    ),
  );
  if (
    date.getUTCFullYear() !== Number(normalized.slice(0, 4)) ||
    date.getUTCMonth() !== Number(normalized.slice(4, 6)) - 1 ||
    date.getUTCDate() !== Number(normalized.slice(6, 8))
  )
    throw new Error(`${label} must be a calendar date.`);
  return text;
}

function assertCompactSourceValue(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error(`${path} contains a non-exact number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertCompactSourceValue(entry, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (isForbiddenSourceKey(key))
        throw new Error(`${path}.${key} is not compact source evidence.`);
      assertCompactSourceValue(entry, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} contains an unsupported value.`);
}

function validateSourceEvidence(evidence: CanonicalSourceEvidence): void {
  requireCanonicalSourceText(evidence.captureId, "Capture ID");
  requireCanonicalSourceText(
    evidence.integrationNamespace,
    "Integration namespace",
  );
  requireCanonicalSourceToken(
    evidence.sourceConnectionKey,
    "Source connection key",
  );
  requireCanonicalSourceToken(evidence.identityEpoch, "Identity epoch");
  requireCanonicalSourceText(evidence.stream, "Stream");
  requireCanonicalSourceText(evidence.recordKind, "Record kind");
  requireCanonicalSourceText(evidence.routeKey, "Authority route");
  requireCanonicalSourceText(evidence.contractVersion, "Contract version");
  requireCanonicalSourceToken(evidence.subjectDigest, "Subject digest");
  if (!Number.isFinite(Date.parse(evidence.observedAt)))
    throw new Error("Observed at must be RFC3339.");
  const dateFormat = evidence.scope.dateFormat ?? "YYYYMMDD";
  if (dateFormat !== "YYYYMMDD" && dateFormat !== "YYYY-MM-DD")
    throw new Error("Source scope date format is unsupported.");
  const start = requireSourceDate(
    evidence.scope.startDate,
    "Scope start",
    dateFormat,
  );
  const end = requireSourceDate(evidence.scope.endDate, "Scope end", dateFormat);
  if (start > end) throw new Error("Scope start must not be after scope end.");
  if (
    evidence.scope.kind !== "bounded-range" &&
    evidence.scope.kind !== "point-in-time"
  )
    throw new Error("Source scope kind is unsupported.");
  if (
    evidence.scope.absenceAuthority !== undefined &&
    evidence.scope.absenceAuthority !== "comparable-complete-range" &&
    evidence.scope.absenceAuthority !== "provider-explicit-no-data"
  )
    throw new Error("Source absence authority is unsupported.");
  requireCanonicalSourceText(
    evidence.scope.ruleVersion,
    "Completeness rule version",
  );
  if (evidence.scope.completenessBasis !== undefined)
    requireCanonicalSourceText(
      evidence.scope.completenessBasis,
      "Completeness basis",
    );
  if (evidence.scope.contractFingerprint !== undefined)
    requireCanonicalSourceToken(
      evidence.scope.contractFingerprint,
      "Contract fingerprint",
    );
  if (evidence.scope.preflightFingerprint !== undefined)
    requireCanonicalSourceToken(
      evidence.scope.preflightFingerprint,
      "Preflight fingerprint",
    );
  const pageTerminalPolicy = evidence.scope.pageTerminalPolicy ?? "last";
  if (pageTerminalPolicy !== "last" && pageTerminalPolicy !== "each")
    throw new Error("Source page terminal policy is unsupported.");
  if (!Array.isArray(evidence.pages) || evidence.pages.length === 0)
    throw new Error("At least one source page is required.");
  let rowCount = 0;
  evidence.pages.forEach((page, index) => {
    if (
      page.pageOrdinal !== index ||
      page.responseCode !== "200" ||
      page.terminal !==
        (pageTerminalPolicy === "each" || index === evidence.pages.length - 1)
    )
      throw new Error(
        "Source page sequence/status/terminal marker is inconsistent.",
      );
    if (!Number.isSafeInteger(page.rowCount) || page.rowCount < 0)
      throw new Error("Source page row count is invalid.");
    assertCompactSourceValue(page.metadata, `page[${index}].metadata`);
    rowCount += page.rowCount;
  });
  if (!Array.isArray(evidence.records) || rowCount !== evidence.records.length)
    throw new Error("Source page counts do not match compact records.");
  const occurrences = new Set<string>();
  evidence.records.forEach((record, index) => {
    requireCanonicalSourceToken(
      record.occurrenceKey,
      `Record ${index} occurrence key`,
    );
    if (record.collisionKey !== undefined)
      requireCanonicalSourceToken(
        record.collisionKey,
        `Record ${index} collision key`,
      );
    if (record.providerKey !== "human-attested:no-provider-key")
      requireCanonicalSourceToken(
        record.providerKey,
        `Record ${index} provider key`,
      );
    requireCanonicalSourceToken(
      record.contentHash,
      `Record ${index} content hash`,
    );
    if (occurrences.has(record.occurrenceKey))
      throw new CanonicalSourceConflictError(
        "Duplicate occurrence in one capture.",
      );
    occurrences.add(record.occurrenceKey);
    if (
      !record.compact ||
      typeof record.compact !== "object" ||
      Array.isArray(record.compact)
    )
      throw new Error(`Record ${index} compact payload must be an object.`);
    assertCompactSourceValue(record.compact, `record[${index}].compact`);
  });
}

function validateAdditionalRecords(
  evidence: CanonicalSourceEvidence,
  additionalRecords: readonly EmbeddedCanonicalSourceRecord[],
): void {
  const occurrences = new Set(evidence.records.map((record) => record.occurrenceKey));
  additionalRecords.forEach((record, index) => {
    requireCanonicalSourceToken(
      record.occurrenceKey,
      `Additional record ${index} occurrence key`,
    );
    if (record.collisionKey !== undefined)
      requireCanonicalSourceToken(
        record.collisionKey,
        `Additional record ${index} collision key`,
      );
    if (record.providerKey !== "human-attested:no-provider-key")
      requireCanonicalSourceToken(
        record.providerKey,
        `Additional record ${index} provider key`,
      );
    requireCanonicalSourceToken(
      record.contentHash,
      `Additional record ${index} content hash`,
    );
    if (record.recordKind !== undefined)
      requireCanonicalSourceText(
        record.recordKind,
        `Additional record ${index} kind`,
      );
    if (occurrences.has(record.occurrenceKey))
      throw new CanonicalSourceConflictError(
        "Duplicate occurrence in one capture.",
      );
    occurrences.add(record.occurrenceKey);
    if (
      !record.compact ||
      typeof record.compact !== "object" ||
      Array.isArray(record.compact)
    )
      throw new Error(
        `Additional record ${index} compact payload must be an object.`,
      );
    assertCompactSourceValue(
      record.compact,
      `additionalRecord[${index}].compact`,
    );
  });
}

function admitSourceEvidence(
  evidence: CanonicalSourceEvidence,
): RuntimeValidatedSourceEvidence {
  validateSourceEvidence(evidence);
  Object.defineProperty(evidence, CANONICAL_SOURCE_RUNTIME_BRAND, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return evidence as RuntimeValidatedSourceEvidence;
}

function routeError(request: CanonicalSourceCaptureAdmissionRequest): void {
  const registration = canonicalSourceRouteRegistration(request.routeKey);
  if (!registration)
    throw new CanonicalSourceCaptureAdmissionError(
      "authority-route-unregistered",
      `Authority route ${request.routeKey} is not registered.`,
    );
  if (
    registration.integrationNamespace !== request.integrationNamespace ||
    registration.stream !== request.stream
  )
    throw new CanonicalSourceCaptureAdmissionError(
      "authority-route-drift",
      `Authority route ${request.routeKey} expected ${registration.integrationNamespace}/${registration.stream} but received ${request.integrationNamespace}/${request.stream}.`,
    );
  if (!registration.contractVersions.includes(request.contractVersion))
    throw new CanonicalSourceCaptureAdmissionError(
      "authority-route-drift",
      `Authority route ${request.routeKey} does not register contract version ${request.contractVersion}.`,
    );
}

function classifyAdmissionError(error: unknown): CanonicalSourceCaptureAdmissionError {
  if (error instanceof CanonicalSourceCaptureAdmissionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/capture overwrite/i.test(message))
    return new CanonicalSourceCaptureAdmissionError(
      "capture-overwrite",
      message,
      { cause: error },
    );
  if (/collision|occurrence/i.test(message))
    return new CanonicalSourceCaptureAdmissionError(
      "occurrence-conflict",
      message,
      { cause: error },
    );
  if (/authority route|contract drift/i.test(message))
    return new CanonicalSourceCaptureAdmissionError(
      "authority-route-drift",
      message,
      { cause: error },
    );
  if (/source evidence|capture id|scope|source page|record|opaque token|RFC3339|compact/i.test(message))
    return new CanonicalSourceCaptureAdmissionError(
      "invalid-evidence",
      message,
      { cause: error },
    );
  return new CanonicalSourceCaptureAdmissionError("infrastructure", message, {
    cause: error,
  });
}

type CanonicalSourceCaptureAdmissionTransactionState = {
  readonly store: CanonicalSourceStore;
  active: boolean;
};

const TRANSACTION_CAPABILITIES = new WeakMap<
  object,
  CanonicalSourceCaptureAdmissionTransactionState
>();

/**
 * This is deliberately an opaque object type.  The only objects accepted by
 * the embedded operation are minted into the private WeakMap while the
 * transaction helper is active; copying properties or symbols cannot forge
 * membership.
 */
export type CanonicalSourceCaptureAdmissionTransactionCapability = object & {
  readonly __canonicalSourceCaptureAdmissionCapability?: never;
  readonly admit: (
    request: CanonicalSourceCaptureAdmissionRequest,
    additionalRecords?: readonly EmbeddedCanonicalSourceRecord[],
  ) => CanonicalSourceCaptureAdmissionTransactionResult;
  readonly persistLegacyCapture: (input: {
    captureId: Uint8Array;
    sourceConnectionId: Uint8Array;
    identityEpochId: Uint8Array;
    authorityRoute: string;
    stream: string;
    accountNo: string | null;
    observedAt: string;
    scopeStart: string;
    scopeEnd: string;
    completeness: string;
    completenessBasis: string;
    completenessRuleVersion: string;
    commitId: Uint8Array;
  }) => void;
  readonly persistLegacyAuthorityRoute: (input: {
    authorityRoute: string;
    integrationNamespace: string;
    stream: string;
    contractVersion: string;
    commitId: Uint8Array;
  }) => void;
  readonly ensureLegacySourceConnection: (input: {
    integrationNamespace: string;
    sourceConnectionKey: string;
    commitId: Uint8Array;
  }) => Buffer;
  readonly ensureLegacyIdentityEpoch: (input: {
    sourceConnectionId: Uint8Array;
    epochKey: string;
    commitId: Uint8Array;
  }) => Buffer;
  readonly persistLegacyScope: (input: {
    scopeId: Uint8Array;
    captureId: Uint8Array;
    sourceConnectionId: Uint8Array;
    identityEpochId: Uint8Array;
    accountId: Uint8Array;
    accountNo: string;
    stream: string;
    scopeStart: string;
    scopeEnd: string;
    scopeKind: string;
    completeness: string;
    completenessBasis: string;
    completenessRuleVersion: string;
    absenceAuthority: string | null;
    contractFingerprint: string;
    preflightFingerprint: string;
    pageCount: number;
    commitId: Uint8Array;
  }) => void;
  readonly persistLegacyPage: (input: {
    scopePageId: Uint8Array;
    scopeId: Uint8Array;
    pageOrdinal: number;
    terminal: boolean;
    rowCount: number;
    responseDigest: string;
    proofKind: string;
    contractFingerprint: string;
    preflightFingerprint: string;
    commitId: Uint8Array;
  }) => void;
  readonly persistLegacyRecord: (input: {
    sourceRecordId: Uint8Array;
    captureId: Uint8Array;
    commitId: Uint8Array;
    sequenceLexeme: string;
    description: string | null;
    payloadJson: string;
  }) => void;
  readonly persistLegacyRecordScope: (input: {
    sourceRecordId: Uint8Array;
    scopeId: Uint8Array;
    captureId: Uint8Array;
    accountId: Uint8Array;
    sequenceLexeme: string;
    commitId: Uint8Array;
  }) => void;
  readonly linkFinancialAccount: (input: {
    accountId: Uint8Array;
    scopeId: Uint8Array;
    sourceRecordIds: readonly Uint8Array[];
  }) => void;
};

/**
 * Internal context returned only to a transaction owner.  The public
 * admission operations project this down to the two-field receipt, while a
 * financial commit uses these IDs to attach its typed facts to the same
 * source commit.
 */
export type CanonicalSourceCaptureAdmissionTransactionResult = Readonly<{
  receipt: CanonicalSourceCaptureAdmissionReceipt;
  captureId: Buffer;
  scopeId: Buffer;
  commitId: Buffer;
  sourceConnectionId: Buffer;
  identityEpochId: Buffer;
  sourceSubjectId: Buffer;
  sourceRecordIds: readonly Buffer[];
}>;

function mintTransactionCapability(
  store: CanonicalSourceStore,
): CanonicalSourceCaptureAdmissionTransactionCapability {
  let capability!: CanonicalSourceCaptureAdmissionTransactionCapability;
  const admit = (
    request: CanonicalSourceCaptureAdmissionRequest,
    additionalRecords: readonly EmbeddedCanonicalSourceRecord[] = [],
  ): CanonicalSourceCaptureAdmissionTransactionResult =>
    admitWithinTransactionResult(store, request, capability, additionalRecords);
  const persistLegacyCapture = (
    input: Parameters<CanonicalSourceCaptureAdmissionTransactionCapability["persistLegacyCapture"]>[0],
  ): void => {
    requireTransactionCapability(store, capability);
    store.db.prepare(
      "INSERT INTO source_captures(capture_id, source_connection_id, identity_epoch_id, authority_route, stream, account_no, observed_at, scope_start, scope_end, completeness, completeness_basis, completeness_rule_version, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      input.captureId,
      input.sourceConnectionId,
      input.identityEpochId,
      input.authorityRoute,
      input.stream,
      input.accountNo,
      input.observedAt,
      input.scopeStart,
      input.scopeEnd,
      input.completeness,
      input.completenessBasis,
      input.completenessRuleVersion,
      input.commitId,
    );
  };
  const persistLegacyAuthorityRoute = (
    input: Parameters<CanonicalSourceCaptureAdmissionTransactionCapability["persistLegacyAuthorityRoute"]>[0],
  ): void => {
    requireTransactionCapability(store, capability);
    store.db.prepare(
      "INSERT OR IGNORE INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id) VALUES (?, ?, ?, ?, ?)",
    ).run(
      input.authorityRoute,
      input.integrationNamespace,
      input.stream,
      input.contractVersion,
      input.commitId,
    );
  };
  const ensureLegacySourceConnection = (
    input: Parameters<CanonicalSourceCaptureAdmissionTransactionCapability["ensureLegacySourceConnection"]>[0],
  ): Buffer => {
    requireTransactionCapability(store, capability);
    const existing = store.db.prepare(
      "SELECT source_connection_id FROM source_connections WHERE integration_namespace = ? AND source_connection_key = ?",
    ).get(input.integrationNamespace, input.sourceConnectionKey) as
      | { source_connection_id?: unknown }
      | undefined;
    if (existing) return blob(existing.source_connection_id);
    const sourceConnectionId = uuidV7();
    store.db.prepare(
      "INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id) VALUES (?, ?, ?, ?)",
    ).run(
      sourceConnectionId,
      input.integrationNamespace,
      input.sourceConnectionKey,
      input.commitId,
    );
    return sourceConnectionId;
  };
  const ensureLegacyIdentityEpoch = (
    input: Parameters<CanonicalSourceCaptureAdmissionTransactionCapability["ensureLegacyIdentityEpoch"]>[0],
  ): Buffer => {
    requireTransactionCapability(store, capability);
    const existing = store.db.prepare(
      "SELECT identity_epoch_id FROM identity_epochs WHERE source_connection_id = ? AND epoch_key = ?",
    ).get(input.sourceConnectionId, input.epochKey) as
      | { identity_epoch_id?: unknown }
      | undefined;
    if (existing) return blob(existing.identity_epoch_id);
    const identityEpochId = uuidV7();
    store.db.prepare(
      "INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id) VALUES (?, ?, ?, ?)",
    ).run(
      identityEpochId,
      input.sourceConnectionId,
      input.epochKey,
      input.commitId,
    );
    return identityEpochId;
  };
  const persistLegacyScope = (
    input: Parameters<CanonicalSourceCaptureAdmissionTransactionCapability["persistLegacyScope"]>[0],
  ): void => {
    requireTransactionCapability(store, capability);
    store.db.prepare(
      "INSERT INTO capture_scopes(scope_id, capture_id, source_connection_id, identity_epoch_id, account_id, account_no, stream, scope_start, scope_end, scope_kind, completeness, completeness_basis, completeness_rule_version, absence_authority, contract_fingerprint, preflight_fingerprint, page_count, terminal, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
    ).run(
      input.scopeId,
      input.captureId,
      input.sourceConnectionId,
      input.identityEpochId,
      input.accountId,
      input.accountNo,
      input.stream,
      input.scopeStart,
      input.scopeEnd,
      input.scopeKind,
      input.completeness,
      input.completenessBasis,
      input.completenessRuleVersion,
      input.absenceAuthority,
      input.contractFingerprint,
      input.preflightFingerprint,
      input.pageCount,
      input.commitId,
    );
  };
  const persistLegacyPage = (
    input: Parameters<CanonicalSourceCaptureAdmissionTransactionCapability["persistLegacyPage"]>[0],
  ): void => {
    requireTransactionCapability(store, capability);
    store.db.prepare(
      "INSERT INTO capture_scope_pages(scope_page_id, scope_id, page_ordinal, terminal, row_count, response_digest, proof_kind, contract_fingerprint, preflight_fingerprint, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      input.scopePageId,
      input.scopeId,
      input.pageOrdinal,
      input.terminal ? 1 : 0,
      input.rowCount,
      input.responseDigest,
      input.proofKind,
      input.contractFingerprint,
      input.preflightFingerprint,
      input.commitId,
    );
  };
  const persistLegacyRecord = (
    input: Parameters<CanonicalSourceCaptureAdmissionTransactionCapability["persistLegacyRecord"]>[0],
  ): void => {
    requireTransactionCapability(store, capability);
    store.db.prepare(
      "INSERT INTO source_records(source_record_id, capture_id, commit_id, sequence_lexeme, description, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      input.sourceRecordId,
      input.captureId,
      input.commitId,
      input.sequenceLexeme,
      input.description,
      input.payloadJson,
    );
  };
  const persistLegacyRecordScope = (
    input: Parameters<CanonicalSourceCaptureAdmissionTransactionCapability["persistLegacyRecordScope"]>[0],
  ): void => {
    requireTransactionCapability(store, capability);
    store.db.prepare(
      "INSERT INTO source_record_scopes(source_record_id, scope_id, capture_id, account_id, sequence_lexeme, commit_id) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      input.sourceRecordId,
      input.scopeId,
      input.captureId,
      input.accountId,
      input.sequenceLexeme,
      input.commitId,
    );
  };
  const linkFinancialAccount = (
    input: Parameters<CanonicalSourceCaptureAdmissionTransactionCapability["linkFinancialAccount"]>[0],
  ): void => {
    requireTransactionCapability(store, capability);
    store.db.prepare(
      "UPDATE capture_scopes SET account_id = ? WHERE scope_id = ?",
    ).run(input.accountId, input.scopeId);
    const linkRecord = store.db.prepare(
      "UPDATE source_record_scopes SET account_id = ? WHERE source_record_id = ? AND scope_id = ?",
    );
    for (const sourceRecordId of input.sourceRecordIds)
      linkRecord.run(input.accountId, sourceRecordId, input.scopeId);
  };
  capability = Object.freeze({
    admit,
    persistLegacyAuthorityRoute,
    ensureLegacySourceConnection,
    ensureLegacyIdentityEpoch,
    persistLegacyCapture,
    persistLegacyScope,
    persistLegacyPage,
    persistLegacyRecord,
    persistLegacyRecordScope,
    linkFinancialAccount,
  }) as
    CanonicalSourceCaptureAdmissionTransactionCapability;
  TRANSACTION_CAPABILITIES.set(capability, { store, active: true });
  return capability;
}

/** @internal Existing canonical owners use this only while their own atomic
 * transaction is active. The capability is revoked before control returns. */
export function withCanonicalSourceCaptureAdmissionExistingTransaction<T>(
  store: CanonicalSourceStore,
  operation: (
    capability: CanonicalSourceCaptureAdmissionTransactionCapability,
  ) => T,
): T {
  assertValidatedCanonicalDatabase(store.db);
  const capability = mintTransactionCapability(store);
  try {
    return operation(capability);
  } finally {
    revokeTransactionCapability(capability);
  }
}

function revokeTransactionCapability(
  capability: CanonicalSourceCaptureAdmissionTransactionCapability,
): void {
  const state = TRANSACTION_CAPABILITIES.get(capability);
  if (state) state.active = false;
}

function requireTransactionCapability(
  store: CanonicalSourceStore,
  capability: unknown,
): asserts capability is CanonicalSourceCaptureAdmissionTransactionCapability {
  if (
    capability === null ||
    (typeof capability !== "object" && typeof capability !== "function")
  )
    throw new CanonicalSourceCaptureAdmissionError(
      "invalid-transaction-capability",
      "Canonical source admission requires its transaction-scoped capability.",
    );
  const state = TRANSACTION_CAPABILITIES.get(capability);
  if (!state || state.store !== store || !state.active)
    throw new CanonicalSourceCaptureAdmissionError(
      "invalid-transaction-capability",
      "Canonical source admission capability is not active for this transaction.",
    );
}

function uuidV7(): Buffer {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());
  for (let index = 0; index < 6; index += 1)
    bytes[index] = Number((timestamp >> BigInt(40 - index * 8)) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes;
}

function blob(value: unknown): Buffer {
  if (value instanceof Uint8Array && value.byteLength === 16)
    return Buffer.from(value);
  throw new Error("Expected a 16-byte canonical ID blob.");
}

function sourceIdFor(...parts: string[]): Buffer {
  return createHash("sha256")
    .update(parts.join("\u0000"))
    .digest()
    .subarray(0, 16);
}

function sourceRecordContentMatches(
  recordKind: string,
  row: Record<string, unknown>,
  record: EmbeddedCanonicalSourceRecord,
): boolean {
  if (String(row.provider_key) !== record.providerKey) return false;
  const payloadJson =
    record.compactJson ?? stableCanonicalSourceJson(record.compact);
  if (!recordKind.endsWith("-credit-card-statement-summary"))
    return (
      String(row.content_hash) === record.contentHash &&
      String(row.payload_json) === payloadJson
    );
  try {
    const prior = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
    const next = JSON.parse(payloadJson) as Record<string, unknown>;
    delete prior.revisionKey;
    delete next.revisionKey;
    return stableCanonicalSourceJson(prior) === stableCanonicalSourceJson(next);
  } catch {
    return false;
  }
}

function nextSourceKnowledgeTime(store: CanonicalSourceStore): number {
  const candidate = store.commitClock();
  if (!Number.isSafeInteger(candidate) || candidate < 0)
    throw new Error(
      "Canonical source commit clock returned an invalid UTC microsecond value.",
    );
  const latest = Number(
    (
      store.db
        .prepare(
          "SELECT COALESCE(MAX(recorded_at_utc_us), -1) AS value FROM canonical_commits",
        )
        .get() as { value?: number }
    ).value ?? -1,
  );
  return Math.max(candidate, latest + 1);
}

/**
 * Store-local source persistence.  This is intentionally private to the
 * admission module: adapters receive only the public receipt and cannot call
 * a raw persistence helper or choose a transaction boundary.
 */
function persistWithinTransaction(
  store: CanonicalSourceStore,
  evidence: RuntimeValidatedSourceEvidence,
  additionalRecords: readonly EmbeddedCanonicalSourceRecord[] = [],
): CanonicalSourceCaptureAdmissionTransactionResult {
  if (!isRuntimeValidatedEvidence(evidence))
    throw new CanonicalSourceConflictError(
      "Source evidence is not runtime-validated.",
    );
  validateSourceEvidence(evidence);
  const db = store.db;

  if (
    db
      .prepare("SELECT 1 FROM source_captures WHERE capture_key = ?")
      .get(evidence.captureId)
  )
    throw new CanonicalSourceConflictError("Capture overwrite is forbidden.");

  const allRecords: readonly EmbeddedCanonicalSourceRecord[] = [
    ...evidence.records,
    ...additionalRecords,
  ];
  for (const record of allRecords) {
    const recordKind = record.recordKind ?? evidence.recordKind;
    if (record.collisionKey !== undefined) {
      const collisions = db
        .prepare(
          `SELECT record.occurrence_key FROM source_records record
           JOIN source_subjects subject ON subject.source_subject_id = record.source_subject_id
           JOIN source_connections connection ON connection.source_connection_id = subject.source_connection_id
           JOIN identity_epochs epoch ON epoch.identity_epoch_id = subject.identity_epoch_id
           WHERE connection.integration_namespace = ? AND connection.source_connection_key = ?
             AND epoch.epoch_key = ? AND subject.stream = ? AND record.record_kind = ?
             AND subject.subject_digest = ? AND record.collision_key = ?`,
        )
        .all(
          evidence.integrationNamespace,
          evidence.sourceConnectionKey,
          evidence.identityEpoch,
          evidence.stream,
          recordKind,
          evidence.subjectDigest,
          record.collisionKey,
        ) as Array<{ occurrence_key?: unknown }>;
      if (
        collisions.some(
          (row) => String(row.occurrence_key) !== record.occurrenceKey,
        )
      )
        throw new CanonicalSourceConflictError(
          "Source collision key maps to another occurrence; overwrite is forbidden.",
        );
    }
    const rows = db
      .prepare(
        `SELECT record.provider_key, record.content_hash, record.payload_json
         FROM source_records record
         JOIN source_subjects subject ON subject.source_subject_id = record.source_subject_id
         JOIN source_connections connection ON connection.source_connection_id = subject.source_connection_id
         JOIN identity_epochs epoch ON epoch.identity_epoch_id = subject.identity_epoch_id
         WHERE connection.integration_namespace = ? AND connection.source_connection_key = ?
           AND epoch.epoch_key = ? AND subject.stream = ? AND record.record_kind = ?
           AND subject.subject_digest = ? AND record.occurrence_key = ?`,
      )
      .all(
        evidence.integrationNamespace,
        evidence.sourceConnectionKey,
        evidence.identityEpoch,
        evidence.stream,
        recordKind,
        evidence.subjectDigest,
        record.occurrenceKey,
      ) as Array<Record<string, unknown>>;
    for (const row of rows)
      if (!sourceRecordContentMatches(recordKind, row, record))
        throw new CanonicalSourceConflictError(
          "Source occurrence content overwrite is forbidden.",
        );
  }

  const sequence = sourceCommitSequence(db);
  const commitId = uuidV7();
  const connectionId = sourceIdFor(
    "connection",
    evidence.integrationNamespace,
    evidence.sourceConnectionKey,
  );
  const epochId = sourceIdFor(
    "epoch",
    evidence.integrationNamespace,
    evidence.sourceConnectionKey,
    evidence.identityEpoch,
  );
  const subjectId = sourceIdFor(
    "subject",
    evidence.integrationNamespace,
    evidence.sourceConnectionKey,
    evidence.identityEpoch,
    evidence.stream,
    evidence.recordKind,
    evidence.subjectDigest,
  );
  const captureId = uuidV7();
  const scopeId = uuidV7();

  db.prepare(
    "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, 'source_capture')",
  ).run(
    commitId,
    sequence,
    nextSourceKnowledgeTime(store),
    evidence.routeKey,
  );
  db.prepare(
    "INSERT INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(authority_route) DO NOTHING",
  ).run(
    evidence.routeKey,
    evidence.integrationNamespace,
    evidence.stream,
    evidence.contractVersion,
    commitId,
  );
  const route = db
    .prepare(
      "SELECT integration_namespace, stream, contract_version FROM source_authority_routes WHERE authority_route = ?",
    )
    .get(evidence.routeKey) as Record<string, unknown>;
  if (
    String(route.integration_namespace) !== evidence.integrationNamespace ||
    String(route.stream) !== evidence.stream ||
    String(route.contract_version) !== evidence.contractVersion
  )
    throw new CanonicalSourceConflictError("Authority route contract drifted.");

  db.prepare(
    "INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id) VALUES (?, ?, ?, ?) ON CONFLICT(integration_namespace, source_connection_key) DO NOTHING",
  ).run(
    connectionId,
    evidence.integrationNamespace,
    evidence.sourceConnectionKey,
    commitId,
  );
  const connection = db
    .prepare(
      "SELECT source_connection_id FROM source_connections WHERE integration_namespace = ? AND source_connection_key = ?",
    )
    .get(evidence.integrationNamespace, evidence.sourceConnectionKey) as {
    source_connection_id?: unknown;
  };
  const actualConnectionId = blob(connection.source_connection_id);
  db.prepare(
    "INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id) VALUES (?, ?, ?, ?) ON CONFLICT(source_connection_id, epoch_key) DO NOTHING",
  ).run(epochId, actualConnectionId, evidence.identityEpoch, commitId);
  const epoch = db
    .prepare(
      "SELECT identity_epoch_id FROM identity_epochs WHERE source_connection_id = ? AND epoch_key = ?",
    )
    .get(actualConnectionId, evidence.identityEpoch) as {
    identity_epoch_id?: unknown;
  };
  const actualEpochId = blob(epoch.identity_epoch_id);
  db.prepare(
    "INSERT INTO source_route_bindings(authority_route, source_connection_id, created_commit_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  ).run(evidence.routeKey, actualConnectionId, commitId);
  db.prepare(
    "INSERT INTO source_subjects(source_subject_id, source_connection_id, identity_epoch_id, stream, record_kind, subject_digest, created_commit_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_connection_id, identity_epoch_id, stream, record_kind, subject_digest) DO NOTHING",
  ).run(
    subjectId,
    actualConnectionId,
    actualEpochId,
    evidence.stream,
    evidence.recordKind,
    evidence.subjectDigest,
    commitId,
  );
  const subject = db
    .prepare(
      "SELECT source_subject_id FROM source_subjects WHERE source_connection_id = ? AND identity_epoch_id = ? AND stream = ? AND record_kind = ? AND subject_digest = ?",
    )
    .get(
      actualConnectionId,
      actualEpochId,
      evidence.stream,
      evidence.recordKind,
      evidence.subjectDigest,
    ) as { source_subject_id?: unknown };
  const actualSubjectId = blob(subject.source_subject_id);

  db.prepare(
    `INSERT INTO source_captures(capture_id, capture_key, source_connection_id, identity_epoch_id, authority_route, source_subject_id, stream, record_kind, account_no, observed_at, scope_start, scope_end, completeness, completeness_basis, completeness_rule_version, commit_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'contract-versioned-source-evidence', ?, ?)`,
  ).run(
    captureId,
    evidence.captureId,
    actualConnectionId,
    actualEpochId,
    evidence.routeKey,
    actualSubjectId,
    evidence.stream,
    evidence.recordKind,
    evidence.scope.accountNo ?? null,
    evidence.observedAt,
    evidence.scope.startDate,
    evidence.scope.endDate,
    evidence.scope.completeness,
    evidence.scope.ruleVersion,
    commitId,
  );

  const contractFingerprint =
    evidence.scope.contractFingerprint ??
    createHash("sha256")
      .update(`${evidence.routeKey}\u0000${evidence.contractVersion}`)
      .digest("hex");
  const preflightFingerprint =
    evidence.scope.preflightFingerprint ??
    createHash("sha256")
      .update(`${evidence.subjectDigest}\u0000${evidence.scope.ruleVersion}`)
      .digest("hex");
  db.prepare(
    `INSERT INTO capture_scopes(scope_id, capture_id, source_connection_id, identity_epoch_id, account_id, source_subject_id, account_no, stream, scope_start, scope_end, scope_kind, completeness, completeness_basis, completeness_rule_version, absence_authority, contract_fingerprint, preflight_fingerprint, page_count, terminal, commit_id)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    scopeId,
    captureId,
    actualConnectionId,
    actualEpochId,
    actualSubjectId,
    evidence.scope.accountNo ?? null,
    evidence.stream,
    evidence.scope.startDate,
    evidence.scope.endDate,
    evidence.scope.kind,
    evidence.scope.completeness,
    evidence.scope.completenessBasis ?? "contract-versioned-source-evidence",
    evidence.scope.ruleVersion,
    evidence.scope.absenceAuthority ?? null,
    contractFingerprint,
    preflightFingerprint,
    evidence.pages.length,
    commitId,
  );
  for (const page of evidence.pages) {
    const metadata =
      page.metadataJson ?? stableCanonicalSourceJson(page.metadata);
    const digest =
      page.responseDigest ?? createHash("sha256").update(metadata).digest("hex");
    db.prepare(
      `INSERT INTO capture_scope_pages(scope_page_id, scope_id, page_ordinal, response_code, terminal, row_count, response_digest, proof_kind, contract_fingerprint, preflight_fingerprint, metadata_json, commit_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuidV7(),
      scopeId,
      page.pageOrdinal,
      page.responseCode,
      page.terminal ? 1 : 0,
      page.rowCount,
      digest,
      page.proofKind ?? "contract-versioned-source-evidence",
      page.contractFingerprint ?? contractFingerprint,
      page.preflightFingerprint ?? preflightFingerprint,
      metadata,
      commitId,
    );
  }
  const sourceRecordIds: Buffer[] = [];
  for (const record of allRecords) {
    const sourceRecordId = uuidV7();
    sourceRecordIds.push(sourceRecordId);
    const payloadJson =
      record.compactJson ?? stableCanonicalSourceJson(record.compact);
    const sequenceLexeme = record.sequenceLexeme ?? record.providerKey;
    db.prepare(
      `INSERT INTO source_records(source_record_id, capture_id, source_subject_id, commit_id, record_kind, sequence_lexeme, provider_key, content_hash, occurrence_key, collision_key, description, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sourceRecordId,
      captureId,
      actualSubjectId,
      commitId,
      record.recordKind ?? evidence.recordKind,
      sequenceLexeme,
      record.providerKey,
      record.contentHash,
      record.occurrenceKey,
      record.collisionKey ?? null,
      record.description ?? null,
      payloadJson,
    );
    db.prepare(
      "INSERT INTO source_record_scopes(source_record_id, scope_id, capture_id, account_id, source_subject_id, sequence_lexeme, occurrence_key, commit_id) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)",
    ).run(
      sourceRecordId,
      scopeId,
      captureId,
      actualSubjectId,
      sequenceLexeme,
      record.occurrenceKey,
      commitId,
    );
    db.prepare(
      "INSERT INTO source_record_provenance(source_record_id, capture_id, commit_id) VALUES (?, ?, ?)",
    ).run(sourceRecordId, captureId, commitId);
  }
  const commitResult: CanonicalSourceCommitResult = {
    status: "durable-source-evidence",
    canonicalAdmission: "blocked",
    captureId: evidence.captureId,
    commitSequence: sequence,
    observationCount: evidence.records.length,
    provenanceCount: Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS value FROM source_captures WHERE record_kind = ?",
          )
          .get(evidence.recordKind) as { value?: number }
      ).value ?? 0,
    ),
  };
  return {
    receipt: receipt(commitResult),
    captureId,
    scopeId,
    commitId,
    sourceConnectionId: actualConnectionId,
    identityEpochId: actualEpochId,
    sourceSubjectId: actualSubjectId,
    sourceRecordIds: Object.freeze(sourceRecordIds),
  };
}

function sourceCommitSequence(db: CanonicalSourceStore["db"]): number {
  return (
    Number(
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
          )
          .get() as { value?: number }
      ).value ?? 0,
    ) + 1
  );
}

function isRuntimeValidatedEvidence(
  evidence: CanonicalSourceEvidence,
): evidence is RuntimeValidatedSourceEvidence {
  return (
    (
      evidence as CanonicalSourceEvidence & {
        [CANONICAL_SOURCE_RUNTIME_BRAND]?: true;
      }
    )[CANONICAL_SOURCE_RUNTIME_BRAND] === true
  );
}

function receipt(result: CanonicalSourceCommitResult): CanonicalSourceCaptureAdmissionReceipt {
  return Object.freeze({
    captureId: result.captureId,
    knowledgePoint: result.commitSequence,
  });
}

/**
 * Compatibility projection for adapters that still expose the historical
 * source-commit result shape.  This is not part of admission's public factory:
 * the factory itself always returns the immutable two-field receipt.
 */
export function canonicalSourceAdmissionCommitResult(
  admitted: CanonicalSourceCaptureAdmissionReceipt,
  observationCount: number,
  provenanceCount = observationCount,
): CanonicalSourceCommitResult {
  return {
    status: "durable-source-evidence",
    canonicalAdmission: "blocked",
    captureId: admitted.captureId,
    commitSequence: admitted.knowledgePoint,
    observationCount,
    provenanceCount,
  };
}

function persistStandalone(
  store: CanonicalSourceStore,
  evidence: RuntimeValidatedSourceEvidence,
): Promise<CanonicalSourceCaptureAdmissionTransactionResult> {
  validateCanonicalSourceStore(store);
  return withCanonicalWriterQueue(store.databasePath, () => {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const result = persistWithinTransaction(store, evidence);
      store.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        store.db.exec("ROLLBACK");
      } catch {
        /* preserve the original admission failure */
      }
      throw error;
    }
  });
}

function persistBatchStandalone(
  store: CanonicalSourceStore,
  evidences: readonly RuntimeValidatedSourceEvidence[],
): Promise<CanonicalSourceCaptureAdmissionTransactionResult[]> {
  validateCanonicalSourceStore(store);
  if (evidences.length === 0)
    throw new CanonicalSourceCaptureAdmissionError(
      "empty-batch",
      "Canonical source capture admission batch cannot be empty.",
    );
  return withCanonicalWriterQueue(store.databasePath, () => {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const results = evidences.map((evidence) =>
        persistWithinTransaction(store, evidence),
      );
      store.db.exec("COMMIT");
      return results;
    } catch (error) {
      try {
        store.db.exec("ROLLBACK");
      } catch {
        /* preserve the original admission failure */
      }
      throw error;
    }
  });
}

export async function withCanonicalSourceCaptureAdmissionTransaction<T>(
  store: CanonicalSourceStore,
  operation: (
    capability: CanonicalSourceCaptureAdmissionTransactionCapability,
  ) => T | Promise<T>,
): Promise<T> {
  assertValidatedCanonicalDatabase(store.db);
  return withCanonicalWriterQueue(store.databasePath, async () => {
    store.db.exec("BEGIN IMMEDIATE");
    const capability = mintTransactionCapability(store);
    try {
      const result = await operation(capability);
      store.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        store.db.exec("ROLLBACK");
      } catch {
        /* preserve the original admission failure */
      }
      throw error;
    } finally {
      revokeTransactionCapability(capability);
    }
  });
}

function admitWithinTransactionResult(
  store: CanonicalSourceStore,
  request: CanonicalSourceCaptureAdmissionRequest,
  capability: unknown,
  additionalRecords: readonly EmbeddedCanonicalSourceRecord[] = [],
): CanonicalSourceCaptureAdmissionTransactionResult {
  try {
    requireTransactionCapability(store, capability);
    routeError(request);
    const admitted = admitSourceEvidence(request);
    validateAdditionalRecords(admitted, additionalRecords);
    return persistWithinTransaction(store, admitted, additionalRecords);
  } catch (error) {
    throw classifyAdmissionError(error);
  }
}

/**
 * Bind admission to one lifecycle-validated canonical store.  Validation and
 * persistence stay behind this interface so callers cannot carry a branded
 * intermediate between the two phases.
 */
export function createCanonicalSourceCaptureAdmission(
  store: CanonicalSourceStore,
) {
  return Object.freeze({
    async admit(
      request: CanonicalSourceCaptureAdmissionRequest,
    ): Promise<CanonicalSourceCaptureAdmissionReceipt> {
      try {
        routeError(request);
        const admitted = admitSourceEvidence(request);
        return (await persistStandalone(store, admitted)).receipt;
      } catch (error) {
        throw classifyAdmissionError(error);
      }
    },
    async admitBatch(
      requests: readonly CanonicalSourceCaptureAdmissionRequest[],
    ): Promise<readonly CanonicalSourceCaptureAdmissionReceipt[]> {
      if (requests.length === 0)
        throw new CanonicalSourceCaptureAdmissionError(
          "empty-batch",
          "Canonical source capture admission batch cannot be empty.",
        );
      try {
        requests.forEach(routeError);
        const admitted = requests.map(admitSourceEvidence);
        const results = await persistBatchStandalone(store, admitted);
        return results.map((result) => result.receipt);
      } catch (error) {
        throw classifyAdmissionError(error);
      }
    },
  });
}
