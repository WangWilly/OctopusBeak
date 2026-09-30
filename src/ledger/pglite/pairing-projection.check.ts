import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGliteStore } from "./transaction.ts";
import { PGLITE_SPENDING_PAIRING_PROJECTION_SQL } from "./pairing-projection-sql.ts";

const id = (value: number) => Uint8Array.from({ length: 16 }, () => value);

const minimalAuthorityTables = `
CREATE TABLE financial_transactions(transaction_id BYTEA PRIMARY KEY);
CREATE TABLE transaction_revisions(
  revision_id BYTEA PRIMARY KEY, effective_on TEXT NOT NULL, description TEXT,
  amount_coefficient TEXT NOT NULL, amount_scale INTEGER NOT NULL, currency TEXT NOT NULL,
  administrative_state TEXT NOT NULL, economic_status TEXT NOT NULL,
  posting_status TEXT NOT NULL, direction TEXT NOT NULL
);
CREATE TABLE current_transactions(transaction_id BYTEA PRIMARY KEY, revision_id BYTEA NOT NULL);
CREATE TABLE current_transaction_enrichment(transaction_id BYTEA NOT NULL, field_name TEXT NOT NULL, taxonomy_code TEXT);
CREATE TABLE canonical_credit_card_transaction_details(
  transaction_id BYTEA NOT NULL, revision_id BYTEA NOT NULL, source_record_id BYTEA NOT NULL,
  consume_date TEXT, posting_date TEXT, effective_date_basis TEXT,
  PRIMARY KEY(revision_id, source_record_id)
);
CREATE TABLE current_spending_dedup_links(transaction_id BYTEA PRIMARY KEY, invoice_id BYTEA NOT NULL);
`;

test("derived Spending pairing entries follow authoritative changes, rollback, and reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pglite-pairing-projection-"));
  const transactionId = id(1), revisionOne = id(2), revisionTwo = id(3);
  const sourceHigh = id(9), sourceLow = id(4);
  let store = new PGliteStore(await PGlite.create(directory));
  try {
    await store.exec(minimalAuthorityTables);
    await store.exec(PGLITE_SPENDING_PAIRING_PROJECTION_SQL);
    await store.query("INSERT INTO financial_transactions(transaction_id) VALUES ($1)", [transactionId]);
    await store.query(`INSERT INTO transaction_revisions(revision_id,effective_on,description,amount_coefficient,amount_scale,currency,administrative_state,economic_status,posting_status,direction)
      VALUES ($1,'2026-09-03','shop','1234',2,'TWD','active','normal','posted','outflow'),
             ($2,'2026-09-04','shop','1234',2,'TWD','deleted','normal','posted','outflow')`, [revisionOne, revisionTwo]);
    await store.query("INSERT INTO current_transactions(transaction_id,revision_id) VALUES ($1,$2)", [transactionId, revisionOne]);
    const count = async () => Number((await store.query<{ count: number | string }>("SELECT COUNT(*) AS count FROM current_spending_pairing_entries")).rows[0]?.count);
    assert.equal(await count(), 0, "kind is required before projection eligibility");
    await store.query("INSERT INTO current_transaction_enrichment(transaction_id,field_name,taxonomy_code) VALUES ($1,'kind','purchase')", [transactionId]);
    assert.equal(await count(), 1);

    const date = async () => (await store.query<{ consume_date: string | null }>("SELECT consume_date FROM current_spending_pairing_entries")).rows[0]?.consume_date;
    await store.query(`INSERT INTO canonical_credit_card_transaction_details(transaction_id,revision_id,source_record_id,consume_date,posting_date,effective_date_basis)
      VALUES ($1,$2,$3,'2026-09-02','2026-09-03','consume-date')`, [transactionId, revisionOne, sourceHigh]);
    assert.equal(await date(), "2026-09-02");
    await store.query(`INSERT INTO canonical_credit_card_transaction_details(transaction_id,revision_id,source_record_id,consume_date,posting_date,effective_date_basis)
      VALUES ($1,$2,$3,'2026-09-01','2026-09-03','consume-date')`, [transactionId, revisionOne, sourceLow]);
    assert.equal(await date(), "2026-09-01", "later lower source id wins deterministically");
    await store.query("DELETE FROM canonical_credit_card_transaction_details WHERE revision_id=$1 AND source_record_id=$2", [revisionOne, sourceLow]);
    assert.equal(await date(), "2026-09-02");

    await store.query("UPDATE current_transaction_enrichment SET taxonomy_code='transfer' WHERE transaction_id=$1", [transactionId]);
    assert.equal(await count(), 0);
    await store.query("UPDATE current_transaction_enrichment SET taxonomy_code='purchase' WHERE transaction_id=$1", [transactionId]);
    assert.equal(await count(), 1);
    for (const excluded of ["cash", "transfer.internal", "investment.buy", "payment.credit_card", "payment.loan.installment"]) {
      await store.query("UPDATE current_transaction_enrichment SET taxonomy_code=$2 WHERE transaction_id=$1", [transactionId, excluded]);
      assert.equal(await count(), 0, `${excluded} remains excluded`);
    }
    await store.query("UPDATE current_transaction_enrichment SET taxonomy_code='purchase' WHERE transaction_id=$1", [transactionId]);
    assert.equal(await count(), 1);
    await store.query("INSERT INTO current_spending_dedup_links(transaction_id,invoice_id) VALUES ($1,$2)", [transactionId, id(5)]);
    assert.equal(await count(), 0);
    await store.query("DELETE FROM current_spending_dedup_links WHERE transaction_id=$1", [transactionId]);
    assert.equal(await count(), 1);
    await store.query("UPDATE current_transactions SET revision_id=$2 WHERE transaction_id=$1", [transactionId, revisionTwo]);
    assert.equal(await count(), 0, "withdrawn current revision disappears");
    await store.query("UPDATE current_transactions SET revision_id=$2 WHERE transaction_id=$1", [transactionId, revisionOne]);
    assert.equal(await count(), 1);
    await store.query("SELECT refresh_current_spending_pairing_entry($1)", [transactionId]);
    await store.query("SELECT refresh_current_spending_pairing_entry($1)", [transactionId]);
    assert.equal(await count(), 1, "refresh is idempotent");
    await store.query("DELETE FROM current_spending_pairing_entries WHERE transaction_id=$1", [transactionId]);
    assert.equal(await count(), 0);
    await store.query("SELECT rebuild_current_spending_pairing_entries()");
    assert.equal(await count(), 1, "derived rows rebuild from authoritative current facts");
    await assert.rejects(store.transaction(async (transaction) => {
      await transaction.query("INSERT INTO current_spending_dedup_links(transaction_id,invoice_id) VALUES ($1,$2)", [transactionId, id(5)]);
      assert.equal(Number((await transaction.query<{ count: number | string }>("SELECT COUNT(*) AS count FROM current_spending_pairing_entries")).rows[0]?.count), 0);
      throw new Error("rollback projection fixture");
    }), /rollback projection fixture/u);
    assert.equal(await count(), 1, "rollback restores projection and canonical state");
    await store.close();
    store = new PGliteStore(await PGlite.create(directory));
    assert.equal(await count(), 1, "projection persists through reopen");
    await store.query("DELETE FROM current_transaction_enrichment WHERE transaction_id=$1", [transactionId]);
    assert.equal(await count(), 0, "reopened triggers remain active");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
