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
} from "./canonical-projection-runtime.ts";

export type CanonicalEnrichmentOrigin = Exclude<TaxonomyOrigin, "user">;
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
  const kind = output.evidence?.kind;
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
  if (output.value === null || output.value === undefined || output.value.trim() === "")
    throw new Error(`Supported enrichment ${output.field} output requires a value.`);
  return output.value.trim();
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

  let value = outputValue(output);
  let confidence = confidenceBasisPoints(output);
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

function validateSourceEvidence(
  db: DatabaseSync,
  transactionId: CanonicalId,
  output: CanonicalEnrichmentOutput,
  sourceRecordId: CanonicalId | null,
  value: string,
): string {
  const sourceField = outputSourceField(output);
  if (!sourceFieldAllowed(canonicalField(output.field), sourceField))
    throw new Error("Source enrichment must retain a contract-defined explicit source field; free text, merchant, MCC, and combined evidence are Derived.");
  if (!sourceRecordId)
    throw new Error("Source enrichment requires the retained source record provenance.");
  const linked = db.prepare(`
    SELECT 1 FROM transaction_revisions revision
    WHERE revision.transaction_id = ? AND revision.source_record_id = ?
  `).get(transactionId, sourceRecordId);
  if (!linked) throw new Error("Source enrichment source record is outside the transaction lineage.");

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
    const declaredFields = [...(rawInput.declaredFields ?? rawInput.fields ?? [])].map(canonicalField);
    const outputs = rawInput.outputs.map((output) => ({ ...output, field: canonicalField(output.field) }));
    const duplicateKeys = new Set<string>();
    for (const output of outputs) {
      const key = `${output.transactionId}:${output.field}`;
      if (duplicateKeys.has(key)) throw new Error(`Automatic enrichment emits more than one output for ${key}.`);
      duplicateKeys.add(key);
    }
    const allFields = new Set<EnrichmentField>([...declaredFields, ...outputs.map((output) => output.field)]);
    if (allFields.size === 0) throw new Error("At least one automatic enrichment subject/field must be declared.");
    const subjects = new Map<string, { id: CanonicalId; account: DbRow }>();
    for (const output of outputs) {
      const id = canonicalId(output.transactionId, "Transaction ID");
      if (!subjects.has(output.transactionId)) subjects.set(output.transactionId, { id, account: accountForTransaction(db, id) });
    }
    if (subjects.size === 0) throw new Error("At least one automatic enrichment subject is required.");
    const firstAccount = [...subjects.values()][0]!.account;
    const integrationNamespace = String(firstAccount.integration_namespace);
    const stream = rawInput.stream?.trim() || String(firstAccount.stream);
    if (rawInput.sourceConnectionKey && rawInput.sourceConnectionKey !== firstAccount.source_connection_key)
      throw new Error("Automatic enrichment source connection scope does not match the transaction.");
    for (const subject of subjects.values()) {
      if (subject.account.integration_namespace !== integrationNamespace || subject.account.stream !== stream)
        throw new Error("Automatic enrichment crossed a source integration or stream boundary.");
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
    for (const field of declaredFields)
      if (!routeByField.has(field)) throw new Error(`No automatic enrichment authority route is declared for ${field}.`);
    db.prepare(
      "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, 'derived_import')",
    ).run(commitId, commitSequence, currentUtcMicros(), `automatic/${producerId}/${producerVersion}`);
    const runId = uuidV7();
    const origins = new Set<CanonicalEnrichmentOrigin>();
    for (const output of outputs) origins.add(output.origin ?? "derived");
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
    for (const output of outputs) {
      const subject = subjects.get(output.transactionId)!;
      const route = routeByField.get(output.field)!;
      const origin = output.origin ?? "derived";
      if (origin === "source" && route.origin_policy === "derived") throw new Error(`Route ${route.route_id} does not allow Source output.`);
      if (origin === "derived" && route.origin_policy === "source") throw new Error(`Route ${route.route_id} does not allow Derived output.`);
      const evidenceKind = outputEvidenceKind(output);
      const sourceRecordId = outputSourceRecordId(output);
      const producer = db.prepare("SELECT confidence_threshold_basis_points FROM enrichment_producer_versions WHERE producer_id = ? AND producer_version = ?").get(producerId, producerVersion) as { confidence_threshold_basis_points?: unknown } | undefined;
      if (!producer) throw new Error(`Producer version ${producerId}@${producerVersion} is not declared.`);
      const threshold = Number(producer.confidence_threshold_basis_points ?? 0);
      const effective = effectiveOutput(output, threshold);
      const value = effective.value;
      let retainedSourceValue: string | null = null;
      if (effective.state === "supported" && value !== null && origin === "source")
        retainedSourceValue = validateSourceEvidence(db, subject.id, output, sourceRecordId, value);
      if (effective.state === "supported" && value !== null) validateOutputCompatibility(db, output, origin, value, evidenceKind, producerId, producerVersion);
      if (effective.state === "supported" && output.field === "category") {
        const kindOutput = outputs.find((candidate) => candidate.transactionId === output.transactionId && candidate.field === "kind");
        const kindValue = kindOutput && kindOutput.state !== "unsupported" && kindOutput.value ? kindOutput.value : currentKindCode(db, subject.id);
        if (!kindValue) throw new Error("A category cannot be captured without a transaction Kind.");
        if (!isCategoryApplicable(value!, kindValue)) throw new Error(`Category ${value} is incompatible with Kind ${kindValue}.`);
      }
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
      const sameRouteAndValue = prior && priorActive && String(prior.value_text) === value && String(prior.route_id ?? "") === route.route_id;
      if (sameRouteAndValue) {
        assertionId = blob(prior.assertion_id);
      } else {
        assertionId = uuidV7();
        if (prior && priorActive && String(prior.route_id ?? "") === route.route_id)
          insertTransition.run(uuidV7(), blob(prior.assertion_id), subject.id, output.field, runId, commitId, "superseded");
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
      if (output.field === "counterparty_role" && output.counterparty) {
        const identity = output.counterparty;
        const referenceId = uuidV7();
        db.prepare(`INSERT INTO counterparty_references(reference_id, producer_namespace, producer_entity_key, display_name, legal_name, created_commit_id)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(producer_namespace, producer_entity_key) DO UPDATE SET display_name = COALESCE(excluded.display_name, display_name), legal_name = COALESCE(excluded.legal_name, legal_name)`)
          .run(referenceId, requireText(identity.producerNamespace, "Counterparty producer namespace"), requireText(identity.producerEntityKey, "Counterparty entity key"), identity.displayName ?? null, identity.legalName ?? null, commitId);
        const persistedReference = db.prepare("SELECT reference_id FROM counterparty_references WHERE producer_namespace = ? AND producer_entity_key = ?").get(identity.producerNamespace, identity.producerEntityKey) as { reference_id?: unknown };
        db.prepare(`INSERT INTO counterparty_participations(participation_id, transaction_id, assertion_id, reference_id, role_code, origin, observed_name, observed_reference, route_id, provenance_json, commit_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(uuidV7(), subject.id, assertionId, sqliteValue(persistedReference.reference_id), value, origin, identity.displayName ?? null, identity.producerEntityKey, route.route_id, JSON.stringify(provenance), commitId);
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
  origin: CanonicalEnrichmentOrigin;
  route: Readonly<{ id: string; producerId: string; producerVersion: string }>;
  assertionId: string;
  provenance: Readonly<Record<string, unknown>>;
}> | Readonly<{ status: "absent" }>;

export type CanonicalEnrichmentTransaction = Readonly<{
  transactionId: string;
  kind: CanonicalEnrichmentFieldResult;
  category: CanonicalEnrichmentFieldResult;
  counterparties: readonly Readonly<Record<string, unknown>>[];
  display: CanonicalEnrichmentFieldResult;
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

function outputProvenance(db: DatabaseSync, assertionId: unknown): Readonly<Record<string, unknown>> {
  const parameter =
    typeof assertionId === "string"
      ? canonicalStoredId(assertionId, "Assertion ID")
      : sqliteValue(assertionId);
  const row = db.prepare(`SELECT provenance_json FROM enrichment_run_outputs WHERE assertion_id = ? ORDER BY rowid DESC LIMIT 1`).get(parameter) as { provenance_json?: unknown } | undefined;
  return parseProvenance(row?.provenance_json);
}

function requireBoundedScope(request: CanonicalEnrichmentQueryRequest): void {
  if (
    !request.sourceConnectionKey &&
    (!request.transactionIds || request.transactionIds.length === 0)
  )
    throw new Error("Canonical enrichment queries require a source connection or explicit transaction IDs.");
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

/**
 * Select the financial transaction membership at a knowledge/financial dual
 * cutoff. This mirrors the canonical Runtime's historical transaction
 * selector and intentionally never depends on the current projection table.
 */
function historicalTransactionRows(
  db: DatabaseSync,
  request: CanonicalEnrichmentQueryRequest,
  knowledgeAt: number,
): DbRow[] {
  const financialAt = request.financialAt ?? "9999-12-31";
  const scope = queryParametersForScope(request, "transaction_row", "account");
  return db.prepare(`
    SELECT transaction_row.transaction_id, revision.effective_on,
           connection.integration_namespace, connection.source_connection_key,
           account.stream
      FROM financial_transactions transaction_row
      JOIN financial_accounts account ON account.account_id = transaction_row.account_id
      JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
      JOIN transaction_revisions revision
        ON revision.transaction_id = transaction_row.transaction_id
      JOIN canonical_commits revision_commit
        ON revision_commit.commit_id = revision.commit_id
     WHERE revision_commit.commit_sequence <= ?
       AND revision.effective_on <= ?
       AND ${scope.clauses.join(" AND ")}
       AND EXISTS (
         SELECT 1
           FROM assertions source_assertion
          WHERE source_assertion.revision_id = revision.revision_id
            AND source_assertion.origin = 'source'
            AND COALESCE((
              SELECT source_event.event_kind
                FROM assertion_transitions source_event
                JOIN canonical_commits source_event_commit
                  ON source_event_commit.commit_id = source_event.commit_id
               WHERE source_event.assertion_id = source_assertion.assertion_id
                 AND source_event_commit.commit_sequence <= ?
               ORDER BY source_event_commit.commit_sequence DESC, source_event.rowid DESC
               LIMIT 1
            ), 'observed') NOT IN ('withdrawn', 'superseded')
       )
       AND NOT EXISTS (
         SELECT 1
           FROM transaction_revisions newer
           JOIN canonical_commits newer_commit
             ON newer_commit.commit_id = newer.commit_id
          WHERE newer.transaction_id = revision.transaction_id
            AND newer_commit.commit_sequence <= ?
            AND newer_commit.commit_sequence > revision_commit.commit_sequence
       )
     ORDER BY transaction_row.source_sequence, transaction_row.transaction_id
  `).all(
    knowledgeAt,
    financialAt,
    ...scope.parameters,
    knowledgeAt,
    knowledgeAt,
  ) as DbRow[];
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
  return historicalTransactionRows(db, request, knowledgeAt);
}

function currentTransaction(
  db: DatabaseSync,
  transactionId: Uint8Array,
): CanonicalEnrichmentTransaction {
  const enrichmentRows = currentEnrichmentRows(db, blob(transactionId));
  const byField = new Map(
    enrichmentRows.map((row) => [row.fieldName, row]),
  );
  const roleAssertion = byField.get("counterparty_role");
  const counterparts = roleAssertion ? db.prepare(`
    SELECT participation.role_code AS role, participation.observed_name AS observedName,
           participation.observed_reference AS observedReference,
           reference.producer_namespace AS producerNamespace,
           reference.producer_entity_key AS producerEntityKey,
           participation.origin, participation.route_id AS routeId,
           participation.assertion_id AS assertionId,
           participation.provenance_json AS provenanceJson,
           typed.taxonomy_id AS taxonomyId,
           typed.taxonomy_version AS taxonomyVersion,
           typed.taxonomy_dimension AS taxonomyDimension,
           typed.taxonomy_code AS taxonomyCode,
           run.producer_id AS producerId,
           run.producer_version AS producerVersion
      FROM counterparty_participations participation
      LEFT JOIN counterparty_references reference ON reference.reference_id = participation.reference_id
      LEFT JOIN enrichment_taxonomy_assertion_values typed
        ON typed.assertion_id = participation.assertion_id
      JOIN enrichment_run_outputs output
        ON output.assertion_id = participation.assertion_id
       AND output.output_state = 'supported'
       AND output.rowid = (
         SELECT newer_output.rowid
           FROM enrichment_run_outputs newer_output
          WHERE newer_output.assertion_id = participation.assertion_id
            AND newer_output.output_state = 'supported'
          ORDER BY newer_output.rowid DESC
          LIMIT 1
       )
      LEFT JOIN enrichment_runs run ON run.run_id = output.run_id
     WHERE participation.transaction_id = ?
       AND participation.assertion_id = ?
       AND NOT EXISTS (
         SELECT 1
           FROM counterparty_participations newer_participation
           JOIN canonical_commits newer_commit
             ON newer_commit.commit_id = newer_participation.commit_id
           JOIN canonical_commits current_commit
             ON current_commit.commit_id = participation.commit_id
          WHERE newer_participation.transaction_id = participation.transaction_id
            AND newer_participation.assertion_id = participation.assertion_id
            AND (newer_commit.commit_sequence > current_commit.commit_sequence
              OR (newer_commit.commit_sequence = current_commit.commit_sequence
                  AND newer_participation.rowid > participation.rowid))
       )
     ORDER BY participation.commit_id DESC, participation.rowid DESC
  `).all(transactionId, canonicalStoredId(roleAssertion.assertionId, "Role assertion ID")) as DbRow[] : [];
  return {
    transactionId: idToString(transactionId),
    kind: resultFromRuntimeRow(
      byField.get("kind"),
      outputProvenance(db, byField.get("kind")?.assertionId),
    ),
    category: resultFromRuntimeRow(
      byField.get("category"),
      outputProvenance(db, byField.get("category")?.assertionId),
    ),
    display: resultFromRuntimeRow(
      byField.get("counterparty_display"),
      outputProvenance(db, byField.get("counterparty_display")?.assertionId),
    ),
    counterparties: counterparts.map((row) => ({
      role: String(row.role),
      observedName: row.observedName === null ? null : String(row.observedName),
      observedReference: row.observedReference === null ? null : String(row.observedReference),
      producerNamespace: row.producerNamespace === null ? null : String(row.producerNamespace),
      producerEntityKey: row.producerEntityKey === null ? null : String(row.producerEntityKey),
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
  };
}

function historicalRows(
  db: DatabaseSync,
  transactionId: Uint8Array,
  cutoff: number,
): DbRow[] {
  return db.prepare(`
    SELECT assertion.assertion_id, assertion.transaction_id, assertion.field_name,
           assertion.value_text, assertion.origin, assertion.producer_id,
           run.producer_version, output.route_id, output.provenance_json,
           typed.taxonomy_id, typed.taxonomy_version, typed.taxonomy_dimension,
           typed.taxonomy_code
      FROM assertions assertion
      JOIN enrichment_run_outputs output
        ON output.assertion_id = assertion.assertion_id
       AND output.output_state = 'supported'
      JOIN canonical_commits output_commit ON output_commit.commit_id = output.commit_id
      JOIN enrichment_runs run ON run.run_id = output.run_id
      JOIN automatic_enrichment_authority_routes route ON route.route_id = output.route_id
      LEFT JOIN enrichment_taxonomy_assertion_values typed ON typed.assertion_id = assertion.assertion_id
      JOIN financial_transactions transaction_row ON transaction_row.transaction_id = assertion.transaction_id
      JOIN financial_accounts account ON account.account_id = transaction_row.account_id
      JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
     WHERE assertion.transaction_id = ?
       AND (SELECT commit_sequence FROM canonical_commits WHERE commit_id = assertion.created_commit_id) <= ?
       AND output_commit.commit_sequence <= ?
       AND route.valid_from_commit_sequence <= ?
       AND (route.valid_to_commit_sequence IS NULL OR ? < route.valid_to_commit_sequence)
       AND (route.scope_kind = 'global' OR (route.scope_kind = 'source_stream' AND route.scope_key = connection.integration_namespace || '/' || account.stream))
       AND COALESCE((SELECT event_kind FROM assertion_transitions event JOIN canonical_commits c ON c.commit_id = event.commit_id WHERE event.assertion_id = assertion.assertion_id AND c.commit_sequence <= ? ORDER BY c.commit_sequence DESC, event.event_id DESC LIMIT 1), 'observed') NOT IN ('withdrawn','superseded')
     ORDER BY output_commit.commit_sequence DESC, assertion.assertion_id DESC
  `).all(transactionId, cutoff, cutoff, cutoff, cutoff, cutoff) as DbRow[];
}

function historicalTransaction(db: DatabaseSync, transactionId: Uint8Array, cutoff: number): CanonicalEnrichmentTransaction {
  const rows = historicalRows(db, transactionId, cutoff);
  const byField = new Map<string, DbRow>();
  for (const row of rows) if (!byField.has(String(row.field_name))) byField.set(String(row.field_name), row);
  const selectedRoleAssertion = byField.get("counterparty_role")?.assertion_id;
  const counterparties = selectedRoleAssertion
    ? db.prepare(`
        WITH candidates AS (
          SELECT participation.role_code AS role, participation.observed_name AS observedName,
                 participation.observed_reference AS observedReference,
                 reference.producer_namespace AS producerNamespace,
                 reference.producer_entity_key AS producerEntityKey,
                 participation.origin, participation.route_id AS routeId,
                 participation.assertion_id AS assertionId,
                 participation.provenance_json AS provenanceJson,
                 typed.taxonomy_id AS taxonomyId,
                 typed.taxonomy_version AS taxonomyVersion,
                 typed.taxonomy_dimension AS taxonomyDimension,
                 typed.taxonomy_code AS taxonomyCode,
                 run.producer_id AS producerId,
                 run.producer_version AS producerVersion,
                 participation.rowid AS participationRowId,
                 ROW_NUMBER() OVER (PARTITION BY participation.assertion_id
                                    ORDER BY commit_row.commit_sequence DESC, participation.rowid DESC) AS rank
            FROM counterparty_participations participation
            JOIN assertions role_assertion
              ON role_assertion.assertion_id = participation.assertion_id
             AND role_assertion.field_name = 'counterparty_role'
            JOIN enrichment_run_outputs output
              ON output.assertion_id = role_assertion.assertion_id
             AND output.output_state = 'supported'
            JOIN enrichment_runs run ON run.run_id = output.run_id
            JOIN canonical_commits output_commit ON output_commit.commit_id = output.commit_id
            JOIN automatic_enrichment_authority_routes route ON route.route_id = output.route_id
            JOIN canonical_commits commit_row ON commit_row.commit_id = participation.commit_id
            LEFT JOIN enrichment_taxonomy_assertion_values typed
              ON typed.assertion_id = role_assertion.assertion_id
            LEFT JOIN counterparty_references reference
              ON reference.reference_id = participation.reference_id
           WHERE participation.transaction_id = ?
             AND participation.assertion_id = ?
             AND output_commit.commit_sequence <= ?
             AND commit_row.commit_sequence <= ?
             AND route.valid_from_commit_sequence <= ?
             AND (route.valid_to_commit_sequence IS NULL OR ? < route.valid_to_commit_sequence)
             AND COALESCE((SELECT event_kind FROM assertion_transitions event
                            JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
                           WHERE event.assertion_id = role_assertion.assertion_id
                             AND event_commit.commit_sequence <= ?
                           ORDER BY event_commit.commit_sequence DESC, event.rowid DESC LIMIT 1), 'observed')
                 NOT IN ('withdrawn','superseded')
        )
        SELECT role, observedName, observedReference, producerNamespace,
               producerEntityKey, origin, routeId, assertionId, provenanceJson,
               taxonomyId, taxonomyVersion, taxonomyDimension, taxonomyCode,
               producerId, producerVersion
          FROM candidates WHERE rank = 1
      `).all(transactionId, sqliteValue(selectedRoleAssertion), cutoff, cutoff, cutoff, cutoff, cutoff) as DbRow[]
    : [];
  return {
    transactionId: idToString(transactionId),
    kind: resultFromRow(byField.get("kind")),
    category: resultFromRow(byField.get("category")),
    display: resultFromRow(byField.get("counterparty_display")),
    counterparties: counterparties.map((row) => ({
      role: String(row.role), observedName: row.observedName === null ? null : String(row.observedName), observedReference: row.observedReference === null ? null : String(row.observedReference), producerNamespace: row.producerNamespace === null ? null : String(row.producerNamespace), producerEntityKey: row.producerEntityKey === null ? null : String(row.producerEntityKey), origin: String(row.origin), routeId: String(row.routeId), assertionId: idToString(blob(row.assertionId)), taxonomyId: String(row.taxonomyId ?? TRANSACTION_TAXONOMY_ID), taxonomyVersion: String(row.taxonomyVersion ?? TRANSACTION_TAXONOMY_VERSION), taxonomyDimension: row.taxonomyDimension === null || row.taxonomyDimension === undefined ? null : String(row.taxonomyDimension), taxonomyCode: row.taxonomyCode === null || row.taxonomyCode === undefined ? String(row.role) : String(row.taxonomyCode), producerId: String(row.producerId ?? ""), producerVersion: String(row.producerVersion ?? ""), provenance: parseProvenance(row.provenanceJson),
    })),
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
        value: row.value_text === null || row.value_text === undefined ? null : String(row.value_text),
        origin: String(row.origin),
        producerId: String(row.producer_id),
        producerVersion: String(row.producer_version ?? ""),
        ruleLineage: String(row.rule_lineage),
        routeId: String(row.route_id ?? ""),
        outputState: String(row.output_state ?? "supported"),
        taxonomyId: row.taxonomy_id === null || row.taxonomy_id === undefined ? null : String(row.taxonomy_id),
        taxonomyVersion: row.taxonomy_version === null || row.taxonomy_version === undefined ? null : String(row.taxonomy_version),
        taxonomyDimension: row.taxonomy_dimension === null || row.taxonomy_dimension === undefined ? null : String(row.taxonomy_dimension),
        taxonomyCode: row.taxonomy_code === null || row.taxonomy_code === undefined ? null : String(row.taxonomy_code),
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
  return { kind: "historical", knowledgePoint: knowledgeAt, financialAt: request.financialAt, transactions: rows.map((row) => historicalTransaction(db, blob(row.transaction_id), knowledgeAt)) };
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
        return {
          kind: "lineage",
          knowledgePoint: knowledgeAt,
          financialAt: request.financialAt ?? null,
          transactions: rows.map((row) => request.knowledgeAt === undefined && request.financialAt === undefined
            ? currentTransaction(db, blob(row.transaction_id))
            : historicalTransaction(db, blob(row.transaction_id), knowledgeAt)),
          lineage: lineageRows(db, boundedRequest, knowledgeAt),
        };
      });
    },
  });
}

export const queryCanonicalEnrichmentCurrent = (ledgerDir: string, request: CanonicalEnrichmentQueryRequest = {}) => createCanonicalEnrichmentQuery(ledgerDir).current(request);
export const queryCanonicalEnrichmentHistorical = (ledgerDir: string, request: CanonicalEnrichmentQueryRequest) => createCanonicalEnrichmentQuery(ledgerDir).historical(request);
export const queryCanonicalEnrichmentLineage = (ledgerDir: string, request: CanonicalEnrichmentQueryRequest = {}) => createCanonicalEnrichmentQuery(ledgerDir).lineage(request);
