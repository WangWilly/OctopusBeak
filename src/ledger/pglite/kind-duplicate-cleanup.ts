import { createHash } from "node:crypto";
import type { PGliteStore } from "./transaction.ts";

/**
 * Removes the derived Kind history a refresh bug wrote (ADR 0144), once per
 * store. A refresh for a commit that touched no transaction re-derived every
 * Kind without reading the current one, so each Kind was written again,
 * unchanged, on every such refresh. Some stores hold thousands of identical
 * Kind assertions per transaction.
 *
 * An assertion is removed when it repeats the assertion before it on the same
 * transaction: same producer, rule, route, value and output provenance, and
 * neither was ever superseded, withdrawn or restored. The first of each run is
 * kept, which is the assertion a correct refresh would have kept, and the
 * Kind at every commit stays the same. An unsupported output is removed when
 * it repeats the output before it and no withdrawal rests on it.
 *
 * Current rows are moved onto the kept assertion, so no projection commit is
 * written. An assertion that a category's provenance names stays.
 */
const KIND_DUPLICATE_CLEANUP = "kind-duplicate-cleanup-v1";

const HISTORY_TABLES = [
  "enrichment_taxonomy_assertion_values",
  "assertion_transitions",
  "assertion_provenance",
  "enrichment_run_outputs",
  "assertions",
] as const;

const signature = (id: string) => createHash("sha256").update(id).digest("hex");

export async function applyPgliteKindDuplicateCleanup(store: PGliteStore): Promise<void> {
  const removed = await store.transaction(async (transaction) => {
    const applied = await transaction.query(
      "SELECT 1 FROM pglite_operational_migrations WHERE migration_key = $1",
      [KIND_DUPLICATE_CLEANUP],
    );
    if (applied.rows.length > 0) return 0;
    await transaction.query(`CREATE TEMP TABLE kind_chain ON COMMIT DROP AS
      WITH named AS (
        SELECT DISTINCT decode(replace(category.provenance_json::jsonb->>'evidenceAssertionId', '-', ''), 'hex') AS assertion_id
          FROM (
            SELECT provenance_json FROM enrichment_run_outputs WHERE field_name = 'category'
            UNION ALL
            SELECT provenance_json FROM enrichment_taxonomy_assertion_values WHERE field_name = 'category'
          ) category
         WHERE category.provenance_json::jsonb ? 'evidenceAssertionId'
      ),
      chain AS (
        SELECT assertion.assertion_id, assertion.transaction_id,
               EXISTS (
                 SELECT 1 FROM assertion_transitions transition
                  WHERE transition.assertion_id = assertion.assertion_id
                    AND transition.event_kind <> 'observed'
               ) AS retired,
               named.assertion_id IS NOT NULL AS named,
               ROW(assertion.producer_id, assertion.rule_lineage, assertion.value_text, output.route_id, output.provenance_json)
                 IS NOT DISTINCT FROM LAG(ROW(assertion.producer_id, assertion.rule_lineage, assertion.value_text, output.route_id, output.provenance_json)) OVER history
                 AS repeats,
               created.commit_sequence
          FROM assertions assertion
          JOIN canonical_commits created ON created.commit_id = assertion.created_commit_id
          JOIN enrichment_run_outputs output ON output.assertion_id = assertion.assertion_id
          LEFT JOIN named ON named.assertion_id = assertion.assertion_id
         WHERE assertion.origin = 'derived'
           AND assertion.target_kind = 'transaction'
           AND assertion.field_name = 'kind'
        WINDOW history AS (PARTITION BY assertion.transaction_id ORDER BY created.commit_sequence, encode(assertion.assertion_id, 'hex'))
      ),
      runs AS (
        SELECT chain.*,
               NOT (repeats AND NOT retired AND NOT COALESCE(LAG(retired) OVER history, true)) AS starts_run
          FROM chain
        WINDOW history AS (PARTITION BY transaction_id ORDER BY commit_sequence, encode(assertion_id, 'hex'))
      ),
      numbered AS (
        SELECT runs.*,
               SUM(CASE WHEN starts_run THEN 1 ELSE 0 END) OVER (
                 PARTITION BY transaction_id ORDER BY commit_sequence, encode(assertion_id, 'hex')
               ) AS run_number
          FROM runs
      )
      SELECT assertion_id,
             FIRST_VALUE(assertion_id) OVER (
               PARTITION BY transaction_id, run_number ORDER BY commit_sequence, encode(assertion_id, 'hex')
             ) AS kept_id,
             NOT starts_run AND NOT named AS removable
        FROM numbered`);
    await transaction.query("DELETE FROM kind_chain WHERE NOT removable");
    await transaction.query(
      `UPDATE current_transaction_enrichment current
          SET assertion_id = chain.kept_id
         FROM kind_chain chain
        WHERE current.field_name = 'kind'
          AND current.assertion_id = chain.assertion_id`,
    );
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
    if (removed > 0) await transaction.query(`ANALYZE ${HISTORY_TABLES.join(", ")}`);
    await transaction.query(
      "INSERT INTO pglite_operational_migrations(migration_key, schema_signature) VALUES ($1, $2)",
      [KIND_DUPLICATE_CLEANUP, signature(KIND_DUPLICATE_CLEANUP)],
    );
    return removed;
  });
  // Deleted rows only free space for reuse; rewriting the tables returns it to
  // the disk. VACUUM cannot run inside a transaction.
  if (removed > 0) {
    for (const table of HISTORY_TABLES) await store.query(`VACUUM (FULL, ANALYZE) ${table}`);
    await store.query("CHECKPOINT");
  }
}
