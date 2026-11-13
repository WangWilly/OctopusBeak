import { applyOperationalMigrations } from "./operational-migrations.ts";
import type { PGliteStore } from "./transaction.ts";

/**
 * Taxonomy rows the published package added after a data directory's
 * baseline was installed. The table only accepts inserts, so each step adds
 * rows and skips any a newer baseline already holds.
 */
const TAXONOMY_SEED_MIGRATIONS = [{
  id: "taxonomy-credit-card-inflow-kinds-v1",
  sql: `INSERT INTO taxonomy_producer_compatibility(
      taxonomy_id, taxonomy_version, producer_id, producer_version, origin, field_name, output_code, evidence_kinds_json
    ) VALUES
      ('transaction-taxonomy', 'v1', 'credit-card/direction-enrichment', 'v1', 'derived', 'kind', 'reversal', '["bank-rule"]'),
      ('transaction-taxonomy', 'v1', 'credit-card/direction-enrichment', 'v1', 'derived', 'kind', 'income.reward', '["bank-rule"]'),
      ('transaction-taxonomy', 'v1', 'credit-card/direction-enrichment', 'v1', 'derived', 'kind', 'payment.credit_card', '["bank-rule"]')
    ON CONFLICT DO NOTHING;`,
}] as const;

export function applyPgliteTaxonomySeed(store: PGliteStore): Promise<void> {
  return applyOperationalMigrations(store, "Taxonomy seed", TAXONOMY_SEED_MIGRATIONS, []);
}
