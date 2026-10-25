import { randomUUID } from "node:crypto";
import type { PGliteStore } from "./transaction.ts";

/**
 * Every table a Canonical Reset keeps; every other table in the store holds
 * financial state and is emptied. Kept are schema metadata, the trusted source
 * contract catalog and reference data the baseline installs, and Preserved
 * Operational Configuration: exchange rates and the automation run history the
 * schedulers read to decide whether an occurrence already ran.
 */
export const CANONICAL_RESET_PRESERVED_TABLES: ReadonlySet<string> = new Set([
  "pglite_baseline_metadata",
  "pglite_invariant_manifest",
  "pglite_operational_baseline_metadata",
  "pglite_operational_migrations",
  "schema_migrations",
  "source_contract_catalog",
  "source_contract_rule_tuples",
  "automatic_enrichment_authority_routes",
  "canonical_grouped_role_contracts",
  "enrichment_producer_versions",
  "taxonomy_applicability",
  "taxonomy_codes",
  "taxonomy_localizations",
  "taxonomy_producer_compatibility",
  "taxonomy_versions",
  "exchange_rates",
  "automation_task_runs",
  "automation_task_run_commit_attempts",
  "automation_task_prerequisite_notices",
]);

const quoted = (identifier: string) => `"${identifier.replaceAll("\"", "\"\"")}"`;

/**
 * Replace all financial state with an empty canonical store in one
 * transaction, so a crash leaves either the old store or the empty one and a
 * retry finishes the job.
 */
export async function resetPGliteCanonicalStore(store: PGliteStore): Promise<void> {
  await store.transaction(async (transaction) => {
    const tables = await transaction.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    const latest = (await transaction.query<{ sequence: number | string; recorded_at_utc_us: number | string | null }>(
      "SELECT COALESCE(MAX(commit_sequence), 0) AS sequence, MAX(recorded_at_utc_us) AS recorded_at_utc_us FROM canonical_commits",
    )).rows[0];
    const financial = tables.rows
      .map(({ table_name }) => table_name)
      .filter((table) => !CANONICAL_RESET_PRESERVED_TABLES.has(table));
    // TRUNCATE skips the per-row append-only guards and gives each table new
    // storage, so the deleted rows leave the table files at commit.
    await transaction.exec(`TRUNCATE ${financial.map(quoted).join(", ")}`);
    // The knowledge version is MAX(commit_sequence). An empty rebuild commit
    // keeps it increasing, so no cache or page keyed by a version from before
    // the reset can match one after it, and live views observe the change.
    await transaction.query(
      `INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind)
       VALUES ($1, $2, $3, 'automatic/pglite-canonical-reset/v1', 'projection_rebuild')`,
      [
        Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex")),
        Number(latest?.sequence ?? 0) + 1,
        Math.max(Date.now() * 1000, Number(latest?.recorded_at_utc_us ?? 0) + 1),
      ],
    );
  });
  await store.exec("CHECKPOINT");
}
