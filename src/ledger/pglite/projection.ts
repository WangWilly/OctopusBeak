import { createHash, randomUUID } from "node:crypto";
import type { PGliteTransaction } from "./transaction.ts";
import {
  derivePGliteCathayDescriptionKind,
  derivePGliteTransactionKind,
  type PGliteProjectionRelations,
  type PGliteProjectionTransaction,
} from "./enrichment.ts";

export type PGliteCanonicalProjectionContext = Readonly<{
  commitId: Uint8Array;
  cutoffSequence: number;
  captureIds?: readonly Uint8Array[];
  transactionIds?: readonly Uint8Array[];
  /** Internal resolved scope; callers normally provide capture/transaction IDs. */
  affectedTransactionIds?: readonly Uint8Array[];
  /** Card extension changes can alter bank payment classification globally. */
  refreshEnrichmentAll?: boolean;
}>;

export type PGliteCanonicalProjectionHook = (
  transaction: PGliteTransaction,
  context: PGliteCanonicalProjectionContext,
) => Promise<void>;

type Row = Readonly<Record<string, unknown>>;

async function query<T>(
  transaction: PGliteTransaction,
  sql: string,
  params: readonly unknown[] = [],
): Promise<readonly T[]> {
  let index = 0;
  const postgresSql = sql.replace(/\?/gu, () => `$${++index}`);
  return (await transaction.query<T>(postgresSql, params)).rows;
}

async function first<T>(
  transaction: PGliteTransaction,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  return (await query<T>(transaction, sql, params))[0];
}

function bytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const result = Uint8Array.from(value);
    if (result.length === 16) return result;
  }
  if (typeof value === "string") {
    const hex = value.replace(/^\\x/u, "");
    if (/^[0-9a-f]{32}$/iu.test(hex)) return Uint8Array.from(Buffer.from(hex, "hex"));
  }
  throw new Error(`${label} is not a canonical UUID.`);
}

function idText(value: unknown, label: string): string {
  const valueBytes = bytes(value, label);
  const hex = Buffer.from(valueBytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, child) =>
    child instanceof Uint8Array ? Buffer.from(child).toString("hex") : child,
  );
}

function digest(value: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(value).digest());
}

async function recordGenerationEvent(
  transaction: PGliteTransaction,
  generationId: number,
  eventKind: "created" | "validated" | "switched" | "knowledge",
  commitId: Uint8Array,
): Promise<void> {
  const existing = await first(
    transaction,
    `SELECT 1 FROM projection_generation_provenance
      WHERE generation_id = ? AND event_kind = ?
        AND event_source = 'routine' AND commit_id = ?`,
    [generationId, eventKind, commitId],
  );
  if (existing) return;
  const previous = await first<{ event_id: unknown; ordinal: number | string }>(
    transaction,
    `SELECT event_id, ordinal FROM projection_generation_provenance
      WHERE generation_id = ? ORDER BY ordinal DESC LIMIT 1`,
    [generationId],
  );
  const ordinal = Number(previous?.ordinal ?? 0) + 1;
  const eventId = uuidBytes();
  const eventDigest = digest(
    json({
      contract: "pglite/canonical-projection-provenance/v1",
      generationId,
      ordinal,
      eventKind,
      eventSource: "routine",
      commitId: Buffer.from(commitId).toString("hex"),
      previousEventId: previous?.event_id == null
        ? null
        : Buffer.from(bytes(previous.event_id, "Projection event")).toString("hex"),
    }),
  );
  await query(
    transaction,
    `INSERT INTO projection_generation_provenance(
       event_id, generation_id, ordinal, previous_event_id, event_kind,
       event_source, commit_id, event_digest
     ) VALUES (?, ?, ?, ?, ?, 'routine', ?, ?)`,
    [eventId, generationId, ordinal, previous?.event_id ?? null, eventKind, commitId, eventDigest],
  );
}

async function ensureActiveGeneration(
  transaction: PGliteTransaction,
  context: PGliteCanonicalProjectionContext,
): Promise<number> {
  const active = await first<{ generation_id: number | string }>(
    transaction,
    "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1",
  );
  let generationId: number;
  if (active) {
    generationId = Number(active.generation_id);
    await query(
      transaction,
      `UPDATE projection_generations
          SET status = 'active', build_cutoff_commit_sequence = ?,
              validated_commit_id = ?, switched_commit_id = ?
        WHERE generation_id = ?`,
      [context.cutoffSequence, context.commitId, context.commitId, generationId],
    );
  } else {
    const latest = await first<{ generation_id: number | string }>(
      transaction,
      "SELECT COALESCE(MAX(generation_id), 0) AS generation_id FROM projection_generations",
    );
    generationId = Number(latest?.generation_id ?? 0) + 1;
    await query(
      transaction,
      `INSERT INTO projection_generations(
         generation_id, status, build_cutoff_commit_sequence, rule_version,
         created_commit_id, validated_commit_id, switched_commit_id
       ) VALUES (?, 'active', ?, 'canonical/projection/v1', ?, ?, ?)`,
      [
        generationId,
        context.cutoffSequence,
        context.commitId,
        context.commitId,
        context.commitId,
      ],
    );
    await query(
      transaction,
      `INSERT INTO active_projection_generation(singleton_id, generation_id, switched_commit_id)
       VALUES (1, ?, ?)`,
      [generationId, context.commitId],
    );
    await recordGenerationEvent(transaction, generationId, "created", context.commitId);
    await recordGenerationEvent(transaction, generationId, "validated", context.commitId);
    await recordGenerationEvent(transaction, generationId, "switched", context.commitId);
  }
  return generationId;
}

async function createProjectionCommit(
  transaction: PGliteTransaction,
): Promise<Readonly<{ id: Uint8Array; sequence: number }>> {
  const latest = await first<{ sequence: number | string; recorded_at_utc_us: number | string }>(
    transaction,
    `SELECT COALESCE(MAX(commit_sequence), 0) AS sequence,
            COALESCE(MAX(recorded_at_utc_us), 0) AS recorded_at_utc_us
       FROM canonical_commits`,
  );
  const sequence = Number(latest?.sequence ?? 0) + 1;
  const recordedAt = Number(latest?.recorded_at_utc_us ?? 0) + 1;
  const id = uuidBytes();
  await query(
    transaction,
    `INSERT INTO canonical_commits(
       commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind
     ) VALUES (?, ?, ?, 'automatic/pglite-current-projection/v1', 'derived_import')`,
    [id, sequence, recordedAt],
  );
  return { id, sequence };
}

async function resolveAffectedTransactionIds(
  transaction: PGliteTransaction,
  context: PGliteCanonicalProjectionContext,
): Promise<Uint8Array[]> {
  const byText = new Map<string, Uint8Array>();
  const add = (value: unknown, label: string): void => {
    const id = bytes(value, label);
    byText.set(Buffer.from(id).toString("hex"), id);
  };
  for (const id of context.affectedTransactionIds ?? context.transactionIds ?? []) add(id, "Projection transaction");
  const captureIds = context.captureIds ?? [];
  if (captureIds.length > 0) {
    const rows = await query<Row>(
      transaction,
      `SELECT DISTINCT revision.transaction_id
         FROM transaction_revisions revision
        WHERE revision.capture_id IN (${captureIds.map(() => "?").join(",")})`,
      captureIds,
    );
    for (const row of rows) add(row.transaction_id, "Projection transaction");
  }
  const lifecycle = await query<Row>(
    transaction,
    `SELECT DISTINCT transition.transaction_id
       FROM assertion_transitions transition
      WHERE transition.commit_id = ?
        AND transition.event_kind IN ('observed', 'superseded', 'withdrawn')`,
    [context.commitId],
  );
  for (const row of lifecycle) add(row.transaction_id, "Projection lifecycle transaction");
  return [...byText.values()];
}

async function resolveAffectedAccountIds(
  transaction: PGliteTransaction,
  context: PGliteCanonicalProjectionContext,
  transactionIds: readonly Uint8Array[],
): Promise<Uint8Array[]> {
  const clauses: string[] = [];
  const params: Uint8Array[] = [];
  if (transactionIds.length > 0) {
    clauses.push(`account.account_id IN (
      SELECT financial.account_id
        FROM financial_transactions financial
       WHERE financial.transaction_id IN (${inList(transactionIds)})
    )`);
    params.push(...transactionIds);
  }
  const captureIds = context.captureIds ?? [];
  if (captureIds.length > 0) {
    clauses.push(`account.account_id IN (
      SELECT scope.account_id
        FROM capture_scopes scope
       WHERE scope.capture_id IN (${inList(captureIds)})
    )`);
    params.push(...captureIds);
  }
  if (clauses.length === 0) return [];
  const rows = await query<Row>(
    transaction,
    `SELECT DISTINCT account.account_id
       FROM financial_accounts account
      WHERE ${clauses.join(" OR ")}`,
    params,
  );
  return rows.map((row) => bytes(row.account_id, "Projection account"));
}

function inList(values: readonly Uint8Array[]): string {
  return values.length === 0 ? "NULL" : values.map(() => "?").join(",");
}

async function refreshCurrentTransactions(
  transaction: PGliteTransaction,
  context: PGliteCanonicalProjectionContext,
  affected: readonly Uint8Array[],
): Promise<void> {
  if (affected.length === 0) return;
  await query(
    transaction,
    `DELETE FROM current_transactions
      WHERE transaction_id IN (${inList(affected)})`,
    affected,
  );
  await query(
    transaction,
    `WITH ranked AS (
       SELECT revision.transaction_id, revision.revision_id,
              revision.commit_id AS revision_commit_id,
              revision.source_record_id,
              ROW_NUMBER() OVER (
                PARTITION BY revision.transaction_id
                ORDER BY revision_commit.commit_sequence DESC,
                         revision.revision_number DESC,
                         encode(revision.revision_id, 'hex') DESC
              ) AS rank
         FROM transaction_revisions revision
         JOIN canonical_commits revision_commit
           ON revision_commit.commit_id = revision.commit_id
        WHERE revision_commit.commit_sequence <= ?
          AND revision.transaction_id IN (${inList(affected)})
     ), selected AS (
       SELECT ranked.*
         FROM ranked
        WHERE ranked.rank = 1
          AND EXISTS (
            SELECT 1
              FROM assertions source_assertion
              JOIN canonical_commits assertion_commit
                ON assertion_commit.commit_id = source_assertion.created_commit_id
             WHERE source_assertion.origin = 'source'
               AND source_assertion.field_name = 'transaction_revision'
               AND source_assertion.revision_id = ranked.revision_id
               AND assertion_commit.commit_sequence <= ?
               AND COALESCE((
                 SELECT transition.event_kind
                   FROM assertion_transitions transition
                   JOIN canonical_commits transition_commit
                     ON transition_commit.commit_id = transition.commit_id
                  WHERE transition.assertion_id = source_assertion.assertion_id
                    AND transition_commit.commit_sequence <= ?
                  ORDER BY transition_commit.commit_sequence DESC,
                           encode(transition.event_id, 'hex') DESC
                  LIMIT 1
               ), 'observed') NOT IN ('withdrawn', 'superseded')
          )
     )
     INSERT INTO current_transactions(
       transaction_id, revision_id, commit_id, projection_commit_id, revision_commit_id
     )
     SELECT transaction_id, revision_id, ?, ?, revision_commit_id
       FROM selected`,
    [context.cutoffSequence, ...affected, context.cutoffSequence, context.cutoffSequence, context.commitId, context.commitId],
  );
}

async function refreshCurrentFields(
  transaction: PGliteTransaction,
  context: PGliteCanonicalProjectionContext,
  affected: readonly Uint8Array[],
): Promise<void> {
  if (affected.length === 0) return;
  await query(
    transaction,
    `DELETE FROM current_transaction_fields
      WHERE transaction_id IN (${inList(affected)})`,
    affected,
  );
  await query(
    transaction,
    `WITH candidates AS (
       SELECT assertion.transaction_id, assertion.field_name, assertion.value_text,
              assertion.origin, assertion.assertion_id,
              ROW_NUMBER() OVER (
                PARTITION BY assertion.transaction_id, assertion.field_name
                ORDER BY CASE WHEN assertion.origin = 'user' THEN 0 ELSE 1 END,
                         commit_row.commit_sequence DESC,
                         encode(assertion.assertion_id, 'hex') DESC
              ) AS rank
         FROM assertions assertion
         JOIN canonical_commits commit_row
           ON commit_row.commit_id = assertion.created_commit_id
        WHERE assertion.field_name IN ('display_name', 'note')
          AND assertion.transaction_id IN (${inList(affected)})
          AND commit_row.commit_sequence <= ?
          AND COALESCE((
            SELECT transition.event_kind
              FROM assertion_transitions transition
              JOIN canonical_commits transition_commit
                ON transition_commit.commit_id = transition.commit_id
             WHERE transition.assertion_id = assertion.assertion_id
               AND transition_commit.commit_sequence <= ?
             ORDER BY transition_commit.commit_sequence DESC,
                      encode(transition.event_id, 'hex') DESC
             LIMIT 1
          ), 'observed') NOT IN ('withdrawn', 'superseded')
     )
     INSERT INTO current_transaction_fields(
       transaction_id, field_name, value_text, origin,
       derived_assertion_id, user_assertion_id, projection_commit_id
     )
     SELECT transaction_id, field_name, value_text, origin,
            CASE WHEN origin = 'derived' THEN assertion_id ELSE NULL END,
            CASE WHEN origin = 'user' THEN assertion_id ELSE NULL END,
            ?
       FROM candidates
      WHERE rank = 1`,
    [ ...affected, context.cutoffSequence, context.cutoffSequence, context.commitId],
  );
}

/**
 * Reselects the active user categorization of each affected transaction into
 * the generation.  A single category follows the transaction; an allocation is
 * kept only while its booked total still equals the current revision's amount,
 * so a revision that changes the amount drops the allocation instead of
 * exposing a partial one.
 */
export async function refreshGenerationTransactionCategorizations(
  transaction: PGliteTransaction,
  generationId: number,
  affected: readonly Uint8Array[],
  projectionCommitId: Uint8Array,
): Promise<void> {
  if (affected.length === 0) return;
  await query(
    transaction,
    `DELETE FROM projection_generation_transaction_categorizations
      WHERE generation_id = ?
        AND transaction_id IN (${inList(affected)})`,
    [generationId, ...affected],
  );
  await query(
    transaction,
    `WITH active_user AS (
       SELECT assertion.assertion_id, assertion.transaction_id,
              ROW_NUMBER() OVER (
                PARTITION BY assertion.transaction_id
                ORDER BY created.commit_sequence DESC, encode(assertion.assertion_id, 'hex') DESC
              ) AS rank
         FROM assertions assertion
         JOIN canonical_commits created ON created.commit_id = assertion.created_commit_id
        WHERE assertion.target_kind = 'transaction'
          AND assertion.field_name = 'category'
          AND assertion.origin = 'user'
          AND assertion.transaction_id IN (${inList(affected)})
          AND COALESCE((
            SELECT transition.event_kind
              FROM assertion_transitions transition
              JOIN canonical_commits event_commit ON event_commit.commit_id = transition.commit_id
             WHERE transition.assertion_id = assertion.assertion_id
             ORDER BY event_commit.commit_sequence DESC, encode(transition.event_id, 'hex') DESC
             LIMIT 1
          ), 'observed') NOT IN ('withdrawn', 'superseded')
     ), selected AS (
       SELECT active_user.assertion_id, active_user.transaction_id,
              generation_row.revision_id, revision.amount_coefficient, revision.amount_scale, revision.currency
         FROM active_user
         JOIN projection_generation_transactions generation_row
           ON generation_row.generation_id = ? AND generation_row.transaction_id = active_user.transaction_id
         JOIN transaction_revisions revision ON revision.revision_id = generation_row.revision_id
        WHERE active_user.rank = 1
     )
     INSERT INTO projection_generation_transaction_categorizations(
       generation_id, transaction_id, revision_id, assertion_id, mode, category_code,
       taxonomy_id, taxonomy_version, allocation_set_id, component_ordinal,
       amount_coefficient, amount_scale, amount_currency,
       booked_coefficient, booked_scale, booked_currency,
       conversion_evidence_kind, conversion_evidence_id, conversion_from_currency,
       conversion_to_currency, conversion_evidence_json, conversion_id, projection_commit_id
     )
     SELECT ?::bigint, selected.transaction_id, selected.revision_id, value.assertion_id, 'single', value.category_code,
            value.taxonomy_id, value.taxonomy_version, NULL, 0,
            NULL, NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, ?::bytea
       FROM selected
       JOIN transaction_categorization_values value ON value.assertion_id = selected.assertion_id
      WHERE value.mode = 'single'
     UNION ALL
     SELECT ?::bigint, selected.transaction_id, selected.revision_id, value.assertion_id, 'allocated', component.category_code,
            component.taxonomy_id, component.taxonomy_version, component.allocation_set_id, component.component_ordinal,
            component.amount_coefficient, component.amount_scale, component.amount_currency,
            component.booked_coefficient, component.booked_scale, component.booked_currency,
            component.conversion_evidence_kind, component.conversion_evidence_id, component.conversion_from_currency,
            component.conversion_to_currency, component.conversion_evidence_json, component.conversion_id, ?::bytea
       FROM selected
       JOIN transaction_categorization_values value ON value.assertion_id = selected.assertion_id
       JOIN category_allocation_sets allocation ON allocation.allocation_set_id = value.allocation_set_id
       JOIN category_allocation_components component ON component.allocation_set_id = allocation.allocation_set_id
      WHERE value.mode = 'allocated'
        AND allocation.booked_currency = selected.currency
        AND allocation.booked_coefficient::numeric * power(10::numeric, -allocation.booked_scale)
          = selected.amount_coefficient::numeric * power(10::numeric, -selected.amount_scale)`,
    [...affected, generationId, generationId, projectionCommitId, generationId, projectionCommitId],
  );
}

async function syncGenerationTransactions(
  transaction: PGliteTransaction,
  generationId: number,
  affected: readonly Uint8Array[],
  projectionCommitId: Uint8Array,
): Promise<void> {
  if (affected.length === 0) return;
  for (const table of [
    "projection_generation_transaction_categorizations",
    "projection_generation_transaction_fields",
    "projection_generation_transaction_selection",
    "projection_generation_transactions",
  ]) {
    await query(
      transaction,
      `DELETE FROM ${table}
        WHERE generation_id = ?
          AND transaction_id IN (${inList(affected)})`,
      [generationId, ...affected],
    );
  }
  await query(
    transaction,
    `INSERT INTO projection_generation_transactions(
       generation_id, transaction_id, revision_id, projection_commit_id, revision_commit_id
     )
     SELECT ?, current_row.transaction_id, current_row.revision_id,
            current_row.projection_commit_id, current_row.revision_commit_id
       FROM current_transactions current_row
      WHERE current_row.transaction_id IN (${inList(affected)})`,
    [generationId, ...affected],
  );
  await query(
    transaction,
    `INSERT INTO projection_generation_transaction_selection(
       generation_id, transaction_id, revision_id, selection_commit_id, selection_kind
     )
     SELECT ?, current_row.transaction_id, current_row.revision_id,
            current_row.projection_commit_id, 'source_lifecycle'
       FROM current_transactions current_row
      WHERE current_row.transaction_id IN (${inList(affected)})`,
    [generationId, ...affected],
  );
  await query(
    transaction,
    `INSERT INTO projection_generation_transaction_fields(
       generation_id, transaction_id, field_name, value_text, origin,
       derived_assertion_id, user_assertion_id, projection_commit_id
     )
     SELECT ?, field.transaction_id, field.field_name, field.value_text, field.origin,
            field.derived_assertion_id, field.user_assertion_id, field.projection_commit_id
       FROM current_transaction_fields field
      WHERE field.transaction_id IN (${inList(affected)})`,
    [generationId, ...affected],
  );
  await refreshGenerationTransactionCategorizations(transaction, generationId, affected, projectionCommitId);
}

async function updateGenerationKnowledge(
  transaction: PGliteTransaction,
  generationId: number,
  context: PGliteCanonicalProjectionContext,
): Promise<void> {
  await query(
    transaction,
    `UPDATE projection_generations
        SET build_cutoff_commit_sequence = ?
      WHERE generation_id = ?`,
    [context.cutoffSequence, generationId],
  );
  await recordGenerationEvent(transaction, generationId, "knowledge", context.commitId);
}

async function refreshCurrentAccountsAndBalances(
  transaction: PGliteTransaction,
  generationId: number,
  context: PGliteCanonicalProjectionContext,
  affectedAccounts: readonly Uint8Array[],
): Promise<void> {
  if (affectedAccounts.length === 0) return;
  for (const table of [
    "current_depository_balance_observations",
    "current_credit_card_balance_observations",
    "current_loan_balance_observations",
    "current_depository_accounts",
    "current_credit_card_accounts",
    "current_loan_accounts",
  ]) {
    await query(
      transaction,
      `DELETE FROM ${table} WHERE account_id IN (${inList(affectedAccounts)})`,
      affectedAccounts,
    );
  }
  await query(
    transaction,
    `INSERT INTO current_depository_accounts(generation_id, account_id, projection_commit_id, created_commit_id)
     SELECT ?, account.account_id, ?, account.created_commit_id
       FROM financial_accounts account
       JOIN canonical_commits created ON created.commit_id = account.created_commit_id
      WHERE account.account_type = 'depository'
        AND account.stream IN ('domestic-deposit', 'foreign-currency-deposit')
        AND account.account_id IN (${inList(affectedAccounts)})
        AND created.commit_sequence <= ?`,
    [generationId, context.commitId, ...affectedAccounts, context.cutoffSequence],
  );
  await query(
    transaction,
    `INSERT INTO current_credit_card_accounts(generation_id, account_id, projection_commit_id, created_commit_id)
     SELECT ?, account.account_id, ?, account.created_commit_id
       FROM financial_accounts account
       JOIN canonical_commits created ON created.commit_id = account.created_commit_id
      WHERE account.account_type = 'credit'
        AND account.stream = 'credit-card'
        AND account.account_id IN (${inList(affectedAccounts)})
        AND created.commit_sequence <= ?`,
    [generationId, context.commitId, ...affectedAccounts, context.cutoffSequence],
  );
  await query(
    transaction,
    `INSERT INTO current_loan_accounts(generation_id, account_id, projection_commit_id, created_commit_id)
     SELECT ?, account.account_id, ?, account.created_commit_id
       FROM financial_accounts account
       JOIN canonical_commits created ON created.commit_id = account.created_commit_id
      WHERE account.account_type = 'loan'
        AND account.stream = 'loan'
        AND account.account_id IN (${inList(affectedAccounts)})
        AND created.commit_sequence <= ?`,
    [generationId, context.commitId, ...affectedAccounts, context.cutoffSequence],
  );
  await query(
    transaction,
    `WITH ranked AS (
       SELECT observation.account_id, observation.balance_kind,
              revision.currency, observation.observation_id, revision.revision_id,
              revision.commit_id, ROW_NUMBER() OVER (
                PARTITION BY observation.account_id, observation.balance_kind, revision.currency
                ORDER BY revision.effective_at DESC, commit_row.commit_sequence DESC,
                         revision.revision_number DESC,
                         encode(revision.revision_id, 'hex') DESC
              ) AS rank
         FROM balance_observations observation
         JOIN balance_observation_revisions revision
           ON revision.observation_id = observation.observation_id
         JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
         JOIN financial_accounts account ON account.account_id = observation.account_id
        WHERE account.account_type = 'depository'
          AND account.stream IN ('domestic-deposit', 'foreign-currency-deposit')
          AND observation.account_id IN (${inList(affectedAccounts)})
          AND observation.balance_kind IN ('ledger', 'available')
          AND commit_row.commit_sequence <= ?
     )
     INSERT INTO current_depository_balance_observations(
       generation_id, account_id, balance_kind, currency, observation_id, revision_id,
       projection_commit_id, revision_commit_id
     )
     SELECT ?, account_id, balance_kind, currency, observation_id, revision_id,
            ?, commit_id
       FROM ranked WHERE rank = 1`,
    [...affectedAccounts, context.cutoffSequence, generationId, context.commitId],
  );
  await query(
    transaction,
    `WITH ranked AS (
       SELECT observation.account_id, observation.balance_kind,
              revision.currency, observation.observation_id, revision.revision_id,
              revision.commit_id, detail.estimate_kind, detail.estimate_basis,
              detail.formula, detail.component_limit_coefficient,
              detail.component_limit_scale, detail.component_available_coefficient,
              detail.component_available_scale,
              ROW_NUMBER() OVER (
                PARTITION BY observation.account_id, observation.balance_kind, revision.currency
                ORDER BY revision.effective_at DESC, commit_row.commit_sequence DESC,
                         revision.revision_number DESC,
                         encode(revision.revision_id, 'hex') DESC
              ) AS rank
         FROM balance_observations observation
         JOIN balance_observation_revisions revision
           ON revision.observation_id = observation.observation_id
         JOIN credit_card_balance_estimate_details detail
           ON detail.revision_id = revision.revision_id
         JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
         JOIN financial_accounts account ON account.account_id = observation.account_id
        WHERE account.account_type = 'credit'
          AND account.stream = 'credit-card'
          AND observation.account_id IN (${inList(affectedAccounts)})
          AND observation.balance_kind = 'credit_used'
          AND commit_row.commit_sequence <= ?
     )
     INSERT INTO current_credit_card_balance_observations(
       generation_id, account_id, balance_kind, currency, observation_id, revision_id,
       estimate_kind, estimate_basis, estimate_formula,
       component_limit_coefficient, component_limit_scale,
       component_available_coefficient, component_available_scale,
       projection_commit_id, revision_commit_id
     )
     SELECT ?, account_id, balance_kind, currency, observation_id, revision_id,
            estimate_kind, estimate_basis, formula,
            component_limit_coefficient, component_limit_scale,
            component_available_coefficient, component_available_scale,
            ?, commit_id
       FROM ranked WHERE rank = 1`,
    [...affectedAccounts, context.cutoffSequence, generationId, context.commitId],
  );
  await query(
    transaction,
    `WITH ranked AS (
       SELECT observation.account_id, observation.balance_kind,
              observation.observation_id, revision.revision_id, revision.commit_id,
              ROW_NUMBER() OVER (
                PARTITION BY observation.account_id, observation.balance_kind
                ORDER BY revision.effective_at DESC, commit_row.commit_sequence DESC,
                         revision.revision_number DESC,
                         encode(revision.revision_id, 'hex') DESC
              ) AS rank
         FROM balance_observations observation
         JOIN balance_observation_revisions revision
           ON revision.observation_id = observation.observation_id
         JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
         JOIN financial_accounts account ON account.account_id = observation.account_id
        WHERE account.account_type = 'loan'
          AND account.stream = 'loan'
          AND observation.account_id IN (${inList(affectedAccounts)})
          AND commit_row.commit_sequence <= ?
     )
     INSERT INTO current_loan_balance_observations(
       generation_id, account_id, balance_kind, observation_id, revision_id,
       projection_commit_id, revision_commit_id
     )
     SELECT ?, account_id, balance_kind, observation_id, revision_id, ?, commit_id
       FROM ranked WHERE rank = 1`,
    [...affectedAccounts, context.cutoffSequence, generationId, context.commitId],
  );
}

async function readCurrentTransactions(
  transaction: PGliteTransaction,
  filter?: readonly Uint8Array[],
): Promise<PGliteProjectionTransaction[]> {
  const filterSql = filter && filter.length > 0
    ? `WHERE current_row.transaction_id IN (${inList(filter)})`
    : "";
  const rows = await query<Row>(
    transaction,
    `SELECT current_row.transaction_id, revision.source_record_id,
            revision.direction, revision.amount_coefficient, revision.amount_scale,
            revision.currency, revision.effective_on, revision.description,
            source_record.payload_json AS source_payload,
            connection.integration_namespace,
            account.stream, connection.source_connection_key,
            epoch.epoch_key AS identity_epoch
       FROM current_transactions current_row
       JOIN transaction_revisions revision
         ON revision.revision_id = current_row.revision_id
       JOIN financial_transactions financial
         ON financial.transaction_id = current_row.transaction_id
       JOIN financial_accounts account ON account.account_id = financial.account_id
       JOIN source_connections connection
         ON connection.source_connection_id = account.source_connection_id
       JOIN identity_epochs epoch ON epoch.identity_epoch_id = account.identity_epoch_id
       JOIN source_records source_record
         ON source_record.source_record_id = revision.source_record_id
        AND source_record.capture_id = revision.capture_id
      ${filterSql}
      ORDER BY encode(current_row.transaction_id, 'hex')`,
    filter && filter.length > 0 ? filter : [],
  );
  return rows.map((row) => ({
    transactionId: idText(row.transaction_id, "Projection transaction"),
    sourceRecordId: idText(row.source_record_id, "Projection source record"),
    direction: String(row.direction) as "inflow" | "outflow",
    amountCoefficient: String(row.amount_coefficient),
    amountScale: Number(row.amount_scale),
    currency: String(row.currency),
    effectiveOn: String(row.effective_on),
    description: row.description == null ? null : String(row.description),
    sourcePayload: row.source_payload == null ? null : String(row.source_payload),
    integrationNamespace: String(row.integration_namespace),
    stream: String(row.stream),
    sourceConnectionKey: String(row.source_connection_key),
    identityEpoch: String(row.identity_epoch),
  }));
}

function exactAmountKey(coefficient: string, scale: number): string {
  let digits = coefficient;
  let normalizedScale = scale;
  while (normalizedScale > 0 && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    normalizedScale -= 1;
  }
  return `${BigInt(digits).toString()}:${normalizedScale}`;
}

async function relationMap(
  transaction: PGliteTransaction,
  rows: readonly PGliteProjectionTransaction[],
  cutoffSequence: number,
): Promise<Map<string, PGliteProjectionRelations>> {
  const result = new Map<string, PGliteProjectionRelations>();
  const add = (id: string, update: Partial<PGliteProjectionRelations>) => {
    result.set(id, { ...(result.get(id) ?? {}), ...update });
  };
  const funding = await query<Row>(
    transaction,
    `SELECT relation.funding_transaction_id, relation.direction
       FROM investment_funding_relations relation
      WHERE COALESCE((
        SELECT event.event_kind
          FROM investment_funding_relation_events event
          JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
         WHERE event.relation_id = relation.relation_id
           AND event_commit.commit_sequence <= ?
         ORDER BY event_commit.commit_sequence DESC,
                  encode(event.event_id, 'hex') DESC
         LIMIT 1
      ), 'withdrawn') = 'observed'`,
    [cutoffSequence],
  );
  for (const row of funding)
    add(idText(row.funding_transaction_id, "Funding transaction"), {
      investmentFundingDirection: String(row.direction) as "inflow" | "outflow",
    });
  const loans = await query<Row>(
    transaction,
    `SELECT DISTINCT member.transaction_id
       FROM loan_repayment_settlement_group_members member
       JOIN loan_repayment_settlement_groups group_row
         ON group_row.settlement_group_id = member.settlement_group_id
      WHERE member.member_kind = 'deposit_outflow'
        AND COALESCE((
          SELECT event.event_kind
            FROM loan_repayment_relation_events event
            JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
           WHERE event.settlement_group_id = group_row.settlement_group_id
             AND event_commit.commit_sequence <= ?
           ORDER BY event_commit.commit_sequence DESC,
                    encode(event.event_id, 'hex') DESC
           LIMIT 1
        ), 'withdrawn') NOT IN ('withdrawn', 'superseded')`,
    [cutoffSequence],
  );
  for (const row of loans)
    add(idText(row.transaction_id, "Loan repayment transaction"), { activeLoanRepayment: true });
  const statementRows = await query<Row>(
    transaction,
    `SELECT statement.statement_id, revision.statement_revision_id,
            revision.issue_date, revision.due_date, revision.currency,
            revision.balance_coefficient, revision.balance_scale
       FROM canonical_credit_card_statements statement
       JOIN canonical_credit_card_statement_revisions revision
         ON revision.statement_id = statement.statement_id
      WHERE revision.revision_number = (
        SELECT MAX(latest.revision_number)
          FROM canonical_credit_card_statement_revisions latest
         WHERE latest.statement_id = revision.statement_id
      )`,
  );
  const statements = statementRows.map((row) => ({
    id: idText(row.statement_revision_id, "Credit-card statement revision"),
    issueDate: String(row.issue_date),
    dueDate: String(row.due_date),
    currency: String(row.currency),
    amount: exactAmountKey(String(row.balance_coefficient), Number(row.balance_scale)),
  }));
  for (const row of rows) {
    if (row.stream !== "domestic-deposit" && row.stream !== "foreign-currency-deposit") continue;
    if (row.direction !== "outflow") continue;
    const amount = exactAmountKey(row.amountCoefficient, row.amountScale);
    const matching = statements.filter((statement) =>
      statement.currency === row.currency &&
      row.effectiveOn >= statement.issueDate &&
      row.effectiveOn <= statement.dueDate &&
      statement.amount === amount,
    );
    if (matching.length === 1)
      add(row.transactionId, { creditCardStatementRevisionId: matching[0]!.id });
  }
  return result;
}

async function refreshCurrentEnrichment(
  transaction: PGliteTransaction,
  context: PGliteCanonicalProjectionContext,
  rows: readonly PGliteProjectionTransaction[],
  affected: readonly Uint8Array[],
): Promise<PGliteCanonicalProjectionContext> {
  const refreshAll = context.refreshEnrichmentAll === true;
  const prior = await query<Row>(
    transaction,
    `SELECT transaction_id, assertion_id, value_text, route_id
       FROM current_transaction_enrichment
      WHERE field_name = 'kind' AND origin = 'derived'
        ${refreshAll ? "" : `AND transaction_id IN (${inList(affected)})`}`,
    refreshAll ? [] : affected,
  );
  const priorByTransaction = new Map(
    prior.map((row) => [idText(row.transaction_id, "Prior enrichment transaction"), row]),
  );
  const sourceKinds = await query<Row>(
    transaction,
    `SELECT DISTINCT ON (assertion.transaction_id)
            assertion.transaction_id, assertion.assertion_id
       FROM assertions assertion
       JOIN canonical_commits created ON created.commit_id = assertion.created_commit_id
      WHERE assertion.origin = 'source'
        AND assertion.field_name = 'kind'
        ${refreshAll ? "" : `AND assertion.transaction_id IN (${inList(affected)})`}
        AND created.commit_sequence <= ?
        AND EXISTS (
          SELECT 1 FROM assertion_provenance provenance
           WHERE provenance.assertion_id = assertion.assertion_id
             AND provenance.source_record_id IS NOT NULL
        )
        AND COALESCE((
          SELECT transition.event_kind
            FROM assertion_transitions transition
            JOIN canonical_commits event_commit ON event_commit.commit_id = transition.commit_id
           WHERE transition.assertion_id = assertion.assertion_id
             AND event_commit.commit_sequence <= ?
           ORDER BY event_commit.commit_sequence DESC,
                    encode(transition.event_id, 'hex') DESC
           LIMIT 1
        ), 'observed') NOT IN ('withdrawn', 'superseded')
      ORDER BY assertion.transaction_id, created.commit_sequence DESC,
               encode(assertion.assertion_id, 'hex') DESC`,
    refreshAll ? [context.cutoffSequence, context.cutoffSequence] : [
      ...affected,
      context.cutoffSequence,
      context.cutoffSequence,
    ],
  );
  const sourceKindIds = new Set(sourceKinds.map((row) => idText(row.transaction_id, "Source kind transaction")));
  const relations = await relationMap(transaction, rows, context.cutoffSequence);
  const pending = rows.flatMap((row) => {
    if (sourceKindIds.has(row.transactionId)) return [];
    const kind = row.integrationNamespace === "cathay"
      ? derivePGliteCathayDescriptionKind(row)
      : derivePGliteTransactionKind(row, relations.get(row.transactionId));
    if (!kind) return [];
    const previous = priorByTransaction.get(row.transactionId);
    if (
      kind.outputState !== "unsupported" &&
      previous &&
      String(previous.value_text) === kind.value &&
      String(previous.route_id) === kind.routeId
    )
      return [];
    return [{ row, kind, previous }];
  });

  let projectionContext = context;
  if (pending.length > 0) {
    const projectionCommit = await createProjectionCommit(transaction);
    projectionContext = {
      ...context,
      commitId: projectionCommit.id,
      cutoffSequence: projectionCommit.sequence,
    };
  }

  if (refreshAll) {
    await query(transaction, "DELETE FROM current_transaction_enrichment");
  } else if (affected.length > 0) {
    await query(
      transaction,
      `DELETE FROM current_transaction_enrichment
        WHERE transaction_id IN (${inList(affected)})`,
      affected,
    );
  }
  const groups = new Map<string, typeof pending>();
  for (const item of pending) {
    const key = [item.kind.producerId, item.kind.producerVersion, item.row.integrationNamespace, item.row.stream, item.row.sourceConnectionKey, item.row.identityEpoch].join("\u0000");
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  }
  for (const items of groups.values()) {
    const firstItem = items[0]!;
    const runId = uuidBytes();
    await query(
      transaction,
      `INSERT INTO enrichment_runs(
         run_id, source_connection_id, identity_epoch_id, stream,
         producer_id, producer_version, origin, rule_lineage, observed_at,
         commit_id, status, complete_scope
       )
       SELECT ?, account.source_connection_id, account.identity_epoch_id, ?, ?, ?, 'derived', ?, capture.observed_at, ?, 'complete', 1
         FROM financial_transactions financial
         JOIN financial_accounts account ON account.account_id = financial.account_id
         JOIN source_captures capture ON capture.capture_id = (
           SELECT revision.capture_id FROM transaction_revisions revision
            WHERE revision.transaction_id = financial.transaction_id
            ORDER BY revision.revision_number DESC LIMIT 1
         )
        WHERE financial.transaction_id = ?
        LIMIT 1`,
      [
        runId,
        firstItem.row.stream,
        firstItem.kind.producerId,
        firstItem.kind.producerVersion,
        firstItem.kind.ruleLineage,
        projectionContext.commitId,
        Uint8Array.from(Buffer.from(firstItem.row.transactionId.replaceAll("-", ""), "hex")),
      ],
    );
    for (const item of items) {
      const transactionId = Uint8Array.from(Buffer.from(item.row.transactionId.replaceAll("-", ""), "hex"));
      const sourceRecordId = Uint8Array.from(Buffer.from(item.row.sourceRecordId.replaceAll("-", ""), "hex"));
      const provenance = json({
        evidenceKind: item.kind.evidenceKind,
        sourceRecordId: item.row.sourceRecordId,
        sourceField: item.kind.sourceField,
        sourceValue: item.kind.sourceValue,
        contractVersion: item.kind.contractVersion,
      });
      if (item.kind.outputState === "unsupported") {
        await query(
          transaction,
          `INSERT INTO enrichment_run_outputs(
             output_id, run_id, transaction_id, field_name, output_state, origin,
             value_text, confidence_basis_points, route_id, source_record_id,
             source_field, source_value_text, provenance_json, assertion_id, commit_id
           ) VALUES (?, ?, ?, 'kind', 'unsupported', NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?)`,
          [
            uuidBytes(),
            runId,
            transactionId,
            item.kind.routeId,
            sourceRecordId,
            item.kind.sourceField,
            item.kind.sourceValue,
            provenance,
            projectionContext.commitId,
          ],
        );
        if (item.previous) {
          const previousAssertion = bytes(item.previous.assertion_id, "Prior enrichment assertion");
          const previousRun = await first<{ enrichment_run_id: unknown }>(
            transaction,
            `SELECT enrichment_run_id FROM assertion_provenance
               WHERE assertion_id = ? AND enrichment_run_id IS NOT NULL
               ORDER BY commit_id DESC LIMIT 1`,
            [previousAssertion],
          );
          if (previousRun?.enrichment_run_id) {
            await query(
              transaction,
              `INSERT INTO assertion_transitions(
                 event_id, assertion_id, transaction_id, field_name, capture_id,
                 scope_id, run_id, enrichment_run_id, coordinate_id, user_id,
                 commit_id, event_kind
               ) VALUES (?, ?, ?, 'kind', NULL, NULL, NULL, ?, NULL, NULL, ?, 'withdrawn')`,
              [uuidBytes(), previousAssertion, transactionId, runId, projectionContext.commitId],
            );
          }
        }
        continue;
      }
      const assertionId = uuidBytes();
      await query(
        transaction,
        `INSERT INTO assertions(
           assertion_id, transaction_id, field_name, target_kind, origin,
           producer_id, rule_lineage, revision_id, value_text, created_commit_id
         ) VALUES (?, ?, 'kind', 'transaction', 'derived', ?, ?, NULL, ?, ?)`,
        [assertionId, transactionId, item.kind.producerId, item.kind.ruleLineage, item.kind.value, projectionContext.commitId],
      );
      await query(
        transaction,
        `INSERT INTO enrichment_run_outputs(
           output_id, run_id, transaction_id, field_name, output_state, origin,
           value_text, confidence_basis_points, route_id, source_record_id,
           source_field, source_value_text, provenance_json, assertion_id, commit_id
         ) VALUES (?, ?, ?, 'kind', 'supported', 'derived', ?, 10000, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidBytes(), runId, transactionId, item.kind.value, item.kind.routeId, null, item.kind.sourceField, item.kind.sourceValue, provenance, assertionId, projectionContext.commitId],
      );
      await query(
        transaction,
        `INSERT INTO assertion_provenance(
           assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id
         ) VALUES (?, NULL, NULL, ?, NULL, ?)`,
        [assertionId, runId, projectionContext.commitId],
      );
      await query(
        transaction,
        `INSERT INTO assertion_transitions(
           event_id, assertion_id, transaction_id, field_name, capture_id,
           scope_id, run_id, enrichment_run_id, coordinate_id, user_id,
           commit_id, event_kind
         ) VALUES (?, ?, ?, 'kind', NULL, NULL, NULL, ?, NULL, NULL, ?, 'observed')`,
        [uuidBytes(), assertionId, transactionId, runId, projectionContext.commitId],
      );
      await query(
        transaction,
        `INSERT INTO enrichment_taxonomy_assertion_values(
           assertion_id, field_name, taxonomy_id, taxonomy_version,
           taxonomy_dimension, taxonomy_code, route_id, run_id,
           source_record_id, provenance_json
         ) VALUES (?, 'kind', 'transaction-taxonomy', 'v1', 'kind', ?, ?, ?, ?, ?)`,
        [assertionId, item.kind.value, item.kind.routeId, runId, null, provenance],
      );
      if (item.previous) {
        const previousAssertion = bytes(item.previous.assertion_id, "Prior enrichment assertion");
        const previousRun = await first<{ enrichment_run_id: unknown }>(
          transaction,
          `SELECT enrichment_run_id FROM assertion_provenance
             WHERE assertion_id = ? AND enrichment_run_id IS NOT NULL
             ORDER BY commit_id DESC LIMIT 1`,
          [previousAssertion],
        );
        if (previousRun?.enrichment_run_id) {
          await query(
            transaction,
            `INSERT INTO assertion_transitions(
               event_id, assertion_id, transaction_id, field_name, capture_id,
               scope_id, run_id, enrichment_run_id, coordinate_id, user_id,
               commit_id, event_kind
             ) VALUES (?, ?, ?, 'kind', NULL, NULL, NULL, ?, NULL, NULL, ?, 'superseded')`,
            [uuidBytes(), previousAssertion, transactionId, runId, projectionContext.commitId],
          );
        }
      }
    }
  }
  await query(
    transaction,
    `WITH eligible AS (
       SELECT assertion.transaction_id, assertion.field_name, assertion.assertion_id,
              assertion.value_text, assertion.origin, assertion.producer_id,
              route.producer_version, output.route_id,
              route.taxonomy_id, route.taxonomy_version,
              typed.taxonomy_dimension, typed.taxonomy_code,
              ROW_NUMBER() OVER (
                PARTITION BY assertion.transaction_id, assertion.field_name
                ORDER BY CASE WHEN assertion.origin = 'source' THEN 0 ELSE 1 END,
                         created.commit_sequence DESC,
                         encode(assertion.assertion_id, 'hex') DESC
              ) AS rank
         FROM assertions assertion
         JOIN canonical_commits created ON created.commit_id = assertion.created_commit_id
         JOIN enrichment_run_outputs output ON output.assertion_id = assertion.assertion_id
          AND output.output_state = 'supported'
         JOIN enrichment_runs run ON run.run_id = output.run_id
         JOIN automatic_enrichment_authority_routes route ON route.route_id = output.route_id
         LEFT JOIN enrichment_taxonomy_assertion_values typed
           ON typed.assertion_id = assertion.assertion_id
        WHERE assertion.target_kind = 'transaction'
          AND created.commit_sequence <= ?
          ${refreshAll ? "" : `AND assertion.transaction_id IN (${inList(affected)})`}
          AND route.valid_from_commit_sequence <= ?
          AND (route.valid_to_commit_sequence IS NULL OR ? < route.valid_to_commit_sequence)
          AND COALESCE((
            SELECT transition.event_kind
              FROM assertion_transitions transition
              JOIN canonical_commits event_commit ON event_commit.commit_id = transition.commit_id
             WHERE transition.assertion_id = assertion.assertion_id
               AND event_commit.commit_sequence <= ?
             ORDER BY event_commit.commit_sequence DESC,
                      encode(transition.event_id, 'hex') DESC
             LIMIT 1
          ), 'observed') NOT IN ('withdrawn', 'superseded')
      )
      INSERT INTO current_transaction_enrichment(
        transaction_id, field_name, assertion_id, value_text, origin,
        producer_id, producer_version, route_id, taxonomy_id, taxonomy_version,
        taxonomy_dimension, taxonomy_code, projection_commit_id
      )
      SELECT transaction_id, field_name, assertion_id, value_text, origin,
             producer_id, producer_version, route_id, taxonomy_id, taxonomy_version,
             taxonomy_dimension, COALESCE(taxonomy_code, value_text), ?
        FROM eligible
       WHERE rank = 1`,
    refreshAll ? [projectionContext.cutoffSequence, projectionContext.cutoffSequence, projectionContext.cutoffSequence, projectionContext.cutoffSequence, projectionContext.commitId] : [
      projectionContext.cutoffSequence,
      ...affected,
      projectionContext.cutoffSequence,
      projectionContext.cutoffSequence,
      projectionContext.cutoffSequence,
      projectionContext.commitId,
    ],
  );
  return projectionContext;
}

/**
 * Rebuilds the authoritative current transaction and enrichment rows in the
 * caller-owned PGlite transaction.  The immutable source spine remains the
 * selector; this routine only refreshes read accelerators and can therefore
 * safely be retried or rolled back with its source commit.
 */
export async function refreshPGliteCurrentProjectionInTransaction(
  transaction: PGliteTransaction,
  context: PGliteCanonicalProjectionContext,
): Promise<void> {
  if (!Number.isSafeInteger(context.cutoffSequence) || context.cutoffSequence < 0)
    throw new Error("PGlite projection cutoff must be a non-negative safe integer.");
  // Keep planner statistics current at the source-commit boundary. Imports
  // append lifecycle and enrichment history in bursts;
  // stale estimates can turn these joins into minutes of nested-loop scans.
  // Analyze the selector tables inside the owning transaction, before planning
  // projections. This changes optimizer metadata, not canonical facts.
  await query(transaction, `ANALYZE canonical_commits, transaction_revisions,
    assertions, assertion_transitions, enrichment_run_outputs, enrichment_runs,
    enrichment_taxonomy_assertion_values, automatic_enrichment_authority_routes`);
  const generationId = await ensureActiveGeneration(transaction, context);
  const affected = await resolveAffectedTransactionIds(transaction, context);
  const affectedAccounts = await resolveAffectedAccountIds(transaction, context, affected);
  await refreshCurrentTransactions(transaction, context, affected);
  await refreshCurrentFields(transaction, context, affected);
  await syncGenerationTransactions(transaction, generationId, affected, context.commitId);
  await refreshCurrentAccountsAndBalances(transaction, generationId, context, affectedAccounts);
  const current = await readCurrentTransactions(
    transaction,
    context.refreshEnrichmentAll ? undefined : affected,
  );
  const projectionContext = await refreshCurrentEnrichment(
    transaction,
    { ...context, affectedTransactionIds: affected },
    current,
    affected,
  );
  await updateGenerationKnowledge(transaction, generationId, projectionContext);
  await query(
    transaction,
    `INSERT INTO current_projection_state(generation, commit_id)
     VALUES (1, ?)
     ON CONFLICT (generation) DO UPDATE SET commit_id = EXCLUDED.commit_id`,
    [projectionContext.commitId],
  );
}

export function createPGliteCanonicalProjectionHook(): PGliteCanonicalProjectionHook {
  return refreshPGliteCurrentProjectionInTransaction;
}
