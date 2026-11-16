import { SPENDING_EXCLUDED_KIND_PREFIXES } from "../canonical/spending-inclusion-policy.ts";

for (const prefix of SPENDING_EXCLUDED_KIND_PREFIXES)
  if (!/^[a-z_.]+$/u.test(prefix)) throw new Error(`Spending excluded Kind prefix is not a plain code: ${prefix}`);

/**
 * SQL conditions, joined by AND, that hold for a Kind Spending may count, as
 * `isSpendingExcludedKind` decides it. `starts_with` keeps a `_` in a code
 * literal, where LIKE would read it as a wildcard.
 */
export function spendingIncludedKindSql(column: string): string {
  return [
    `${column} IS NOT NULL`,
    `${column} NOT IN (${SPENDING_EXCLUDED_KIND_PREFIXES.map((prefix) => `'${prefix}'`).join(", ")})`,
    ...SPENDING_EXCLUDED_KIND_PREFIXES.map((prefix) => `NOT starts_with(${column}, '${prefix}.')`),
  ].join("\n     AND ");
}

/** The body of `refresh_current_spending_pairing_entry`, as `pg_proc.prosrc` holds it. */
export const PGLITE_SPENDING_PAIRING_REFRESH_BODY = `
BEGIN
  DELETE FROM current_spending_pairing_entries WHERE transaction_id = target_transaction_id;
  INSERT INTO current_spending_pairing_entries (
    transaction_id, revision_id, effective_on, consume_date, posting_date,
    effective_date_basis, description, amount_coefficient, amount_scale, currency
  )
  SELECT current_row.transaction_id, current_row.revision_id,
         revision.effective_on, facts.consume_date, facts.posting_date,
         facts.effective_date_basis, revision.description,
         revision.amount_coefficient, revision.amount_scale, revision.currency
    FROM current_transactions current_row
    JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
    JOIN current_transaction_enrichment kind
      ON kind.transaction_id = current_row.transaction_id AND kind.field_name = 'kind'
    LEFT JOIN LATERAL (
      SELECT consume_date, posting_date, effective_date_basis
        FROM canonical_credit_card_transaction_details detail
       WHERE detail.revision_id = current_row.revision_id
       ORDER BY detail.source_record_id
       LIMIT 1
    ) facts ON TRUE
   WHERE current_row.transaction_id = target_transaction_id
     AND revision.administrative_state = 'active'
     AND revision.economic_status = 'normal'
     AND revision.posting_status = 'posted'
     AND revision.direction = 'outflow'
     AND ${spendingIncludedKindSql("kind.taxonomy_code")}
     AND NOT EXISTS (
       SELECT 1 FROM current_spending_dedup_links active_link
        WHERE active_link.transaction_id = current_row.transaction_id
     );
END
`;

/** Installs the current refresh function in place of whatever a store holds. */
export const PGLITE_SPENDING_PAIRING_REFRESH_SQL = `
CREATE OR REPLACE FUNCTION refresh_current_spending_pairing_entry(target_transaction_id BYTEA)
RETURNS VOID LANGUAGE plpgsql AS $$${PGLITE_SPENDING_PAIRING_REFRESH_BODY}$$;
`;

type SqlRunner = Readonly<{
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}>;

/**
 * Brings a store's pairing eligibility to the current Spending exclusions: a
 * refresh function whose body differs from this module's is replaced, and
 * every pairing entry rebuilt with it. A store that already holds the current
 * function is left as it is, so the step is safe on every open, and a later
 * change to the exclusions converges every store without a new entry.
 * Returns whether it rebuilt.
 */
export async function applyPgliteSpendingPairingEligibility(transaction: SqlRunner): Promise<boolean> {
  const installed = await transaction.query<{ prosrc: string }>(
    "SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure($1)",
    [`${PGLITE_SPENDING_PAIRING_PROJECTION_OBJECTS.refreshFunction}(bytea)`],
  );
  if (installed.rows[0]?.prosrc === PGLITE_SPENDING_PAIRING_REFRESH_BODY) return false;
  await transaction.exec(PGLITE_SPENDING_PAIRING_REFRESH_SQL);
  await transaction.query(`SELECT ${PGLITE_SPENDING_PAIRING_PROJECTION_OBJECTS.rebuildFunction}()`);
  return true;
}

/**
 * Disposable, transactionally maintained read projection for Spending Pairing.
 * Install after the authoritative baseline tables and foreign keys. This SQL
 * never replaces canonical transaction, enrichment, date-fact, or link rows.
 * The baseline SQL keeps the refresh function as first reviewed;
 * `applyPgliteSpendingPairingEligibility` replaces it with this one.
 */
export const PGLITE_SPENDING_PAIRING_PROJECTION_SQL = `
CREATE TABLE current_spending_pairing_entries (
  transaction_id BYTEA PRIMARY KEY REFERENCES financial_transactions(transaction_id),
  revision_id BYTEA NOT NULL REFERENCES transaction_revisions(revision_id),
  effective_on TEXT NOT NULL,
  consume_date TEXT,
  posting_date TEXT,
  effective_date_basis TEXT,
  description TEXT,
  amount_coefficient TEXT NOT NULL,
  amount_scale INTEGER NOT NULL,
  currency TEXT NOT NULL
);
${PGLITE_SPENDING_PAIRING_REFRESH_SQL}
CREATE OR REPLACE FUNCTION rebuild_current_spending_pairing_entries()
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE current_id BYTEA;
BEGIN
  DELETE FROM current_spending_pairing_entries;
  FOR current_id IN SELECT transaction_id FROM current_transactions LOOP
    PERFORM refresh_current_spending_pairing_entry(current_id);
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION refresh_current_spending_pairing_entry_trigger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'current_transaction_enrichment' THEN
    IF TG_OP = 'DELETE' AND OLD.field_name <> 'kind' THEN RETURN OLD; END IF;
    IF TG_OP <> 'DELETE' AND NEW.field_name <> 'kind' AND
       (TG_OP <> 'UPDATE' OR OLD.field_name <> 'kind') THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_current_spending_pairing_entry(OLD.transaction_id);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.transaction_id IS DISTINCT FROM NEW.transaction_id THEN
    PERFORM refresh_current_spending_pairing_entry(OLD.transaction_id);
  END IF;
  PERFORM refresh_current_spending_pairing_entry(NEW.transaction_id);
  RETURN NEW;
END
$$;

CREATE TRIGGER current_spending_pairing_current_transactions_refresh
  AFTER INSERT OR UPDATE OR DELETE ON current_transactions
  FOR EACH ROW EXECUTE FUNCTION refresh_current_spending_pairing_entry_trigger();
CREATE TRIGGER current_spending_pairing_kind_refresh
  AFTER INSERT OR UPDATE OR DELETE ON current_transaction_enrichment
  FOR EACH ROW EXECUTE FUNCTION refresh_current_spending_pairing_entry_trigger();
CREATE TRIGGER current_spending_pairing_date_fact_refresh
  AFTER INSERT OR UPDATE OR DELETE ON canonical_credit_card_transaction_details
  FOR EACH ROW EXECUTE FUNCTION refresh_current_spending_pairing_entry_trigger();
CREATE TRIGGER current_spending_pairing_link_refresh
  AFTER INSERT OR UPDATE OR DELETE ON current_spending_dedup_links
  FOR EACH ROW EXECUTE FUNCTION refresh_current_spending_pairing_entry_trigger();
`;

/** Reviewed object inventory for the fresh-baseline derived projection. */
export const PGLITE_SPENDING_PAIRING_PROJECTION_OBJECTS = Object.freeze({
  table: "current_spending_pairing_entries",
  refreshFunction: "refresh_current_spending_pairing_entry",
  rebuildFunction: "rebuild_current_spending_pairing_entries",
  triggerFunction: "refresh_current_spending_pairing_entry_trigger",
  triggers: Object.freeze([
    "current_spending_pairing_current_transactions_refresh",
    "current_spending_pairing_kind_refresh",
    "current_spending_pairing_date_fact_refresh",
    "current_spending_pairing_link_refresh",
  ]),
} as const);
