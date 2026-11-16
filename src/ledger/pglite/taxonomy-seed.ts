import { applyOperationalMigrations } from "./operational-migrations.ts";
import type { PGliteStore } from "./transaction.ts";

/**
 * Taxonomy rows the published package added after a data directory's
 * baseline was installed. These tables only accept inserts, so each step adds
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
}, {
  // ADR 0138: the investment and loan event producer, its routes, then the Kinds it may write.
  id: "taxonomy-account-event-kinds-v1",
  sql: `INSERT INTO enrichment_producer_versions(
      producer_id, producer_version, taxonomy_id, taxonomy_version, confidence_threshold_basis_points
    ) VALUES
      ('account-event/kind-enrichment', 'v1', 'transaction-taxonomy', 'v1', 10000)
    ON CONFLICT DO NOTHING;
    INSERT INTO automatic_enrichment_authority_routes(
      route_id, subject_kind, field_name, scope_kind, scope_key, producer_id, producer_version,
      origin_policy, taxonomy_id, taxonomy_version, valid_from_commit_sequence, valid_to_commit_sequence
    ) VALUES
      ('yuanta-fund/investment/event-kind-enrichment/v1/kind', 'transaction', 'kind', 'source_stream', 'yuanta-fund/investment', 'account-event/kind-enrichment', 'v1', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
      ('yuanta-trade/investment/event-kind-enrichment/v1/kind', 'transaction', 'kind', 'source_stream', 'yuanta-trade/investment', 'account-event/kind-enrichment', 'v1', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
      ('maicoin/investment/event-kind-enrichment/v1/kind', 'transaction', 'kind', 'source_stream', 'maicoin/investment', 'account-event/kind-enrichment', 'v1', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
      ('binance/investment/event-kind-enrichment/v1/kind', 'transaction', 'kind', 'source_stream', 'binance/investment', 'account-event/kind-enrichment', 'v1', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
      ('yuanta/loan/event-kind-enrichment/v1/kind', 'transaction', 'kind', 'source_stream', 'yuanta/loan', 'account-event/kind-enrichment', 'v1', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
      ('fubon/loan/event-kind-enrichment/v1/kind', 'transaction', 'kind', 'source_stream', 'fubon/loan', 'account-event/kind-enrichment', 'v1', 'derived', 'transaction-taxonomy', 'v1', 1, NULL)
    ON CONFLICT DO NOTHING;
    INSERT INTO taxonomy_producer_compatibility(
      taxonomy_id, taxonomy_version, producer_id, producer_version, origin, field_name, output_code, evidence_kinds_json
    ) VALUES
      ('transaction-taxonomy', 'v1', 'account-event/kind-enrichment', 'v1', 'derived', 'kind', 'investment.trade.buy', '["investment-event"]'),
      ('transaction-taxonomy', 'v1', 'account-event/kind-enrichment', 'v1', 'derived', 'kind', 'investment.trade.sell', '["investment-event"]'),
      ('transaction-taxonomy', 'v1', 'account-event/kind-enrichment', 'v1', 'derived', 'kind', 'investment.corporate_action', '["investment-event"]'),
      ('transaction-taxonomy', 'v1', 'account-event/kind-enrichment', 'v1', 'derived', 'kind', 'income.dividend', '["investment-event"]'),
      ('transaction-taxonomy', 'v1', 'account-event/kind-enrichment', 'v1', 'derived', 'kind', 'payment.loan', '["loan-event"]'),
      ('transaction-taxonomy', 'v1', 'account-event/kind-enrichment', 'v1', 'derived', 'kind', 'loan.disbursement', '["loan-event"]'),
      ('transaction-taxonomy', 'v1', 'account-event/kind-enrichment', 'v1', 'derived', 'kind', 'interest.charged', '["loan-event"]'),
      ('transaction-taxonomy', 'v1', 'account-event/kind-enrichment', 'v1', 'derived', 'kind', 'fee.loan', '["loan-event"]')
    ON CONFLICT DO NOTHING;`,
}] as const;

export function applyPgliteTaxonomySeed(store: PGliteStore): Promise<void> {
  return applyOperationalMigrations(store, "Taxonomy seed", TAXONOMY_SEED_MIGRATIONS, []);
}
