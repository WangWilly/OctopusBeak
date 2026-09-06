import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import {
  CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
  CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
  TRANSACTION_TAXONOMY_ID,
  TRANSACTION_TAXONOMY_VERSION,
  type EnrichmentField,
  type TaxonomyOrigin,
  isCategoryApplicable,
  isTaxonomyCode,
  producerAllowsOutput,
  taxonomyDimensionForField,
} from "./transaction-taxonomy.ts";
import {
  openCanonicalDatabase,
} from "./canonical-database.ts";
import {
  canonicalSqlitePath,
  currentUtcMicros,
  idFromString,
  idToString,
  uuidV7,
  blob,
  type CanonicalId,
} from "./canonical-schema-implementation.ts";
import {
  withCanonicalSnapshot,
  withCanonicalWriterQueue,
  type CanonicalRuntimeOptions,
} from "./canonical-runtime.ts";
import {
  createCanonicalProjectionRuntime,
  type CanonicalProjectionTransactionEnrichment,
  type CanonicalProjectionTransactionCategorization,
  type CanonicalProjectionTransaction,
} from "./canonical-projection-runtime.ts";
import {
  readCanonicalTransactionTags,
  readCanonicalUserCounterpartyDisplays,
  type CanonicalTransactionTagView,
  type CanonicalUserCounterpartyDisplay,
} from "./canonical-display-tags.ts";

export {
  applyCanonicalTransactionTag,
  archiveCanonicalTransactionTag,
  commitCanonicalCounterpartyAlias,
  commitCanonicalCounterpartyDisplay,
  commitCanonicalTag,
  commitCanonicalTransactionTag,
  commitCanonicalTransactionDisplay,
  commitCanonicalUserCounterpartyDisplay,
  commitCanonicalUserTag,
  createCanonicalTransactionTag,
  normalizeCanonicalTagLabel,
  readCanonicalTransactionTags,
  removeCanonicalTransactionTag,
  renameCanonicalTransactionTag,
  CANONICAL_TAG_LABEL_NORMALIZATION_VERSION,
} from "./canonical-display-tags.ts";
export type {
  CanonicalCounterpartyDisplayInput,
  CanonicalCounterpartyDisplayResult,
  CanonicalTransactionTagAction,
  CanonicalTransactionTagInput,
  CanonicalTransactionTagResult,
  CanonicalTransactionTagView,
  CanonicalUserCounterpartyDisplay,
} from "./canonical-display-tags.ts";

export type CanonicalEnrichmentOrigin = Exclude<TaxonomyOrigin, "user">;
type CanonicalEffectiveOrigin = CanonicalEnrichmentOrigin | "user";
export type CanonicalEnrichmentOutputState = "supported" | "unsupported";

export type CanonicalEnrichmentEvidence = Readonly<{
  kind?: string;
  sourceRecordId?: string;
  sourceField?: string;
  sourceValue?: string | number | boolean | null;
  contractVersion?: string;
  merchant?: string;
  mcc?: string;
  candidates?: readonly Readonly<{ value: string; confidence?: number; confidenceBasisPoints?: number }>[];
}>;

export type CanonicalCounterpartyIdentity = Readonly<{
  producerNamespace: string;
  producerEntityKey: string;
  displayName?: string | null;
  legalName?: string | null;
}>;

export type CanonicalCounterpartySourceClassification = Readonly<{
  scheme: string;
  code: string;
}>;

/** One producer-declared participation inside a grouped role output. */
export type CanonicalCounterpartyParticipationOutput = Readonly<{
  /** Stable producer-owned key used only for deterministic tie handling. */
  participationKey?: string;
  role: string;
  observedName?: string | null;
  observedReference?: string | null;
  counterparty?: CanonicalCounterpartyIdentity;
  sourceClassification?: CanonicalCounterpartySourceClassification;
  evidence?: CanonicalEnrichmentEvidence;
}>;

export type CanonicalEnrichmentOutput = Readonly<{
  transactionId: string;
  field: EnrichmentField;
  state?: CanonicalEnrichmentOutputState;
  origin?: CanonicalEnrichmentOrigin;
  value?: string | null;
  confidence?: number;
  confidenceBasisPoints?: number;
  tie?: boolean;
  evidence?: CanonicalEnrichmentEvidence;
  counterparty?: CanonicalCounterpartyIdentity;
  /**
   * Counterparty roles are one declared field with a complete grouped output.
   * The group is expanded into independent typed Assertions atomically.
   */
  participations?: readonly CanonicalCounterpartyParticipationOutput[];
}>;

export type CanonicalEnrichmentRunInput = Readonly<{
  sourceConnectionKey?: string;
  identityEpoch?: string;
  stream?: string;
  producerId?: string;
  producerVersion?: string;
  ruleLineage: string;
  observedAt?: string;
  routeId?: string;
  /** A closed-run marker matching the source import contract. */
  complete?: boolean;
  /** Failed or partial runs are diagnostics and must not alter assertions. */
  status?: "complete" | "partial" | "failed";
  /** Every declared subject/field must have one matching authority route. */
  declaredSubjects?: readonly Readonly<{
    transactionId: string;
    fields: readonly EnrichmentField[];
  }>[];
  /** @deprecated Use declaredSubjects to declare the subject scope explicitly. */
  declaredFields?: readonly EnrichmentField[];
  fields?: readonly EnrichmentField[];
  outputs: readonly CanonicalEnrichmentOutput[];
}>;

export type CanonicalEnrichmentCommitResult = Readonly<{
  status: "committed";
  runId: string;
  commitId: string;
  commitSequence: number;
  assertionIds: readonly string[];
  absent: readonly Readonly<{ transactionId: string; field: EnrichmentField }>[];
}>;

type DbRow = Record<string, unknown>;
type RouteRow = DbRow & {
  route_id: string;
  field_name: EnrichmentField;
  producer_id: string;
  producer_version: string;
  origin_policy: string;
};

type DeclaredSubject = Readonly<{
  transactionId: string;
  id: CanonicalId;
  fields: readonly EnrichmentField[];
}>;

type AdmittedOutput = Readonly<{
  output: CanonicalEnrichmentOutput;
  transactionId: string;
  id: CanonicalId;
  field: EnrichmentField;
  route: RouteRow;
  origin: CanonicalEnrichmentOrigin;
  evidenceKind: string;
  sourceRecordId: CanonicalId | null;
  effective: Readonly<{
    state: CanonicalEnrichmentOutputState;
    value: string | null;
    confidence: number | null;
  }>;
  retainedSourceValue: string | null;
  participations: readonly CanonicalCounterpartyParticipationOutput[];
}>;

function sqliteValue(value: unknown): SQLInputValue {
  return value === undefined ? null : value as SQLInputValue;
}

const FIELD_ALIASES: Readonly<Record<string, EnrichmentField>> = {
  kind: "kind",
  transaction_kind: "kind",
  category: "category",
  personal_category: "category",
  counterparty_role: "counterparty_role",
  counterparty_display: "counterparty_display",
  merchant: "counterparty_display",
};

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required.`);
  return value.trim();
}

function canonicalField(value: unknown): EnrichmentField {
  const field = typeof value === "string" ? FIELD_ALIASES[value] : undefined;
  if (!field) throw new Error(`Unsupported automatic enrichment field: ${String(value)}.`);
  return field;
}

function normalizedCanonicalId(value: string): string {
  return value.replaceAll("-", "").toLowerCase();
}

function declaredSubjectScope(
  input: CanonicalEnrichmentRunInput,
): DeclaredSubject[] {
  if (!Array.isArray(input.declaredSubjects) || input.declaredSubjects.length === 0)
    throw new Error("A complete enrichment run requires an explicit declared subject scope.");
  const seenSubjects = new Set<string>();
  return input.declaredSubjects.map((rawSubject) => {
    if (!rawSubject || typeof rawSubject !== "object")
      throw new Error("Every declared enrichment subject must be an object.");
    const id = canonicalId(rawSubject.transactionId, "Declared transaction ID");
    const transactionId = idToString(id);
    const key = normalizedCanonicalId(transactionId);
    if (seenSubjects.has(key))
      throw new Error(`Automatic enrichment declares transaction ${transactionId} more than once.`);
    seenSubjects.add(key);
    if (!Array.isArray(rawSubject.fields) || rawSubject.fields.length === 0)
      throw new Error(`Automatic enrichment subject ${transactionId} must declare at least one field.`);
    const fields = rawSubject.fields.map(canonicalField);
    if (new Set(fields).size !== fields.length)
      throw new Error(`Automatic enrichment subject ${transactionId} declares a field more than once.`);
    return { transactionId, id, fields };
  });
}

function canonicalId(value: string | Uint8Array, label: string): CanonicalId {
  if (value instanceof Uint8Array) return blob(value);
  try {
    return idFromString(requireText(value, label));
  } catch (error) {
    throw new Error(`${label} must be a canonical UUID.`, { cause: error });
  }
}

function canonicalStoredId(value: string, label: string): CanonicalId {
  if (/^[0-9a-f]{32}$/iu.test(value)) return Buffer.from(value, "hex");
  return canonicalId(value, label);
}

function confidenceBasisPoints(output: CanonicalEnrichmentOutput): number | null {
  if (output.confidenceBasisPoints !== undefined) {
    if (!Number.isInteger(output.confidenceBasisPoints) || output.confidenceBasisPoints < 0 || output.confidenceBasisPoints > 10_000)
      throw new Error("Enrichment confidence basis points must be between 0 and 10000.");
    return output.confidenceBasisPoints;
  }
  if (output.confidence === undefined) return null;
  if (!Number.isFinite(output.confidence) || output.confidence < 0 || output.confidence > 1)
    throw new Error("Enrichment confidence must be between 0 and 1.");
  return Math.round(output.confidence * 10_000);
}

function outputEvidenceKind(output: CanonicalEnrichmentOutput): string {
  const kind = output.evidence?.kind ?? output.participations?.[0]?.evidence?.kind;
  if (typeof kind !== "string" || kind.trim() === "")
    throw new Error(`Enrichment ${output.field} output requires an evidence kind.`);
  return kind.trim();
}

function outputSourceRecordId(output: CanonicalEnrichmentOutput): CanonicalId | null {
  const value = output.evidence?.sourceRecordId;
  return value === undefined || value === null ? null : canonicalId(value, "Source record ID");
}

function outputSourceField(output: CanonicalEnrichmentOutput): string | null {
  const value = output.evidence?.sourceField;
  return value === undefined || value === null ? null : requireText(value, "Source field");
}

function sourceFieldAllowed(field: EnrichmentField, sourceField: string | null): boolean {
  if (!sourceField) return false;
  const normalized = sourceField.toLowerCase();
  if (field === "kind") return ["kind", "transaction_kind", "source_kind"].includes(normalized);
  if (field === "category") return ["category", "personal_category", "source_category"].includes(normalized);
  if (field === "counterparty_role") return normalized === "counterparty_role";
  return ["counterparty_display", "merchant", "counterparty_name"].includes(normalized);
}

function outputValue(output: CanonicalEnrichmentOutput): string | null {
  if (output.state === "unsupported") return null;
  if (output.field === "counterparty_role" && output.participations?.length) {
    const first = output.participations[0];
    if (!first || typeof first.role !== "string" || first.role.trim() === "")
      throw new Error("Counterparty participation role is required.");
    return first.role.trim();
  }
  if (output.value === null || output.value === undefined || output.value.trim() === "")
    throw new Error(`Supported enrichment ${output.field} output requires a value.`);
  return output.value.trim();
}

function normalizedParticipationKey(
  participation: CanonicalCounterpartyParticipationOutput,
  index: number,
): string {
  const provided = participation.participationKey?.trim();
  if (provided) return provided;
  const reference = participation.counterparty?.producerNamespace &&
      participation.counterparty.producerEntityKey
    ? `${participation.counterparty.producerNamespace}:${participation.counterparty.producerEntityKey}`
    : "unreferenced";
  return `${participation.role.trim()}:${reference}:${index + 1}`;
}

function groupedParticipations(
  output: CanonicalEnrichmentOutput,
): readonly CanonicalCounterpartyParticipationOutput[] {
  if (output.field !== "counterparty_role") return [];
  const values = output.participations;
  if (values === undefined) return [];
  if (!Array.isArray(values) || (values.length === 0 && output.state !== "unsupported"))
    throw new Error("Counterparty participation group cannot be empty.");
  const seen = new Set<string>();
  const normalized = values.map((raw, index) => {
    if (!raw || typeof raw !== "object")
      throw new Error("Counterparty participation must be an object.");
    const role = requireText(raw.role, "Counterparty participation role");
    const key = normalizedParticipationKey({ ...raw, role }, index);
    if (seen.has(key))
      throw new Error(`Counterparty participation key ${key} is duplicated.`);
    seen.add(key);
    return {
      ...raw,
      role,
      participationKey: key,
      ...(raw.observedName === undefined ? {} : { observedName: raw.observedName === null ? null : requireText(raw.observedName, "Observed counterparty name") }),
      ...(raw.observedReference === undefined ? {} : { observedReference: raw.observedReference === null ? null : requireText(raw.observedReference, "Observed counterparty reference") }),
    };
  });
  const declaredValue = output.value?.trim();
  if (declaredValue && normalized[0] && declaredValue !== normalized[0].role)
    throw new Error("Counterparty role output value must match the first grouped participation role.");
  return normalized;
}

function counterpartyIdentity(
  value: CanonicalCounterpartyIdentity | undefined,
): { producerNamespace: string; producerEntityKey: string; displayName: string | null; legalName: string | null } | null {
  if (!value) return null;
  return {
    producerNamespace: requireText(value.producerNamespace, "Counterparty producer namespace"),
    producerEntityKey: requireText(value.producerEntityKey, "Counterparty entity key"),
    displayName: value.displayName === undefined || value.displayName === null
      ? null
      : requireText(value.displayName, "Counterparty display name"),
    legalName: value.legalName === undefined || value.legalName === null
      ? null
      : requireText(value.legalName, "Counterparty legal name"),
  };
}

function ensureCounterpartyReference(
  db: DatabaseSync,
  identity: CanonicalCounterpartyIdentity | undefined,
  commitId: CanonicalId,
  producerId: string,
  producerVersion: string,
  provenance: Readonly<Record<string, unknown>>,
): Uint8Array | null {
  const normalized = counterpartyIdentity(identity);
  if (!normalized) return null;
  // Reference identity is exact and producer-scoped. The display/legal names
  // are knowledge-time revisions; the identity row is never updated in place.
  db.prepare(`
    INSERT OR IGNORE INTO counterparty_references(
      reference_id, producer_namespace, producer_entity_key,
      display_name, legal_name, created_commit_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    uuidV7(),
    normalized.producerNamespace,
    normalized.producerEntityKey,
    normalized.displayName,
    normalized.legalName,
    commitId,
  );
  const row = db.prepare(`
    SELECT reference_id
      FROM counterparty_references
     WHERE producer_namespace = ? AND producer_entity_key = ?
  `).get(normalized.producerNamespace, normalized.producerEntityKey) as { reference_id?: unknown } | undefined;
  if (!row?.reference_id) throw new Error("Counterparty reference could not be admitted.");
  const referenceId = blob(row.reference_id);
  const otherProducer = db.prepare(`
    SELECT 1
      FROM counterparty_reference_revisions
     WHERE reference_id = ?
       AND producer_id <> ?
       AND producer_id <> 'legacy/counterparty'
     LIMIT 1
  `).get(referenceId, producerId);
  if (otherProducer)
    throw new Error("Counterparty producer namespace is already bound to another producer.");
  // A revision is retained even when its names are absent. This binds the
  // trusted producer namespace at first observation and makes a null name a
  // knowledge-time fact rather than an instruction to consult mutable state.
  db.prepare(`
    INSERT OR IGNORE INTO counterparty_reference_revisions(
      reference_revision_id, reference_id, display_name, legal_name,
      producer_id, producer_version, provenance_json, created_commit_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidV7(),
    referenceId,
    normalized.displayName,
    normalized.legalName,
    producerId,
    producerVersion,
    JSON.stringify(provenance),
    commitId,
  );
  return referenceId;
}

function participationPayloadMatches(
  db: DatabaseSync,
  transactionId: CanonicalId,
  assertionId: CanonicalId,
  expected: readonly CanonicalCounterpartyParticipationOutput[],
): boolean {
  const actual = db.prepare(`
    SELECT participation.participation_key AS participationKey,
           participation.role_code AS role,
           participation.observed_name AS observedName,
           participation.observed_reference AS observedReference,
           participation.source_classification_scheme AS sourceClassificationScheme,
           participation.source_classification_code AS sourceClassificationCode,
           reference.producer_namespace AS producerNamespace,
           reference.producer_entity_key AS producerEntityKey
      FROM counterparty_participations participation
      LEFT JOIN counterparty_references reference
        ON reference.reference_id = participation.reference_id
     WHERE participation.transaction_id = ? AND participation.assertion_id = ?
     ORDER BY participation.participation_key, participation.participation_id
  `).all(transactionId, assertionId) as DbRow[];
  const expectedSignature = expected.map((participation) => JSON.stringify({
    key: participation.participationKey ?? "",
    role: participation.role,
    observedName: participation.observedName ?? null,
    observedReference: participation.observedReference ?? null,
    scheme: participation.sourceClassification?.scheme ?? null,
    code: participation.sourceClassification?.code ?? null,
    namespace: participation.counterparty?.producerNamespace ?? null,
    entityKey: participation.counterparty?.producerEntityKey ?? null,
  })).sort();
  const actualSignature = actual.map((row) => JSON.stringify({
    key: String(row.participationKey ?? ""),
    role: String(row.role),
    observedName: row.observedName ?? null,
    observedReference: row.observedReference ?? null,
    scheme: row.sourceClassificationScheme ?? null,
    code: row.sourceClassificationCode ?? null,
    namespace: row.producerNamespace ?? null,
    entityKey: row.producerEntityKey ?? null,
  })).sort();
  return JSON.stringify(actualSignature) === JSON.stringify(expectedSignature);
}

function outputParticipations(
  output: CanonicalEnrichmentOutput,
  value: string | null,
): readonly CanonicalCounterpartyParticipationOutput[] {
  if (output.participations?.length) return output.participations;
  if (output.field !== "counterparty_role" || value === null) return [];
  return [{
    participationKey: `${value}:legacy`,
    role: value,
    observedName: output.counterparty?.displayName ?? null,
    observedReference: output.counterparty?.producerEntityKey ?? null,
    counterparty: output.counterparty,
  }];
}

type Candidate = Readonly<{
  value: string;
  confidence: number;
}>;

function candidateConfidenceBasisPoints(
  candidate: Readonly<{ confidence?: number; confidenceBasisPoints?: number }>,
): number {
  if (candidate.confidenceBasisPoints !== undefined) {
    if (
      !Number.isInteger(candidate.confidenceBasisPoints) ||
      candidate.confidenceBasisPoints < 0 ||
      candidate.confidenceBasisPoints > 10_000
    )
      throw new Error("Enrichment candidate confidence basis points must be between 0 and 10000.");
    return candidate.confidenceBasisPoints;
  }
  if (candidate.confidence === undefined) return 0;
  if (
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  )
    throw new Error("Enrichment candidate confidence must be between 0 and 1.");
  return Math.round(candidate.confidence * 10_000);
}

function effectiveOutput(
  output: CanonicalEnrichmentOutput,
  threshold: number,
): { state: CanonicalEnrichmentOutputState; value: string | null; confidence: number | null } {
  const state = output.state ?? "supported";
  if (state === "unsupported") return { state, value: null, confidence: null };
  const candidates = output.evidence?.candidates ?? [];
  if (output.tie === true)
    return { state: "unsupported", value: null, confidence: null };

  let value: string | null = null;
  let confidence: number | null = null;
  if (candidates.length > 0) {
    const scored: Candidate[] = candidates.map((candidate) => {
      if (typeof candidate.value !== "string" || candidate.value.trim() === "")
        throw new Error("Enrichment candidate value is required.");
      return {
        value: candidate.value.trim(),
        confidence: candidateConfidenceBasisPoints(candidate),
      };
    });
    const highest = Math.max(...scored.map((candidate) => candidate.confidence));
    if (scored.filter((candidate) => candidate.confidence === highest).length !== 1)
      return { state: "unsupported", value: null, confidence: highest };
    const winner = scored.find((candidate) => candidate.confidence === highest)!;
    // A producer may return its candidate set instead of duplicating the
    // winning value in `value`; the admission result is always the unique
    // winner, never a lower caller supplied candidate.
    value = winner.value;
    confidence = winner.confidence;
  } else {
    value = outputValue(output);
    confidence = confidenceBasisPoints(output);
  }

  // The package threshold is an exclusive lower bound: a Derived result must
  // be strictly above the producer's local threshold. Missing confidence is
  // therefore conservative absence, just like a low or tied result.
  if ((output.origin ?? "derived") === "derived" &&
      (confidence === null || confidence <= threshold))
    return { state: "unsupported", value: null, confidence };
  return { state: "supported", value, confidence };
}

function routeScopeMatches(route: RouteRow, integrationNamespace: string, stream: string): boolean {
  return route.scope_kind === "global" ||
    (route.scope_kind === "source_stream" && route.scope_key === `${integrationNamespace}/${stream}`);
}

function matchingRoutes(
  db: DatabaseSync,
  field: EnrichmentField,
  integrationNamespace: string,
  stream: string,
  sequence: number,
  requestedRouteId?: string,
): RouteRow[] {
  const rows = db.prepare(`
    SELECT route_id, subject_kind, field_name, scope_kind, scope_key,
           producer_id, producer_version, origin_policy, taxonomy_id,
           taxonomy_version, valid_from_commit_sequence, valid_to_commit_sequence
      FROM automatic_enrichment_authority_routes
     WHERE subject_kind = 'transaction' AND field_name = ?
       AND valid_from_commit_sequence <= ?
       AND (valid_to_commit_sequence IS NULL OR ? < valid_to_commit_sequence)
  `).all(field, sequence, sequence) as RouteRow[];
  const matching = rows.filter((route) => routeScopeMatches(route, integrationNamespace, stream));
  if (requestedRouteId) {
    const selected = matching.filter((route) => route.route_id === requestedRouteId);
    if (selected.length !== 1) throw new Error(`Automatic enrichment route ${requestedRouteId} is not active for ${field}.`);
    if (matching.length !== 1) throw new Error(`Automatic enrichment authority routes overlap for ${field}.`);
    return selected;
  }
  if (matching.length !== 1)
    throw new Error(matching.length === 0
      ? `No automatic enrichment authority route is declared for ${field}.`
      : `Automatic enrichment authority routes overlap for ${field}.`);
  return matching;
}

function accountForTransaction(db: DatabaseSync, transactionId: CanonicalId): DbRow {
  const row = db.prepare(`
    SELECT transaction_row.transaction_id, transaction_row.account_id,
           account.source_connection_id, account.identity_epoch_id, account.stream,
           connection.integration_namespace, connection.source_connection_key
      FROM financial_transactions transaction_row
      JOIN financial_accounts account ON account.account_id = transaction_row.account_id
      JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
     WHERE transaction_row.transaction_id = ?
  `).get(transactionId) as DbRow | undefined;
  if (!row) throw new Error("Automatic enrichment targets an unknown transaction subject.");
  return row;
}

function latestAssertion(
  db: DatabaseSync,
  transactionId: CanonicalId,
  field: EnrichmentField,
  producerId: string,
  ruleLineage: string,
): DbRow | undefined {
  return db.prepare(`
    SELECT assertion.assertion_id, assertion.value_text, assertion.origin,
           assertion.producer_id, assertion.rule_lineage,
           output.route_id,
           COALESCE((SELECT event_kind FROM assertion_transitions event
             JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
            WHERE event.assertion_id = assertion.assertion_id
            ORDER BY event_commit.commit_sequence DESC, event.event_id DESC LIMIT 1), 'observed') AS latest_event
      FROM assertions assertion
      LEFT JOIN enrichment_run_outputs output ON output.assertion_id = assertion.assertion_id
     WHERE assertion.transaction_id = ? AND assertion.field_name = ?
       AND assertion.producer_id = ? AND assertion.rule_lineage = ?
     ORDER BY (SELECT commit_sequence FROM canonical_commits WHERE commit_id = assertion.created_commit_id) DESC,
              assertion.assertion_id DESC
     LIMIT 1
  `).get(transactionId, field, producerId, ruleLineage) as DbRow | undefined;
}

function currentEnrichmentRows(
  db: DatabaseSync,
  transactionId: CanonicalId,
): readonly CanonicalProjectionTransactionEnrichment[] {
  const transactionIdText = idToString(transactionId);
  return createCanonicalProjectionRuntime(db).read({
    kind: "current",
    families: ["transaction-enrichment"],
    scope: { transactionIds: [transactionIdText] },
  }).families["transaction-enrichment"];
}

function currentKindCode(db: DatabaseSync, transactionId: CanonicalId): string | null {
  const row = currentEnrichmentRows(db, transactionId).find(
    (candidate) => candidate.fieldName === "kind",
  );
  return row?.taxonomyCode ?? row?.value ?? null;
}

function currentCategoryCode(db: DatabaseSync, transactionId: CanonicalId): string | null {
  const row = currentEnrichmentRows(db, transactionId).find(
    (candidate) => candidate.fieldName === "category",
  );
  return row?.taxonomyCode ?? row?.value ?? null;
}

function validateRetainedEvidenceLineage(
  db: DatabaseSync,
  transactionId: CanonicalId,
  sourceRecordId: CanonicalId,
  account: DbRow,
): void {
  const linked = db.prepare(`
    SELECT 1
      FROM transaction_revisions revision
      JOIN source_records source_record
        ON source_record.source_record_id = revision.source_record_id
      JOIN source_captures capture
        ON capture.capture_id = source_record.capture_id
     WHERE revision.transaction_id = ?
       AND revision.source_record_id = ?
       AND capture.source_connection_id = ?
       AND capture.identity_epoch_id = ?
       AND capture.stream = ?
  `).get(
    transactionId,
    sourceRecordId,
    sqliteValue(account.source_connection_id),
    sqliteValue(account.identity_epoch_id),
    String(account.stream),
  );
  if (!linked)
    throw new Error("Enrichment source evidence is outside the transaction's declared source scope.");
}

function validateSourceEvidence(
  db: DatabaseSync,
  transactionId: CanonicalId,
  output: CanonicalEnrichmentOutput,
  sourceRecordId: CanonicalId | null,
  value: string,
  account: DbRow,
): string {
  const sourceField = outputSourceField(output);
  if (!sourceFieldAllowed(canonicalField(output.field), sourceField))
    throw new Error("Source enrichment must retain a contract-defined explicit source field; free text, merchant, MCC, and combined evidence are Derived.");
  if (!sourceRecordId)
    throw new Error("Source enrichment requires the retained source record provenance.");
  validateRetainedEvidenceLineage(db, transactionId, sourceRecordId, account);

  const source = db.prepare(
    "SELECT payload_json FROM source_records WHERE source_record_id = ?",
  ).get(sourceRecordId) as { payload_json?: unknown } | undefined;
  if (!source) throw new Error("Source enrichment source record is not retained.");
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(source.payload_json));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new Error("Source enrichment source record payload is invalid.");
  }
  const sourceKey = Object.keys(payload).find(
    (key) => key.toLowerCase() === sourceField!.toLowerCase(),
  );
  if (!sourceKey)
    throw new Error(`Source enrichment field ${sourceField} is not retained by the source contract.`);
  const retained = payload[sourceKey];
  if (
    retained === null ||
    retained === undefined ||
    (typeof retained !== "string" && typeof retained !== "number" && typeof retained !== "boolean")
  )
    throw new Error(`Source enrichment field ${sourceField} has no retained scalar value.`);
  const claimed = output.evidence?.sourceValue;
  if (claimed === undefined || claimed === null)
    throw new Error("Source enrichment requires the retained source field value.");
  if (String(retained).trim() !== String(claimed).trim() || String(retained).trim() !== value)
    throw new Error(`Source enrichment field ${sourceField} does not match the retained source value.`);
  return String(retained);
}

function validateOutputCompatibility(
  db: DatabaseSync,
  output: CanonicalEnrichmentOutput,
  origin: CanonicalEnrichmentOrigin,
  value: string,
  evidenceKind: string,
  producerId: string,
  producerVersion: string,
): void {
  const field = canonicalField(output.field);
  if (field !== "counterparty_display" && !isTaxonomyCode(field, value))
    throw new Error(`Undeclared ${field} taxonomy code ${value}.`);
  if (!producerAllowsOutput(producerId, producerVersion, origin, field, value, evidenceKind))
    throw new Error(`Producer ${producerId}@${producerVersion} emitted an undeclared ${field} output ${value}.`);
  const declared = db.prepare(`
    SELECT 1 FROM taxonomy_producer_compatibility
     WHERE producer_id = ? AND producer_version = ? AND origin = ?
       AND field_name = ? AND (output_code IS NULL OR output_code = ?)
       AND EXISTS (SELECT 1 FROM json_each(evidence_kinds_json) WHERE value = ?)
  `).get(producerId, producerVersion, origin, field, field === "counterparty_display" ? null : value, evidenceKind);
  if (!declared) throw new Error(`Producer output ${field}:${value} is not declared in the persisted taxonomy package.`);
}

function commitAutomaticEnrichmentRunOnce(
  ledgerDir: string,
  rawInput: CanonicalEnrichmentRunInput,
  clock: () => string,
): CanonicalEnrichmentCommitResult {
  if (rawInput.complete === false || (rawInput.status !== undefined && rawInput.status !== "complete"))
    throw new Error("Only a complete successful enrichment run may mutate canonical data.");
  const producerId = rawInput.producerId?.trim() || CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID;
  const producerVersion = rawInput.producerVersion?.trim() || CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION;
  const ruleLineage = requireText(rawInput.ruleLineage, "Enrichment rule lineage");
  if (!Array.isArray(rawInput.outputs)) throw new Error("Enrichment outputs are required.");
  const db = openCanonicalDatabase(ledgerDir);
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    const commitSequence = Number((db.prepare("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits").get() as { value?: unknown }).value ?? 0) + 1;
    const commitId = uuidV7();
    const declaredSubjects = declaredSubjectScope(rawInput);
    const expectedOutputKeys = new Set<string>();
    const allFields = new Set<EnrichmentField>();
    for (const subject of declaredSubjects) {
      for (const field of subject.fields) {
        expectedOutputKeys.add(`${normalizedCanonicalId(subject.transactionId)}:${field}`);
        allFields.add(field);
      }
    }
    const outputs = rawInput.outputs.map((output) => ({
      ...output,
      field: canonicalField(output.field),
      transactionId: idToString(canonicalId(output.transactionId, "Transaction ID")),
      participations: output.field === "counterparty_role"
        ? groupedParticipations(output)
        : undefined,
    }));
    const outputKeys = new Set<string>();
    for (const output of outputs) {
      const key = `${normalizedCanonicalId(output.transactionId)}:${output.field}`;
      if (!expectedOutputKeys.has(key))
        throw new Error(`Automatic enrichment emitted an undeclared subject/field ${key}.`);
      if (outputKeys.has(key))
        throw new Error(`Automatic enrichment emits more than one output for ${key}.`);
      outputKeys.add(key);
    }
    if (outputKeys.size !== expectedOutputKeys.size)
      throw new Error("Automatic enrichment complete scope is missing a declared subject/field output.");
    const subjects = new Map<string, { id: CanonicalId; account: DbRow; fields: readonly EnrichmentField[] }>();
    for (const declared of declaredSubjects)
      subjects.set(normalizedCanonicalId(declared.transactionId), {
        id: declared.id,
        account: accountForTransaction(db, declared.id),
        fields: declared.fields,
      });
    const firstAccount = [...subjects.values()][0]!.account;
    const integrationNamespace = String(firstAccount.integration_namespace);
    const stream = rawInput.stream?.trim() || String(firstAccount.stream);
    const sourceConnectionId = firstAccount.source_connection_id;
    const identityEpochId = firstAccount.identity_epoch_id;
    if (rawInput.sourceConnectionKey && rawInput.sourceConnectionKey !== firstAccount.source_connection_key)
      throw new Error("Automatic enrichment source connection scope does not match the transaction.");
    for (const subject of subjects.values()) {
      if (subject.account.integration_namespace !== integrationNamespace || subject.account.stream !== stream)
        throw new Error("Automatic enrichment crossed a source integration or stream boundary.");
      if (!(sourceConnectionId instanceof Uint8Array) ||
          !(subject.account.source_connection_id instanceof Uint8Array) ||
          !Buffer.from(sourceConnectionId).equals(Buffer.from(subject.account.source_connection_id)))
        throw new Error("Automatic enrichment crossed a source connection boundary.");
      if (!(identityEpochId instanceof Uint8Array) ||
          !(subject.account.identity_epoch_id instanceof Uint8Array) ||
          !Buffer.from(identityEpochId).equals(Buffer.from(subject.account.identity_epoch_id)))
        throw new Error("Automatic enrichment crossed an identity epoch boundary.");
      if (rawInput.sourceConnectionKey && subject.account.source_connection_key !== rawInput.sourceConnectionKey)
        throw new Error("Automatic enrichment crossed a source connection boundary.");
      if (rawInput.identityEpoch && subject.account.identity_epoch_id instanceof Uint8Array) {
        const epoch = db.prepare("SELECT epoch_key FROM identity_epochs WHERE identity_epoch_id = ?").get(sqliteValue(subject.account.identity_epoch_id)) as { epoch_key?: unknown } | undefined;
        if (!epoch || String(epoch.epoch_key) !== rawInput.identityEpoch) throw new Error("Automatic enrichment identity epoch does not match the transaction.");
      }
    }
    const routeByField = new Map<EnrichmentField, RouteRow>();
    for (const field of allFields) {
      const routes = matchingRoutes(db, field, integrationNamespace, stream, commitSequence, rawInput.routeId);
      routeByField.set(field, routes[0]!);
    }
    for (const field of allFields)
      if (!routeByField.has(field)) throw new Error(`No automatic enrichment authority route is declared for ${field}.`);
    const producer = db.prepare(
      `SELECT confidence_threshold_basis_points
         FROM enrichment_producer_versions
        WHERE producer_id = ? AND producer_version = ?`,
    ).get(producerId, producerVersion) as { confidence_threshold_basis_points?: unknown } | undefined;
    if (!producer) throw new Error(`Producer version ${producerId}@${producerVersion} is not declared.`);
    const threshold = Number(producer.confidence_threshold_basis_points ?? 0);
    const admittedOutputs: AdmittedOutput[] = [];
    for (const output of outputs) {
      const transactionKey = normalizedCanonicalId(output.transactionId);
      const subject = subjects.get(transactionKey);
      if (!subject) throw new Error(`Automatic enrichment targets an undeclared transaction ${output.transactionId}.`);
      const route = routeByField.get(output.field)!;
      const origin = output.origin ?? "derived";
      if (origin === "source" && route.origin_policy === "derived")
        throw new Error(`Route ${route.route_id} does not allow Source output.`);
      if (origin === "derived" && route.origin_policy === "source")
        throw new Error(`Route ${route.route_id} does not allow Derived output.`);
      // The run-scope normalization above already validated and copied the
      // grouped payload. Re-validating an intentionally empty legacy/absent
      // role would turn it into a false admission error.
      const participations = output.participations ?? groupedParticipations(output);
      const evidenceKind = outputEvidenceKind(output);
      const sourceRecordId = outputSourceRecordId(output);
      if (sourceRecordId)
        validateRetainedEvidenceLineage(db, subject.id, sourceRecordId, subject.account);
      const effective = effectiveOutput(output, threshold);
      const value = effective.value;
      if (
        effective.state === "supported" &&
        output.field === "counterparty_role" &&
        participations.length > 0 &&
        value !== participations[0]!.role
      )
        throw new Error("Counterparty role winner must match the first grouped participation role.");
      if (effective.state === "supported" && origin === "derived" &&
          producerId === CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID &&
          evidenceKind === "description" && !sourceRecordId)
        throw new Error("Cathay description-derived enrichment requires retained source record provenance.");
      let retainedSourceValue: string | null = null;
      if (effective.state === "supported" && value !== null && origin === "source")
        retainedSourceValue = validateSourceEvidence(db, subject.id, output, sourceRecordId, value, subject.account);
      if (effective.state === "supported" && value !== null)
        validateOutputCompatibility(db, output, origin, value, evidenceKind, producerId, producerVersion);
      if (effective.state === "supported" && output.field === "counterparty_role" && participations.length > 0) {
        for (const participation of participations) {
          const participationEvidenceKind = participation.evidence?.kind?.trim() || evidenceKind;
          if (!isTaxonomyCode("counterparty_role", participation.role) ||
              !producerAllowsOutput(producerId, producerVersion, origin, "counterparty_role", participation.role, participationEvidenceKind))
            throw new Error(`Producer ${producerId}@${producerVersion} emitted an undeclared counterparty role ${participation.role}.`);
          const declared = db.prepare(`
            SELECT 1 FROM taxonomy_producer_compatibility
             WHERE producer_id = ? AND producer_version = ? AND origin = ?
               AND field_name = 'counterparty_role'
               AND (output_code IS NULL OR output_code = ?)
               AND EXISTS (SELECT 1 FROM json_each(evidence_kinds_json) WHERE value = ?)
          `).get(producerId, producerVersion, origin, participation.role, participationEvidenceKind);
          if (!declared)
            throw new Error(`Producer output counterparty_role:${participation.role} is not declared in the persisted taxonomy package.`);
        }
      }
      admittedOutputs.push({
        output,
        transactionId: output.transactionId,
        id: subject.id,
        field: output.field,
        route,
        origin,
        evidenceKind,
        sourceRecordId,
        effective,
        retainedSourceValue,
        participations,
      });
    }
    const admittedByKey = new Map(
      admittedOutputs.map((admitted) => [
        `${normalizedCanonicalId(admitted.transactionId)}:${admitted.field}`,
        admitted,
      ]),
    );
    for (const subject of declaredSubjects) {
      const subjectKey = normalizedCanonicalId(subject.transactionId);
      const kindOutput = admittedByKey.get(`${subjectKey}:kind`);
      const categoryOutput = admittedByKey.get(`${subjectKey}:category`);
      const kindValue = subject.fields.includes("kind")
        ? kindOutput?.effective.state === "supported" ? kindOutput.effective.value : null
        : currentKindCode(db, subject.id);
      const categoryValue = subject.fields.includes("category")
        ? categoryOutput?.effective.state === "supported" ? categoryOutput.effective.value : null
        : currentCategoryCode(db, subject.id);
      if (categoryValue && !kindValue)
        throw new Error("A category cannot be captured without a transaction Kind.");
      if (kindValue && categoryValue && !isCategoryApplicable(categoryValue, kindValue))
        throw new Error(`Category ${categoryValue} is incompatible with Kind ${kindValue}.`);
    }
    db.prepare(
      "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, 'derived_import')",
    ).run(commitId, commitSequence, currentUtcMicros(), `automatic/${producerId}/${producerVersion}`);
    const runId = uuidV7();
    const origins = new Set<CanonicalEnrichmentOrigin>();
    for (const admitted of admittedOutputs) origins.add(admitted.origin);
    db.prepare(`
      INSERT INTO enrichment_runs(run_id, source_connection_id, identity_epoch_id, stream,
        producer_id, producer_version, origin, rule_lineage, observed_at, commit_id, status, complete_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', 1)
    `).run(
      runId,
      sqliteValue(firstAccount.source_connection_id),
      sqliteValue(firstAccount.identity_epoch_id),
      stream,
      producerId,
      producerVersion,
      origins.size === 1 ? [...origins][0] : "mixed",
      ruleLineage,
      rawInput.observedAt ?? clock(),
      commitId,
    );
    const assertionIds: string[] = [];
    const absent: Array<{ transactionId: string; field: EnrichmentField }> = [];
    const insertOutput = db.prepare(`
      INSERT INTO enrichment_run_outputs(
        output_id, run_id, transaction_id, field_name, output_state, origin,
        value_text, confidence_basis_points, route_id, source_record_id,
        source_field, source_value_text, provenance_json, assertion_id, commit_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `);
    const updateOutputAssertion = db.prepare("UPDATE enrichment_run_outputs SET assertion_id = ? WHERE output_id = ?");
    const insertAssertion = db.prepare(`
      INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin,
        producer_id, rule_lineage, revision_id, value_text, created_commit_id)
      VALUES (?, ?, ?, 'transaction', ?, ?, ?, NULL, ?, ?)
    `);
    const insertTyped = db.prepare(`
      INSERT INTO enrichment_taxonomy_assertion_values(
        assertion_id, field_name, taxonomy_id, taxonomy_version, taxonomy_dimension,
        taxonomy_code, route_id, run_id, source_record_id, provenance_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTransition = db.prepare(`
      INSERT INTO assertion_transitions(
        event_id, assertion_id, transaction_id, field_name, capture_id, scope_id,
        run_id, enrichment_run_id, coordinate_id, user_id, commit_id, event_kind)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, ?, ?)
    `);
    const insertProvenance = db.prepare(`
      INSERT INTO assertion_provenance(
        assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id)
      VALUES (?, ?, NULL, ?, NULL, ?)
    `);
    for (const admitted of admittedOutputs) {
      const output = admitted.output;
      const subject = subjects.get(normalizedCanonicalId(admitted.transactionId))!;
      const route = admitted.route;
      const origin = admitted.origin;
      const evidenceKind = admitted.evidenceKind;
      const sourceRecordId = admitted.sourceRecordId;
      const effective = admitted.effective;
      const value = effective.value;
      const retainedSourceValue = admitted.retainedSourceValue;
      const provenance = {
        taxonomyId: TRANSACTION_TAXONOMY_ID,
        taxonomyVersion: TRANSACTION_TAXONOMY_VERSION,
        routeId: route.route_id,
        producerId,
        producerVersion,
        origin,
        evidenceKind,
        sourceField: outputSourceField(output),
        sourceValue: retainedSourceValue ?? output.evidence?.sourceValue ?? null,
        contractVersion: output.evidence?.contractVersion ?? null,
        confidenceBasisPoints: effective.confidence,
        ruleLineage,
        ...(admitted.participations.length > 0
          ? {
              participations: admitted.participations.map((participation) => ({
                participationKey: participation.participationKey,
                role: participation.role,
                observedName: participation.observedName ?? null,
                observedReference: participation.observedReference ?? null,
                sourceClassification: participation.sourceClassification ?? null,
                counterparty: participation.counterparty
                  ? {
                      producerNamespace: participation.counterparty.producerNamespace,
                      producerEntityKey: participation.counterparty.producerEntityKey,
                    }
                  : null,
              })),
            }
          : {}),
      };
      const outputId = uuidV7();
      insertOutput.run(
        outputId,
        runId,
        subject.id,
        output.field,
        effective.state,
        effective.state === "supported" ? origin : null,
        value,
        effective.confidence,
        route.route_id,
        sourceRecordId,
        outputSourceField(output),
        retainedSourceValue ?? (output.evidence?.sourceValue === undefined ? null : String(output.evidence.sourceValue)),
        JSON.stringify(provenance),
        commitId,
      );
      const prior = latestAssertion(db, subject.id, output.field, producerId, ruleLineage);
      const priorActive = prior && !["withdrawn", "superseded"].includes(String(prior.latest_event));
      if (effective.state === "unsupported") {
        absent.push({ transactionId: output.transactionId, field: output.field });
        if (prior && priorActive) {
          const priorId = blob(prior.assertion_id);
          updateOutputAssertion.run(priorId, outputId);
          insertTransition.run(uuidV7(), priorId, subject.id, output.field, runId, commitId, "withdrawn");
          insertProvenance.run(priorId, sourceRecordId, runId, commitId);
        }
        continue;
      }
      let assertionId: CanonicalId;
      const sameParticipationPayload = output.field !== "counterparty_role" || !prior
        ? true
        : participationPayloadMatches(
            db,
            subject.id,
            blob(prior.assertion_id),
            outputParticipations(output, value),
          );
      const sameRouteAndValue = prior && priorActive && String(prior.value_text) === value && String(prior.route_id ?? "") === route.route_id && sameParticipationPayload;
      if (sameRouteAndValue) {
        assertionId = blob(prior.assertion_id);
      } else {
        assertionId = uuidV7();
        if (prior && priorActive && String(prior.route_id ?? "") === route.route_id) {
          // The v23 transition guard requires the run output to point at the
          // assertion being superseded before that lifecycle event is written.
          // It is repointed to the replacement assertion immediately below.
          const priorId = blob(prior.assertion_id);
          updateOutputAssertion.run(priorId, outputId);
          insertTransition.run(uuidV7(), priorId, subject.id, output.field, runId, commitId, "superseded");
        }
        insertAssertion.run(assertionId, subject.id, output.field, origin, producerId, ruleLineage, value, commitId);
        const dimension = taxonomyDimensionForField(output.field);
        if (dimension)
          insertTyped.run(assertionId, output.field, TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION, dimension, value, route.route_id, runId, sourceRecordId, JSON.stringify(provenance));
      }
      updateOutputAssertion.run(assertionId, outputId);
      insertProvenance.run(assertionId, sourceRecordId, runId, commitId);
      if (!sameRouteAndValue)
        insertTransition.run(uuidV7(), assertionId, subject.id, output.field, runId, commitId, "observed");
      assertionIds.push(idToString(assertionId));
      if (output.field === "counterparty_role") {
        const participations = outputParticipations(output, value);
        for (const participation of participations) {
          const classification = participation.sourceClassification;
          if ((classification?.scheme === undefined) !== (classification?.code === undefined))
            throw new Error("Counterparty source classification requires both scheme and code.");
          const participationProvenance = {
            ...provenance,
            participationKey: participation.participationKey,
            participationRole: participation.role,
            ...(participation.evidence?.kind
              ? { participationEvidenceKind: participation.evidence.kind }
              : {}),
          };
          const referenceId = ensureCounterpartyReference(
            db,
            participation.counterparty,
            commitId,
            producerId,
            producerVersion,
            participationProvenance,
          );
          if (sameRouteAndValue) continue;
          db.prepare(`
            INSERT INTO counterparty_participations(
              participation_id, transaction_id, assertion_id, reference_id,
              role_code, origin, observed_name, observed_reference,
              source_classification_scheme, source_classification_code,
              participation_key, producer_id, producer_version,
              route_id, provenance_json, commit_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            uuidV7(),
            subject.id,
            assertionId,
            sqliteValue(referenceId),
            participation.role,
            origin,
            participation.observedName ?? participation.counterparty?.displayName ?? null,
            participation.observedReference ?? participation.counterparty?.producerEntityKey ?? null,
            classification?.scheme ?? null,
            classification?.code ?? null,
            participation.participationKey ?? "",
            producerId,
            producerVersion,
            route.route_id,
            JSON.stringify(participationProvenance),
            commitId,
          );
        }
      }
      if (output.field === "counterparty_display") {
        const referenceId = ensureCounterpartyReference(
          db,
          output.counterparty,
          commitId,
          producerId,
          producerVersion,
          provenance,
        );
        db.prepare(`
          INSERT OR IGNORE INTO counterparty_display_assertion_values(
            assertion_id, transaction_id, origin, display_kind, reference_id,
            participation_key, label, created_commit_id)
          VALUES (?, ?, ?, 'automatic', ?, ?, ?, ?)
        `).run(
          assertionId,
          subject.id,
          origin,
          sqliteValue(referenceId),
          null,
          value,
          commitId,
        );
      }
    }
    createCanonicalProjectionRuntime(db).applyCommit({ commitId, kind: "derived_import" });
    db.exec("COMMIT");
    inTransaction = false;
    return {
      status: "committed",
      runId: idToString(runId),
      commitId: idToString(commitId),
      commitSequence,
      assertionIds,
      absent,
    };
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function commitCanonicalAutomaticEnrichmentRun(
  ledgerDir: string,
  input: CanonicalEnrichmentRunInput,
  options: { clock?: () => string; runtime?: CanonicalRuntimeOptions } = {},
): Promise<CanonicalEnrichmentCommitResult> {
  const clock = options.clock ?? (() => new Date().toISOString());
  return withCanonicalWriterQueue(
    canonicalSqlitePath(ledgerDir),
    () => commitAutomaticEnrichmentRunOnce(ledgerDir, input, clock),
    options.runtime,
  );
}

export const commitCanonicalEnrichmentRun = commitCanonicalAutomaticEnrichmentRun;

export type CanonicalEnrichmentFieldResult = Readonly<{
  status: "supported";
  code?: string;
  value: string;
  taxonomyId: string;
  taxonomyVersion: string;
  taxonomyDimension: string | null;
  origin: CanonicalEffectiveOrigin;
  route: Readonly<{ id: string; producerId: string; producerVersion: string }>;
  assertionId: string;
  provenance: Readonly<Record<string, unknown>>;
  displayKind?: "automatic" | "override" | "reference_alias";
  referenceId?: string | null;
  participationKey?: string | null;
}> | Readonly<{ status: "absent" }>;

export type CanonicalEnrichmentCategoryComponent = Readonly<{
  categoryCode: string;
  taxonomyId: string;
  taxonomyVersion: string;
  coefficient: string;
  scale: number;
  currency: string;
  origin: "user";
  assertionId: string;
  provenance: Readonly<Record<string, unknown>>;
  conversionEvidence?: Readonly<{
    kind: string;
    id: string;
    fromCurrency: string;
    toCurrency: string;
    json: string;
  }>;
}>;

export type CanonicalEnrichmentCategoryResult =
  | Readonly<{ status: "absent"; mode: "absent" }>
  | Readonly<{
      status: "supported";
      mode: "single";
      code?: string;
      value: string;
      taxonomyId: string;
      taxonomyVersion: string;
      taxonomyDimension: string | null;
      origin: CanonicalEffectiveOrigin;
      route: Readonly<{
        id: string;
        producerId: string;
        producerVersion: string;
      }> | null;
      assertionId: string;
      provenance: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      status: "supported";
      mode: "allocated";
      value: null;
      taxonomyId: string;
      taxonomyVersion: string;
      taxonomyDimension: "category";
      origin: "user";
      route: null;
      assertionId: string;
      provenance: Readonly<Record<string, unknown>>;
      components: readonly CanonicalEnrichmentCategoryComponent[];
    }>;

export type CanonicalEnrichmentTransaction = Readonly<{
  transactionId: string;
  kind: CanonicalEnrichmentFieldResult;
  category: CanonicalEnrichmentCategoryResult;
  counterparties: readonly Readonly<Record<string, unknown>>[];
  display: CanonicalEnrichmentFieldResult;
  tags: readonly CanonicalTransactionTagView[];
}>;

export type CanonicalEnrichmentQueryResult = Readonly<{
  kind: "current" | "historical" | "lineage";
  knowledgePoint: number;
  financialAt: string | null;
  transactions: readonly CanonicalEnrichmentTransaction[];
  lineage?: readonly Readonly<Record<string, unknown>>[];
}>;

export type CanonicalEnrichmentQueryRequest = Readonly<{
  transactionIds?: readonly string[];
  sourceConnectionKey?: string;
  stream?: string;
  financialAt?: string;
  knowledgeAt?: number;
}>;

function parseProvenance(value: unknown): Readonly<Record<string, unknown>> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Readonly<Record<string, unknown>>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resultFromRow(row: DbRow | undefined): CanonicalEnrichmentFieldResult {
  if (!row) return { status: "absent" };
  const value = String(row.value_text ?? "");
  const field = String(row.field_name);
  return {
    status: "supported",
    code: row.taxonomy_code === null || row.taxonomy_code === undefined ? undefined : String(row.taxonomy_code),
    value,
    taxonomyId: String(row.taxonomy_id ?? TRANSACTION_TAXONOMY_ID),
    taxonomyVersion: String(row.taxonomy_version ?? TRANSACTION_TAXONOMY_VERSION),
    taxonomyDimension: row.taxonomy_dimension === null || row.taxonomy_dimension === undefined ? null : String(row.taxonomy_dimension),
    origin: String(row.origin) as CanonicalEnrichmentOrigin,
    route: { id: String(row.route_id), producerId: String(row.producer_id), producerVersion: String(row.producer_version) },
    assertionId: idToString(blob(row.assertion_id)),
    provenance: parseProvenance(row.provenance_json),
  };
}

function resultFromRuntimeRow(
  row: CanonicalProjectionTransactionEnrichment | undefined,
  provenance: Readonly<Record<string, unknown>>,
): CanonicalEnrichmentFieldResult {
  if (!row) return { status: "absent" };
  return {
    status: "supported",
    code: row.taxonomyCode ?? undefined,
    value: row.value,
    taxonomyId: row.taxonomyId,
    taxonomyVersion: row.taxonomyVersion,
    taxonomyDimension: row.taxonomyDimension,
    origin: row.origin as CanonicalEnrichmentOrigin,
    route: {
      id: row.routeId,
      producerId: row.producerId,
      producerVersion: row.producerVersion,
    },
    assertionId: idToString(canonicalStoredId(row.assertionId, "Assertion ID")),
    provenance,
  };
}

type PersistedExact = Readonly<{ coefficient: bigint; scale: number }>;

function persistedExact(
  coefficient: string | null,
  scale: number | null,
  label: string,
): PersistedExact | null {
  if (coefficient === null || scale === null) return null;
  if (!/^-?(?:0|[1-9]\d*)$/u.test(coefficient) || !Number.isSafeInteger(scale) || scale < 0)
    throw new Error(`${label} is not a canonical exact amount.`);
  return { coefficient: BigInt(coefficient), scale };
}

function alignPersisted(left: PersistedExact, right: PersistedExact): [bigint, bigint] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * 10n ** BigInt(scale - left.scale),
    right.coefficient * 10n ** BigInt(scale - right.scale),
  ];
}

function equalPersisted(left: PersistedExact, right: PersistedExact): boolean {
  const aligned = alignPersisted(left, right);
  return aligned[0] === aligned[1];
}

function addPersisted(left: PersistedExact, right: PersistedExact): PersistedExact {
  const scale = Math.max(left.scale, right.scale);
  const [leftCoefficient, rightCoefficient] = alignPersisted(left, right);
  return { coefficient: leftCoefficient + rightCoefficient, scale };
}

function absentCategory(): CanonicalEnrichmentCategoryResult {
  return { status: "absent", mode: "absent" };
}

function categoryFromRuntimeRows(
  transaction: CanonicalProjectionTransaction,
  kind: CanonicalProjectionTransactionEnrichment | undefined,
  automatic: CanonicalProjectionTransactionEnrichment | undefined,
  userRows: readonly CanonicalProjectionTransactionCategorization[],
  db: DatabaseSync,
  knowledgeAt?: number,
): CanonicalEnrichmentCategoryResult {
  const kindCode = kind?.taxonomyCode ?? kind?.value ?? null;
  const transactionRows = userRows.filter(
    (row) => row.transactionId === transaction.transactionId,
  );
  if (kindCode !== null && transactionRows.length > 0) {
    const assertionIds = new Set(transactionRows.map((row) => row.assertionId));
    const first = transactionRows[0]!;
    const oneAssertion = assertionIds.size === 1;
    if (oneAssertion && first.mode === "single") {
      const selected = transactionRows.length === 1 ? first : null;
      if (
        selected &&
        selected.categoryCode &&
        isCategoryApplicable(selected.categoryCode, kindCode)
      ) {
        return {
          status: "supported",
          mode: "single",
          code: selected.categoryCode,
          value: selected.categoryCode,
          taxonomyId: selected.taxonomyId,
          taxonomyVersion: selected.taxonomyVersion,
          taxonomyDimension: "category",
          origin: "user",
          route: null,
          assertionId: selected.assertionId,
          provenance: {
            kind: "user-categorization",
            projectionCommitId: selected.projectionCommitId,
            projectionCommitSequence: selected.projectionCommitSequence,
          },
        };
      }
    } else if (oneAssertion && first.mode === "allocated") {
      const components = [...transactionRows].sort(
        (left, right) => (left.componentOrdinal ?? 0) - (right.componentOrdinal ?? 0),
      );
      const seen = new Set<string>();
      let total: PersistedExact = { coefficient: 0n, scale: 0 };
      let complete = components.length >= 2;
      for (const component of components) {
        if (
          component.categoryCode === null ||
          component.componentOrdinal === null ||
          component.amountCoefficient === null ||
          component.amountScale === null ||
          component.amountCurrency === null ||
          component.bookedCoefficient === null ||
          component.bookedScale === null ||
          component.bookedCurrency === null ||
          seen.has(component.categoryCode) ||
          !isCategoryApplicable(component.categoryCode, kindCode) ||
          component.bookedCurrency !== transaction.currency
        ) {
          complete = false;
          break;
        }
        seen.add(component.categoryCode);
        const booked = persistedExact(
          component.bookedCoefficient,
          component.bookedScale,
          "Persisted allocation booked amount",
        );
        if (!booked) {
          complete = false;
          break;
        }
        total = addPersisted(total, booked);
      }
      const transactionAmount = persistedExact(
        transaction.amountCoefficient,
        transaction.amountScale,
        "Transaction amount",
      );
      if (!transactionAmount || !equalPersisted(total, transactionAmount))
        complete = false;
      if (complete) {
        return {
          status: "supported",
          mode: "allocated",
          value: null,
          taxonomyId: first.taxonomyId,
          taxonomyVersion: first.taxonomyVersion,
          taxonomyDimension: "category",
          origin: "user",
          route: null,
          assertionId: first.assertionId,
          provenance: {
            kind: "user-categorization",
            projectionCommitId: first.projectionCommitId,
            projectionCommitSequence: first.projectionCommitSequence,
          },
          components: components.map((component) => ({
            categoryCode: component.categoryCode!,
            taxonomyId: component.taxonomyId,
            taxonomyVersion: component.taxonomyVersion,
            coefficient: component.bookedCoefficient!,
            scale: component.bookedScale!,
            currency: component.bookedCurrency!,
            origin: "user" as const,
            assertionId: component.assertionId,
            provenance: {
              kind: "user-categorization",
              projectionCommitId: component.projectionCommitId,
              projectionCommitSequence: component.projectionCommitSequence,
            },
            ...(component.conversionEvidenceKind &&
            component.conversionEvidenceId &&
            component.conversionFromCurrency &&
            component.conversionToCurrency &&
            component.conversionEvidenceJson
              ? {
                  conversionEvidence: {
                    kind: component.conversionEvidenceKind,
                    id: component.conversionEvidenceId,
                    fromCurrency: component.conversionFromCurrency,
                    toCurrency: component.conversionToCurrency,
                    json: component.conversionEvidenceJson,
                  },
                }
              : {}),
          })),
        };
      }
    }
  }
  const automaticCode = automatic?.taxonomyCode ?? automatic?.value ?? null;
  if (
    automatic &&
    automaticCode &&
    kindCode &&
    isCategoryApplicable(automaticCode, kindCode)
  ) {
    const automaticResult = resultFromRuntimeRow(
      automatic,
      outputProvenance(db, automatic.assertionId, knowledgeAt),
    );
    if (automaticResult.status === "supported")
      return { ...automaticResult, mode: "single" };
  }
  return absentCategory();
}

function outputProvenance(
  db: DatabaseSync,
  assertionId: unknown,
  knowledgeAt?: number,
): Readonly<Record<string, unknown>> {
  const parameter =
    typeof assertionId === "string"
      ? canonicalStoredId(assertionId, "Assertion ID")
      : sqliteValue(assertionId);
  const row = knowledgeAt === undefined
    ? db.prepare(`
        SELECT provenance_json
          FROM enrichment_run_outputs
         WHERE assertion_id = ?
         ORDER BY rowid DESC
         LIMIT 1
      `).get(parameter) as { provenance_json?: unknown } | undefined
    : db.prepare(`
        SELECT output.provenance_json
          FROM enrichment_run_outputs output
          JOIN canonical_commits output_commit
            ON output_commit.commit_id = output.commit_id
         WHERE output.assertion_id = ?
           AND output_commit.commit_sequence <= ?
         ORDER BY output_commit.commit_sequence DESC, output.rowid DESC
         LIMIT 1
      `).get(parameter, knowledgeAt) as { provenance_json?: unknown } | undefined;
  return parseProvenance(row?.provenance_json);
}

function requireBoundedScope(request: CanonicalEnrichmentQueryRequest): void {
  if (
    !request.sourceConnectionKey &&
    (!request.transactionIds || request.transactionIds.length === 0)
  )
    throw new Error("Canonical enrichment queries require a source connection or explicit transaction IDs.");
}

const COUNTERPARTY_ROLE_ORDER: Readonly<Record<string, number>> = {
  merchant: 10,
  marketplace: 20,
  payment_platform: 30,
  financial_institution: 40,
  income_source: 50,
  government: 60,
  person: 70,
};

function counterpartyRoleRank(role: unknown): number {
  const normalized = String(role ?? "");
  return COUNTERPARTY_ROLE_ORDER[normalized] ?? 1_000;
}

/**
 * Read every active participation in the selected typed role assertion. The
 * participation key is producer-owned and is only a deterministic tie-break;
 * producer namespace/entity key remains the sole reference identity.
 */
function selectedCounterpartyRows(
  db: DatabaseSync,
  transactionId: Uint8Array,
  assertionId: Uint8Array | string,
  cutoff: number,
  current = false,
): DbRow[] {
  const assertionParameter = typeof assertionId === "string"
    ? canonicalStoredId(assertionId, "Role assertion ID")
    : assertionId;
  const participationTable = current
    ? "current_counterparty_participations"
    : "counterparty_participations";
  const participationCommitColumn = current
    ? "participation.projection_commit_id"
    : "participation.commit_id";
  const rows = db.prepare(`
    SELECT participation.participation_id AS participationId,
           participation.participation_key AS participationKey,
           participation.role_code AS role,
           participation.observed_name AS observedName,
           participation.observed_reference AS observedReference,
           participation.source_classification_scheme AS sourceClassificationScheme,
           participation.source_classification_code AS sourceClassificationCode,
           participation.origin,
           participation.route_id AS routeId,
           participation.assertion_id AS assertionId,
           participation.producer_id AS producerId,
           participation.producer_version AS producerVersion,
           participation.provenance_json AS provenanceJson,
           reference.reference_id AS referenceId,
           reference.producer_namespace AS producerNamespace,
           reference.producer_entity_key AS producerEntityKey,
           CASE WHEN reference.reference_id IS NULL THEN NULL
                WHEN EXISTS (SELECT 1
                               FROM counterparty_reference_revisions revision
                               JOIN canonical_commits revision_commit
                                 ON revision_commit.commit_id = revision.created_commit_id
                              WHERE revision.reference_id = reference.reference_id
                                AND revision_commit.commit_sequence <= ?) THEN
                  (SELECT revision.display_name
                     FROM counterparty_reference_revisions revision
                     JOIN canonical_commits revision_commit
                       ON revision_commit.commit_id = revision.created_commit_id
                    WHERE revision.reference_id = reference.reference_id
                      AND revision_commit.commit_sequence <= ?
                    ORDER BY revision_commit.commit_sequence DESC, revision.rowid DESC
                    LIMIT 1)
                ELSE reference.display_name
           END AS referenceDisplayName,
           CASE WHEN reference.reference_id IS NULL THEN NULL
                WHEN EXISTS (SELECT 1
                               FROM counterparty_reference_revisions revision
                               JOIN canonical_commits revision_commit
                                 ON revision_commit.commit_id = revision.created_commit_id
                              WHERE revision.reference_id = reference.reference_id
                                AND revision_commit.commit_sequence <= ?) THEN
                  (SELECT revision.legal_name
                     FROM counterparty_reference_revisions revision
                     JOIN canonical_commits revision_commit
                       ON revision_commit.commit_id = revision.created_commit_id
                    WHERE revision.reference_id = reference.reference_id
                      AND revision_commit.commit_sequence <= ?
                    ORDER BY revision_commit.commit_sequence DESC, revision.rowid DESC
                    LIMIT 1)
                ELSE reference.legal_name
           END AS referenceLegalName,
           typed.taxonomy_id AS taxonomyId,
           typed.taxonomy_version AS taxonomyVersion,
           typed.taxonomy_dimension AS taxonomyDimension,
           /* A grouped assertion carries one declared field value, while
            * each retained participation has its own typed role. */
           participation.role_code AS taxonomyCode
      FROM ${participationTable} participation
      JOIN assertions role_assertion
        ON role_assertion.assertion_id = participation.assertion_id
       AND role_assertion.transaction_id = participation.transaction_id
       AND role_assertion.field_name = 'counterparty_role'
      LEFT JOIN counterparty_references reference
        ON reference.reference_id = participation.reference_id
      LEFT JOIN enrichment_taxonomy_assertion_values typed
        ON typed.assertion_id = participation.assertion_id
       AND typed.field_name = 'counterparty_role'
     WHERE participation.transaction_id = ?
       AND participation.assertion_id = ?
       AND (SELECT commit_sequence FROM canonical_commits
              WHERE commit_id = ${participationCommitColumn}) <= ?
       AND (SELECT commit_sequence FROM canonical_commits
              WHERE commit_id = role_assertion.created_commit_id) <= ?
       AND COALESCE((SELECT event_kind
                       FROM assertion_transitions event
                       JOIN canonical_commits event_commit
                         ON event_commit.commit_id = event.commit_id
                      WHERE event.assertion_id = role_assertion.assertion_id
                        AND event_commit.commit_sequence <= ?
                      ORDER BY event_commit.commit_sequence DESC, event.rowid DESC
                      LIMIT 1), 'observed') NOT IN ('withdrawn','superseded')
     ORDER BY participation.role_code, participation.participation_key,
              participation.participation_id
  `).all(cutoff, cutoff, cutoff, cutoff, transactionId, assertionParameter, cutoff, cutoff, cutoff) as DbRow[];
  return rows.sort((left, right) => {
    const role = counterpartyRoleRank(left.role) - counterpartyRoleRank(right.role);
    if (role !== 0) return role;
    const key = String(left.participationKey ?? "").localeCompare(String(right.participationKey ?? ""));
    if (key !== 0) return key;
    return Buffer.from(blob(left.participationId)).compare(Buffer.from(blob(right.participationId)));
  });
}

function userDisplayResult(
  row: CanonicalUserCounterpartyDisplay,
): CanonicalEnrichmentFieldResult {
  return {
    status: "supported",
    value: row.label,
    taxonomyId: TRANSACTION_TAXONOMY_ID,
    taxonomyVersion: TRANSACTION_TAXONOMY_VERSION,
    taxonomyDimension: null,
    origin: "user",
    route: {
      id: "user/counterparty-display/v1",
      producerId: row.userId,
      producerVersion: "v1",
    },
    assertionId: row.assertionId,
    provenance: {
      kind: "user-counterparty-display",
      displayKind: row.displayKind,
      referenceId: row.referenceId,
      participationKey: row.participationKey,
      userId: row.userId,
      commitSequence: row.commitSequence,
    },
    displayKind: row.displayKind,
    referenceId: row.referenceId,
    participationKey: row.participationKey,
  };
}

function selectedCounterpartyDisplay(
  db: DatabaseSync,
  transactionId: Uint8Array,
  cutoff: number,
  counterparties: readonly DbRow[],
  automatic: CanonicalProjectionTransactionEnrichment | undefined,
): CanonicalEnrichmentFieldResult {
  const userDisplays = [...readCanonicalUserCounterpartyDisplays(db, transactionId, cutoff)]
    .sort((left, right) => right.commitSequence - left.commitSequence || left.assertionId.localeCompare(right.assertionId));
  const override = userDisplays.find((row) => row.displayKind === "override");
  if (override) return userDisplayResult(override);
  const selected = counterparties[0];
  const selectedReferenceId = selected?.referenceId instanceof Uint8Array
    ? idToString(blob(selected.referenceId))
    : selected?.referenceId === null || selected?.referenceId === undefined
      ? null
      : idToString(blob(selected.referenceId));
  if (selectedReferenceId) {
    const alias = userDisplays.find(
      (row) => row.displayKind === "reference_alias" && row.referenceId === selectedReferenceId,
    );
    if (alias) return userDisplayResult(alias);
  }
  if (automatic) {
    const result = resultFromRuntimeRow(
      automatic,
      outputProvenance(db, automatic.assertionId, cutoff),
    );
    if (result.status === "supported")
      return { ...result, displayKind: "automatic", referenceId: selectedReferenceId };
  }
  return { status: "absent" };
}

function latestKnowledgePoint(db: DatabaseSync): number {
  return Number(
    (db.prepare("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits").get() as { value?: unknown }).value ?? 0,
  );
}

function queryParametersForScope(
  request: CanonicalEnrichmentQueryRequest,
  transactionAlias: string,
  accountAlias: string,
  connectionAlias = "connection",
): { clauses: string[]; parameters: Array<string | Uint8Array> } {
  const clauses = ["1 = 1"];
  const parameters: Array<string | Uint8Array> = [];
  if (request.sourceConnectionKey) {
    clauses.push(`${connectionAlias}.source_connection_key = ?`);
    parameters.push(request.sourceConnectionKey);
  }
  if (request.stream) {
    clauses.push(`${accountAlias}.stream = ?`);
    parameters.push(request.stream);
  }
  if (request.transactionIds && request.transactionIds.length > 0) {
    const ids = request.transactionIds.map((id) => canonicalId(id, "Transaction ID"));
    clauses.push(`${transactionAlias}.transaction_id IN (${ids.map(() => "?").join(",")})`);
    parameters.push(...ids);
  } else if (request.transactionIds && request.transactionIds.length === 0)
    return { clauses: ["0 = 1"], parameters };
  return { clauses, parameters };
}

function currentTransactionRows(
  db: DatabaseSync,
  request: CanonicalEnrichmentQueryRequest,
): DbRow[] {
  const projectionScope = {
    ...(request.sourceConnectionKey
      ? { sourceConnectionKey: request.sourceConnectionKey }
      : {}),
    ...(request.transactionIds
      ? { transactionIds: request.transactionIds }
      : {}),
    ...(request.financialAt ? { endDate: request.financialAt } : {}),
  };
  const projection = createCanonicalProjectionRuntime(db).read({
    kind: "current",
    families: ["transactions"],
    scope: projectionScope,
  });
  const projected = projection.families.transactions;
  if (projected.length === 0) return [];
  const projectionIds = projected.map((row) => {
    const normalized = row.transactionId.replaceAll("-", "");
    if (!/^[0-9a-f]{32}$/iu.test(normalized))
      throw new Error("Canonical projection returned an invalid transaction ID.");
    return Buffer.from(normalized, "hex");
  });
  const scope = queryParametersForScope(request, "transaction_row", "account");
  const rows = db.prepare(`
    SELECT transaction_row.transaction_id,
           connection.integration_namespace, connection.source_connection_key,
           account.stream
      FROM financial_transactions transaction_row
      JOIN financial_accounts account ON account.account_id = transaction_row.account_id
      JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
     WHERE ${scope.clauses.join(" AND ")}
       AND transaction_row.transaction_id IN (${projectionIds.map(() => "?").join(",")})
  `).all(...scope.parameters, ...projectionIds) as DbRow[];
  const metadata = new Map(
    rows.map((row) => [idToString(blob(row.transaction_id)), row]),
  );
  return projected.flatMap((row) => {
    const transactionId = idToString(
      Buffer.from(row.transactionId.replaceAll("-", ""), "hex"),
    );
    const source = metadata.get(transactionId);
    if (!source) return [];
    return [
      {
        ...source,
        effective_on: row.effectiveOn,
      },
    ];
  });
}

function transactionRows(
  db: DatabaseSync,
  request: CanonicalEnrichmentQueryRequest,
  mode: "current" | "historical" | "lineage",
  knowledgeAt?: number,
): DbRow[] {
  requireBoundedScope(request);
  if (mode === "current" || knowledgeAt === undefined)
    return currentTransactionRows(db, request);
  if (!request.financialAt)
    throw new Error("Historical enrichment queries require a financial date cutoff.");
  const scope = {
    ...(request.sourceConnectionKey ? { sourceConnectionKey: request.sourceConnectionKey } : {}),
    ...(request.transactionIds ? { transactionIds: request.transactionIds } : {}),
  };
  const projection = createCanonicalProjectionRuntime(db).read({
    kind: "historical",
    families: ["transactions"],
    scope,
    cutoff: { financialAt: request.financialAt, knowledgeAt },
  });
  const streamIds = request.stream
    ? new Set(
      (db.prepare(`
        SELECT transaction_row.transaction_id
          FROM financial_transactions transaction_row
          JOIN financial_accounts account ON account.account_id = transaction_row.account_id
         WHERE account.stream = ?
      `).all(request.stream) as Array<Record<string, unknown>>)
        .map((row) => idToString(blob(row.transaction_id))),
    )
    : null;
  return projection.families.transactions.flatMap((row) => {
    const transactionId = idToString(canonicalStoredId(row.transactionId, "Transaction ID"));
    if (streamIds && !streamIds.has(transactionId)) return [];
    return [{ transaction_id: canonicalStoredId(transactionId, "Transaction ID"), effective_on: row.effectiveOn }];
  });
}

function currentTransaction(
  db: DatabaseSync,
  transactionId: Uint8Array,
): CanonicalEnrichmentTransaction {
  const transactionIdText = idToString(transactionId);
  const projection = createCanonicalProjectionRuntime(db).read({
    kind: "current",
    families: ["transactions", "transaction-enrichment", "transaction-categorization"],
    scope: { transactionIds: [transactionIdText] },
  });
  const transactionKey = transactionIdText.replaceAll("-", "").toLowerCase();
  const transaction = projection.families.transactions.find(
    (row) => row.transactionId.replaceAll("-", "").toLowerCase() === transactionKey,
  );
  if (!transaction)
    throw new Error("Canonical projection returned an unknown transaction subject.");
  const enrichmentRows = projection.families["transaction-enrichment"];
  const categorizationRows = projection.families["transaction-categorization"];
  const byField = new Map(
    enrichmentRows.map((row) => [row.fieldName, row]),
  );
  const roleAssertion = byField.get("counterparty_role");
  const cutoff = latestKnowledgePoint(db);
  const counterparts = roleAssertion
      ? selectedCounterpartyRows(db, transactionId, roleAssertion.assertionId, cutoff, true)
    : [];
  return {
    transactionId: idToString(transactionId),
    kind: resultFromRuntimeRow(
      byField.get("kind"),
      outputProvenance(db, byField.get("kind")?.assertionId),
    ),
    category: categoryFromRuntimeRows(
      transaction,
      byField.get("kind"),
      byField.get("category"),
      categorizationRows,
      db,
    ),
    display: selectedCounterpartyDisplay(
      db,
      transactionId,
      cutoff,
      counterparts,
      byField.get("counterparty_display"),
    ),
    counterparties: counterparts.map((row) => ({
      participationKey: String(row.participationKey ?? ""),
      role: String(row.role),
      observedName: row.observedName === null ? null : String(row.observedName),
      observedReference: row.observedReference === null ? null : String(row.observedReference),
      sourceClassificationScheme: row.sourceClassificationScheme === null || row.sourceClassificationScheme === undefined ? null : String(row.sourceClassificationScheme),
      sourceClassificationCode: row.sourceClassificationCode === null || row.sourceClassificationCode === undefined ? null : String(row.sourceClassificationCode),
      producerNamespace: row.producerNamespace === null ? null : String(row.producerNamespace),
      producerEntityKey: row.producerEntityKey === null ? null : String(row.producerEntityKey),
      referenceId: row.referenceId === null || row.referenceId === undefined ? null : idToString(blob(row.referenceId)),
      referenceDisplayName: row.referenceDisplayName === null || row.referenceDisplayName === undefined ? null : String(row.referenceDisplayName),
      referenceLegalName: row.referenceLegalName === null || row.referenceLegalName === undefined ? null : String(row.referenceLegalName),
      origin: String(row.origin),
      routeId: String(row.routeId),
      assertionId: idToString(blob(row.assertionId)),
      taxonomyId: String(row.taxonomyId ?? TRANSACTION_TAXONOMY_ID),
      taxonomyVersion: String(row.taxonomyVersion ?? TRANSACTION_TAXONOMY_VERSION),
      taxonomyDimension: row.taxonomyDimension === null || row.taxonomyDimension === undefined ? null : String(row.taxonomyDimension),
      taxonomyCode: row.taxonomyCode === null || row.taxonomyCode === undefined ? String(row.role) : String(row.taxonomyCode),
      producerId: String(row.producerId ?? ""),
      producerVersion: String(row.producerVersion ?? ""),
      provenance: parseProvenance(row.provenanceJson),
    })),
    tags: readCanonicalTransactionTags(db, transactionId, cutoff, true),
  };
}

function historicalTransaction(
  db: DatabaseSync,
  transactionId: Uint8Array,
  cutoff: number,
  transaction: CanonicalProjectionTransaction,
  enrichmentRows: readonly CanonicalProjectionTransactionEnrichment[],
  categorizationRows: readonly CanonicalProjectionTransactionCategorization[],
): CanonicalEnrichmentTransaction {
  const transactionKey = idToString(transactionId).replaceAll("-", "").toLowerCase();
  const selectedRows = enrichmentRows.filter(
    (row) => row.transactionId.replaceAll("-", "").toLowerCase() === transactionKey,
  );
  const byField = new Map<string, CanonicalProjectionTransactionEnrichment>();
  for (const row of selectedRows) if (!byField.has(row.fieldName)) byField.set(row.fieldName, row);
  const selectedRoleAssertion = byField.get("counterparty_role")?.assertionId;
  const counterparties = selectedRoleAssertion
    ? selectedCounterpartyRows(db, transactionId, selectedRoleAssertion, cutoff)
    : [];
  return {
    transactionId: idToString(transactionId),
    kind: resultFromRuntimeRow(
      byField.get("kind"),
      outputProvenance(db, byField.get("kind")?.assertionId, cutoff),
    ),
    category: categoryFromRuntimeRows(
      transaction,
      byField.get("kind"),
      byField.get("category"),
      categorizationRows,
      db,
      cutoff,
    ),
    display: selectedCounterpartyDisplay(
      db,
      transactionId,
      cutoff,
      counterparties,
      byField.get("counterparty_display"),
    ),
    counterparties: counterparties.map((row) => ({
      participationKey: String(row.participationKey ?? ""), role: String(row.role), observedName: row.observedName === null ? null : String(row.observedName), observedReference: row.observedReference === null ? null : String(row.observedReference), sourceClassificationScheme: row.sourceClassificationScheme === null || row.sourceClassificationScheme === undefined ? null : String(row.sourceClassificationScheme), sourceClassificationCode: row.sourceClassificationCode === null || row.sourceClassificationCode === undefined ? null : String(row.sourceClassificationCode), producerNamespace: row.producerNamespace === null ? null : String(row.producerNamespace), producerEntityKey: row.producerEntityKey === null ? null : String(row.producerEntityKey), referenceId: row.referenceId === null || row.referenceId === undefined ? null : idToString(blob(row.referenceId)), referenceDisplayName: row.referenceDisplayName === null || row.referenceDisplayName === undefined ? null : String(row.referenceDisplayName), referenceLegalName: row.referenceLegalName === null || row.referenceLegalName === undefined ? null : String(row.referenceLegalName), origin: String(row.origin), routeId: String(row.routeId), assertionId: idToString(blob(row.assertionId)), taxonomyId: String(row.taxonomyId ?? TRANSACTION_TAXONOMY_ID), taxonomyVersion: String(row.taxonomyVersion ?? TRANSACTION_TAXONOMY_VERSION), taxonomyDimension: row.taxonomyDimension === null || row.taxonomyDimension === undefined ? null : String(row.taxonomyDimension), taxonomyCode: row.taxonomyCode === null || row.taxonomyCode === undefined ? String(row.role) : String(row.taxonomyCode), producerId: String(row.producerId ?? ""), producerVersion: String(row.producerVersion ?? ""), provenance: parseProvenance(row.provenanceJson),
    })),
    tags: readCanonicalTransactionTags(db, transactionId, cutoff),
  };
}

function lineageRows(
  db: DatabaseSync,
  request: CanonicalEnrichmentQueryRequest,
  knowledgeAt: number,
): Readonly<Record<string, unknown>>[] {
  const rows = transactionRows(db, request, "lineage", knowledgeAt);
  const result: Readonly<Record<string, unknown>>[] = [];
  for (const transaction of rows) {
    const assertions = db.prepare(`
      SELECT assertion.assertion_id, assertion.field_name, assertion.value_text,
             assertion.origin, assertion.producer_id, assertion.rule_lineage,
             assertion.created_commit_id, output.output_state,
             output.route_id, output.provenance_json,
             typed.taxonomy_id, typed.taxonomy_version, typed.taxonomy_dimension,
             typed.taxonomy_code, output.commit_id AS output_commit_id,
             run.producer_version, run.observed_at,
             output.source_record_id, output.source_field, output.source_value_text
        FROM assertions assertion
        LEFT JOIN enrichment_run_outputs output
          ON output.assertion_id = assertion.assertion_id
         AND output.rowid = (
           SELECT latest_output.rowid
             FROM enrichment_run_outputs latest_output
             JOIN canonical_commits latest_output_commit
               ON latest_output_commit.commit_id = latest_output.commit_id
            WHERE latest_output.assertion_id = assertion.assertion_id
              AND latest_output_commit.commit_sequence <= ?
            ORDER BY latest_output_commit.commit_sequence DESC, latest_output.rowid DESC
            LIMIT 1
         )
        LEFT JOIN enrichment_runs run ON run.run_id = output.run_id
        LEFT JOIN enrichment_taxonomy_assertion_values typed
          ON typed.assertion_id = assertion.assertion_id
       WHERE assertion.transaction_id = ?
         AND (SELECT commit_sequence FROM canonical_commits WHERE commit_id = assertion.created_commit_id) <= ?
       ORDER BY (SELECT commit_sequence FROM canonical_commits WHERE commit_id = assertion.created_commit_id), assertion.assertion_id
    `).all(knowledgeAt, sqliteValue(transaction.transaction_id), knowledgeAt) as DbRow[];
    for (const row of assertions) {
      const isAllocation =
        row.field_name === "category" && row.value_text === "__allocation__";
      const typedCategorization = row.field_name === "category"
        ? db.prepare(`
            SELECT value.mode, value.category_code, value.taxonomy_id,
                   value.taxonomy_version, value.allocation_set_id
              FROM transaction_categorization_values value
             WHERE value.assertion_id = ? AND value.transaction_id = ?
          `).get(sqliteValue(row.assertion_id), sqliteValue(transaction.transaction_id)) as DbRow | undefined
        : undefined;
      const lineageComponents =
        typedCategorization?.mode === "allocated" &&
        typedCategorization.allocation_set_id instanceof Uint8Array
          ? db.prepare(`
              SELECT component.category_code, component.taxonomy_id,
                     component.taxonomy_version, component.booked_coefficient,
                     component.booked_scale, component.booked_currency,
                     component.conversion_evidence_kind,
                     component.conversion_evidence_id,
                     component.conversion_from_currency,
                     component.conversion_to_currency,
                     component.conversion_evidence_json
                FROM category_allocation_components component
                JOIN category_allocation_sets allocation_set
                  ON allocation_set.allocation_set_id = component.allocation_set_id
                 AND allocation_set.assertion_id = ?
                 AND allocation_set.transaction_id = ?
               WHERE component.allocation_set_id = ?
               ORDER BY component.component_ordinal
            `).all(
              sqliteValue(row.assertion_id),
              sqliteValue(transaction.transaction_id),
              typedCategorization.allocation_set_id,
            ) as DbRow[]
          : [];
      const lineageCategoryMode = row.field_name === "category"
        ? typedCategorization?.mode === "allocated" || isAllocation
          ? "allocated"
          : row.output_state === "supported" &&
              (typedCategorization?.mode === "single" ||
                row.taxonomy_code !== null ||
                row.value_text !== null)
            ? "single"
            : "absent"
        : undefined;
      const lineageTaxonomyId =
        typedCategorization?.taxonomy_id ?? row.taxonomy_id;
      const lineageTaxonomyVersion =
        typedCategorization?.taxonomy_version ?? row.taxonomy_version;
      const lineageCategoryCode =
        typedCategorization?.category_code ?? row.taxonomy_code;
      const events = db.prepare(`
        SELECT event.event_kind AS eventKind, hex(event.commit_id) AS commitId,
               event_commit.commit_sequence AS commitSequence
          FROM assertion_transitions event
          JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
         WHERE event.assertion_id = ? AND event_commit.commit_sequence <= ?
         ORDER BY event_commit.commit_sequence, event.rowid
      `).all(sqliteValue(row.assertion_id), knowledgeAt) as DbRow[];
      result.push({
        transactionId: idToString(blob(transaction.transaction_id)),
        assertionId: idToString(blob(row.assertion_id)),
        field: String(row.field_name),
        value:
          isAllocation || row.value_text === null || row.value_text === undefined
            ? null
            : String(row.value_text),
        ...(lineageCategoryMode ? { mode: lineageCategoryMode } : {}),
        ...(row.field_name === "category"
          ? {
              components: lineageComponents.map((component) => ({
                categoryCode: String(component.category_code),
                taxonomyId: String(component.taxonomy_id),
                taxonomyVersion: String(component.taxonomy_version),
                coefficient: String(component.booked_coefficient),
                scale: Number(component.booked_scale),
                currency: String(component.booked_currency),
                origin: "user",
                assertionId: idToString(blob(row.assertion_id)),
                provenance: parseProvenance(row.provenance_json),
                ...(component.conversion_evidence_kind &&
                component.conversion_evidence_id &&
                component.conversion_from_currency &&
                component.conversion_to_currency &&
                component.conversion_evidence_json
                  ? {
                      conversionEvidence: {
                        kind: String(component.conversion_evidence_kind),
                        id: String(component.conversion_evidence_id),
                        fromCurrency: String(component.conversion_from_currency),
                        toCurrency: String(component.conversion_to_currency),
                        json: String(component.conversion_evidence_json),
                      },
                    }
                  : {}),
              })),
            }
          : {}),
        origin: String(row.origin),
        producerId: String(row.producer_id),
        producerVersion: String(row.producer_version ?? ""),
        ruleLineage: String(row.rule_lineage),
        routeId: String(row.route_id ?? ""),
        outputState: String(row.output_state ?? "supported"),
        taxonomyId: lineageTaxonomyId === null || lineageTaxonomyId === undefined ? null : String(lineageTaxonomyId),
        taxonomyVersion: lineageTaxonomyVersion === null || lineageTaxonomyVersion === undefined ? null : String(lineageTaxonomyVersion),
        taxonomyDimension: row.taxonomy_dimension === null || row.taxonomy_dimension === undefined ? null : String(row.taxonomy_dimension),
        taxonomyCode: lineageCategoryCode === null || lineageCategoryCode === undefined ? null : String(lineageCategoryCode),
        outputCommitId: row.output_commit_id === null || row.output_commit_id === undefined ? null : idToString(blob(row.output_commit_id)),
        sourceRecordId: row.source_record_id === null || row.source_record_id === undefined ? null : idToString(blob(row.source_record_id)),
        sourceField: row.source_field === null || row.source_field === undefined ? null : String(row.source_field),
        sourceValue: row.source_value_text === null || row.source_value_text === undefined ? null : String(row.source_value_text),
        provenance: parseProvenance(row.provenance_json),
        events,
      });
    }
    const outputs = db.prepare(`
      SELECT output.field_name, output.output_state, output.route_id,
             output.provenance_json, output.commit_id,
             run.producer_id, run.producer_version,
             output.source_record_id, output.source_field, output.source_value_text
        FROM enrichment_run_outputs output
        JOIN canonical_commits output_commit ON output_commit.commit_id = output.commit_id
        JOIN enrichment_runs run ON run.run_id = output.run_id
       WHERE output.transaction_id = ? AND output.output_state = 'unsupported'
         AND output_commit.commit_sequence <= ?
       ORDER BY output_commit.commit_sequence, output.rowid
    `).all(sqliteValue(transaction.transaction_id), knowledgeAt) as DbRow[];
    for (const output of outputs.filter((row) => row.output_state === "unsupported"))
      result.push({
        transactionId: idToString(blob(transaction.transaction_id)),
        field: String(output.field_name),
        outputState: "unsupported",
        routeId: String(output.route_id),
        producerId: String(output.producer_id),
        producerVersion: String(output.producer_version),
        taxonomyId: null,
        taxonomyVersion: null,
        taxonomyDimension: null,
        taxonomyCode: null,
        sourceRecordId: output.source_record_id === null || output.source_record_id === undefined ? null : idToString(blob(output.source_record_id)),
        sourceField: output.source_field === null || output.source_field === undefined ? null : String(output.source_field),
        sourceValue: output.source_value_text === null || output.source_value_text === undefined ? null : String(output.source_value_text),
        provenance: parseProvenance(output.provenance_json),
        commitId: idToString(blob(output.commit_id)),
      });
  }
  return result;
}

function queryCurrent(db: DatabaseSync, request: CanonicalEnrichmentQueryRequest): CanonicalEnrichmentQueryResult {
  const rows = transactionRows(db, request, "current");
  const knowledgePoint = latestKnowledgePoint(db);
  return { kind: "current", knowledgePoint, financialAt: request.financialAt ?? null, transactions: rows.map((row) => currentTransaction(db, blob(row.transaction_id))) };
}

function readHistoricalProjection(
  db: DatabaseSync,
  request: CanonicalEnrichmentQueryRequest,
  knowledgeAt: number,
) {
  const scope = {
    ...(request.sourceConnectionKey ? { sourceConnectionKey: request.sourceConnectionKey } : {}),
    ...(request.transactionIds ? { transactionIds: request.transactionIds } : {}),
  };
  return createCanonicalProjectionRuntime(db).read({
    kind: "historical",
    families: [
      "transactions",
      "transaction-enrichment",
      "transaction-categorization",
    ],
    scope,
    cutoff: { financialAt: request.financialAt!, knowledgeAt },
  });
}

function queryHistorical(db: DatabaseSync, request: CanonicalEnrichmentQueryRequest): CanonicalEnrichmentQueryResult {
  requireBoundedScope(request);
  if (!request.financialAt || !/^\d{4}-\d{2}-\d{2}$/u.test(request.financialAt))
    throw new Error("Historical enrichment queries require a financial date cutoff.");
  if (request.knowledgeAt === undefined)
    throw new Error("Historical enrichment queries require a knowledge cutoff.");
  const latest = latestKnowledgePoint(db);
  const knowledgeAt = request.knowledgeAt;
  if (!Number.isSafeInteger(knowledgeAt) || knowledgeAt < 0 || knowledgeAt > latest)
    throw new Error("Historical enrichment knowledge cutoff is invalid.");
  const rows = transactionRows(db, request, "historical", knowledgeAt);
  const projection = readHistoricalProjection(db, request, knowledgeAt);
  const transactionRowsById = new Map(
    projection.families.transactions.map((row) => [
      row.transactionId.replaceAll("-", "").toLowerCase(),
      row,
    ]),
  );
  const enrichmentRows = projection.families["transaction-enrichment"];
  const categorizationRows = projection.families["transaction-categorization"];
  return {
    kind: "historical",
    knowledgePoint: knowledgeAt,
    financialAt: request.financialAt,
    transactions: rows.map((row) => historicalTransaction(
      db,
      blob(row.transaction_id),
      knowledgeAt,
      transactionRowsById.get(
        idToString(blob(row.transaction_id)).replaceAll("-", "").toLowerCase(),
      )!,
      enrichmentRows,
      categorizationRows,
    )),
  };
}

export function createCanonicalEnrichmentQuery(ledgerDir: string) {
  const run = <T>(operation: (db: DatabaseSync) => T): T => {
    const db = openCanonicalDatabase(ledgerDir, { readOnly: true });
    try { return withCanonicalSnapshot(db, () => operation(db)); } finally { db.close(); }
  };
  return Object.freeze({
    current(request: CanonicalEnrichmentQueryRequest = {}): CanonicalEnrichmentQueryResult { return run((db) => queryCurrent(db, request)); },
    historical(request: CanonicalEnrichmentQueryRequest): CanonicalEnrichmentQueryResult { return run((db) => queryHistorical(db, request)); },
    lineage(request: CanonicalEnrichmentQueryRequest = {}): CanonicalEnrichmentQueryResult {
      return run((db) => {
        requireBoundedScope(request);
        const latest = latestKnowledgePoint(db);
        const knowledgeAt = request.knowledgeAt ?? latest;
        if (!Number.isSafeInteger(knowledgeAt) || knowledgeAt < 0 || knowledgeAt > latest)
          throw new Error("Lineage enrichment knowledge cutoff is invalid.");
        const boundedRequest = request.knowledgeAt === undefined && request.financialAt === undefined
          ? request
          : { ...request, financialAt: request.financialAt ?? "9999-12-31" };
        const rows = transactionRows(db, boundedRequest, "lineage", knowledgeAt);
        const historicalProjection = request.knowledgeAt === undefined && request.financialAt === undefined
          ? null
          : readHistoricalProjection(db, boundedRequest, knowledgeAt);
        const enrichmentRows = historicalProjection?.families["transaction-enrichment"] ?? [];
        const categorizationRows = historicalProjection?.families["transaction-categorization"] ?? [];
        const transactionRowsById = new Map(
          historicalProjection?.families.transactions.map((row) => [
            row.transactionId.replaceAll("-", "").toLowerCase(),
            row,
          ]) ?? [],
        );
        return {
          kind: "lineage",
          knowledgePoint: knowledgeAt,
          financialAt: request.financialAt ?? null,
          transactions: rows.map((row) => request.knowledgeAt === undefined && request.financialAt === undefined
            ? currentTransaction(db, blob(row.transaction_id))
            : historicalTransaction(
              db,
              blob(row.transaction_id),
              knowledgeAt,
              transactionRowsById.get(
                idToString(blob(row.transaction_id)).replaceAll("-", "").toLowerCase(),
              )!,
              enrichmentRows,
              categorizationRows,
            )),
          lineage: lineageRows(db, boundedRequest, knowledgeAt),
        };
      });
    },
  });
}

export const queryCanonicalEnrichmentCurrent = (ledgerDir: string, request: CanonicalEnrichmentQueryRequest = {}) => createCanonicalEnrichmentQuery(ledgerDir).current(request);
export const queryCanonicalEnrichmentHistorical = (ledgerDir: string, request: CanonicalEnrichmentQueryRequest) => createCanonicalEnrichmentQuery(ledgerDir).historical(request);
export const queryCanonicalEnrichmentLineage = (ledgerDir: string, request: CanonicalEnrichmentQueryRequest = {}) => createCanonicalEnrichmentQuery(ledgerDir).lineage(request);
