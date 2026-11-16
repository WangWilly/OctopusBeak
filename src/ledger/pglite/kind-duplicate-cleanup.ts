import { createHash } from "node:crypto";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

/**
 * Removes the derived Kind history a refresh bug wrote (ADR 0144), once per
 * store. A refresh for a commit that touched no transaction re-derived every
 * Kind without reading the current one, so each Kind was written again,
 * unchanged, on every such refresh. Some stores hold thousands of identical
 * Kind assertions per transaction.
 *
 * An assertion is removed when it repeats the assertion before it on the same
 * transaction: same producer, rule, route, value, taxonomy code and output
 * provenance, each with exactly one output, and neither was ever superseded,
 * withdrawn or restored. The first of each run is kept, which is the
 * assertion a correct refresh would have kept, and the Kind at every commit
 * stays the same. An unsupported output is removed when it repeats the output
 * before it and no withdrawal rests on it. An assertion a category's
 * provenance names stays.
 *
 * Current rows move onto the run's last kept assertion, the one the Kind
 * selection picks, so no projection commit is written.
 *
 * This only returns space. When it cannot finish, the store keeps every row,
 * the failure is logged, and the store opens as before.
 */
const CLEANUP = "kind-duplicate-cleanup-v1";
/** Recorded once the tables are rewritten, so an interrupted rewrite runs again on the next open. */
const SPACE_RETURNED = "kind-duplicate-cleanup-space-v1";

const HISTORY_TABLES = [
  "enrichment_taxonomy_assertion_values",
  "assertion_transitions",
  "assertion_provenance",
  "enrichment_run_outputs",
  "assertions",
] as const;

const signature = (id: string) => createHash("sha256").update(id).digest("hex");

async function record(transaction: PGliteTransaction | PGliteStore, keys: readonly string[]): Promise<void> {
  for (const key of keys)
    await transaction.query(
      `INSERT INTO pglite_operational_migrations(migration_key, schema_signature) VALUES ($1, $2)
       ON CONFLICT (migration_key) DO NOTHING`,
      [key, signature(key)],
    );
}

export async function applyPgliteKindDuplicateCleanup(store: PGliteStore): Promise<void> {
  const recorded = async (key: string) =>
    (await store.query("SELECT 1 FROM pglite_operational_migrations WHERE migration_key = $1", [key])).rows.length > 0;
  if (!(await recorded(CLEANUP))) {
    try {
      await store.transaction(async (transaction) => {
        const removed = await removeRepeatedKinds(transaction);
        await record(transaction, removed > 0 ? [CLEANUP] : [CLEANUP, SPACE_RETURNED]);
      });
    } catch (error) {
      console.warn("Kind duplicate cleanup skipped; the store keeps its full history.", error);
      await record(store, [CLEANUP, SPACE_RETURNED]);
      return;
    }
  }
  if (await recorded(SPACE_RETURNED)) return;
  // Deleted rows only free space for reuse; rewriting the tables returns it to
  // the disk. VACUUM cannot run inside a transaction.
  try {
    for (const table of HISTORY_TABLES) await store.query(`VACUUM (FULL, ANALYZE) ${table}`);
    await store.query("CHECKPOINT");
    await record(store, [SPACE_RETURNED]);
  } catch (error) {
    console.warn("Kind duplicate cleanup could not return its space yet; the next open tries again.", error);
  }
}

async function removeRepeatedKinds(transaction: PGliteTransaction): Promise<number> {
  await transaction.query(`CREATE TEMP TABLE kind_chain ON COMMIT DROP AS
    WITH named AS (
      SELECT DISTINCT decode(replace(category.provenance_json::jsonb->>'evidenceAssertionId', '-', ''), 'hex') AS assertion_id
        FROM (
          SELECT provenance_json FROM enrichment_run_outputs WHERE field_name = 'category'
          UNION ALL
          SELECT provenance_json FROM enrichment_taxonomy_assertion_values WHERE field_name = 'category'
        ) category
       WHERE replace(category.provenance_json::jsonb->>'evidenceAssertionId', '-', '') ~* '^[0-9a-f]{32}$'
    ),
    outputs AS (
      SELECT assertion_id, count(*) AS output_count, min(run_id) AS run_id,
             min(route_id) AS route_id, min(provenance_json) AS provenance_json
        FROM enrichment_run_outputs
       WHERE assertion_id IS NOT NULL
       GROUP BY assertion_id
    ),
    chain AS (
      SELECT assertion.assertion_id, assertion.transaction_id, created.commit_sequence,
             outputs.output_count IS DISTINCT FROM 1 OR EXISTS (
               SELECT 1 FROM assertion_transitions transition
                WHERE transition.assertion_id = assertion.assertion_id
                  AND transition.event_kind <> 'observed'
             ) AS blocked,
             named.assertion_id IS NOT NULL AS named,
             ROW(assertion.producer_id, assertion.rule_lineage, assertion.value_text,
                 outputs.route_id, outputs.provenance_json,
                 typed.taxonomy_id, typed.taxonomy_version, typed.taxonomy_code,
                 EXISTS (
                   SELECT 1 FROM assertion_provenance provenance
                    WHERE provenance.assertion_id = assertion.assertion_id
                      AND provenance.enrichment_run_id = outputs.run_id
                 )) AS shape
        FROM assertions assertion
        JOIN canonical_commits created ON created.commit_id = assertion.created_commit_id
        LEFT JOIN outputs ON outputs.assertion_id = assertion.assertion_id
        LEFT JOIN enrichment_taxonomy_assertion_values typed ON typed.assertion_id = assertion.assertion_id
        LEFT JOIN named ON named.assertion_id = assertion.assertion_id
       WHERE assertion.origin = 'derived'
         AND assertion.target_kind = 'transaction'
         AND assertion.field_name = 'kind'
    ),
    runs AS (
      SELECT chain.*,
             NOT (shape IS NOT DISTINCT FROM LAG(shape) OVER history
                  AND NOT blocked
                  AND NOT COALESCE(LAG(blocked) OVER history, true)) AS starts_run
        FROM chain
      WINDOW history AS (PARTITION BY transaction_id ORDER BY commit_sequence, encode(assertion_id, 'hex'))
    ),
    marked AS (
      SELECT runs.assertion_id, runs.transaction_id, runs.commit_sequence,
             NOT starts_run AND NOT named AS removable,
             SUM(CASE WHEN starts_run THEN 1 ELSE 0 END) OVER (
               PARTITION BY transaction_id ORDER BY commit_sequence, encode(assertion_id, 'hex')
             ) AS run_number
        FROM runs
    ),
    kept AS (
      SELECT DISTINCT ON (transaction_id, run_number) transaction_id, run_number, assertion_id AS kept_id
        FROM marked
       WHERE NOT removable
       ORDER BY transaction_id, run_number, commit_sequence DESC, encode(assertion_id, 'hex') DESC
    )
    SELECT marked.assertion_id, kept.kept_id
      FROM marked
      JOIN kept ON kept.transaction_id = marked.transaction_id AND kept.run_number = marked.run_number
     WHERE marked.removable`);
  await transaction.query(
    `UPDATE current_transaction_enrichment current
        SET assertion_id = chain.kept_id
       FROM kind_chain chain
      WHERE current.field_name = 'kind'
        AND current.assertion_id = chain.assertion_id`,
  );
  // Every other table that names an assertion must name a kept one. Checked
  // once here, the per-row foreign-key checks can be skipped for the delete,
  // which on a large store would otherwise take hours.
  const references = await transaction.query<{ table_name: string; column_name: string; referenced_column: string }>(
    `SELECT constraint_row.conrelid::regclass::text AS table_name,
            quote_ident(referencing.attname) AS column_name,
            referenced.attname AS referenced_column
       FROM pg_constraint constraint_row
       JOIN pg_attribute referencing
         ON referencing.attrelid = constraint_row.conrelid AND referencing.attnum = constraint_row.conkey[1]
       JOIN pg_attribute referenced
         ON referenced.attrelid = constraint_row.confrelid AND referenced.attnum = constraint_row.confkey[1]
      WHERE constraint_row.contype = 'f'
        AND constraint_row.confrelid = ANY($1::regclass[])
        AND NOT constraint_row.conrelid = ANY($1::regclass[])`,
    [HISTORY_TABLES],
  );
  for (const { table_name, column_name, referenced_column } of references.rows) {
    if (referenced_column !== "assertion_id")
      throw new Error(`Kind duplicate cleanup cannot check ${table_name}, which names ${referenced_column}.`);
    const named = await transaction.query(
      `SELECT 1 FROM ${table_name} referencing JOIN kind_chain chain ON chain.assertion_id = referencing.${column_name} LIMIT 1`,
    );
    if (named.rows.length > 0) throw new Error(`Kind duplicate cleanup would remove an assertion ${table_name} names.`);
  }
  await transaction.query("SET LOCAL session_replication_role = replica");
  let removed = 0;
  for (const table of HISTORY_TABLES)
    removed += (await transaction.query(
      `DELETE FROM ${table} history USING kind_chain chain WHERE history.assertion_id = chain.assertion_id`,
    )).affectedRows ?? 0;
  removed += (await transaction.query(`
    DELETE FROM enrichment_run_outputs history USING (
      SELECT output.output_id,
             output.output_state = 'unsupported'
               AND ROW(output.output_state, output.route_id, output.provenance_json)
                   IS NOT DISTINCT FROM LAG(ROW(output.output_state, output.route_id, output.provenance_json)) OVER history
               AND NOT EXISTS (
                 SELECT 1 FROM assertion_transitions transition
                  WHERE transition.enrichment_run_id = output.run_id
                    AND transition.transaction_id = output.transaction_id
                    AND transition.field_name = output.field_name
                    AND transition.event_kind = 'withdrawn'
               ) AS removable
        FROM enrichment_run_outputs output
        JOIN canonical_commits written ON written.commit_id = output.commit_id
       WHERE output.field_name = 'kind' AND output.transaction_id IS NOT NULL
      WINDOW history AS (PARTITION BY output.transaction_id ORDER BY written.commit_sequence, encode(output.output_id, 'hex'))
    ) repeated
    WHERE history.output_id = repeated.output_id AND repeated.removable`)).affectedRows ?? 0;
  await transaction.query("SET LOCAL session_replication_role = origin");
  if (removed > 0) await transaction.query(`ANALYZE ${HISTORY_TABLES.join(", ")}`);
  return removed;
}
