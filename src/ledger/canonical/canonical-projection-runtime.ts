import type { DatabaseSync } from "node:sqlite";
import { basename, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { CANONICAL_SQLITE_FILE } from "./canonical-schema-implementation.ts";
import {
  openCanonicalDatabase,
} from "./canonical-database.ts";
import {
  canonicalProjectionRuntimeRebuildInternal,
  canonicalProjectionRuntimeSyncInternal,
} from "./canonical-projection-implementation.ts";
import type {
  CanonicalProjectionRebuildOptions,
  CanonicalProjectionRebuildResult,
} from "./canonical-projection-contract.ts";
import { assertValidatedCanonicalDatabase } from "./canonical-schema-lifecycle.ts";

type ProjectionSqlInput =
  | null
  | number
  | bigint
  | string
  | NodeJS.ArrayBufferView;

/**
 * The only commit kinds understood by the projection runtime.  This registry
 * is intentionally closed: adding a new canonical commit kind without adding
 * an impact policy must fail before a caller can publish an inconsistent
 * projection.
 */
export type CanonicalProjectionCommitKind =
  | "source_capture"
  | "derived_import"
  | "user_assertion"
  | "projection_rebuild"
  | "relation_resolution";

const CANONICAL_PROJECTION_COMMIT_IMPACTS: Readonly<
  Record<
    CanonicalProjectionCommitKind,
    "compatibility-and-loan" | "loan-and-investment" | "no-op"
  >
> = Object.freeze({
  source_capture: "compatibility-and-loan",
  derived_import: "compatibility-and-loan",
  user_assertion: "compatibility-and-loan",
  projection_rebuild: "no-op",
  relation_resolution: "loan-and-investment",
});

const CANONICAL_PROJECTION_FAMILIES = Object.freeze([
  "transactions",
  "transaction-fields",
  "loan-accounts",
  "loan-balances",
  "loan-relations",
  "loan-settlement-groups",
  "investment-accounts",
  "investment-holdings",
  "investment-transactions",
  "investment-margin-balances",
  "investment-funding-relations",
] as const);

export type CanonicalProjectionFamily =
  (typeof CANONICAL_PROJECTION_FAMILIES)[number];

export type CanonicalProjectionCommitToken = Readonly<{
  commitId: Uint8Array;
  kind?: CanonicalProjectionCommitKind;
}>;

export type CanonicalProjectionScope = Readonly<{
  /** A source connection is the normal bounded read scope. */
  sourceConnectionKey?: string;
  /** A caller may instead scope by canonical account IDs. */
  accountIds?: readonly string[];
  startDate?: string;
  endDate?: string;
}>;

export type CanonicalProjectionReadRequest = Readonly<{
  kind: "current" | "historical";
  families: readonly CanonicalProjectionFamily[];
  scope: CanonicalProjectionScope;
  cutoff?: Readonly<{
    financialAt: string;
    knowledgeAt: number;
  }>;
}>;

export type CanonicalProjectionTransaction = Readonly<{
  transactionId: string;
  revisionId: string;
  accountId: string;
  accountNumber: string | null;
  amountCoefficient: string;
  amountScale: number;
  currency: string;
  direction: string;
  effectiveOn: string;
  description: string | null;
  projectionCommitId: string | null;
  revisionCommitId: string;
}>;
export type CanonicalProjectionTransactionField = Readonly<{
  transactionId: string;
  fieldName: string;
  value: string;
  origin: string;
  projectionCommitId: string | null;
  projectionCommitSequence: number;
}>;
export type CanonicalProjectionLoanAccount = Readonly<{ accountId: string }>;
export type CanonicalProjectionLoanBalance = Readonly<{
  accountId: string;
  observationId: string;
  revisionId: string;
}>;
export type CanonicalProjectionLoanRelation = Readonly<{
  relationId: string;
  fromTransactionId: string;
  toTransactionId: string;
}>;
export type CanonicalProjectionLoanSettlementGroup = Readonly<{
  settlementGroupId: string;
}>;
export type CanonicalProjectionInvestmentAccount = Readonly<{
  accountId: string;
  sourceId: string;
  accountKey: string;
  accountSubtype: string;
}>;
export type CanonicalProjectionInvestmentHolding = Readonly<{
  accountId: string;
  securityId: string;
  securityKey: string;
  measurementKey: string;
  revisionNumber: number;
  isCurrent: boolean;
  quantityCoefficient: string | null;
  quantityScale: number | null;
  valuationCoefficient: string | null;
  valuationScale: number | null;
  valuationCurrency: string | null;
  costCoefficient: string | null;
  costScale: number | null;
  costCurrency: string | null;
  effectiveOn: string;
  observedAt: string;
  lineageJson: string;
}>;
export type CanonicalProjectionInvestmentTransaction = Readonly<{
  transactionId: string;
  accountId: string;
  securityId: string;
  action: string;
  quantityCoefficient: string;
  quantityScale: number;
  cashCoefficient: string;
  cashScale: number;
  cashCurrency: string;
  effectiveOn: string;
  fundingEvidenceJson: string;
}>;
export type CanonicalProjectionInvestmentMarginBalance = Readonly<{
  accountId: string;
  balanceKind: string;
  coefficient: string;
  scale: number;
  currency: string;
  effectiveOn: string;
}>;
export type CanonicalProjectionInvestmentFundingRelation = Readonly<{
  relationId: string;
  relationKey: string;
  settlementGroupKey: string;
  investmentAccountId: string;
  settlementEffectiveOn: string;
  settlementModel: string;
  coefficient: string;
  scale: number;
  currency: string;
  direction: string;
  sourceLinkageKey: string;
  investmentTransactionCount: number;
}>;
export type CanonicalProjectionFamilyRows = Readonly<{
  transactions: CanonicalProjectionTransaction;
  "transaction-fields": CanonicalProjectionTransactionField;
  "loan-accounts": CanonicalProjectionLoanAccount;
  "loan-balances": CanonicalProjectionLoanBalance;
  "loan-relations": CanonicalProjectionLoanRelation;
  "loan-settlement-groups": CanonicalProjectionLoanSettlementGroup;
  "investment-accounts": CanonicalProjectionInvestmentAccount;
  "investment-holdings": CanonicalProjectionInvestmentHolding;
  "investment-transactions": CanonicalProjectionInvestmentTransaction;
  "investment-margin-balances": CanonicalProjectionInvestmentMarginBalance;
  "investment-funding-relations": CanonicalProjectionInvestmentFundingRelation;
}>;

export type CanonicalProjectionSnapshot = Readonly<{
  kind: CanonicalProjectionReadRequest["kind"];
  generation: number | null;
  knowledgePoint: number;
  financialAt: string | null;
  families: Readonly<{
    [Family in CanonicalProjectionFamily]: readonly CanonicalProjectionFamilyRows[Family][];
  }>;
}>;

type ProjectionStorageRow = Readonly<Record<string, unknown>>;

export type CanonicalProjectionRuntime = Readonly<{
  /** Apply projection impact inside the caller-owned financial commit. */
  applyCommit(commit: CanonicalProjectionCommitToken): void;
  read(request: CanonicalProjectionReadRequest): CanonicalProjectionSnapshot;
  rebuild(
    options?: CanonicalProjectionRebuildOptions,
  ): Promise<CanonicalProjectionRebuildResult>;
}>;

const COMMIT_ID_LENGTH = 16;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HEX_ID = /^[0-9a-f]{32}$/iu;

function rowValue(value: unknown): unknown {
  // Snapshot data must remain immutable after the read transaction closes.
  // Returning a Buffer would expose mutable bytes even when its containing
  // row is frozen, so canonical BLOB identifiers cross this seam as hex.
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(rowValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        rowValue(item),
      ]),
    );
  }
  return value;
}

function freezeDeep<T>(value: T): T {
  // ArrayBuffer views (including SQLite BLOB values) cannot be frozen when
  // they contain elements.  They are cloned at the row boundary and remain
  // immutable to the caller by convention; freezing their containing row is
  // sufficient to prevent accidental replacement.
  if (ArrayBuffer.isView(value)) return value;
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>))
      freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function rows<T extends Record<string, unknown>>(
  db: DatabaseSync,
  sql: string,
  ...parameters: readonly ProjectionSqlInput[]
): ProjectionStorageRow[] {
  return (db.prepare(sql).all(...parameters) as T[]).map((row) =>
    freezeDeep(rowValue(row) as ProjectionStorageRow),
  );
}

function requireScope(scope: CanonicalProjectionScope): void {
  if (scope === null || typeof scope !== "object")
    throw new Error("Canonical projection reads require a bounded scope.");
  const sourceConnectionKey = scope.sourceConnectionKey?.trim();
  const accountIds = scope.accountIds ?? [];
  const hasAccountScope = Object.prototype.hasOwnProperty.call(
    scope,
    "accountIds",
  );
  if (
    !sourceConnectionKey &&
    !hasAccountScope &&
    !scope.startDate &&
    !scope.endDate
  )
    throw new Error(
      "Canonical projection reads require a source connection, account IDs, or date range.",
    );
  if (sourceConnectionKey === "")
    throw new Error("Canonical projection source connection scope is invalid.");
  if (
    accountIds.some(
      (value) =>
        typeof value !== "string" || (!UUID.test(value) && !HEX_ID.test(value)),
    )
  )
    throw new Error("Canonical projection account scope contains an invalid ID.");
  if (scope.startDate !== undefined && !ISO_DATE.test(scope.startDate))
    throw new Error("Canonical projection scope start date is invalid.");
  if (scope.endDate !== undefined && !ISO_DATE.test(scope.endDate))
    throw new Error("Canonical projection scope end date is invalid.");
  if (
    scope.startDate !== undefined &&
    scope.endDate !== undefined &&
    scope.startDate > scope.endDate
  )
    throw new Error("Canonical projection scope date range is inverted.");
}

function requireCommitId(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== COMMIT_ID_LENGTH)
    throw new Error("Canonical projection commit ID is invalid.");
}

function accountScopeId(value: string): Buffer {
  if (!UUID.test(value) && !HEX_ID.test(value))
    throw new Error("Canonical projection account scope contains an invalid ID.");
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function commitKind(
  db: DatabaseSync,
  token: CanonicalProjectionCommitToken,
): CanonicalProjectionCommitKind {
  if (
    token.kind !== undefined &&
    !(token.kind in CANONICAL_PROJECTION_COMMIT_IMPACTS)
  )
    throw new Error(`Unknown canonical projection commit kind: ${token.kind}.`);
  const row = db
    .prepare("SELECT commit_kind FROM canonical_commits WHERE commit_id = ?")
    .get(token.commitId) as { commit_kind?: unknown } | undefined;
  if (!row) throw new Error("Canonical projection commit is not retained.");
  const kind = String(row.commit_kind);
  if (!(kind in CANONICAL_PROJECTION_COMMIT_IMPACTS))
    throw new Error(`Unknown canonical projection commit kind: ${kind}.`);
  if (token.kind !== undefined && token.kind !== kind)
    throw new Error("Canonical projection commit kind does not match storage.");
  return kind as CanonicalProjectionCommitKind;
}

function currentProjectionCommitSequence(db: DatabaseSync): number {
  return activeGenerationState(db).cutoffCommitSequence;
}

function activeGenerationState(db: DatabaseSync): {
  generationId: number;
  cutoffCommitSequence: number;
} {
  const row = db
    .prepare(
      `SELECT generation.generation_id, generation.build_cutoff_commit_sequence
         FROM active_projection_generation active
         JOIN projection_generations generation
           ON generation.generation_id = active.generation_id
        WHERE active.singleton_id = 1 AND generation.status = 'active'`,
    )
    .get() as
    | { generation_id?: unknown; build_cutoff_commit_sequence?: unknown }
    | undefined;
  const generationId = Number(row?.generation_id);
  const cutoffCommitSequence = Number(row?.build_cutoff_commit_sequence);
  if (
    !Number.isSafeInteger(generationId) ||
    generationId < 1 ||
    !Number.isSafeInteger(cutoffCommitSequence) ||
    cutoffCommitSequence < 0
  )
    throw new Error("Canonical active projection generation is missing.");
  return { generationId, cutoffCommitSequence };
}

function activeGenerationForRead(db: DatabaseSync, latest: number) {
  try {
    return activeGenerationState(db);
  } catch (error) {
    // A freshly-created v20 ledger has no financial commits and therefore no
    // generation to select yet. It is a valid empty Current Projection, not a
    // partially-built generation. Once any commit exists, absence fails closed.
    if (latest === 0) return null;
    throw error;
  }
}

/** Read-only access to the active generation for domain adapters. */
function activeCanonicalProjectionGeneration(db: DatabaseSync): number {
  assertValidatedCanonicalDatabase(db);
  return activeGenerationState(db).generationId;
}

function markCurrentProjectionCommit(
  db: DatabaseSync,
  commitId: Uint8Array,
): void {
  assertValidatedCanonicalDatabase(db);
  db.prepare(
    `INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?)
     ON CONFLICT(generation) DO UPDATE SET commit_id = excluded.commit_id`,
  ).run(commitId);
}

function recordRuntimeKnowledgePoint(
  db: DatabaseSync,
  generationId: number,
  commitId: Uint8Array,
): void {
  if (
    db
      .prepare(
        `SELECT 1 FROM projection_generation_provenance
          WHERE generation_id = ? AND event_kind = 'knowledge'
            AND event_source = 'routine' AND commit_id = ?`,
      )
      .get(generationId, commitId)
  )
    return;
  const last = db
    .prepare(
      `SELECT event_id, ordinal FROM projection_generation_provenance
        WHERE generation_id = ? ORDER BY ordinal DESC LIMIT 1`,
    )
    .get(generationId) as { event_id?: Uint8Array; ordinal?: number } | undefined;
  const ordinal = Number(last?.ordinal ?? 0) + 1;
  const previous = last?.event_id ?? null;
  const eventId = randomBytes(16);
  const previousHex = previous ? Buffer.from(previous).toString("hex") : "";
  const commitHex = Buffer.from(commitId).toString("hex");
  const eventDigest = createHash("sha256")
    .update(
      `canonical-projection-provenance/v1|${generationId}|${ordinal}|knowledge|routine|${commitHex}|${previousHex}`,
      "utf8",
    )
    .digest();
  db.prepare(
    `INSERT INTO projection_generation_provenance(
       event_id, generation_id, ordinal, previous_event_id, event_kind,
       event_source, commit_id, event_digest
     ) VALUES (?, ?, ?, ?, 'knowledge', 'routine', ?, ?)`,
  ).run(eventId, generationId, ordinal, previous, commitId, eventDigest);
}

/** Rebuild the loan balance projection for one account in the active generation. */
function refreshCurrentLoanBalanceProjection(
  db: DatabaseSync,
  values: Readonly<{
    generationId: number;
    accountId: Uint8Array;
    projectionCommitId: Uint8Array;
  }>,
): void {
  assertValidatedCanonicalDatabase(db);
  db.prepare(
    "DELETE FROM current_loan_balance_observations WHERE generation_id = ? AND account_id = ?",
  ).run(values.generationId, values.accountId);
  db.prepare(
    `INSERT INTO current_loan_balance_observations(
       generation_id, account_id, balance_kind, observation_id, revision_id,
       projection_commit_id, revision_commit_id
     )
     SELECT ?, ranked.account_id, ranked.balance_kind, ranked.observation_id,
            ranked.revision_id, ?, ranked.commit_id
     FROM (
       SELECT observation.account_id, observation.balance_kind,
              observation.observation_id, revision.revision_id, revision.commit_id,
              ROW_NUMBER() OVER (
                PARTITION BY observation.account_id, observation.balance_kind
                ORDER BY revision.effective_at DESC,
                         revision_commit.commit_sequence DESC,
                         COALESCE(balance_fact.occurrence_index, -1) DESC,
                         balance_record.occurrence_key DESC,
                         observation.observation_key DESC,
                         hex(revision.revision_id) DESC
              ) AS rank
       FROM balance_observations observation
       JOIN balance_observation_revisions revision
         ON revision.observation_id = observation.observation_id
       JOIN canonical_commits revision_commit
         ON revision_commit.commit_id = revision.commit_id
       JOIN source_records balance_record
         ON balance_record.source_record_id = revision.source_record_id
       JOIN source_captures balance_capture
         ON balance_capture.capture_id = revision.capture_id
       LEFT JOIN loan_transaction_facts balance_fact
         ON balance_fact.revision_id = (
           SELECT transaction_revision.revision_id
           FROM transaction_revisions transaction_revision
           WHERE transaction_revision.source_record_id = revision.source_record_id
           ORDER BY transaction_revision.revision_number DESC
           LIMIT 1
         )
       WHERE observation.account_id = ?
         AND balance_capture.authority_route IN (
           'fubon/loan/canonical-v2', 'yuanta/loan/canonical-v1'
         )
         AND balance_capture.completeness_rule_version IN (
           'loan/canonical/v2.fubon', 'loan/canonical/v1.yuanta'
         )
     ) ranked
     WHERE ranked.rank = 1`,
  ).run(
    values.generationId,
    values.projectionCommitId,
    values.accountId,
  );
}

function refreshTransactionProjection(
  db: DatabaseSync,
  projectionCommitId: Uint8Array,
  knowledgePoint: number,
): void {
  db.prepare("DELETE FROM current_transaction_fields").run();
  db.prepare("DELETE FROM current_transactions").run();
  db.prepare(
    `INSERT INTO current_transactions(
       transaction_id, revision_id, commit_id, projection_commit_id,
       revision_commit_id
     )
     SELECT transaction_row.transaction_id, revision.revision_id,
            lifecycle.selection_commit_id, lifecycle.selection_commit_id,
            revision.commit_id
       FROM financial_transactions transaction_row
       JOIN transaction_revisions revision
         ON revision.transaction_id = transaction_row.transaction_id
       JOIN canonical_commits revision_commit
         ON revision_commit.commit_id = revision.commit_id
       JOIN source_captures capture ON capture.capture_id = revision.capture_id
       JOIN source_records source_record
         ON source_record.source_record_id = revision.source_record_id
        AND source_record.capture_id = revision.capture_id
       JOIN source_record_scopes source_scope
         ON source_scope.source_record_id = source_record.source_record_id
        AND source_scope.capture_id = source_record.capture_id
        AND source_scope.sequence_lexeme = source_record.sequence_lexeme
       JOIN capture_scopes scope
         ON scope.scope_id = source_scope.scope_id
        AND scope.capture_id = source_scope.capture_id
        AND scope.account_id = transaction_row.account_id
       JOIN (
         SELECT source_assertion.revision_id,
                transition.commit_id AS selection_commit_id,
                transition.event_kind,
                ROW_NUMBER() OVER (
                  PARTITION BY source_assertion.revision_id
                  ORDER BY transition_commit.commit_sequence DESC,
                           transition.rowid DESC
                ) AS selection_rank
           FROM assertions source_assertion
           JOIN assertion_transitions transition
             ON transition.assertion_id = source_assertion.assertion_id
           JOIN canonical_commits transition_commit
             ON transition_commit.commit_id = transition.commit_id
          WHERE source_assertion.origin = 'source'
            AND transition_commit.commit_sequence <= ?
       ) lifecycle
         ON lifecycle.revision_id = revision.revision_id
        AND lifecycle.selection_rank = 1
      WHERE revision_commit.commit_sequence <= ?
        AND NOT EXISTS (
          SELECT 1
            FROM transaction_revisions newer
            JOIN canonical_commits newer_commit
              ON newer_commit.commit_id = newer.commit_id
           WHERE newer.transaction_id = revision.transaction_id
             AND newer_commit.commit_sequence <= ?
             AND newer_commit.commit_sequence > revision_commit.commit_sequence
        )
        AND lifecycle.event_kind <> 'withdrawn'`,
  ).run(
    knowledgePoint,
    knowledgePoint,
    knowledgePoint,
  );
  db.prepare(
    `WITH field_candidates AS (
       SELECT assertion.transaction_id, assertion.field_name,
              assertion.value_text, assertion.origin,
              assertion.assertion_id, event.commit_id AS projection_commit_id,
              event_commit.commit_sequence,
              ROW_NUMBER() OVER (
                PARTITION BY assertion.transaction_id, assertion.field_name,
                             assertion.origin
                ORDER BY event_commit.commit_sequence DESC, event.rowid DESC
              ) AS origin_rank
         FROM assertions assertion
         JOIN assertion_transitions event
           ON event.assertion_id = assertion.assertion_id
         JOIN canonical_commits event_commit
           ON event_commit.commit_id = event.commit_id
         JOIN current_transactions current_transaction
           ON current_transaction.transaction_id = assertion.transaction_id
        WHERE assertion.field_name IN ('display_name', 'note')
          AND assertion.origin IN ('derived', 'user')
          AND event_commit.commit_sequence <= ?
          AND event.event_kind NOT IN ('withdrawn', 'superseded')
          AND NOT EXISTS (
            SELECT 1
              FROM assertion_transitions newer_event
              JOIN canonical_commits newer_commit
                ON newer_commit.commit_id = newer_event.commit_id
             WHERE newer_event.assertion_id = event.assertion_id
               AND newer_commit.commit_sequence <= ?
               AND (newer_commit.commit_sequence > event_commit.commit_sequence
                    OR (newer_commit.commit_sequence = event_commit.commit_sequence
                        AND newer_event.rowid > event.rowid))
          )
     ), selected_fields AS (
       SELECT candidate.*,
              ROW_NUMBER() OVER (
                PARTITION BY candidate.transaction_id, candidate.field_name
                ORDER BY CASE candidate.origin WHEN 'user' THEN 0 ELSE 1 END,
                         candidate.commit_sequence DESC,
                         candidate.assertion_id
              ) AS field_rank
         FROM field_candidates candidate
        WHERE candidate.origin_rank = 1
     )
     INSERT INTO current_transaction_fields(
       transaction_id, field_name, value_text, origin,
       derived_assertion_id, user_assertion_id, projection_commit_id
     )
     SELECT transaction_id, field_name, value_text, origin,
            CASE WHEN origin = 'derived' THEN assertion_id ELSE NULL END,
            CASE WHEN origin = 'user' THEN assertion_id ELSE NULL END,
            projection_commit_id
       FROM selected_fields
      WHERE field_rank = 1`,
  ).run(knowledgePoint, knowledgePoint);
}

function refreshLoanProjection(
  db: DatabaseSync,
  projectionCommitId: Uint8Array,
  knowledgePoint: number,
): void {
  const generationId = activeCanonicalProjectionGeneration(db);
  db.prepare(
    `INSERT INTO current_loan_accounts(
       generation_id, account_id, projection_commit_id, created_commit_id
     )
     SELECT ?, identity.account_id, ?, identity.created_commit_id
       FROM loan_account_identities identity
      WHERE identity.account_type = 'loan' AND identity.stream = 'loan'
     ON CONFLICT(generation_id, account_id) DO UPDATE SET
       projection_commit_id = excluded.projection_commit_id`,
  ).run(generationId, projectionCommitId);

  const accounts = db
    .prepare(
      "SELECT account_id FROM loan_account_identities WHERE account_type = 'loan' AND stream = 'loan'",
    )
    .all() as Array<{ account_id: Uint8Array }>;
  for (const account of accounts)
    refreshCurrentLoanBalanceProjection(db, {
      generationId,
      accountId: account.account_id,
      projectionCommitId,
    });

  refreshLoanRelationProjection(db, projectionCommitId, knowledgePoint);
}

function refreshLoanRelationProjection(
  db: DatabaseSync,
  projectionCommitId: Uint8Array,
  knowledgePoint: number,
): void {
  const generationId = activeCanonicalProjectionGeneration(db);
  db.prepare(
    "DELETE FROM current_loan_relations WHERE generation_id = ?",
  ).run(generationId);
  db.prepare(
    `INSERT INTO current_loan_relations(
       generation_id, relation_id, projection_commit_id, relation_commit_id
     )
     SELECT ?, relation.relation_id, ?, relation.commit_id
       FROM transaction_relations relation
       JOIN canonical_commits relation_commit
         ON relation_commit.commit_id = relation.commit_id
      WHERE relation_commit.commit_sequence <= ?
        AND
        COALESCE((
        SELECT event.event_kind
          FROM loan_repayment_relation_events event
          JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
         WHERE event.relation_id = relation.relation_id
           AND event_commit.commit_sequence <= ?
         ORDER BY event_commit.commit_sequence DESC, event.event_id DESC
         LIMIT 1
      ), 'observed') NOT IN ('withdrawn', 'superseded')`,
  ).run(generationId, projectionCommitId, knowledgePoint, knowledgePoint);

  db.prepare(
    "DELETE FROM current_loan_repayment_settlement_groups WHERE generation_id = ?",
  ).run(generationId);
  db.prepare(
    `INSERT INTO current_loan_repayment_settlement_groups(
       generation_id, settlement_group_id, projection_commit_id
     )
     SELECT ?, group_row.settlement_group_id, ?
       FROM loan_repayment_settlement_groups group_row
       JOIN canonical_commits created_commit
         ON created_commit.commit_id = group_row.created_commit_id
      WHERE created_commit.commit_sequence <= ?
        AND COALESCE((
        SELECT event.event_kind
          FROM loan_repayment_relation_events event
          JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
         WHERE event.settlement_group_id = group_row.settlement_group_id
           AND event_commit.commit_sequence <= ?
         ORDER BY event_commit.commit_sequence DESC, event.event_id DESC
         LIMIT 1
      ), 'observed') NOT IN ('withdrawn', 'superseded')`,
  ).run(generationId, projectionCommitId, knowledgePoint, knowledgePoint);
}

function applyCommitInTransaction(
  db: DatabaseSync,
  token: CanonicalProjectionCommitToken,
): void {
  requireCommitId(token.commitId);
  const kind = commitKind(db, token);
  const impact = CANONICAL_PROJECTION_COMMIT_IMPACTS[kind];
  if (impact === "no-op") return;
  const current = db
    .prepare(
      `SELECT current_state.commit_id, current_commit.commit_sequence
         FROM current_projection_state current_state
         JOIN canonical_commits current_commit
           ON current_commit.commit_id = current_state.commit_id
        WHERE current_state.generation = 1`,
    )
    .get() as { commit_id?: unknown; commit_sequence?: unknown } | undefined;
  const target = db
    .prepare("SELECT commit_sequence FROM canonical_commits WHERE commit_id = ?")
    .get(token.commitId) as { commit_sequence?: unknown } | undefined;
  const targetSequence = Number(target?.commit_sequence);
  if (!Number.isSafeInteger(targetSequence))
    throw new Error("Canonical projection commit sequence is invalid.");
  if (impact === "loan-and-investment") {
    const active = activeGenerationState(db);
    if (targetSequence <= active.cutoffCommitSequence) return;
    const unappliedFinancialCommit = db
      .prepare(
        `SELECT 1
           FROM canonical_commits
          WHERE commit_sequence > ? AND commit_sequence <= ?
            AND commit_kind NOT IN ('relation_resolution', 'projection_rebuild')
          LIMIT 1`,
      )
      .get(active.cutoffCommitSequence, targetSequence);
    if (unappliedFinancialCommit)
      throw new Error(
        "Canonical projection relation commit cannot skip unapplied financial commits.",
      );
    refreshLoanRelationProjection(db, token.commitId, targetSequence);
    db.prepare(
      "UPDATE projection_generations SET build_cutoff_commit_sequence = ? WHERE generation_id = ?",
    ).run(targetSequence, active.generationId);
    recordRuntimeKnowledgePoint(db, active.generationId, token.commitId);
    markCurrentProjectionCommit(db, token.commitId);
    return;
  }
  if (
    current?.commit_id instanceof Uint8Array &&
    Buffer.from(current.commit_id).equals(Buffer.from(token.commitId))
  ) {
    // Extension writers may add loan facts after the shared financial spine
    // has applied this same commit. Re-applying the public token must remain
    // idempotent while bringing those commit-owned extension facts into the
    // Runtime-owned projection.
    refreshLoanProjection(db, token.commitId, targetSequence);
    return;
  }
  if (
    current?.commit_sequence !== undefined &&
    Number(current.commit_sequence) >= targetSequence
  )
    return;
  refreshTransactionProjection(db, token.commitId, targetSequence);
  canonicalProjectionRuntimeSyncInternal(db, token.commitId);
  markCurrentProjectionCommit(db, token.commitId);
  refreshLoanProjection(db, token.commitId, targetSequence);
}

/**
 * Apply one commit's projection impact inside the caller-owned transaction.
 * This function never opens a transaction or changes the writer queue.
 */
function applyCanonicalProjectionCommit(
  db: DatabaseSync,
  token: CanonicalProjectionCommitToken,
): void {
  assertValidatedCanonicalDatabase(db);
  applyCommitInTransaction(db, token);
}

function readFamily(
  db: DatabaseSync,
  family: CanonicalProjectionFamily,
  request: CanonicalProjectionReadRequest,
  knowledgeAt: number,
  generation: number | null,
): ProjectionStorageRow[] {
  const sourceConnectionKey = request.scope.sourceConnectionKey;
  const accountFilter = sourceConnectionKey
    ? "AND connection_scope.source_connection_key = ?"
    : "";
  const accountIds = (request.scope.accountIds ?? []).map(accountScopeId);
  const hasExplicitEmptyAccountScope =
    Object.prototype.hasOwnProperty.call(request.scope, "accountIds") &&
    accountIds.length === 0;
  const accountIdPlaceholders = accountIds.map(() => "?").join(",");
  const accountParameter: ProjectionSqlInput[] = sourceConnectionKey
    ? [sourceConnectionKey]
    : [];
  const scopedFilter = (alias: string): string =>
    hasExplicitEmptyAccountScope
      ? `${accountFilter} AND 0`
      : accountIds.length > 0
      ? `${accountFilter} AND ${alias}.account_id IN (${accountIdPlaceholders})`
      : accountFilter;
  const scopedParameters = (): ProjectionSqlInput[] => [
    ...accountParameter,
    ...accountIds,
  ];
  const groupScopedFilter = hasExplicitEmptyAccountScope
    ? `${accountFilter} AND 0`
    : accountIds.length
    ? `${accountFilter} AND EXISTS (
         SELECT 1
           FROM loan_repayment_settlement_group_members scoped_member
           JOIN financial_transactions scoped_transaction
             ON scoped_transaction.transaction_id = scoped_member.transaction_id
          WHERE scoped_member.settlement_group_id = group_row.settlement_group_id
            AND scoped_transaction.account_id IN (${accountIdPlaceholders})
       )`
    : accountFilter;
  const dateStart = request.scope.startDate;
  const dateEnd = request.scope.endDate;
  const financialAt =
    request.kind === "historical" ? request.cutoff?.financialAt ?? null : null;
  switch (family) {
    case "transactions": {
      if (request.kind === "current" && generation !== null)
        return rows(
          db,
          `SELECT projected.transaction_id, projected.revision_id,
                  projected.projection_commit_id, projected.revision_commit_id,
                  transaction_row.account_id, account.account_no,
                  revision.amount_coefficient, revision.amount_scale,
                  revision.currency, revision.direction, revision.effective_on,
                  revision.description, revision.commit_id
             FROM projection_generation_transactions projected
             JOIN financial_transactions transaction_row
               ON transaction_row.transaction_id = projected.transaction_id
             JOIN financial_accounts account
               ON account.account_id = transaction_row.account_id
             JOIN source_connections connection_scope
               ON connection_scope.source_connection_id = account.source_connection_id
             JOIN transaction_revisions revision
               ON revision.revision_id = projected.revision_id
            WHERE projected.generation_id = ? ${scopedFilter("account")}
              AND (? IS NULL OR revision.effective_on >= ?)
              AND (? IS NULL OR revision.effective_on <= ?)
            ORDER BY revision.effective_on, projected.transaction_id`,
          generation,
          ...scopedParameters(),
          dateStart ?? null,
          dateStart ?? null,
          dateEnd ?? null,
          dateEnd ?? null,
        );
      return rows(
        db,
        `SELECT transaction_row.transaction_id, transaction_row.account_id,
                account.account_no, revision.revision_id,
                revision.amount_coefficient, revision.amount_scale,
                revision.currency, revision.direction, revision.effective_on,
                revision.description, revision.commit_id
           FROM financial_transactions transaction_row
           JOIN financial_accounts account
             ON account.account_id = transaction_row.account_id
           JOIN source_connections connection_scope
             ON connection_scope.source_connection_id = account.source_connection_id
           JOIN transaction_revisions revision
             ON revision.transaction_id = transaction_row.transaction_id
           JOIN canonical_commits revision_commit
             ON revision_commit.commit_id = revision.commit_id
          WHERE revision_commit.commit_sequence <= ? ${scopedFilter("account")}
            AND (? IS NULL OR revision.effective_on >= ?)
            AND (? IS NULL OR revision.effective_on <= ?)
            AND (? IS NULL OR revision.effective_on <= ?)
            AND EXISTS (
              SELECT 1
                FROM assertions source_assertion
                JOIN assertion_transitions source_event
                  ON source_event.assertion_id = source_assertion.assertion_id
                JOIN canonical_commits source_event_commit
                  ON source_event_commit.commit_id = source_event.commit_id
               WHERE source_assertion.revision_id = revision.revision_id
                 AND source_assertion.origin = 'source'
                 AND source_event_commit.commit_sequence <= ?
                 AND source_event.event_kind <> 'withdrawn'
                 AND (
                   source_event.event_kind <> 'superseded'
                   OR NOT EXISTS (
                     SELECT 1
                       FROM transaction_revisions superseding_revision
                       JOIN canonical_commits superseding_commit
                         ON superseding_commit.commit_id = superseding_revision.commit_id
                      WHERE superseding_revision.transaction_id = revision.transaction_id
                        AND superseding_commit.commit_sequence >= source_event_commit.commit_sequence
                        AND superseding_commit.commit_sequence <= ?
                        AND (? IS NULL OR superseding_revision.effective_on <= ?)
                   )
                 )
                 AND NOT EXISTS (
                   SELECT 1
                     FROM assertion_transitions newer_source_event
                     JOIN canonical_commits newer_source_commit
                       ON newer_source_commit.commit_id = newer_source_event.commit_id
                    WHERE newer_source_event.assertion_id = source_event.assertion_id
                      AND newer_source_commit.commit_sequence <= ?
                      AND (newer_source_commit.commit_sequence > source_event_commit.commit_sequence
                           OR (newer_source_commit.commit_sequence = source_event_commit.commit_sequence
                               AND newer_source_event.rowid > source_event.rowid))
                 )
            )
            AND NOT EXISTS (
              SELECT 1 FROM transaction_revisions newer
              JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.commit_id
              WHERE newer.transaction_id = revision.transaction_id
                AND newer_commit.commit_sequence <= ?
                AND (? IS NULL OR newer.effective_on <= ?)
                AND newer_commit.commit_sequence > revision_commit.commit_sequence
            )
          ORDER BY revision.effective_on, transaction_row.transaction_id`,
        knowledgeAt,
        ...scopedParameters(),
        dateStart ?? null,
        dateStart ?? null,
        dateEnd ?? null,
        dateEnd ?? null,
        financialAt,
        financialAt,
        knowledgeAt,
        knowledgeAt,
        financialAt,
        financialAt,
        knowledgeAt,
        knowledgeAt,
        financialAt,
        financialAt,
      );
    }
    case "transaction-fields": {
      if (request.kind === "current" && generation !== null)
        return rows(
          db,
          `SELECT fields.transaction_id, fields.field_name, fields.value_text,
                  fields.origin, fields.projection_commit_id,
                  projection_commit.commit_sequence AS projection_commit_sequence
             FROM projection_generation_transaction_fields fields
             JOIN canonical_commits projection_commit
               ON projection_commit.commit_id = fields.projection_commit_id
             JOIN financial_transactions transaction_row
               ON transaction_row.transaction_id = fields.transaction_id
             JOIN financial_accounts account
               ON account.account_id = transaction_row.account_id
             JOIN source_connections connection_scope
               ON connection_scope.source_connection_id = account.source_connection_id
             JOIN projection_generation_transactions scoped_transaction
               ON scoped_transaction.generation_id = fields.generation_id
              AND scoped_transaction.transaction_id = fields.transaction_id
             JOIN transaction_revisions scoped_revision
               ON scoped_revision.revision_id = scoped_transaction.revision_id
            WHERE fields.generation_id = ? ${scopedFilter("account")}
              AND (? IS NULL OR scoped_revision.effective_on >= ?)
              AND (? IS NULL OR scoped_revision.effective_on <= ?)
            ORDER BY fields.transaction_id, fields.field_name`,
          generation,
          ...scopedParameters(),
          dateStart ?? null,
          dateStart ?? null,
          dateEnd ?? null,
          dateEnd ?? null,
        );
      return rows(
        db,
        `WITH eligible_transactions AS (
           SELECT revision.transaction_id,
                  ROW_NUMBER() OVER (
                    PARTITION BY revision.transaction_id
                    ORDER BY revision_commit.commit_sequence DESC
                  ) AS selection_rank
             FROM transaction_revisions revision
             JOIN canonical_commits revision_commit
               ON revision_commit.commit_id = revision.commit_id
            WHERE revision_commit.commit_sequence <= ?
              AND (? IS NULL OR revision.effective_on <= ?)
              AND (? IS NULL OR revision.effective_on >= ?)
              AND (? IS NULL OR revision.effective_on <= ?)
         ), field_candidates AS (
           SELECT assertion.transaction_id, assertion.field_name,
                  assertion.value_text, assertion.origin,
                  assertion.assertion_id,
                  field_commit.commit_sequence,
                  ROW_NUMBER() OVER (
                    PARTITION BY assertion.transaction_id, assertion.field_name,
                                 assertion.origin
                    ORDER BY field_commit.commit_sequence DESC, event.rowid DESC
                  ) AS selection_rank
             FROM assertions assertion
             JOIN assertion_transitions event
               ON event.assertion_id = assertion.assertion_id
             JOIN canonical_commits field_commit
               ON field_commit.commit_id = event.commit_id
            WHERE assertion.field_name IN ('display_name', 'note')
              AND assertion.origin IN ('derived', 'user')
              AND field_commit.commit_sequence <= ?
              AND event.event_kind NOT IN ('withdrawn', 'superseded')
              AND NOT EXISTS (
                SELECT 1
                  FROM assertion_transitions newer_event
                  JOIN canonical_commits newer_commit
                    ON newer_commit.commit_id = newer_event.commit_id
                 WHERE newer_event.assertion_id = event.assertion_id
                   AND newer_commit.commit_sequence <= ?
                   AND (newer_commit.commit_sequence > field_commit.commit_sequence
                        OR (newer_commit.commit_sequence = field_commit.commit_sequence
                            AND newer_event.rowid > event.rowid))
              )
         ), selected_fields AS (
           SELECT candidate.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY candidate.transaction_id, candidate.field_name
                    ORDER BY CASE candidate.origin WHEN 'user' THEN 0 ELSE 1 END,
                             candidate.commit_sequence DESC,
                             candidate.assertion_id
                  ) AS field_rank
             FROM field_candidates candidate
            WHERE candidate.selection_rank = 1
         )
         SELECT selected.transaction_id, selected.field_name,
                selected.value_text, selected.origin,
                selected.commit_sequence AS projection_commit_sequence
           FROM selected_fields selected
           JOIN financial_transactions transaction_row
             ON transaction_row.transaction_id = selected.transaction_id
           JOIN financial_accounts account
             ON account.account_id = transaction_row.account_id
           JOIN source_connections connection_scope
             ON connection_scope.source_connection_id = account.source_connection_id
           JOIN eligible_transactions eligible
             ON eligible.transaction_id = selected.transaction_id
            AND eligible.selection_rank = 1
          WHERE selected.field_rank = 1 ${scopedFilter("account")}
          ORDER BY selected.transaction_id, selected.field_name`,
        knowledgeAt,
        financialAt,
        financialAt,
        dateStart ?? null,
        dateStart ?? null,
        dateEnd ?? null,
        dateEnd ?? null,
        knowledgeAt,
        knowledgeAt,
        ...scopedParameters(),
      );
    }
    case "loan-accounts":
      if (generation === null)
        return rows(
          db,
          `SELECT identity.account_id, identity.account_key, identity.account_no,
                  identity.account_type, identity.stream, identity.created_commit_id
             FROM loan_account_identities identity
             JOIN financial_accounts account ON account.account_id = identity.account_id
             JOIN source_connections connection_scope ON connection_scope.source_connection_id = account.source_connection_id
             JOIN canonical_commits created ON created.commit_id = identity.created_commit_id
            WHERE created.commit_sequence <= ? ${scopedFilter("account")}
            ORDER BY identity.account_no`,
          knowledgeAt,
          ...scopedParameters(),
        );
      return rows(
        db,
        `SELECT projected.generation_id, projected.account_id,
                projected.projection_commit_id, projected.created_commit_id,
                identity.account_key, identity.account_no
           FROM current_loan_accounts projected
           JOIN loan_account_identities identity ON identity.account_id = projected.account_id
           JOIN financial_accounts account ON account.account_id = projected.account_id
           JOIN source_connections connection_scope ON connection_scope.source_connection_id = account.source_connection_id
          WHERE projected.generation_id = ? ${scopedFilter("account")}
          ORDER BY identity.account_no`,
        generation,
        ...scopedParameters(),
      );
    case "loan-balances": {
      if (request.kind === "current" && generation !== null)
        return rows(
          db,
          `SELECT projected.generation_id, projected.account_id,
                  projected.balance_kind, projected.observation_id,
                  projected.revision_id, projected.projection_commit_id,
                  projected.revision_commit_id, revision.balance_coefficient,
                  revision.balance_scale, revision.currency, revision.effective_at
             FROM current_loan_balance_observations projected
             JOIN balance_observation_revisions revision ON revision.revision_id = projected.revision_id
             JOIN financial_accounts account ON account.account_id = projected.account_id
             JOIN source_connections connection_scope ON connection_scope.source_connection_id = account.source_connection_id
          WHERE projected.generation_id = ? ${scopedFilter("account")}
              AND (? IS NULL OR substr(revision.effective_at, 1, 10) >= ?)
              AND (? IS NULL OR substr(revision.effective_at, 1, 10) <= ?)
            ORDER BY revision.effective_at, projected.account_id`,
          generation,
          ...scopedParameters(),
          dateStart ?? null,
          dateStart ?? null,
          dateEnd ?? null,
          dateEnd ?? null,
        );
      return rows(
        db,
        `SELECT observation.observation_id, observation.account_id,
                observation.balance_kind, revision.revision_id,
                revision.balance_coefficient, revision.balance_scale,
                revision.currency, revision.effective_at,
                revision.commit_id AS revision_commit_id
           FROM balance_observations observation
           JOIN balance_observation_revisions revision
             ON revision.observation_id = observation.observation_id
           JOIN financial_accounts account ON account.account_id = observation.account_id
           JOIN source_connections connection_scope
             ON connection_scope.source_connection_id = account.source_connection_id
           JOIN canonical_commits revision_commit
             ON revision_commit.commit_id = revision.commit_id
          WHERE revision_commit.commit_sequence <= ?
            AND substr(revision.effective_at, 1, 10) <= ? ${scopedFilter("account")}
            AND (? IS NULL OR substr(revision.effective_at, 1, 10) >= ?)
            AND NOT EXISTS (
              SELECT 1
                FROM balance_observation_revisions newer
                JOIN canonical_commits newer_commit
                  ON newer_commit.commit_id = newer.commit_id
               WHERE newer.observation_id = observation.observation_id
                 AND newer_commit.commit_sequence <= ?
                 AND substr(newer.effective_at, 1, 10) <= ?
                 AND newer_commit.commit_sequence > revision_commit.commit_sequence
            )
          ORDER BY revision.effective_at, observation.account_id`,
        knowledgeAt,
        financialAt,
        ...scopedParameters(),
        dateStart ?? null,
        dateStart ?? null,
        knowledgeAt,
        financialAt,
      );
    }
    case "loan-relations": {
      if (request.kind === "current" && generation !== null)
        return rows(
          db,
          `SELECT projected.generation_id, projected.relation_id,
                  projected.projection_commit_id, projected.relation_commit_id,
                  relation.from_account_id, relation.to_account_id,
                  relation.from_transaction_id, relation.to_transaction_id,
                  relation.relation_key, relation.relation_kind
             FROM current_loan_relations projected
             JOIN transaction_relations relation ON relation.relation_id = projected.relation_id
             JOIN financial_accounts account ON account.account_id = relation.account_id
             JOIN source_connections connection_scope ON connection_scope.source_connection_id = account.source_connection_id
             JOIN projection_generation_transactions from_projected
               ON from_projected.generation_id = projected.generation_id
              AND from_projected.transaction_id = relation.from_transaction_id
             JOIN transaction_revisions from_revision
               ON from_revision.revision_id = from_projected.revision_id
             JOIN projection_generation_transactions to_projected
               ON to_projected.generation_id = projected.generation_id
              AND to_projected.transaction_id = relation.to_transaction_id
             JOIN transaction_revisions to_revision
               ON to_revision.revision_id = to_projected.revision_id
            WHERE projected.generation_id = ? ${scopedFilter("account")}
              AND (? IS NULL OR (from_revision.effective_on >= ? AND to_revision.effective_on >= ?))
              AND (? IS NULL OR (from_revision.effective_on <= ? AND to_revision.effective_on <= ?))
            ORDER BY projected.relation_id`,
          generation,
          ...scopedParameters(),
          dateStart ?? null,
          dateStart ?? null,
          dateStart ?? null,
          dateEnd ?? null,
          dateEnd ?? null,
          dateEnd ?? null,
        );
      return rows(
        db,
        `SELECT relation.relation_id, relation.account_id,
                relation.from_account_id, relation.to_account_id,
                relation.from_transaction_id, relation.to_transaction_id,
                relation.relation_key, relation.relation_kind,
                relation.commit_id AS relation_commit_id
           FROM (
             SELECT base_relation.*,
                    (SELECT MAX(from_revision.effective_on)
                       FROM transaction_revisions from_revision
                       JOIN canonical_commits from_commit
                         ON from_commit.commit_id = from_revision.commit_id
                      WHERE from_revision.transaction_id = base_relation.from_transaction_id
                        AND from_commit.commit_sequence <= ?
                        AND from_revision.effective_on <= ?) AS from_effective_on,
                    (SELECT MAX(to_revision.effective_on)
                       FROM transaction_revisions to_revision
                       JOIN canonical_commits to_commit
                         ON to_commit.commit_id = to_revision.commit_id
                      WHERE to_revision.transaction_id = base_relation.to_transaction_id
                        AND to_commit.commit_sequence <= ?
                        AND to_revision.effective_on <= ?) AS to_effective_on
               FROM transaction_relations base_relation
           ) relation
           JOIN financial_accounts account ON account.account_id = relation.account_id
           JOIN source_connections connection_scope
             ON connection_scope.source_connection_id = account.source_connection_id
           JOIN canonical_commits relation_commit
             ON relation_commit.commit_id = relation.commit_id
          WHERE relation_commit.commit_sequence <= ? ${scopedFilter("account")}
            AND (
              ? IS NULL OR (
                relation.from_effective_on <= ?
                AND relation.to_effective_on <= ?
              )
            )
            AND (? IS NULL OR (relation.from_effective_on >= ? AND relation.to_effective_on >= ?))
            AND (? IS NULL OR (relation.from_effective_on <= ? AND relation.to_effective_on <= ?))
            AND COALESCE((
              SELECT lifecycle.event_kind
                FROM loan_repayment_relation_events lifecycle
                JOIN canonical_commits lifecycle_commit
                  ON lifecycle_commit.commit_id = lifecycle.commit_id
               WHERE lifecycle.relation_id = relation.relation_id
                 AND lifecycle_commit.commit_sequence <= ?
               ORDER BY lifecycle_commit.commit_sequence DESC, lifecycle.event_id DESC
               LIMIT 1
            ), 'observed') NOT IN ('withdrawn', 'superseded')
            AND NOT EXISTS (
              SELECT 1
                FROM transaction_relations newer
                JOIN canonical_commits newer_commit
                  ON newer_commit.commit_id = newer.commit_id
               WHERE newer.account_id = relation.account_id
                 AND newer.relation_key = relation.relation_key
                 AND newer_commit.commit_sequence <= ?
                 AND newer_commit.commit_sequence > relation_commit.commit_sequence
            )
          ORDER BY relation.relation_id`,
        knowledgeAt,
        financialAt,
        knowledgeAt,
        financialAt,
        knowledgeAt,
        ...scopedParameters(),
        financialAt,
        financialAt,
        financialAt,
        dateStart ?? null,
        dateStart ?? null,
        dateStart ?? null,
        dateEnd ?? null,
        dateEnd ?? null,
        dateEnd ?? null,
        knowledgeAt,
        knowledgeAt,
      );
    }
    case "loan-settlement-groups": {
      if (request.kind === "current" && generation !== null)
        return rows(
          db,
          `SELECT projected.generation_id, projected.settlement_group_id,
                  projected.projection_commit_id, group_row.group_key,
                  group_row.resolver_version
             FROM current_loan_repayment_settlement_groups projected
             JOIN loan_repayment_settlement_groups group_row
               ON group_row.settlement_group_id = projected.settlement_group_id
             JOIN source_connections connection_scope
               ON connection_scope.source_connection_id = group_row.source_connection_id
            WHERE projected.generation_id = ? ${groupScopedFilter}
              AND EXISTS (
                SELECT 1
                  FROM loan_repayment_settlement_group_members bounded_member
                  JOIN projection_generation_transactions bounded_projected
                    ON bounded_projected.generation_id = projected.generation_id
                   AND bounded_projected.transaction_id = bounded_member.transaction_id
                  JOIN transaction_revisions bounded_revision
                    ON bounded_revision.revision_id = bounded_projected.revision_id
                 WHERE bounded_member.settlement_group_id = group_row.settlement_group_id
                   AND (? IS NULL OR bounded_revision.effective_on >= ?)
                   AND (? IS NULL OR bounded_revision.effective_on <= ?)
              )
            ORDER BY projected.settlement_group_id`,
          generation,
          ...scopedParameters(),
          dateStart ?? null,
          dateStart ?? null,
          dateEnd ?? null,
          dateEnd ?? null,
        );
      return rows(
        db,
        `SELECT group_row.settlement_group_id,
                group_row.group_key, group_row.resolver_version,
                group_row.created_commit_id
           FROM loan_repayment_settlement_groups group_row
           JOIN source_connections connection_scope
             ON connection_scope.source_connection_id = group_row.source_connection_id
           JOIN canonical_commits created
             ON created.commit_id = group_row.created_commit_id
          WHERE created.commit_sequence <= ? ${groupScopedFilter}
            AND COALESCE((
              SELECT lifecycle.event_kind
                FROM loan_repayment_relation_events lifecycle
                JOIN canonical_commits lifecycle_commit
                  ON lifecycle_commit.commit_id = lifecycle.commit_id
               WHERE lifecycle.settlement_group_id = group_row.settlement_group_id
                 AND lifecycle_commit.commit_sequence <= ?
               ORDER BY lifecycle_commit.commit_sequence DESC, lifecycle.event_id DESC
               LIMIT 1
            ), 'observed') NOT IN ('withdrawn', 'superseded')
            AND EXISTS (
              SELECT 1
                FROM loan_repayment_settlement_group_members bounded_member
                JOIN transaction_revisions bounded_revision
                  ON bounded_revision.transaction_id = bounded_member.transaction_id
                JOIN canonical_commits bounded_commit
                  ON bounded_commit.commit_id = bounded_revision.commit_id
               WHERE bounded_member.settlement_group_id = group_row.settlement_group_id
                 AND bounded_commit.commit_sequence <= ?
                 AND bounded_revision.effective_on <= ?
                 AND (? IS NULL OR bounded_revision.effective_on >= ?)
                 AND (? IS NULL OR bounded_revision.effective_on <= ?)
                 AND NOT EXISTS (
                   SELECT 1
                     FROM transaction_revisions bounded_newer
                     JOIN canonical_commits bounded_newer_commit
                       ON bounded_newer_commit.commit_id = bounded_newer.commit_id
                    WHERE bounded_newer.transaction_id = bounded_revision.transaction_id
                      AND bounded_newer_commit.commit_sequence <= ?
                      AND bounded_newer.effective_on <= ?
                      AND bounded_newer_commit.commit_sequence > bounded_commit.commit_sequence
                 )
            )
          ORDER BY group_row.settlement_group_id`,
        knowledgeAt,
        ...scopedParameters(),
        knowledgeAt,
        knowledgeAt,
        financialAt,
        dateStart ?? null,
        dateStart ?? null,
        dateEnd ?? null,
        dateEnd ?? null,
        knowledgeAt,
        financialAt,
      );
    }
    case "investment-accounts":
      return rows(
        db,
        `SELECT investment_account.account_id, investment_account.source_id,
                investment_account.account_key, investment_account.account_subtype
           FROM investment_accounts investment_account
           JOIN source_connections connection_scope
             ON connection_scope.source_connection_id = investment_account.source_connection_id
           JOIN financial_accounts financial_account
             ON financial_account.account_id = investment_account.account_id
           JOIN canonical_commits account_commit
             ON account_commit.commit_id = financial_account.created_commit_id
          WHERE account_commit.commit_sequence <= ? ${scopedFilter("investment_account")}
          ORDER BY investment_account.source_id, investment_account.account_key`,
        knowledgeAt,
        ...scopedParameters(),
      );
    case "investment-holdings":
      return rows(
        db,
        `SELECT holding.account_id, holding.security_id, holding.measurement_key,
                holding.revision_number, holding.quantity_coefficient,
                holding.quantity_scale, holding.valuation_coefficient,
                holding.valuation_scale, holding.valuation_currency,
                holding.cost_coefficient, holding.cost_scale, holding.cost_currency,
                holding.effective_on, holding.observed_at, holding.lineage_json,
                holding.is_current,
                security.security_key
           FROM (
             SELECT observation.*,
               ${
                 request.kind === "current"
                   ? `ROW_NUMBER() OVER (
                        PARTITION BY observation.account_id, observation.security_id
                        ORDER BY observation.effective_on DESC, observation.observed_at DESC,
                                 observation.revision_number DESC, observation.rowid DESC
                      )`
                   : "1"
               } AS selection_rank
             FROM investment_holding_observations observation
            JOIN canonical_commits holding_commit ON holding_commit.commit_id = observation.commit_id
            WHERE holding_commit.commit_sequence <= ?
              ${request.kind === "current" ? "AND observation.is_current = 1" : ""}
              AND (? IS NULL OR observation.effective_on <= ?)
           ) holding
           JOIN investment_securities security ON security.security_id = holding.security_id
           JOIN source_connections connection_scope
             ON connection_scope.source_connection_id = (
               SELECT investment_account.source_connection_id FROM investment_accounts investment_account
                WHERE investment_account.account_id = holding.account_id
             )
          WHERE holding.selection_rank = 1 ${scopedFilter("holding")}
            AND (? IS NULL OR holding.effective_on >= ?)
          ORDER BY holding.effective_on, security.security_key`,
        knowledgeAt,
        request.kind === "historical" ? financialAt : dateEnd ?? null,
        request.kind === "historical" ? financialAt : dateEnd ?? null,
        ...scopedParameters(),
        dateStart ?? null,
        dateStart ?? null,
      );
    case "investment-transactions":
      return rows(
        db,
        `SELECT investment_transaction.transaction_id,
                investment_transaction.account_id, investment_transaction.security_id,
                investment_transaction.action, investment_transaction.quantity_coefficient,
                investment_transaction.quantity_scale, investment_transaction.cash_coefficient,
                investment_transaction.cash_scale, investment_transaction.cash_currency,
                investment_transaction.effective_on,
                investment_transaction.funding_evidence_json
           FROM investment_transactions investment_transaction
           JOIN canonical_commits investment_commit ON investment_commit.commit_id = investment_transaction.commit_id
           JOIN source_connections connection_scope ON connection_scope.source_connection_id = (
             SELECT investment_account.source_connection_id FROM investment_accounts investment_account
              WHERE investment_account.account_id = investment_transaction.account_id
           )
          WHERE investment_commit.commit_sequence <= ? ${scopedFilter("investment_transaction")}
            AND (? IS NULL OR investment_transaction.effective_on >= ?)
            AND (? IS NULL OR investment_transaction.effective_on <= ?)
            AND (? IS NULL OR investment_transaction.effective_on <= ?)
          ORDER BY investment_transaction.effective_on, investment_transaction.rowid`,
        knowledgeAt,
        ...scopedParameters(),
        dateStart ?? null,
        dateStart ?? null,
        dateEnd ?? null,
        dateEnd ?? null,
        financialAt,
        financialAt,
      );
    case "investment-margin-balances":
      return rows(
        db,
        `SELECT margin.account_id, margin.balance_kind, margin.coefficient,
                margin.scale, margin.currency, margin.effective_on
           FROM investment_margin_balance_observations margin
           JOIN canonical_commits margin_commit ON margin_commit.commit_id = margin.commit_id
           JOIN source_connections connection_scope ON connection_scope.source_connection_id = (
             SELECT investment_account.source_connection_id FROM investment_accounts investment_account
              WHERE investment_account.account_id = margin.account_id
           )
          WHERE margin_commit.commit_sequence <= ? ${scopedFilter("margin")}
            AND (? IS NULL OR margin.effective_on >= ?)
            AND (? IS NULL OR margin.effective_on <= ?)
            AND (? IS NULL OR margin.effective_on <= ?)
          ORDER BY margin.effective_on, margin.account_id`,
        knowledgeAt,
        ...scopedParameters(),
        dateStart ?? null,
        dateStart ?? null,
        dateEnd ?? null,
        dateEnd ?? null,
        financialAt,
        financialAt,
      );
    case "investment-funding-relations":
      return rows(
        db,
        `SELECT relation.relation_id, relation.relation_key,
                relation.settlement_group_key, relation.investment_account_id,
                relation.settlement_effective_on, relation.settlement_model,
                relation.coefficient, relation.scale, relation.currency,
                relation.direction, relation.source_linkage_key,
                COUNT(member.investment_transaction_id) AS investment_transaction_count
           FROM investment_funding_relations relation
           JOIN investment_accounts investment_account
             ON investment_account.account_id = relation.investment_account_id
           JOIN source_connections connection_scope
             ON connection_scope.source_connection_id = investment_account.source_connection_id
           JOIN investment_funding_relation_members member
             ON member.relation_id = relation.relation_id
           JOIN canonical_commits relation_commit
             ON relation_commit.commit_id = relation.created_commit_id
          WHERE relation_commit.commit_sequence <= ? ${scopedFilter("investment_account")}
            AND (? IS NULL OR relation.settlement_effective_on >= ?)
            AND (? IS NULL OR relation.settlement_effective_on <= ?)
            AND (? IS NULL OR relation.settlement_effective_on <= ?)
            AND COALESCE((
              SELECT event.event_kind
                FROM investment_funding_relation_events event
                JOIN canonical_commits event_commit
                  ON event_commit.commit_id = event.commit_id
               WHERE event.relation_id = relation.relation_id
                 AND event_commit.commit_sequence <= ?
               ORDER BY event_commit.commit_sequence DESC, event.rowid DESC
               LIMIT 1
            ), 'withdrawn') = 'observed'
          GROUP BY relation.relation_id
          ORDER BY relation.settlement_effective_on, relation.relation_key`,
        knowledgeAt,
        ...scopedParameters(),
        dateStart ?? null,
        dateStart ?? null,
        dateEnd ?? null,
        dateEnd ?? null,
        financialAt,
        financialAt,
        knowledgeAt,
      );
  }
}

const textValue = (row: ProjectionStorageRow, key: string): string =>
  String(row[key]);
const nullableTextValue = (
  row: ProjectionStorageRow,
  key: string,
): string | null => (row[key] == null ? null : String(row[key]));
const nullableNumberValue = (
  row: ProjectionStorageRow,
  key: string,
): number | null => (row[key] == null ? null : Number(row[key]));

function projectFamilyRows<Family extends CanonicalProjectionFamily>(
  family: Family,
  storageRows: readonly ProjectionStorageRow[],
): readonly CanonicalProjectionFamilyRows[Family][] {
  const projected = storageRows.map((row) => {
    switch (family) {
      case "transactions":
        return {
          transactionId: textValue(row, "transaction_id"),
          revisionId: textValue(row, "revision_id"),
          accountId: textValue(row, "account_id"),
          accountNumber: nullableTextValue(row, "account_no"),
          amountCoefficient: textValue(row, "amount_coefficient"),
          amountScale: Number(row.amount_scale),
          currency: textValue(row, "currency"),
          direction: textValue(row, "direction"),
          effectiveOn: textValue(row, "effective_on"),
          description: nullableTextValue(row, "description"),
          projectionCommitId: nullableTextValue(row, "projection_commit_id"),
          revisionCommitId:
            nullableTextValue(row, "revision_commit_id") ??
            textValue(row, "commit_id"),
        };
      case "transaction-fields":
        return {
          transactionId: textValue(row, "transaction_id"),
          fieldName: textValue(row, "field_name"),
          value: textValue(row, "value_text"),
          origin: textValue(row, "origin"),
          projectionCommitId: nullableTextValue(row, "projection_commit_id"),
          projectionCommitSequence: Number(row.projection_commit_sequence),
        };
      case "loan-accounts":
        return { accountId: textValue(row, "account_id") };
      case "loan-balances":
        return {
          accountId: textValue(row, "account_id"),
          observationId: textValue(row, "observation_id"),
          revisionId: textValue(row, "revision_id"),
        };
      case "loan-relations":
        return {
          relationId: textValue(row, "relation_id"),
          fromTransactionId: textValue(row, "from_transaction_id"),
          toTransactionId: textValue(row, "to_transaction_id"),
        };
      case "loan-settlement-groups":
        return { settlementGroupId: textValue(row, "settlement_group_id") };
      case "investment-accounts":
        return {
          accountId: textValue(row, "account_id"),
          sourceId: textValue(row, "source_id"),
          accountKey: textValue(row, "account_key"),
          accountSubtype: textValue(row, "account_subtype"),
        };
      case "investment-holdings":
        return {
          accountId: textValue(row, "account_id"),
          securityId: textValue(row, "security_id"),
          securityKey: textValue(row, "security_key"),
          measurementKey: textValue(row, "measurement_key"),
          revisionNumber: Number(row.revision_number),
          isCurrent: Number(row.is_current) === 1,
          quantityCoefficient: nullableTextValue(row, "quantity_coefficient"),
          quantityScale: nullableNumberValue(row, "quantity_scale"),
          valuationCoefficient: nullableTextValue(row, "valuation_coefficient"),
          valuationScale: nullableNumberValue(row, "valuation_scale"),
          valuationCurrency: nullableTextValue(row, "valuation_currency"),
          costCoefficient: nullableTextValue(row, "cost_coefficient"),
          costScale: nullableNumberValue(row, "cost_scale"),
          costCurrency: nullableTextValue(row, "cost_currency"),
          effectiveOn: textValue(row, "effective_on"),
          observedAt: textValue(row, "observed_at"),
          lineageJson: textValue(row, "lineage_json"),
        };
      case "investment-transactions":
        return {
          transactionId: textValue(row, "transaction_id"),
          accountId: textValue(row, "account_id"),
          securityId: textValue(row, "security_id"),
          action: textValue(row, "action"),
          quantityCoefficient: textValue(row, "quantity_coefficient"),
          quantityScale: Number(row.quantity_scale),
          cashCoefficient: textValue(row, "cash_coefficient"),
          cashScale: Number(row.cash_scale),
          cashCurrency: textValue(row, "cash_currency"),
          effectiveOn: textValue(row, "effective_on"),
          fundingEvidenceJson: textValue(row, "funding_evidence_json"),
        };
      case "investment-margin-balances":
        return {
          accountId: textValue(row, "account_id"),
          balanceKind: textValue(row, "balance_kind"),
          coefficient: textValue(row, "coefficient"),
          scale: Number(row.scale),
          currency: textValue(row, "currency"),
          effectiveOn: textValue(row, "effective_on"),
        };
      case "investment-funding-relations":
        return {
          relationId: textValue(row, "relation_id"),
          relationKey: textValue(row, "relation_key"),
          settlementGroupKey: textValue(row, "settlement_group_key"),
          investmentAccountId: textValue(row, "investment_account_id"),
          settlementEffectiveOn: textValue(row, "settlement_effective_on"),
          settlementModel: textValue(row, "settlement_model"),
          coefficient: textValue(row, "coefficient"),
          scale: Number(row.scale),
          currency: textValue(row, "currency"),
          direction: textValue(row, "direction"),
          sourceLinkageKey: textValue(row, "source_linkage_key"),
          investmentTransactionCount: Number(row.investment_transaction_count),
        };
    }
  });
  return freezeDeep(projected) as unknown as readonly CanonicalProjectionFamilyRows[Family][];
}

function readSnapshotInTransaction(
  db: DatabaseSync,
  request: CanonicalProjectionReadRequest,
): CanonicalProjectionSnapshot {
  if (request.families.length === 0)
    throw new Error("Canonical projection read requires at least one family.");
  if (
    request.families.some(
      (family) => !CANONICAL_PROJECTION_FAMILIES.includes(family),
    )
  )
    throw new Error("Unknown canonical projection family.");
  requireScope(request.scope);
  if (
    request.kind === "historical" &&
    (!request.cutoff ||
      !ISO_DATE.test(request.cutoff.financialAt) ||
      !Number.isSafeInteger(request.cutoff.knowledgeAt))
  )
    throw new Error(
      "Historical projection reads require financial and knowledge cutoffs.",
    );
  const latest = Number(
    (
      db
        .prepare(
          "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
        )
        .get() as { value?: unknown }
    ).value ?? 0,
  );
  const active =
    request.kind === "current" ? activeGenerationForRead(db, latest) : null;
  const cutoff = request.cutoff;
  const knowledgeAt =
    request.kind === "current"
      ? active === null
        ? 0
        : currentProjectionCommitSequence(db)
      : cutoff?.knowledgeAt;
  if (
    knowledgeAt === undefined ||
    !Number.isSafeInteger(knowledgeAt) ||
    knowledgeAt < 0 ||
    knowledgeAt > latest
  )
    throw new Error("Canonical projection knowledge cutoff is invalid.");
  const requested = new Set(request.families);
  const familyRows = <Family extends CanonicalProjectionFamily>(family: Family) =>
    requested.has(family)
      ? projectFamilyRows(
          family,
          readFamily(
            db,
            family,
            request,
            knowledgeAt,
            active?.generationId ?? null,
          ),
        )
      : ([] as readonly CanonicalProjectionFamilyRows[Family][]);
  const families = {
    transactions: familyRows("transactions"),
    "transaction-fields": familyRows("transaction-fields"),
    "loan-accounts": familyRows("loan-accounts"),
    "loan-balances": familyRows("loan-balances"),
    "loan-relations": familyRows("loan-relations"),
    "loan-settlement-groups": familyRows("loan-settlement-groups"),
    "investment-accounts": familyRows("investment-accounts"),
    "investment-holdings": familyRows("investment-holdings"),
    "investment-transactions": familyRows("investment-transactions"),
    "investment-margin-balances": familyRows("investment-margin-balances"),
    "investment-funding-relations": familyRows("investment-funding-relations"),
  };
  return freezeDeep({
    kind: request.kind,
    generation: active?.generationId ?? null,
    knowledgePoint: knowledgeAt,
    financialAt: cutoff?.financialAt ?? null,
    families,
  });
}

function createRuntime(target: string | DatabaseSync): CanonicalProjectionRuntime {
  const databasePath = typeof target === "string" ? target : null;
  const ledgerDirectory =
    databasePath !== null && basename(databasePath) === CANONICAL_SQLITE_FILE
      ? dirname(databasePath)
      : databasePath;
  return Object.freeze({
    applyCommit(commit: CanonicalProjectionCommitToken): void {
      if (typeof target === "string")
        throw new Error(
          "Canonical projection apply requires a Runtime bound to the caller-owned transaction.",
        );
      applyCanonicalProjectionCommit(target, commit);
    },
    read(request: CanonicalProjectionReadRequest): CanonicalProjectionSnapshot {
      if (typeof target !== "string")
        return withProjectionReadSnapshot(target, () =>
          readSnapshotInTransaction(target, request),
        );
      if (ledgerDirectory === null)
        throw new Error("Canonical projection runtime database path is required.");
      const db = openCanonicalDatabase(ledgerDirectory, { readOnly: true });
      try {
        return withProjectionReadSnapshot(db, () =>
          readSnapshotInTransaction(db, request),
        );
      } finally {
        db.close();
      }
    },
    rebuild(options: CanonicalProjectionRebuildOptions = {}) {
      if (ledgerDirectory === null)
        throw new Error(
          "Canonical projection rebuild requires a path-bound Runtime.",
        );
      return canonicalProjectionRuntimeRebuildInternal(ledgerDirectory, options);
    },
  });
}

function withProjectionReadSnapshot<T>(db: DatabaseSync, operation: () => T): T {
  let ownsTransaction = false;
  try {
    db.exec("BEGIN");
    ownsTransaction = true;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/within a transaction/iu.test(error.message)
    )
      throw error;
    // A caller-owned financial transaction already supplies the snapshot.
  }
  try {
    const value = operation();
    if (ownsTransaction) db.exec("COMMIT");
    return value;
  } catch (error) {
    if (ownsTransaction)
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the projection read failure.
      }
    throw error;
  }
}

export function createCanonicalProjectionRuntime(
  target: string | DatabaseSync,
): CanonicalProjectionRuntime {
  if (typeof target === "string" && !target.trim())
    throw new Error("Canonical projection runtime database path is required.");
  if (typeof target !== "string") assertValidatedCanonicalDatabase(target);
  return createRuntime(target);
}
