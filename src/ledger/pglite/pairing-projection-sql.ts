/**
 * Disposable, transactionally maintained read projection for Spending Pairing.
 * Install after the authoritative baseline tables and foreign keys. This SQL
 * never replaces canonical transaction, enrichment, date-fact, or link rows.
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

CREATE OR REPLACE FUNCTION refresh_current_spending_pairing_entry(target_transaction_id BYTEA)
RETURNS VOID LANGUAGE plpgsql AS $$
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
     AND kind.taxonomy_code IS NOT NULL
     AND kind.taxonomy_code NOT IN ('transfer', 'cash', 'investment', 'payment.credit_card', 'payment.loan')
     AND kind.taxonomy_code NOT LIKE 'transfer.%'
     AND kind.taxonomy_code NOT LIKE 'cash.%'
     AND kind.taxonomy_code NOT LIKE 'investment.%'
     AND kind.taxonomy_code NOT LIKE 'payment.credit_card.%'
     AND kind.taxonomy_code NOT LIKE 'payment.loan.%'
     AND NOT EXISTS (
       SELECT 1 FROM current_spending_dedup_links active_link
        WHERE active_link.transaction_id = current_row.transaction_id
     );
END
$$;

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
