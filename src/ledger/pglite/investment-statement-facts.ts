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

/**
 * The digest `maicoinStatementRecordKey` derives, so the migration can name
 * the investment row each logged statement became: SHA-256 of the parts
 * joined by NUL, as unpadded base64url.
 */
function maicoinRecordKeySql(leg: string): string {
  const part = (value: string) => `convert_to(${value}, 'UTF8')`;
  const parts = ["'maicoin-statement-record-v1'", "logged.endpoint", "COALESCE(logged.wallet_type, '')", "logged.row_type", "logged.external_id", leg]
    .map(part).join(" || '\\x00'::bytea || ");
  return `'sha256:' || rtrim(translate(encode(sha256(${parts}), 'base64'), '+/', '-_'), '=')`;
}

/** The record that installed the statement log. */
const RETIRED_LOG_MIGRATION = "maicoin-operational-v1";

const LATEST_LOGGED_STATEMENTS_SQL = `SELECT DISTINCT ON (endpoint, wallet_type, row_type, external_id)
         endpoint, wallet_type, row_type, external_id, value_twd,
         raw_payload_json::jsonb->>'state' AS state
    FROM maicoin_statement_rows
   WHERE row_type IN ('deposit','withdrawal','reward','convert','transfer','trade')
   ORDER BY endpoint, wallet_type, row_type, external_id, captured_at DESC, statement_id DESC`;

/**
 * ADR 0158 retires the MAX statement log. Its row types and TWD values move
 * onto the investment rows they describe, keyed by each leg's source record
 * key: a transfer or convert has a `from` and a `to` leg, every other row a
 * `transaction` leg. A value moves only where Cash flow read it: a reward, or
 * a non-TWD deposit MAX logged as `done`. It carries no price, so it is a
 * `legacy-log` valuation citing the row's own source record. The log's three
 * tables and its migration record go in the same transaction. A store that
 * never synced MAX has no log and only loses the record.
 */
export const PGLITE_MAICOIN_STATEMENT_LOG_RETIREMENT_SQL = String.raw`
DO $retire$
BEGIN
  IF to_regclass('maicoin_statement_rows') IS NOT NULL THEN
    UPDATE investment_transactions investment
       SET row_type = keyed.row_type
      FROM source_records record,
           (SELECT ${maicoinRecordKeySql("leg.leg")} AS record_key, logged.row_type
              FROM (${LATEST_LOGGED_STATEMENTS_SQL}) logged
             CROSS JOIN (VALUES ('transaction'), ('from'), ('to')) AS leg(leg)) keyed
     WHERE record.source_record_id = investment.source_record_id
       AND record.provider_key = keyed.record_key
       AND investment.row_type IS NULL;
    INSERT INTO investment_transaction_twd_valuations(
      transaction_id, capture_id, commit_id, source_record_id,
      value_coefficient, value_scale, value_currency, price_route)
    SELECT investment.transaction_id, investment.capture_id, investment.commit_id, investment.source_record_id,
           CASE WHEN valued.amount = 0 THEN '0' ELSE ltrim(replace(valued.amount::text, '.', ''), '0') END,
           CASE WHEN valued.amount = 0 THEN 0 ELSE scale(valued.amount) END,
           'TWD', 'legacy-log'
      FROM (SELECT ${maicoinRecordKeySql("'transaction'")} AS record_key, logged.row_type, logged.state,
                   logged.value_twd::numeric AS amount
              FROM (${LATEST_LOGGED_STATEMENTS_SQL}) logged
             WHERE logged.value_twd >= 0 AND logged.value_twd < 'Infinity'::float8) valued
      JOIN source_records record ON record.provider_key = valued.record_key
      JOIN investment_transactions investment ON investment.source_record_id = record.source_record_id
      JOIN investment_securities security ON security.security_id = investment.security_id
     WHERE security.source_id = 'maicoin'
       AND (valued.row_type = 'reward'
            OR (valued.row_type = 'deposit' AND valued.state = 'done' AND upper(security.producer_security_id) <> 'TWD'))
    ON CONFLICT (transaction_id) DO NOTHING;
  END IF;
END
$retire$;
DROP TABLE IF EXISTS maicoin_statement_rows, maicoin_account_snapshots, maicoin_sync_runs;
DELETE FROM pglite_operational_migrations WHERE migration_key = '${RETIRED_LOG_MIGRATION}';
`;

export const INVESTMENT_STATEMENT_FACT_TABLES = ["investment_transaction_twd_valuations"] as const;

const INVESTMENT_STATEMENT_FACT_MIGRATIONS = [
  { id: "investment-statement-facts-v1", sql: PGLITE_INVESTMENT_STATEMENT_FACTS_SQL },
  { id: "maicoin-statement-log-retirement-v1", sql: PGLITE_MAICOIN_STATEMENT_LOG_RETIREMENT_SQL },
] as const;

export function applyPgliteInvestmentStatementFactsSchema(store: PGliteStore): Promise<void> {
  return applyOperationalMigrations(store, "Investment statement facts", INVESTMENT_STATEMENT_FACT_MIGRATIONS, INVESTMENT_STATEMENT_FACT_TABLES);
}
