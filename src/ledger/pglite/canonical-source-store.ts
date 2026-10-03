import { createHash, randomUUID } from "node:crypto";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";
import type {
  PGliteCanonicalProjectionHook,
} from "./projection.ts";
import { refreshPGliteCurrentProjectionInTransaction } from "./projection.ts";
import { canonicalSourceRouteRegistration } from "../canonical/canonical-source-route-registry.ts";
import { canonicalOccurrenceGroupBucketInventory } from "../canonical/occurrence-groups.ts";
import {
  assertPGliteHumanAttestationActive,
  getPGliteHumanAttestationRoute,
  recordInitialPGliteHumanAttestationIfMissing,
} from "./attestation.ts";
import {
  canonicalSourceRecordJson,
  classifyPGliteCanonicalAdmissionError,
  PGliteCanonicalSourceAdmissionError,
  validateCanonicalSourceAccountNumber,
  validatePGliteCanonicalBalanceObservation,
  validatePGliteCanonicalFinancialAccount,
  validatePGliteCanonicalFinancialFact,
  validatePGliteCanonicalSourceEvidence,
  type PGliteCanonicalFinancialAccountInput,
  type PGliteCanonicalFinancialFactInput,
  type PGliteCanonicalAccountIdentifierInput,
  type PGliteCanonicalBalanceObservationInput,
  type PGliteCanonicalSourceEvidence,
} from "./source-admission-validation.ts";

/** A serializable source-admission request accepted by the worker. */
export type PGliteCanonicalSourceAdmissionRequest = PGliteCanonicalSourceEvidence;

export type PGliteCanonicalSourceAdmissionReceipt = Readonly<{
  captureId: string;
  knowledgePoint: number;
}>;

export type PGliteCanonicalFinancialCommitRequest = Readonly<{
  /** Provider-neutral source evidence. The worker validates its route. */
  capture: PGliteCanonicalSourceEvidence;
  /** The stable account identity must be declared by the adapter. */
  account: PGliteCanonicalFinancialAccountInput;
  /** Typed facts are keyed to admitted source occurrences. */
  transactions: readonly PGliteCanonicalFinancialFactInput[];
  /** Optional account-number evidence retained with the account identity. */
  accountIdentifier?: PGliteCanonicalAccountIdentifierInput | null;
  /** Optional current balance evidence written in the same source commit. */
  balanceObservations?: readonly PGliteCanonicalBalanceObservationInput[];
  /** Current-balance commands must attach to an existing account. */
  requireExistingAccount?: boolean;
  /** Complete range captures may explicitly withdraw omitted source assertions. */
  withdrawalPolicy?: "allow-inference" | "never-infer";
  /** Provider cursor retained with the latest source synchronization state. */
  sourceSyncCursor?: string | null;
  /** Optional deterministic worker-provided commit timestamp. */
  recordedAtUtcUs?: number;
}>;

/** A provider run may group several captures into one atomic command. */
export type PGliteCanonicalFinancialCommitBatchRequest = Readonly<{
  commits: readonly PGliteCanonicalFinancialCommitRequest[];
}>;

export type PGliteCanonicalCommitOptions = Readonly<{
  signal?: AbortSignal;
  /** Worker-local clock hook; never part of the serializable request. */
  clock?: () => number;
  /** A request's serializable timestamp, copied into the local transaction. */
  recordedAtUtcUs?: number;
  /** Worker-local current projection hook; never crosses the named IPC seam. */
  projection?: PGliteCanonicalProjectionHook;
  /** Internal nested-domain marker; extension commands project once at the end. */
  skipProjection?: boolean;
}>;

export type PGliteCanonicalFinancialTransactionResult = Readonly<{
  transactionId: string;
  revisionId: string;
  sourceSequence: string;
  sourceOccurrenceKey: string;
  direction: "inflow" | "outflow";
  amount: Readonly<{ coefficient: string; scale: number }>;
  revisionCreated: boolean;
}>;

export type PGliteCanonicalFinancialCommitResult = Readonly<{
  captureId: string;
  commitSequence: number;
  transactions: readonly PGliteCanonicalFinancialTransactionResult[];
}>;

type SourceCaptureWrite = Readonly<{
  receipt: PGliteCanonicalSourceAdmissionReceipt;
  captureId: Uint8Array;
  scopeId: Uint8Array;
  commitId: Uint8Array;
  sourceConnectionId: Uint8Array;
  identityEpochId: Uint8Array;
  sourceSubjectId: Uint8Array;
  sourceRecordIds: readonly Uint8Array[];
  sourceRecordIdsByOccurrence: ReadonlyMap<string, Uint8Array>;
}>;

/**
 * Internal worker-domain seam for typed extensions which must be committed
 * together with source evidence. The transaction capability stays inside the
 * worker; callers receive only the admitted identifiers needed to persist
 * their typed rows.
 */
export type PGliteCanonicalSourceCaptureTransactionResult = SourceCaptureWrite;

type Row = Readonly<Record<string, unknown>>;

/** Translate the repository's SQLite-style placeholders at the PGlite seam. */
async function txQuery<T>(
  transaction: PGliteTransaction,
  sql: string,
  params: readonly unknown[] = [],
): Promise<{ rows: readonly T[] }> {
  let index = 0;
  const postgresSql = sql.replace(/\?/gu, () => `$${++index}`);
  return transaction.query<T>(postgresSql, params);
}

async function first<T>(
  transaction: PGliteTransaction,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  return (await txQuery<T>(transaction, sql, params)).rows[0];
}

function uuidBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
}

function idString(value: unknown, label = "Canonical identity"): string {
  if (typeof value === "string") {
    const clean = value.toLowerCase().replace(/^\\x/u, "");
    if (/^[0-9a-f]{32}$/u.test(clean))
      return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(clean))
      return clean;
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const hex = Buffer.from(value).toString("hex");
    if (hex.length === 32)
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error(`${label} is not a UUID bytea value.`);
}

function bytesValue(value: unknown, label = "Canonical identity"): Uint8Array {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const bytes = Uint8Array.from(value);
    if (bytes.length === 16) return bytes;
  }
  if (typeof value === "string") {
    const hex = value.replace(/^\\x/u, "");
    if (/^[0-9a-f]{32}$/iu.test(hex)) return Uint8Array.from(Buffer.from(hex, "hex"));
  }
  throw new Error(`${label} is not a UUID bytea value.`);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is missing.`);
  return value;
}

function integerValue(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} is invalid.`);
  return number;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new PGliteCanonicalSourceAdmissionError(
      "cancelled",
      "Canonical PGlite financial commit was cancelled.",
    );
}

/**
 * Domain extension writers use the same cancellation boundary as the generic
 * financial writer.  Keep the error shape stable when an extension finishes
 * its writes after the nested source commit has intentionally skipped the
 * projection refresh.
 */
export function assertPGliteCanonicalCommitNotCancelled(
  signal: AbortSignal | undefined,
): void {
  throwIfCancelled(signal);
}

function cloneEvidence(
  evidence: PGliteCanonicalSourceEvidence,
): PGliteCanonicalSourceEvidence {
  // Requests are serializable by contract. Snapshot before the first async
  // query so caller mutation cannot change the rows committed by the worker.
  return structuredClone(evidence);
}

function cloneFinancialRequest(
  request: PGliteCanonicalFinancialCommitRequest,
): PGliteCanonicalFinancialCommitRequest {
  return structuredClone(request);
}

function compactPayloadHash(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function canonicalBalanceInstant(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/u.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return value;
  const milliseconds = Date.parse(value);
  const seconds = Math.floor(milliseconds / 1000);
  const fraction = (match[2] ?? "").padEnd(9, "0").slice(0, 9);
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}.${fraction}Z`;
}

function canonicalBalanceObservationKey(
  observation: PGliteCanonicalBalanceObservationInput,
): string {
  const effectiveAt = canonicalBalanceInstant(observation.effectiveAt);
  return `sha256:${createHash("sha256")
    .update(
      `canonical/depository-balance-observation/v2|${observation.observationKey}|${observation.balanceKind}|${observation.currency}|${effectiveAt}`,
    )
    .digest("base64url")}`;
}

function nextCommitTime(
  latest: unknown,
  requested: number | undefined,
  clock: (() => number) | undefined,
): number {
  const prior = Number(latest ?? -1);
  const candidate = requested ?? clock?.() ?? Date.now() * 1000;
  if (!Number.isSafeInteger(candidate) || candidate < 0)
    throw new Error("Canonical PGlite commit clock returned an invalid timestamp.");
  return Math.max(candidate, Number.isSafeInteger(prior) ? prior + 1 : candidate);
}

function sameFinancialRevision(
  row: Row,
  fact: PGliteCanonicalFinancialFactInput,
): boolean {
  return (
    String(row.amount_coefficient) === fact.amount.coefficient &&
    Number(row.amount_scale) === fact.amount.scale &&
    String(row.currency) === fact.currency &&
    String(row.direction) === fact.direction &&
    String(row.posting_status) === fact.postingStatus &&
    String(row.posting_origin) === fact.postingOrigin &&
    String(row.posting_basis) === fact.postingBasis &&
    String(row.posting_rule_version) === fact.postingRuleVersion &&
    (row.description == null ? null : String(row.description)) === (fact.description ?? null) &&
    String(row.economic_status) === fact.economicStatus &&
    String(row.administrative_state) === fact.administrativeState &&
    String(row.semantic_rule_version) === fact.semanticRuleVersion &&
    String(row.effective_on) === fact.effectiveOn &&
    String(row.transaction_date_time_local) === fact.transactionDateTimeLocal &&
    String(row.time_zone) === fact.timeZone &&
    String(row.time_precision) === fact.timePrecision &&
    String(row.time_origin) === fact.timeOrigin &&
    String(row.effective_time_basis) === fact.effectiveTimeBasis &&
    String(row.effective_time_rule_version) === fact.effectiveTimeRuleVersion &&
    Number(row.utc_instant_utc_us) === fact.utcInstantUtcUs
  );
}

function nullableStringValue(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function sameNullableAmount(
  coefficient: unknown,
  scale: unknown,
  expected: Readonly<{ coefficient: string; scale: number }> | null | undefined,
): boolean {
  if (expected === undefined || expected === null)
    return coefficient === null && scale === null;
  return String(coefficient) === expected.coefficient && Number(scale) === expected.scale;
}

function sameConversionEvidence(
  row: Row,
  conversion: NonNullable<PGliteCanonicalFinancialFactInput["conversionEvidence"]>,
): boolean {
  return (
    sameNullableAmount(row.original_amount_coefficient, row.original_amount_scale, conversion.originalAmount) &&
    nullableStringValue(row.original_currency) === conversion.originalCurrency &&
    sameNullableAmount(row.booked_amount_coefficient, row.booked_amount_scale, conversion.bookedAmount) &&
    nullableStringValue(row.booked_currency) === conversion.bookedCurrency &&
    sameNullableAmount(row.source_reported_rate_coefficient, row.source_reported_rate_scale, conversion.sourceReportedRate?.amount) &&
    nullableStringValue(row.source_reported_rate_base_currency) === (conversion.sourceReportedRate?.baseCurrency ?? null) &&
    nullableStringValue(row.source_reported_rate_quote_currency) === (conversion.sourceReportedRate?.quoteCurrency ?? null) &&
    nullableStringValue(row.source_reported_rate_date) === (conversion.sourceReportedRate?.observedOn ?? null) &&
    sameNullableAmount(row.implied_rate_coefficient, row.implied_rate_scale, conversion.impliedRate?.amount) &&
    nullableStringValue(row.implied_rate_base_currency) === (conversion.impliedRate?.baseCurrency ?? null) &&
    nullableStringValue(row.implied_rate_quote_currency) === (conversion.impliedRate?.quoteCurrency ?? null) &&
    nullableStringValue(row.implied_rate_date) === (conversion.impliedRate?.observedOn ?? null) &&
    nullableStringValue(row.comparison) === conversion.comparison &&
    sameNullableAmount(row.fee_amount_coefficient, row.fee_amount_scale, conversion.feeAmount) &&
    nullableStringValue(row.fee_currency) === (conversion.feeCurrency ?? null) &&
    nullableStringValue(row.evidence_origin) === conversion.evidenceOrigin
  );
}

function classifyDatabaseError(error: unknown): never {
  throw classifyPGliteCanonicalAdmissionError(error);
}

async function ensureSourceIdentity(
  transaction: PGliteTransaction,
  evidence: PGliteCanonicalSourceEvidence,
  commitId: Uint8Array,
): Promise<Readonly<{
  sourceConnectionId: Uint8Array;
  identityEpochId: Uint8Array;
  sourceSubjectId: Uint8Array;
}>> {
  const connectionRow = await first<{ source_connection_id: unknown }>(
    transaction,
    "SELECT source_connection_id FROM source_connections WHERE integration_namespace = ? AND source_connection_key = ?",
    [evidence.integrationNamespace, evidence.sourceConnectionKey],
  );
  const sourceConnectionId = connectionRow?.source_connection_id
    ? bytesValue(connectionRow.source_connection_id, "Source connection identity")
    : uuidBytes();
  if (!connectionRow)
    await txQuery(
      transaction,
      "INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id) VALUES (?, ?, ?, ?)",
      [sourceConnectionId, evidence.integrationNamespace, evidence.sourceConnectionKey, commitId],
    );

  const epochRow = await first<{ identity_epoch_id: unknown }>(
    transaction,
    "SELECT identity_epoch_id FROM identity_epochs WHERE source_connection_id = ? AND epoch_key = ?",
    [sourceConnectionId, evidence.identityEpoch],
  );
  const identityEpochId = epochRow?.identity_epoch_id
    ? bytesValue(epochRow.identity_epoch_id, "Identity epoch")
    : uuidBytes();
  if (!epochRow)
    await txQuery(
      transaction,
      "INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id) VALUES (?, ?, ?, ?)",
      [identityEpochId, sourceConnectionId, evidence.identityEpoch, commitId],
    );

  const subjectRow = await first<{ source_subject_id: unknown }>(
    transaction,
    `SELECT source_subject_id FROM source_subjects
       WHERE source_connection_id = ? AND identity_epoch_id = ? AND stream = ?
         AND record_kind = ? AND subject_digest = ?`,
    [
      sourceConnectionId,
      identityEpochId,
      evidence.stream,
      evidence.recordKind,
      evidence.subjectDigest,
    ],
  );
  const sourceSubjectId = subjectRow?.source_subject_id
    ? bytesValue(subjectRow.source_subject_id, "Source subject identity")
    : uuidBytes();
  if (!subjectRow)
    await txQuery(
      transaction,
      `INSERT INTO source_subjects(
         source_subject_id, source_connection_id, identity_epoch_id, stream,
         record_kind, subject_digest, created_commit_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        sourceSubjectId,
        sourceConnectionId,
        identityEpochId,
        evidence.stream,
        evidence.recordKind,
        evidence.subjectDigest,
        commitId,
      ],
    );

  return { sourceConnectionId, identityEpochId, sourceSubjectId };
}

async function assertSourceRouteBinding(
  transaction: PGliteTransaction,
  evidence: PGliteCanonicalSourceEvidence,
  sourceConnectionId: Uint8Array,
): Promise<void> {
  const route = await first<Row>(
    transaction,
    "SELECT integration_namespace, stream, contract_version FROM source_authority_routes WHERE authority_route = ?",
    [evidence.routeKey],
  );
  if (route && (
    String(route.integration_namespace) !== evidence.integrationNamespace ||
    String(route.stream) !== evidence.stream ||
    String(route.contract_version) !== evidence.contractVersion
  ))
    throw new PGliteCanonicalSourceAdmissionError(
      "authority-route-drift",
      "Authority route contract drifted in the PGlite baseline.",
    );
  const bindings = await txQuery<{ source_connection_id: unknown }>(
    transaction,
    "SELECT source_connection_id FROM source_route_bindings WHERE authority_route = ?",
    [evidence.routeKey],
  );
  if (bindings.rows.some((row) => idString(row.source_connection_id) !== idString(sourceConnectionId)))
    throw new PGliteCanonicalSourceAdmissionError(
      "authority-route-drift",
      "Authority route is bound to another source connection.",
    );
}

async function assertOccurrenceContinuity(
  transaction: PGliteTransaction,
  evidence: PGliteCanonicalSourceEvidence,
  sourceSubjectId: Uint8Array,
): Promise<void> {
  for (const record of evidence.records) {
    const recordKind = evidence.recordKind;
    if (record.collisionKey !== undefined) {
      const collisions = await txQuery<{ occurrence_key: string | null }>(
        transaction,
        `SELECT occurrence_key FROM source_records
          WHERE source_subject_id = ? AND record_kind = ? AND collision_key = ?`,
        [sourceSubjectId, recordKind, record.collisionKey],
      );
      if (collisions.rows.some((row) => row.occurrence_key !== record.occurrenceKey))
        throw new PGliteCanonicalSourceAdmissionError(
          "occurrence-conflict",
          "Source collision key maps to another occurrence; overwrite is forbidden.",
        );
    }
    const prior = await txQuery<{
      provider_key: string | null;
      payload_json: string;
      occurrence_group_scope_key: string | null;
      occurrence_group_fingerprint: string | null;
      occurrence_group_partition_date: string | null;
      occurrence_group_ordinal: number | string | null;
    }>(
      transaction,
      `SELECT provider_key, payload_json,
              occurrence_group_scope_key, occurrence_group_fingerprint,
              occurrence_group_partition_date::text AS occurrence_group_partition_date,
              occurrence_group_ordinal
         FROM source_records
        WHERE source_subject_id = ? AND record_kind = ? AND occurrence_key = ?`,
      [sourceSubjectId, recordKind, record.occurrenceKey],
    );
    const comparablePayloadJson = canonicalOccurrencePayload(canonicalSourceRecordJson(record));
    for (const row of prior.rows) {
      const priorJson = canonicalOccurrencePayload(row.payload_json);
      const providerMatches = row.provider_key === record.providerKey;
      const allowedFubonLoanEvolution = recordKind === "fubon-loan-transaction" && equivalentFubonLoanPayload(row.payload_json, comparablePayloadJson);
      if (
        !providerMatches ||
        !samePersistedOccurrenceGroup(row, record.occurrenceGroup) ||
        (priorJson !== comparablePayloadJson && !allowedFubonLoanEvolution)
      ) {
        throw new PGliteCanonicalSourceAdmissionError(
          "occurrence-conflict",
          "Source occurrence content or group identity overwrite is forbidden.",
        );
      }
    }
  }
}

function samePersistedOccurrenceGroup(
  prior: Readonly<{
    occurrence_group_scope_key: string | null;
    occurrence_group_fingerprint: string | null;
    occurrence_group_partition_date: string | null;
    occurrence_group_ordinal: number | string | null;
  }>,
  current: PGliteCanonicalSourceEvidence["records"][number]["occurrenceGroup"],
): boolean {
  if (current === undefined)
    return prior.occurrence_group_scope_key === null &&
      prior.occurrence_group_fingerprint === null &&
      prior.occurrence_group_partition_date === null &&
      prior.occurrence_group_ordinal === null;
  return prior.occurrence_group_scope_key === current.scopeKey &&
    prior.occurrence_group_fingerprint === current.fingerprint &&
    prior.occurrence_group_partition_date === current.partitionDate &&
    integerValue(prior.occurrence_group_ordinal, "Persisted occurrence group ordinal") === current.ordinal;
}

function canonicalOccurrencePayload(payloadJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch (cause) {
    throw new PGliteCanonicalSourceAdmissionError(
      "occurrence-conflict",
      "Source occurrence payload must be valid JSON; compatibility recovery is unsupported.",
      { cause },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new PGliteCanonicalSourceAdmissionError(
      "occurrence-conflict",
      "Source occurrence payload must be an object.",
    );
  return canonicalJson(parsed as Record<string, unknown>);
}

function canonicalJson(value: Record<string, unknown>): string {
  // The validator has already rejected unsupported values. Sorting here makes
  // recaptures with equivalent object property order idempotent.
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object")
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    return entry;
  };
  return JSON.stringify(normalize(value));
}

/** Fubon loan rows carry mutable balance/display observations beside the
 * immutable booked event. Keep those observations in each capture while
 * allowing a later capture to advance only the typed balance revision. */
function equivalentFubonLoanPayload(
  prior: string,
  next: string,
): boolean {
  try {
    const priorValue = JSON.parse(prior) as unknown;
    const nextValue = JSON.parse(next) as unknown;
    if (
      !priorValue || typeof priorValue !== "object" || Array.isArray(priorValue) ||
      !nextValue || typeof nextValue !== "object" || Array.isArray(nextValue)
    ) return false;
    const priorRecord = { ...(priorValue as Record<string, unknown>) };
    const nextRecord = { ...(nextValue as Record<string, unknown>) };
    delete priorRecord.balanceSourceEvidence;
    delete nextRecord.balanceSourceEvidence;
    delete priorRecord.sourceDescription;
    delete nextRecord.sourceDescription;
    return canonicalJson(priorRecord) === canonicalJson(nextRecord);
  } catch {
    return false;
  }
}

async function assertOccurrenceGroupContinuity(
  transaction: PGliteTransaction,
  evidence: PGliteCanonicalSourceEvidence,
  sourceSubjectId: Uint8Array,
): Promise<void> {
  const coverage = evidence.occurrenceGroupCoverage;
  // A point-in-time holding/balance snapshot does not claim transaction
  // history completeness, even when this route also carries transaction
  // history on other captures. Only a complete bounded history capture can
  // compare a missing group proof with earlier group counts.
  if (evidence.scope.kind !== "bounded-range" || evidence.scope.completeness !== "complete-range")
    return;
  const dateFormat = evidence.scope.dateFormat ?? "YYYYMMDD";
  const scopeStart = normalizeSourceScopeDate(evidence.scope.startDate, dateFormat);
  const scopeEnd = normalizeSourceScopeDate(evidence.scope.endDate, dateFormat);
  if (coverage === undefined) {
    const priorCoverage = await first<{ exists: boolean }>(
      transaction,
      `SELECT EXISTS (
         SELECT 1 FROM source_occurrence_group_coverages
          WHERE source_subject_id = ? AND record_kind = ? AND contract_version = ?
            AND scope_start <= ?::date AND ?::date <= scope_end
       ) AS exists`,
      [sourceSubjectId, evidence.recordKind, evidence.contractVersion, scopeEnd, scopeStart],
    );
    if (priorCoverage?.exists)
      throw new PGliteCanonicalSourceAdmissionError(
        "occurrence-conflict",
        "A source with prior occurrence groups must preserve complete group coverage.",
      );
    return;
  }

  const currentCounts = new Map<string, number>();
  for (const record of evidence.records) {
    const group = record.occurrenceGroup;
    if (!group) continue;
    const key = occurrenceGroupCountKey(group.scopeKey, group.partitionDate, group.fingerprint);
    currentCounts.set(key, (currentCounts.get(key) ?? 0) + 1);
  }

  for (const entry of coverage) {
    const bucketInventoryJson = entry.bucketKeys === undefined
      ? null
      : canonicalOccurrenceGroupBucketInventory(entry.bucketKeys);
    const priorGroups = bucketInventoryJson === null
      ? await txQuery<{
      partition_date: string;
      fingerprint: string;
      occurrence_count: number | string;
    }>(
      transaction,
      `SELECT group_count.partition_date::text AS partition_date,
              group_count.fingerprint,
              MAX(group_count.occurrence_count) AS occurrence_count
         FROM source_occurrence_group_counts group_count
         JOIN source_occurrence_group_coverages group_coverage
           ON group_coverage.coverage_id = group_count.coverage_id
        WHERE group_coverage.source_subject_id = ?
          AND group_coverage.record_kind = ?
          AND group_coverage.scope_key = ?
          AND group_coverage.contract_version = ?
          AND group_count.partition_date BETWEEN ?::date AND ?::date
        GROUP BY group_count.partition_date, group_count.fingerprint`,
      [
        sourceSubjectId,
        evidence.recordKind,
        entry.scopeKey,
        entry.contractVersion,
        entry.startDate,
        entry.endDate,
      ],
    )
      : await txQuery<{
          partition_date: string;
          fingerprint: string;
          occurrence_count: number | string;
        }>(
          transaction,
          `SELECT prior_group.partition_date,
                  prior_group.fingerprint,
                  MAX(prior_group.occurrence_count) AS occurrence_count
             FROM (
               SELECT group_coverage.capture_id,
                      group_count.partition_date::text AS partition_date,
                      group_count.fingerprint,
                      SUM(group_count.occurrence_count) AS occurrence_count
                 FROM source_occurrence_group_counts group_count
                 JOIN source_occurrence_group_coverages group_coverage
                   ON group_coverage.coverage_id = group_count.coverage_id
                WHERE group_coverage.source_subject_id = ?
                  AND group_coverage.record_kind = ?
                  AND group_coverage.scope_key = ?
                  AND group_coverage.contract_version = ?
                  AND group_coverage.bucket_inventory_json = ?
                GROUP BY group_coverage.capture_id,
                         group_count.partition_date,
                         group_count.fingerprint
             ) prior_group
            GROUP BY prior_group.partition_date, prior_group.fingerprint`,
          [
            sourceSubjectId,
            evidence.recordKind,
            entry.scopeKey,
            entry.contractVersion,
            bucketInventoryJson,
          ],
        );
    for (const prior of priorGroups.rows) {
      const current = currentCounts.get(
        occurrenceGroupCountKey(entry.scopeKey, prior.partition_date, prior.fingerprint),
      ) ?? 0;
      if (current < integerValue(prior.occurrence_count, "Occurrence group count"))
        throw new PGliteCanonicalSourceAdmissionError(
          "occurrence-conflict",
          "A complete occurrence group cannot lose members without correction evidence.",
        );
    }
  }
}

async function persistOccurrenceGroupCoverage(
  transaction: PGliteTransaction,
  evidence: PGliteCanonicalSourceEvidence,
  sourceSubjectId: Uint8Array,
  captureId: Uint8Array,
  commitId: Uint8Array,
): Promise<void> {
  const coverage = evidence.occurrenceGroupCoverage;
  if (coverage === undefined) return;

  const counts = new Map<string, Readonly<{
    scopeKey: string;
    partitionDate: string;
    fingerprint: string;
    bucketKey: string;
    count: number;
  }>>();
  for (const record of evidence.records) {
    const group = record.occurrenceGroup;
    if (!group) continue;
    const bucketKey = record.occurrenceGroupBucketKey ?? "";
    const key = JSON.stringify([
      group.scopeKey,
      group.partitionDate,
      group.fingerprint,
      bucketKey,
    ]);
    const prior = counts.get(key);
    counts.set(key, {
      scopeKey: group.scopeKey,
      partitionDate: group.partitionDate,
      fingerprint: group.fingerprint,
      bucketKey,
      count: (prior?.count ?? 0) + 1,
    });
  }

  for (const entry of coverage) {
    const coverageId = uuidBytes();
    await txQuery(
      transaction,
      `INSERT INTO source_occurrence_group_coverages(
         coverage_id, capture_id, source_subject_id, record_kind, scope_key,
         scope_start, scope_end, contract_version, bucket_inventory_json, commit_id
       ) VALUES (?, ?, ?, ?, ?, ?::date, ?::date, ?, ?, ?)`,
      [
        coverageId,
        captureId,
        sourceSubjectId,
        evidence.recordKind,
        entry.scopeKey,
        entry.startDate,
        entry.endDate,
        entry.contractVersion,
        entry.bucketKeys === undefined
          ? null
          : canonicalOccurrenceGroupBucketInventory(entry.bucketKeys),
        commitId,
      ],
    );
    for (const group of counts.values()) {
      if (
        group.scopeKey !== entry.scopeKey ||
        (entry.bucketKeys === undefined
          ? group.partitionDate < entry.startDate || group.partitionDate > entry.endDate
          : !entry.bucketKeys.includes(group.bucketKey))
      )
        continue;
      await txQuery(
        transaction,
        `INSERT INTO source_occurrence_group_counts(
           observation_id, coverage_id, partition_date, fingerprint, bucket_key,
           occurrence_count
         ) VALUES (?, ?, ?::date, ?, ?, ?)`,
        [uuidBytes(), coverageId, group.partitionDate, group.fingerprint, group.bucketKey, group.count],
      );
    }
  }
}

function occurrenceGroupCountKey(scopeKey: string, date: string, fingerprint: string): string {
  return JSON.stringify([scopeKey, date, fingerprint]);
}

function normalizeSourceScopeDate(
  value: string,
  format: "YYYYMMDD" | "YYYY-MM-DD",
): string {
  return format === "YYYYMMDD"
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : value;
}

async function persistSourceCapture(
  transaction: PGliteTransaction,
  evidence: PGliteCanonicalSourceEvidence,
  options: PGliteCanonicalCommitOptions,
): Promise<SourceCaptureWrite> {
  throwIfCancelled(options.signal);
  const overwritten = await first<Row>(
    transaction,
    "SELECT capture_id FROM source_captures WHERE capture_key = ?",
    [evidence.captureId],
  );
  if (overwritten)
    throw new PGliteCanonicalSourceAdmissionError(
      "capture-overwrite",
      "Capture overwrite is forbidden.",
    );

  const latest = await first<{ value: number | string }>(
    transaction,
    "SELECT COALESCE(MAX(recorded_at_utc_us), -1) AS value FROM canonical_commits",
  );
  const recordedAt = nextCommitTime(
    latest?.value,
    options.recordedAtUtcUs,
    options.clock,
  );
  const commitId = uuidBytes();

  const sequenceRow = await first<{ value: number | string }>(
    transaction,
    "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
  );
  const commitSequence = integerValue(sequenceRow?.value ?? 0, "Canonical commit sequence") + 1;
  await txQuery(
    transaction,
    "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, 'source_capture')",
    [commitId, commitSequence, recordedAt, evidence.routeKey],
  );

  // Resolve existing identity IDs before validating continuity. New IDs are
  // only inserted after this query, and the enclosing transaction rolls back
  // all setup if a later invariant rejects the capture.
  const identity = await ensureSourceIdentity(transaction, evidence, commitId);
  await assertSourceRouteBinding(transaction, evidence, identity.sourceConnectionId);
  await assertOccurrenceContinuity(transaction, evidence, identity.sourceSubjectId);
  await assertOccurrenceGroupContinuity(transaction, evidence, identity.sourceSubjectId);
  await txQuery(
    transaction,
    `INSERT INTO source_authority_routes(
       authority_route, integration_namespace, stream, contract_version, created_commit_id
     ) VALUES (?, ?, ?, ?, ?) ON CONFLICT(authority_route) DO NOTHING`,
    [evidence.routeKey, evidence.integrationNamespace, evidence.stream, evidence.contractVersion, commitId],
  );
  await txQuery(
    transaction,
    `INSERT INTO source_route_bindings(authority_route, source_connection_id, created_commit_id)
      VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    [evidence.routeKey, identity.sourceConnectionId, commitId],
  );

  const captureId = uuidBytes();
  const scopeId = uuidBytes();
  await txQuery(
    transaction,
    `INSERT INTO source_captures(
       capture_id, capture_key, source_connection_id, identity_epoch_id,
       authority_route, source_subject_id, stream, record_kind, source_account_key,
       observed_at, scope_start, scope_end, completeness, completeness_basis,
       completeness_rule_version, commit_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      captureId,
      evidence.captureId,
      identity.sourceConnectionId,
      identity.identityEpochId,
      evidence.routeKey,
      identity.sourceSubjectId,
      evidence.stream,
      evidence.recordKind,
      evidence.scope.sourceAccountKey ?? evidence.scope.accountNo ?? null,
      evidence.observedAt,
      evidence.scope.startDate,
      evidence.scope.endDate,
      evidence.scope.completeness,
      evidence.scope.completenessBasis ?? "contract-versioned-source-evidence",
      evidence.scope.ruleVersion,
      commitId,
    ],
  );
  const contractFingerprint =
    evidence.scope.contractFingerprint ??
    `sha256:${createHash("sha256").update(`${evidence.routeKey}\u0000${evidence.contractVersion}`).digest("base64url")}`;
  const preflightFingerprint =
    evidence.scope.preflightFingerprint ??
    `sha256:${createHash("sha256").update(`${evidence.subjectDigest}\u0000${evidence.scope.ruleVersion}`).digest("base64url")}`;
  await txQuery(
    transaction,
    `INSERT INTO capture_scopes(
       scope_id, capture_id, source_connection_id, identity_epoch_id, account_id,
       source_subject_id, source_account_key, stream, scope_start, scope_end,
       scope_kind, completeness, completeness_basis, completeness_rule_version,
       absence_authority, contract_fingerprint, preflight_fingerprint, page_count,
       terminal, commit_id
     ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      scopeId,
      captureId,
      identity.sourceConnectionId,
      identity.identityEpochId,
      identity.sourceSubjectId,
      evidence.scope.sourceAccountKey ?? evidence.scope.accountNo ?? null,
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
    ],
  );
  for (const page of evidence.pages) {
    throwIfCancelled(options.signal);
    const metadataJson = page.metadataJson ?? canonicalJson(page.metadata);
    const responseDigest = page.responseDigest ?? compactPayloadHash(metadataJson);
    await txQuery(
      transaction,
      `INSERT INTO capture_scope_pages(
         scope_page_id, scope_id, page_ordinal, response_code, terminal, row_count,
         response_digest, proof_kind, contract_fingerprint, preflight_fingerprint,
         metadata_json, commit_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidBytes(),
        scopeId,
        page.pageOrdinal,
        page.responseCode,
        page.terminal ? 1 : 0,
        page.rowCount,
        responseDigest,
        page.proofKind ?? "contract-versioned-source-evidence",
        page.contractFingerprint ?? contractFingerprint,
        page.preflightFingerprint ?? preflightFingerprint,
        metadataJson,
        commitId,
      ],
    );
  }
  await persistOccurrenceGroupCoverage(
    transaction,
    evidence,
    identity.sourceSubjectId,
    captureId,
    commitId,
  );
  const sourceRecordIds: Uint8Array[] = [];
  const sourceRecordIdsByOccurrence = new Map<string, Uint8Array>();
  for (const record of evidence.records) {
    throwIfCancelled(options.signal);
    const sourceRecordId = uuidBytes();
    const payloadJson = canonicalSourceRecordJson(record);
    const sequenceLexeme = record.sequenceLexeme ?? record.providerKey;
    sourceRecordIds.push(sourceRecordId);
    sourceRecordIdsByOccurrence.set(record.occurrenceKey, sourceRecordId);
    await txQuery(
      transaction,
      `INSERT INTO source_records(
         source_record_id, capture_id, source_subject_id, commit_id, record_kind,
         sequence_lexeme, provider_key, content_hash, occurrence_key, collision_key,
         description, payload_json, occurrence_group_scope_key,
         occurrence_group_fingerprint, occurrence_group_partition_date,
         occurrence_group_ordinal, occurrence_group_bucket_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::date, ?, ?)`,
      [
        sourceRecordId,
        captureId,
        identity.sourceSubjectId,
        commitId,
        evidence.recordKind,
        sequenceLexeme,
        record.providerKey,
        record.contentHash,
        record.occurrenceKey,
        record.collisionKey ?? null,
        record.description ?? null,
        payloadJson,
        record.occurrenceGroup?.scopeKey ?? null,
        record.occurrenceGroup?.fingerprint ?? null,
        record.occurrenceGroup?.partitionDate ?? null,
        record.occurrenceGroup?.ordinal ?? null,
        record.occurrenceGroupBucketKey ?? null,
      ],
    );
    await txQuery(
      transaction,
      `INSERT INTO source_record_scopes(
         source_record_id, scope_id, capture_id, account_id, source_subject_id,
         sequence_lexeme, occurrence_key, commit_id
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
      [
        sourceRecordId,
        scopeId,
        captureId,
        identity.sourceSubjectId,
        sequenceLexeme,
        record.occurrenceKey,
        commitId,
      ],
    );
    await txQuery(
      transaction,
      "INSERT INTO source_record_provenance(source_record_id, capture_id, commit_id) VALUES (?, ?, ?)",
      [sourceRecordId, captureId, commitId],
    );
  }
  return {
    receipt: { captureId: evidence.captureId, knowledgePoint: commitSequence },
    captureId,
    scopeId,
    commitId,
    sourceConnectionId: identity.sourceConnectionId,
    identityEpochId: identity.identityEpochId,
    sourceSubjectId: identity.sourceSubjectId,
    sourceRecordIds: Object.freeze(sourceRecordIds),
    sourceRecordIdsByOccurrence,
  };
}

async function ensureFinancialAccount(
  transaction: PGliteTransaction,
  request: PGliteCanonicalFinancialCommitRequest,
  capture: SourceCaptureWrite,
): Promise<Uint8Array> {
  const { account } = request;
  const existing = await first<Row>(
    transaction,
    `SELECT account_id, account_no, account_type, currency
       FROM financial_accounts
      WHERE source_connection_id = ? AND identity_epoch_id = ? AND stream = ?
        AND source_account_key = ?`,
    [capture.sourceConnectionId, capture.identityEpochId, request.capture.stream, account.sourceAccountKey],
  );
  if (existing) {
    if (String(existing.account_type) !== account.accountType ||
      (existing.currency == null ? null : String(existing.currency)) !== account.currency)
      throw new PGliteCanonicalSourceAdmissionError(
        "invalid-financial-fact",
        "Financial account identity has conflicting classification.",
      );
    if (account.accountNo != null && existing.account_no != null && String(existing.account_no) !== account.accountNo)
      throw new PGliteCanonicalSourceAdmissionError(
        "invalid-financial-fact",
        "Financial account number changed without a versioned account revision.",
      );
    if (account.accountNo != null && existing.account_no == null)
      await txQuery(
        transaction,
        "UPDATE financial_accounts SET account_no = ? WHERE account_id = ? AND account_no IS NULL",
        [account.accountNo, existing.account_id],
      );
    return bytesValue(existing.account_id, "Financial account identity");
  }
  if (request.requireExistingAccount)
    throw new PGliteCanonicalSourceAdmissionError(
      "invalid-financial-fact",
      "The balance command must attach to an existing financial account.",
    );
  const accountId = uuidBytes();
  await txQuery(
    transaction,
    `INSERT INTO financial_accounts(
       account_id, source_connection_id, identity_epoch_id, stream,
       source_account_key, account_no, account_type, currency, created_commit_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      accountId,
      capture.sourceConnectionId,
      capture.identityEpochId,
      request.capture.stream,
      account.sourceAccountKey,
      account.accountNo ?? null,
      account.accountType,
      account.currency,
      capture.commitId,
    ],
  );
  await txQuery(
    transaction,
    "UPDATE capture_scopes SET account_id = ? WHERE scope_id = ? AND capture_id = ?",
    [accountId, capture.scopeId, capture.captureId],
  );
  await txQuery(
    transaction,
    "UPDATE source_record_scopes SET account_id = ? WHERE scope_id = ? AND capture_id = ?",
    [accountId, capture.scopeId, capture.captureId],
  );
  return accountId;
}

async function persistAccountIdentifier(
  transaction: PGliteTransaction,
  request: PGliteCanonicalFinancialCommitRequest,
  capture: SourceCaptureWrite,
  accountId: Uint8Array,
): Promise<void> {
  const identifier = request.accountIdentifier;
  if (!identifier) return;
  validateCanonicalSourceAccountNumber(identifier);
  await txQuery(
    transaction,
    `INSERT INTO financial_account_identifier_observations(
       observation_id, account_id, capture_id, source_record_id, commit_id,
       identifier_kind, identifier_value, evidence_version, source_field, observed_at
     ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, capture_id, identifier_kind, identifier_value) DO NOTHING`,
    [
      uuidBytes(),
      accountId,
      capture.captureId,
      capture.commitId,
      identifier.kind,
      identifier.value,
      identifier.evidenceVersion,
      identifier.sourceField,
      request.capture.observedAt,
    ],
  );
}

async function persistBalanceObservations(
  transaction: PGliteTransaction,
  request: PGliteCanonicalFinancialCommitRequest,
  capture: SourceCaptureWrite,
  accountId: Uint8Array,
  options: PGliteCanonicalCommitOptions,
): Promise<Readonly<{ revisionCount: number; deduplicatedRevisionCount: number }>> {
  const observations = request.balanceObservations ?? [];
  let revisionCount = 0;
  let deduplicatedRevisionCount = 0;
  for (const observation of observations) {
    throwIfCancelled(options.signal);
    const sourceRecordId = capture.sourceRecordIdsByOccurrence.get(observation.sourceOccurrenceKey);
    if (!sourceRecordId)
      throw new PGliteCanonicalSourceAdmissionError(
        "invalid-financial-fact",
        `Balance evidence references an occurrence not present in capture: ${observation.sourceOccurrenceKey}.`,
      );
    const currency = observation.currency.toUpperCase();
    const observationKey = canonicalBalanceObservationKey({ ...observation, currency });
    const effectiveAt = canonicalBalanceInstant(observation.effectiveAt);
    const existing = await first<{ observation_id: unknown }>(
      transaction,
      `SELECT observation_id FROM balance_observations
        WHERE account_id = ? AND observation_key = ? AND balance_kind = ? AND balance_currency = ?
        ORDER BY observation_id LIMIT 1`,
      [accountId, observationKey, observation.balanceKind, currency],
    );
    const observationId = existing?.observation_id
      ? bytesValue(existing.observation_id, "Balance observation identity")
      : uuidBytes();
    if (!existing)
      await txQuery(
        transaction,
        `INSERT INTO balance_observations(
           observation_id, account_id, observation_key, balance_kind,
           balance_currency, created_capture_id, created_commit_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          observationId,
          accountId,
          observationKey,
          observation.balanceKind,
          currency,
          capture.captureId,
          capture.commitId,
        ],
      );
    const duplicate = await first<Row>(
      transaction,
      `SELECT revision_id, balance_coefficient, balance_scale
         FROM balance_observation_revisions
        WHERE observation_id = ? AND currency = ? AND effective_at = ?`,
      [observationId, currency, effectiveAt],
    );
    if (duplicate) {
      if (
        String(duplicate.balance_coefficient) !== observation.balance.coefficient ||
        Number(duplicate.balance_scale) !== observation.balance.scale
      )
        throw new PGliteCanonicalSourceAdmissionError(
          "occurrence-conflict",
          "Balance evidence contradicts an existing measurement at the same provider instant.",
        );
      deduplicatedRevisionCount += 1;
      continue;
    }
    const prior = await first<{ revision_number: number | string }>(
      transaction,
      "SELECT COALESCE(MAX(revision_number), 0) AS revision_number FROM balance_observation_revisions WHERE observation_id = ?",
      [observationId],
    );
    await txQuery(
      transaction,
      `INSERT INTO balance_observation_revisions(
         revision_id, observation_id, source_record_id, capture_id, commit_id,
         revision_number, balance_coefficient, balance_scale, currency,
         effective_at, effective_time_basis, effective_time_rule_version,
         effective_time_evidence_source_record_key,
         effective_time_evidence_source_field,
         effective_time_evidence_value,
         effective_time_evidence_contract_version,
         effective_time_evidence_endpoint,
         effective_time_evidence_response_status,
         effective_time_evidence_cache_policy, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidBytes(),
        observationId,
        sourceRecordId,
        capture.captureId,
        capture.commitId,
        Number(prior?.revision_number ?? 0) + 1,
        observation.balance.coefficient,
        observation.balance.scale,
        currency,
        effectiveAt,
        observation.effectiveTimeBasis,
        observation.effectiveTimeRuleVersion,
        observation.evidenceSourceRecordKey,
        observation.evidenceSourceField,
        observation.evidenceSourceValue,
        observation.evidenceContractVersion,
        observation.evidenceEndpoint ?? request.capture.routeKey,
        observation.evidenceResponseStatus ?? 200,
        observation.evidenceCachePolicy ?? "provider-contract",
        request.capture.observedAt,
      ],
    );
    revisionCount += 1;
  }
  return { revisionCount, deduplicatedRevisionCount };
}

async function withdrawOmittedSourceAssertions(
  transaction: PGliteTransaction,
  request: PGliteCanonicalFinancialCommitRequest,
  capture: SourceCaptureWrite,
  accountId: Uint8Array,
  options: PGliteCanonicalCommitOptions,
  seenOccurrences: ReadonlySet<string>,
): Promise<void> {
  if (request.withdrawalPolicy !== "allow-inference") return;
  const omitted = await txQuery<{
    assertion_id: unknown;
    transaction_id: unknown;
    occurrence_key: string | null;
  }>(
    transaction,
    `SELECT DISTINCT assertion.assertion_id, assertion.transaction_id, source_record.occurrence_key
       FROM assertions assertion
       JOIN assertion_provenance provenance
         ON provenance.assertion_id = assertion.assertion_id
       JOIN source_records source_record
         ON source_record.source_record_id = provenance.source_record_id
       JOIN source_record_scopes source_scope
         ON source_scope.source_record_id = source_record.source_record_id
       JOIN capture_scopes prior_scope
         ON prior_scope.scope_id = source_scope.scope_id
       JOIN source_captures prior_capture
         ON prior_capture.capture_id = prior_scope.capture_id
      WHERE assertion.origin = 'source'
        AND assertion.field_name = 'transaction_revision'
        AND source_scope.account_id = ?
        AND prior_capture.authority_route = ?
        AND prior_scope.scope_start = ?
        AND prior_scope.scope_end = ?
        AND prior_scope.completeness_rule_version = ?
        AND prior_scope.contract_fingerprint = ?`,
    [
      accountId,
      request.capture.routeKey,
      request.capture.scope.startDate,
      request.capture.scope.endDate,
      request.capture.scope.ruleVersion,
      request.capture.scope.contractFingerprint ??
        `sha256:${createHash("sha256").update(`${request.capture.routeKey}\u0000${request.capture.contractVersion}`).digest("base64url")}`,
    ],
  );
  for (const row of omitted.rows) {
    throwIfCancelled(options.signal);
    const occurrence = row.occurrence_key;
    if (occurrence !== null && seenOccurrences.has(occurrence)) continue;
    const alreadyWithdrawn = await first<{ event_id: unknown }>(
      transaction,
      `SELECT event_id FROM assertion_transitions
        WHERE assertion_id = ? AND capture_id = ? AND event_kind = 'withdrawn' LIMIT 1`,
      [row.assertion_id, capture.captureId],
    );
    if (alreadyWithdrawn) continue;
    await txQuery(
      transaction,
      `INSERT INTO assertion_transitions(
         event_id, assertion_id, transaction_id, field_name, capture_id,
         scope_id, run_id, enrichment_run_id, coordinate_id, user_id,
         commit_id, event_kind
       ) VALUES (?, ?, ?, 'transaction_revision', ?, ?, NULL, NULL, NULL, NULL, ?, 'withdrawn')`,
      [
        uuidBytes(),
        row.assertion_id,
        row.transaction_id,
        capture.captureId,
        capture.scopeId,
        capture.commitId,
      ],
    );
  }
}

async function persistSourceSyncState(
  transaction: PGliteTransaction,
  request: PGliteCanonicalFinancialCommitRequest,
  capture: SourceCaptureWrite,
  accountId: Uint8Array,
): Promise<void> {
  await txQuery(
    transaction,
    `INSERT INTO source_sync_states(
       source_connection_id, account_id, stream, scope_start, scope_end,
       cursor, last_capture_id, commit_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_connection_id, account_id, stream) DO UPDATE SET
       scope_start = excluded.scope_start,
       scope_end = excluded.scope_end,
       cursor = excluded.cursor,
       last_capture_id = excluded.last_capture_id,
       commit_id = excluded.commit_id`,
    [
      capture.sourceConnectionId,
      accountId,
      request.capture.stream,
      request.capture.scope.startDate,
      request.capture.scope.endDate,
      request.sourceSyncCursor ?? null,
      capture.captureId,
      capture.commitId,
    ],
  );
}

async function attachFinancialAccountToScope(
  transaction: PGliteTransaction,
  capture: SourceCaptureWrite,
  accountId: Uint8Array,
): Promise<void> {
  await txQuery(
    transaction,
    "UPDATE capture_scopes SET account_id = ? WHERE scope_id = ? AND capture_id = ?",
    [accountId, capture.scopeId, capture.captureId],
  );
  await txQuery(
    transaction,
    "UPDATE source_record_scopes SET account_id = ? WHERE scope_id = ? AND capture_id = ?",
    [accountId, capture.scopeId, capture.captureId],
  );
}

async function persistConversionEvidence(
  transaction: PGliteTransaction,
  fact: PGliteCanonicalFinancialFactInput,
  transactionId: Uint8Array,
  revisionId: Uint8Array,
  sourceRecordId: Uint8Array,
  capture: SourceCaptureWrite,
): Promise<void> {
  const conversion = fact.conversionEvidence;
  if (conversion === undefined || conversion === null) return;
  const existing = await first<Row>(
    transaction,
    "SELECT * FROM transaction_conversion_evidence WHERE revision_id = ?",
    [revisionId],
  );
  if (existing) {
    if (!sameConversionEvidence(existing, conversion))
      throw new PGliteCanonicalSourceAdmissionError(
        "occurrence-conflict",
        "Conversion evidence contradicts the existing financial revision.",
      );
    return;
  }
  await txQuery(
    transaction,
    `INSERT INTO transaction_conversion_evidence(
       conversion_id, transaction_id, revision_id, source_record_id,
       capture_id, commit_id, original_amount_coefficient,
       original_amount_scale, original_currency, booked_amount_coefficient,
       booked_amount_scale, booked_currency, source_reported_rate_coefficient,
       source_reported_rate_scale, source_reported_rate_base_currency,
       source_reported_rate_quote_currency, source_reported_rate_date,
       implied_rate_coefficient, implied_rate_scale, implied_rate_base_currency,
       implied_rate_quote_currency, implied_rate_date, comparison,
       fee_amount_coefficient, fee_amount_scale, fee_currency, evidence_origin
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidBytes(),
      transactionId,
      revisionId,
      sourceRecordId,
      capture.captureId,
      capture.commitId,
      conversion.originalAmount?.coefficient ?? null,
      conversion.originalAmount?.scale ?? null,
      conversion.originalCurrency,
      conversion.bookedAmount.coefficient,
      conversion.bookedAmount.scale,
      conversion.bookedCurrency,
      conversion.sourceReportedRate?.amount.coefficient ?? null,
      conversion.sourceReportedRate?.amount.scale ?? null,
      conversion.sourceReportedRate?.baseCurrency ?? null,
      conversion.sourceReportedRate?.quoteCurrency ?? null,
      conversion.sourceReportedRate?.observedOn ?? null,
      conversion.impliedRate?.amount.coefficient ?? null,
      conversion.impliedRate?.amount.scale ?? null,
      conversion.impliedRate?.baseCurrency ?? null,
      conversion.impliedRate?.quoteCurrency ?? null,
      conversion.impliedRate?.observedOn ?? null,
      conversion.comparison,
      conversion.feeAmount?.coefficient ?? null,
      conversion.feeAmount?.scale ?? null,
      conversion.feeCurrency ?? null,
      conversion.evidenceOrigin,
    ],
  );
}

async function commitFinancialFacts(
  transaction: PGliteTransaction,
  request: PGliteCanonicalFinancialCommitRequest,
  capture: SourceCaptureWrite,
  accountId: Uint8Array,
  options: PGliteCanonicalCommitOptions,
): Promise<readonly PGliteCanonicalFinancialTransactionResult[]> {
  const seenSequences = new Set<string>();
  const results: PGliteCanonicalFinancialTransactionResult[] = [];
  for (const fact of request.transactions) {
    throwIfCancelled(options.signal);
    if (seenSequences.has(fact.sourceSequence))
      throw new PGliteCanonicalSourceAdmissionError(
        "invalid-financial-fact",
        "A financial source sequence may appear only once in one commit.",
      );
    seenSequences.add(fact.sourceSequence);
    const sourceRecordId = capture.sourceRecordIdsByOccurrence.get(fact.sourceOccurrenceKey);
    if (!sourceRecordId)
      throw new PGliteCanonicalSourceAdmissionError(
        "invalid-financial-fact",
        `Financial fact references an occurrence not present in capture: ${fact.sourceOccurrenceKey}.`,
      );
    const existing = await first<{ transaction_id: unknown }>(
      transaction,
      "SELECT transaction_id FROM financial_transactions WHERE account_id = ? AND source_sequence = ?",
      [accountId, fact.sourceSequence],
    );
    const transactionId = existing?.transaction_id
      ? bytesValue(existing.transaction_id, "Financial transaction identity")
      : uuidBytes();
    if (!existing)
      await txQuery(
        transaction,
        "INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id) VALUES (?, ?, ?, ?)",
        [transactionId, accountId, fact.sourceSequence, capture.commitId],
      );
    const latest = await first<Row>(
      transaction,
      "SELECT * FROM transaction_revisions WHERE transaction_id = ? ORDER BY revision_number DESC LIMIT 1",
      [transactionId],
    );
    const revisionCreated = !latest || !sameFinancialRevision(latest, fact);
    let revisionId = latest?.revision_id
      ? bytesValue(latest.revision_id, "Financial revision identity")
      : uuidBytes();
    let assertionId: Uint8Array;
    if (revisionCreated) {
      if (latest?.revision_id) {
        const priorAssertion = await first<{ assertion_id: unknown }>(
          transaction,
          "SELECT assertion_id FROM assertions WHERE origin = 'source' AND revision_id = ?",
          [latest.revision_id],
        );
        if (priorAssertion)
          await txQuery(
            transaction,
            `INSERT INTO assertion_transitions(
               event_id, assertion_id, transaction_id, field_name, capture_id,
               scope_id, run_id, coordinate_id, user_id, commit_id, event_kind
             ) VALUES (?, ?, ?, 'transaction_revision', ?, ?, NULL, NULL, NULL, ?, 'superseded')`,
            [
              uuidBytes(),
              priorAssertion.assertion_id,
              transactionId,
              capture.captureId,
              capture.scopeId,
              capture.commitId,
            ],
          );
      }
      revisionId = uuidBytes();
      const revisionNumber = latest ? integerValue(latest.revision_number, "Revision number") + 1 : 1;
      await txQuery(
        transaction,
        `INSERT INTO transaction_revisions(
           revision_id, transaction_id, source_record_id, capture_id, commit_id,
           revision_number, amount_coefficient, amount_scale, currency, direction,
           posting_status, posting_origin, posting_basis, posting_rule_version,
           description, economic_status, administrative_state, semantic_rule_version,
           effective_on, transaction_date_time_local, time_zone, time_precision,
           time_origin, effective_time_basis, effective_time_rule_version,
           utc_instant_utc_us
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          revisionId,
          transactionId,
          sourceRecordId,
          capture.captureId,
          capture.commitId,
          revisionNumber,
          fact.amount.coefficient,
          fact.amount.scale,
          fact.currency,
          fact.direction,
          fact.postingStatus,
          fact.postingOrigin,
          fact.postingBasis,
          fact.postingRuleVersion,
          fact.description ?? null,
          fact.economicStatus,
          fact.administrativeState,
          fact.semanticRuleVersion,
          fact.effectiveOn,
          fact.transactionDateTimeLocal,
          fact.timeZone,
          fact.timePrecision,
          fact.timeOrigin,
          fact.effectiveTimeBasis,
          fact.effectiveTimeRuleVersion,
          fact.utcInstantUtcUs,
        ],
      );
      await txQuery(
        transaction,
        `INSERT INTO transaction_time_observations(
           observation_id, transaction_id, revision_id, source_record_id, commit_id,
           role, local_value, time_zone, time_precision, time_origin, utc_instant_utc_us
         ) VALUES (?, ?, ?, ?, ?, 'occurred', ?, ?, ?, ?, ?)`,
        [
          uuidBytes(),
          transactionId,
          revisionId,
          sourceRecordId,
          capture.commitId,
          fact.transactionDateTimeLocal,
          fact.timeZone,
          fact.timePrecision,
          fact.timeOrigin,
          fact.utcInstantUtcUs,
        ],
      );
      assertionId = uuidBytes();
      await txQuery(
        transaction,
        `INSERT INTO assertions(
           assertion_id, transaction_id, field_name, target_kind, origin,
           producer_id, rule_lineage, revision_id, value_text, created_commit_id
         ) VALUES (?, ?, 'transaction_revision', 'transaction', 'source', ?, ?, ?, NULL, ?)`,
        [assertionId, transactionId, request.capture.routeKey, request.capture.routeKey, revisionId, capture.commitId],
      );
      await txQuery(
        transaction,
        `INSERT INTO assertion_transitions(
           event_id, assertion_id, transaction_id, field_name, capture_id,
           scope_id, run_id, coordinate_id, user_id, commit_id, event_kind
         ) VALUES (?, ?, ?, 'transaction_revision', ?, ?, NULL, NULL, NULL, ?, 'observed')`,
        [uuidBytes(), assertionId, transactionId, capture.captureId, capture.scopeId, capture.commitId],
      );
    } else {
      const priorAssertion = await first<{ assertion_id: unknown }>(
        transaction,
        "SELECT assertion_id FROM assertions WHERE origin = 'source' AND revision_id = ?",
        [revisionId],
      );
      if (!priorAssertion)
        throw new Error("Canonical source assertion is missing for an unchanged revision.");
      assertionId = bytesValue(priorAssertion.assertion_id, "Financial assertion identity");
    }
    await txQuery(
      transaction,
      `INSERT INTO assertion_provenance(
         assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id
       ) VALUES (?, ?, NULL, NULL, NULL, ?)`,
      [assertionId, sourceRecordId, capture.commitId],
    );
    await persistConversionEvidence(
      transaction,
      fact,
      transactionId,
      revisionId,
      sourceRecordId,
      capture,
    );
    results.push({
      transactionId: idString(transactionId),
      revisionId: idString(revisionId),
      sourceSequence: fact.sourceSequence,
      sourceOccurrenceKey: fact.sourceOccurrenceKey,
      direction: fact.direction,
      amount: { coefficient: fact.amount.coefficient, scale: fact.amount.scale },
      revisionCreated,
    });
  }
  return Object.freeze(results);
}

async function persistAdmission(
  database: PGliteStore,
  evidence: PGliteCanonicalSourceEvidence,
  options: PGliteCanonicalCommitOptions,
): Promise<SourceCaptureWrite> {
  try {
    validatePGliteCanonicalSourceEvidence(evidence);
    const snapshot = cloneEvidence(evidence);
    throwIfCancelled(options.signal);
    return await database.transaction((transaction) =>
      persistSourceCapture(transaction, snapshot, options),
    );
  } catch (error) {
    return classifyDatabaseError(error);
  }
}

/** Admit source evidence inside a caller-owned PGlite transaction. */
export async function admitPGliteCanonicalSourceCaptureInTransaction(
  transaction: PGliteTransaction,
  request: PGliteCanonicalSourceAdmissionRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalSourceCaptureTransactionResult> {
  validatePGliteCanonicalSourceEvidence(request);
  throwIfCancelled(options.signal);
  return persistSourceCapture(transaction, cloneEvidence(request), options);
}

/** Commit typed financial facts inside a caller-owned PGlite transaction. */
export async function commitPGliteCanonicalFinancialCaptureInTransaction(
  transaction: PGliteTransaction,
  request: PGliteCanonicalFinancialCommitRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalFinancialCommitResult> {
  const snapshot = cloneFinancialRequest(request);
  validateFinancialRequest(snapshot);
  return commitFinancialRequestInTransaction(transaction, snapshot, options);
}

function validateFinancialRequest(
  request: PGliteCanonicalFinancialCommitRequest,
): void {
  validatePGliteCanonicalSourceEvidence(request.capture);
  if (
    canonicalSourceRouteRegistration(request.capture.routeKey)?.occurrenceGroups === "required"
  ) {
    const groupedOccurrences = new Set(
      request.capture.records
        .filter((record) => record.occurrenceGroup !== undefined)
        .map((record) => record.occurrenceKey),
    );
    for (const fact of request.transactions) {
      if (!groupedOccurrences.has(fact.sourceOccurrenceKey))
        throw new PGliteCanonicalSourceAdmissionError(
          "invalid-financial-fact",
          "Financial facts on this source route require occurrence group identity.",
        );
    }
  }
  validatePGliteCanonicalFinancialAccount(request.account, request.capture);
  if (request.accountIdentifier !== undefined && request.accountIdentifier !== null) {
    validateCanonicalSourceAccountNumber(request.accountIdentifier);
    if (request.account.accountNo !== undefined && request.account.accountNo !== null &&
      request.account.accountNo !== request.accountIdentifier.value)
      throw new PGliteCanonicalSourceAdmissionError(
        "invalid-financial-fact",
        "Financial account number must match its retained identifier evidence.",
      );
  }
  if (request.requireExistingAccount !== undefined && typeof request.requireExistingAccount !== "boolean")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Existing-account requirement is invalid.");
  if (request.withdrawalPolicy !== undefined &&
    request.withdrawalPolicy !== "allow-inference" && request.withdrawalPolicy !== "never-infer")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Withdrawal policy is unsupported.");
  if (request.sourceSyncCursor !== undefined && request.sourceSyncCursor !== null &&
    typeof request.sourceSyncCursor !== "string")
    throw new PGliteCanonicalSourceAdmissionError("invalid-financial-fact", "Source synchronization cursor must be text or null.");
  for (const observation of request.balanceObservations ?? [])
    validatePGliteCanonicalBalanceObservation(
      observation,
      request.capture.routeKey,
      request.capture.contractVersion,
    );
  if (request.recordedAtUtcUs !== undefined &&
    (!Number.isSafeInteger(request.recordedAtUtcUs) || request.recordedAtUtcUs < 0))
    throw new PGliteCanonicalSourceAdmissionError(
      "invalid-financial-fact",
      "Financial commit timestamp must be a non-negative safe integer.",
    );
  // A transaction's booked denomination is source evidence; the account
  // currency is a reporting/default value and cannot override it (ADR 0006).
  for (const fact of request.transactions)
    validatePGliteCanonicalFinancialFact(
      fact,
      request.capture.routeKey,
      request.capture.contractVersion,
    );
}

async function commitFinancialRequestInTransaction(
  transaction: PGliteTransaction,
  request: PGliteCanonicalFinancialCommitRequest,
  options: PGliteCanonicalCommitOptions,
): Promise<PGliteCanonicalFinancialCommitResult> {
  throwIfCancelled(options.signal);
  const attestation = getPGliteHumanAttestationRoute(request.capture.routeKey);
  if (attestation) {
    // The immutable local manifest seeds the first event. A revoked durable
    // chain cannot be re-seeded, and the active check shares this transaction
    // with the financial capture it authorizes.
    await recordInitialPGliteHumanAttestationIfMissing(transaction, attestation);
    await assertPGliteHumanAttestationActive(transaction, attestation);
  }
  const transactionOptions: PGliteCanonicalCommitOptions = {
    ...options,
    recordedAtUtcUs: request.recordedAtUtcUs,
  };
  const capture = await persistSourceCapture(transaction, request.capture, transactionOptions);
  const accountId = await ensureFinancialAccount(transaction, request, capture);
  await attachFinancialAccountToScope(transaction, capture, accountId);
  await persistAccountIdentifier(transaction, request, capture, accountId);
  const transactions = await commitFinancialFacts(transaction, request, capture, accountId, transactionOptions);
  await persistBalanceObservations(transaction, request, capture, accountId, transactionOptions);
  await withdrawOmittedSourceAssertions(
    transaction,
    request,
    capture,
    accountId,
    transactionOptions,
    new Set(request.transactions.map((fact) => fact.sourceOccurrenceKey)),
  );
  await persistSourceSyncState(transaction, request, capture, accountId);
  throwIfCancelled(transactionOptions.signal);
  if (!options.skipProjection) {
    await (options.projection ?? refreshPGliteCurrentProjectionInTransaction)(transaction, {
      commitId: capture.commitId,
      cutoffSequence: capture.receipt.knowledgePoint,
      captureIds: [capture.captureId],
      transactionIds: transactions.map((result) =>
        Uint8Array.from(Buffer.from(result.transactionId.replaceAll("-", ""), "hex")),
      ),
    });
  }
  throwIfCancelled(transactionOptions.signal);
  return {
    captureId: capture.receipt.captureId,
    commitSequence: capture.receipt.knowledgePoint,
    transactions,
  };
}

/** Admit source evidence through one worker-owned PGlite transaction. */
export async function admitPGliteCanonicalSourceCapture(
  database: PGliteStore,
  request: PGliteCanonicalSourceAdmissionRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalSourceAdmissionReceipt> {
  return (await persistAdmission(database, request, options)).receipt;
}

/**
 * Atomically admit source evidence and its typed financial facts.  The
 * request contains only data; no callback or SQL capability crosses this API.
 */
export async function commitPGliteCanonicalFinancialCapture(
  database: PGliteStore,
  request: PGliteCanonicalFinancialCommitRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<PGliteCanonicalFinancialCommitResult> {
  try {
    const snapshot = cloneFinancialRequest(request);
    validateFinancialRequest(snapshot);
    throwIfCancelled(options.signal);
    return await database.transaction((transaction) =>
      commitFinancialRequestInTransaction(transaction, snapshot, options),
    );
  } catch (error) {
    return classifyDatabaseError(error);
  }
}

/**
 * Commit a provider run as one database transaction.  This preserves the
 * callback execution seam's all-or-nothing grouping while keeping every item
 * serializable and named.
 */
export async function commitPGliteCanonicalFinancialBatch(
  database: PGliteStore,
  request: PGliteCanonicalFinancialCommitBatchRequest,
  options: PGliteCanonicalCommitOptions = {},
): Promise<readonly PGliteCanonicalFinancialCommitResult[]> {
  try {
    if (request.commits.length === 0)
      throw new PGliteCanonicalSourceAdmissionError(
        "empty-batch",
        "Canonical PGlite financial commit batch cannot be empty.",
      );
    const snapshots = request.commits.map(cloneFinancialRequest);
    const captureKeys = new Set<string>();
    for (const snapshot of snapshots) {
      if (captureKeys.has(snapshot.capture.captureId))
        throw new PGliteCanonicalSourceAdmissionError(
          "capture-overwrite",
          "Canonical PGlite financial commit batch contains a duplicate capture key.",
        );
      captureKeys.add(snapshot.capture.captureId);
      validateFinancialRequest(snapshot);
    }
    throwIfCancelled(options.signal);
    return await database.transaction(async (transaction) => {
      const results: PGliteCanonicalFinancialCommitResult[] = [];
      for (const snapshot of snapshots) {
        throwIfCancelled(options.signal);
        results.push(await commitFinancialRequestInTransaction(transaction, snapshot, options));
      }
      throwIfCancelled(options.signal);
      return Object.freeze(results);
    });
  } catch (error) {
    return classifyDatabaseError(error);
  }
}

export type PGliteCanonicalSourceStore = Readonly<{
  admit(
    request: PGliteCanonicalSourceAdmissionRequest,
    options?: PGliteCanonicalCommitOptions,
  ): Promise<PGliteCanonicalSourceAdmissionReceipt>;
  commit(
    request: PGliteCanonicalFinancialCommitRequest,
    options?: PGliteCanonicalCommitOptions,
  ): Promise<PGliteCanonicalFinancialCommitResult>;
  commitBatch(
    request: PGliteCanonicalFinancialCommitBatchRequest,
    options?: PGliteCanonicalCommitOptions,
  ): Promise<readonly PGliteCanonicalFinancialCommitResult[]>;
}>;

/** Bind the named commands to one already worker-owned PGlite store. */
export function createPGliteCanonicalSourceStore(
  database: PGliteStore,
): PGliteCanonicalSourceStore {
  return Object.freeze({
    admit: (request, options) => admitPGliteCanonicalSourceCapture(database, request, options),
    commit: (request, options) => commitPGliteCanonicalFinancialCapture(database, request, options),
    commitBatch: (request, options) => commitPGliteCanonicalFinancialBatch(database, request, options),
  });
}
