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
}, {
  // TDCC settlement deposits get a bank Kind route, and a Cathay 網銀轉帳 may be a plain transfer.
  id: "taxonomy-deposit-kind-gaps-v1",
  sql: `INSERT INTO automatic_enrichment_authority_routes(
      route_id, subject_kind, field_name, scope_kind, scope_key, producer_id, producer_version,
      origin_policy, taxonomy_id, taxonomy_version, valid_from_commit_sequence, valid_to_commit_sequence
    ) VALUES
      ('tdcc/domestic-deposit/kind-enrichment/v4/kind', 'transaction', 'kind', 'source_stream', 'tdcc/domestic-deposit', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'transaction-taxonomy', 'v1', 1, NULL)
    ON CONFLICT DO NOTHING;
    INSERT INTO taxonomy_producer_compatibility(
      taxonomy_id, taxonomy_version, producer_id, producer_version, origin, field_name, output_code, evidence_kinds_json
    ) VALUES
      ('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'transfer', '["bank-rule"]')
    ON CONFLICT DO NOTHING;`,
}, {
  // ADR 0141: the interest-and-fees Personal Category, then the producer that derives it from a Kind.
  id: "taxonomy-interest-and-fees-v1",
  sql: `INSERT INTO taxonomy_codes(
      taxonomy_id, taxonomy_version, dimension, code, parent_code, definition, localization_key, aggregation_safe
    ) VALUES
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', NULL, 'Interest charged and fees for bank, card, and loan services.', 'transaction-taxonomy.category.interest_and_fees', 1)
    ON CONFLICT DO NOTHING;
    INSERT INTO taxonomy_localizations(taxonomy_id, taxonomy_version, dimension, code, locale, label) VALUES
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', 'en', 'Interest And Fees'),
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', 'zh-Hant', '利息與手續費')
    ON CONFLICT DO NOTHING;
    INSERT INTO taxonomy_applicability(taxonomy_id, taxonomy_version, category_dimension, category_code, kind_dimension, kind_code) VALUES
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', 'kind', 'purchase'),
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', 'kind', 'payment'),
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', 'kind', 'payment.bill'),
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', 'kind', 'payment.loan'),
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', 'kind', 'fee'),
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', 'kind', 'fee.bank'),
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', 'kind', 'fee.card'),
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', 'kind', 'fee.loan'),
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', 'kind', 'fee.investment'),
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', 'kind', 'interest.charged'),
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', 'kind', 'tax.payment'),
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', 'kind', 'tax.refund'),
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', 'kind', 'refund'),
      ('transaction-taxonomy', 'v1', 'category', 'interest_and_fees', 'kind', 'reversal')
    ON CONFLICT DO NOTHING;
    INSERT INTO enrichment_producer_versions(
      producer_id, producer_version, taxonomy_id, taxonomy_version, confidence_threshold_basis_points
    ) VALUES
      ('kind/category-enrichment', 'v1', 'transaction-taxonomy', 'v1', 10000)
    ON CONFLICT DO NOTHING;
    INSERT INTO automatic_enrichment_authority_routes(
      route_id, subject_kind, field_name, scope_kind, scope_key, producer_id, producer_version,
      origin_policy, taxonomy_id, taxonomy_version, valid_from_commit_sequence, valid_to_commit_sequence
    ) VALUES
      ('global/kind-category-enrichment/v1/category', 'transaction', 'category', 'global', NULL, 'kind/category-enrichment', 'v1', 'derived', 'transaction-taxonomy', 'v1', 1, NULL)
    ON CONFLICT DO NOTHING;
    INSERT INTO taxonomy_producer_compatibility(
      taxonomy_id, taxonomy_version, producer_id, producer_version, origin, field_name, output_code, evidence_kinds_json
    ) VALUES
      ('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'interest_and_fees', '["explicit-source-field"]'),
      ('transaction-taxonomy', 'v1', 'einvoice/item-category-enrichment', 'v1', 'derived', 'category', 'interest_and_fees', '["item-name","seller-tax-id","seller-name"]'),
      ('transaction-taxonomy', 'v1', 'kind/category-enrichment', 'v1', 'derived', 'category', 'interest_and_fees', '["kind"]')
    ON CONFLICT DO NOTHING;`,
}, {
  // A card outflow whose issuer label names the card's interest or fee.
  id: "taxonomy-credit-card-charge-kinds-v1",
  sql: `INSERT INTO taxonomy_producer_compatibility(
      taxonomy_id, taxonomy_version, producer_id, producer_version, origin, field_name, output_code, evidence_kinds_json
    ) VALUES
      ('transaction-taxonomy', 'v1', 'credit-card/direction-enrichment', 'v1', 'derived', 'kind', 'interest.charged', '["bank-rule"]'),
      ('transaction-taxonomy', 'v1', 'credit-card/direction-enrichment', 'v1', 'derived', 'kind', 'fee.card', '["bank-rule"]')
    ON CONFLICT DO NOTHING;`,
}] as const;

export function applyPgliteTaxonomySeed(store: PGliteStore): Promise<void> {
  return applyOperationalMigrations(store, "Taxonomy seed", TAXONOMY_SEED_MIGRATIONS, []);
}
