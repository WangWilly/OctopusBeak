import { applyOperationalMigrations } from "./operational-migrations.ts";
import type { PGliteStore } from "./transaction.ts";

/**
 * The MAX statement facts an investment commit admits beside its event (ADR
 * 0158): the statement family on `investment_transactions.row_type`, and one
 * TWD valuation per event. A NULL `row_type` is a row admitted before the
 * column existed; the next commit of that event fills it.
 *
 * A valuation is written once. The only change allowed is replacing a
 * `legacy-log` row, which the migration carried over from the retired MAX
 * statement log without a price, by the first priced valuation.
 */
export const PGLITE_INVESTMENT_STATEMENT_FACTS_SQL = String.raw`
ALTER TABLE investment_transactions ADD COLUMN row_type TEXT
  CHECK(row_type IN ('deposit','withdrawal','reward','convert','transfer','trade'));
CREATE TABLE investment_transaction_twd_valuations (
  transaction_id BYTEA PRIMARY KEY REFERENCES investment_transactions(transaction_id),
  capture_id BYTEA NOT NULL REFERENCES investment_captures(capture_id),
  commit_id BYTEA NOT NULL REFERENCES canonical_commits(commit_id),
  source_record_id BYTEA NOT NULL REFERENCES source_records(source_record_id),
  value_coefficient TEXT NOT NULL CHECK(value_coefficient ~ '^(0|[1-9][0-9]*)$'),
  value_scale BIGINT NOT NULL CHECK(value_scale >= 0),
  value_currency TEXT NOT NULL CHECK(value_currency = 'TWD'),
  price_route TEXT NOT NULL CHECK(price_route IN ('twd','direct','via-usdt','legacy-log')),
  market TEXT,
  close_coefficient TEXT CHECK(close_coefficient ~ '^(0|[1-9][0-9]*)$'),
  close_scale BIGINT CHECK(close_scale >= 0),
  usdt_twd_close_coefficient TEXT CHECK(usdt_twd_close_coefficient ~ '^(0|[1-9][0-9]*)$'),
  usdt_twd_close_scale BIGINT CHECK(usdt_twd_close_scale >= 0),
  candle_day TEXT CHECK(candle_day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  CHECK((price_route IN ('twd','legacy-log')
         AND market IS NULL AND close_coefficient IS NULL AND close_scale IS NULL
         AND usdt_twd_close_coefficient IS NULL AND usdt_twd_close_scale IS NULL AND candle_day IS NULL)
     OR (price_route = 'direct'
         AND market IS NOT NULL AND close_coefficient IS NOT NULL AND close_scale IS NOT NULL
         AND usdt_twd_close_coefficient IS NULL AND usdt_twd_close_scale IS NULL AND candle_day IS NOT NULL)
     OR (price_route = 'via-usdt'
         AND market IS NOT NULL AND close_coefficient IS NOT NULL AND close_scale IS NOT NULL
         AND usdt_twd_close_coefficient IS NOT NULL AND usdt_twd_close_scale IS NOT NULL AND candle_day IS NOT NULL))
);
CREATE OR REPLACE FUNCTION investment_transaction_twd_valuations_write_once()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND canonical_purge_delete_allowed() <> 0 THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND OLD.price_route = 'legacy-log' AND NEW.price_route <> 'legacy-log'
     AND NEW.transaction_id = OLD.transaction_id THEN RETURN NEW; END IF;
  RAISE EXCEPTION '%', 'Investment TWD valuations are written once';
END
$$;
CREATE TRIGGER investment_transaction_twd_valuations_write_once
  BEFORE UPDATE OR DELETE ON investment_transaction_twd_valuations
  FOR EACH ROW EXECUTE FUNCTION investment_transaction_twd_valuations_write_once();
`;

export const INVESTMENT_STATEMENT_FACT_TABLES = ["investment_transaction_twd_valuations"] as const;

const INVESTMENT_STATEMENT_FACT_MIGRATIONS = [
  { id: "investment-statement-facts-v1", sql: PGLITE_INVESTMENT_STATEMENT_FACTS_SQL },
] as const;

export function applyPgliteInvestmentStatementFactsSchema(store: PGliteStore): Promise<void> {
  return applyOperationalMigrations(store, "Investment statement facts", INVESTMENT_STATEMENT_FACT_MIGRATIONS, INVESTMENT_STATEMENT_FACT_TABLES);
}
