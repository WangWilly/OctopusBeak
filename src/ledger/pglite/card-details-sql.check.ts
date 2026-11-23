/**
 * A revision whose card details changed holds one details row per change
 * (ADR 0152), and every reader must take the row of the latest commit, not
 * whichever row a scan returns first or last.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { queryCurrentTransactionById, querySpendingReport } from "./spending-facts.ts";
import { createSpendingCategoryFixture, setKind } from "./spending-test-fixture.ts";
import type { PGliteStore } from "./transaction.ts";

const idBytes = (id: string) => Buffer.from(id.replaceAll("-", ""), "hex");
const filled = (byte: number) => Buffer.alloc(16, byte);

/**
 * Store another details row for the transaction's current revision, written
 * by a new commit and capture that cite a copy of its record under `recordId`.
 */
async function addLaterDetails(store: PGliteStore, transactionId: string, recordId: Buffer, consumeDate: string, ordinal: number): Promise<void> {
  const { rows: [current] } = await store.query<{ revision_id: Buffer; source_record_id: Buffer; capture_id: Buffer }>(
    `SELECT detail.revision_id, detail.source_record_id, detail.capture_id
       FROM current_transactions current_row
       JOIN canonical_credit_card_transaction_details detail ON detail.revision_id = current_row.revision_id
      WHERE current_row.transaction_id = $1 LIMIT 1`,
    [idBytes(transactionId)],
  );
  const commitId = filled(0x10 + ordinal);
  const captureId = filled(0x20 + ordinal);
  await store.exec(`
    CREATE TEMP TABLE later_commit AS SELECT * FROM canonical_commits LIMIT 0;
    CREATE TEMP TABLE later_capture AS SELECT * FROM source_captures LIMIT 0;
    CREATE TEMP TABLE later_record AS SELECT * FROM source_records LIMIT 0;
    CREATE TEMP TABLE later_detail AS SELECT * FROM canonical_credit_card_transaction_details LIMIT 0;`);
  await store.query(
    `INSERT INTO later_commit SELECT * FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1`);
  await store.query(
    `UPDATE later_commit SET commit_id = $1, commit_sequence = commit_sequence + 1`, [commitId]);
  await store.query(
    `INSERT INTO later_capture SELECT * FROM source_captures WHERE capture_id = $1`, [current!.capture_id]);
  await store.query(
    `UPDATE later_capture SET capture_id = $1, commit_id = $2, capture_key = capture_key || $3`, [captureId, commitId, `-later-${ordinal}`]);
  await store.query(
    `INSERT INTO later_record SELECT * FROM source_records WHERE source_record_id = $1`, [current!.source_record_id]);
  await store.query(
    `UPDATE later_record SET source_record_id = $1, capture_id = $2, commit_id = $3`, [recordId, captureId, commitId]);
  await store.query(
    `INSERT INTO later_detail SELECT * FROM canonical_credit_card_transaction_details WHERE revision_id = $1 AND source_record_id = $2`,
    [current!.revision_id, current!.source_record_id]);
  await store.query(
    `UPDATE later_detail SET source_record_id = $1, capture_id = $2, consume_date = $3`, [recordId, captureId, consumeDate]);
  await store.exec(`
    INSERT INTO canonical_commits SELECT * FROM later_commit;
    INSERT INTO source_captures SELECT * FROM later_capture;
    INSERT INTO source_records SELECT * FROM later_record;
    INSERT INTO canonical_credit_card_transaction_details SELECT * FROM later_detail;
    DROP TABLE later_commit, later_capture, later_record, later_detail;`);
}

test("every card details reader takes the row of the latest commit", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const transactionId = await fixture.addTransaction({
      amount: "100",
      date: "2026-09-10",
      card: { consumeDate: "2026-09-05", postingDate: "2026-09-10", cardMask: "****4281" },
    });
    await setKind(fixture.store, transactionId, "purchase");
    // Record ids chosen so that neither the lowest nor the highest id is the latest row.
    await addLaterDetails(fixture.store, transactionId, filled(0xff), "2026-09-06", 1);
    await addLaterDetails(fixture.store, transactionId, filled(0x80), "2026-09-07", 2);
    await addLaterDetails(fixture.store, transactionId, filled(0x01), "2026-09-08", 3);
    await addLaterDetails(fixture.store, transactionId, filled(0x40), "2026-09-09", 4);
    const { rows: [count] } = await fixture.store.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM canonical_credit_card_transaction_details");
    assert.equal(count!.count, 5, "the revision holds five details rows");

    // Read in primary-key order, so a reader that keeps the last row it sees reads by record id.
    for (const scan of ["seqscan", "indexscan"] as const) {
      await fixture.store.exec(scan === "indexscan"
        ? "SET enable_seqscan = off; SET enable_bitmapscan = off;"
        : "RESET enable_seqscan; RESET enable_bitmapscan;");
      const knowledgeAt = await fixture.knowledgeAt();
      const report = await querySpendingReport(fixture.store, "current", knowledgeAt, null, { startDate: "2026-09-01", endDate: "2026-09-30" });
      assert.equal(report.transactions.find((transaction) => transaction.transactionId === transactionId)?.consumeDate, "2026-09-09", `report (${scan})`);
      const unscoped = await querySpendingReport(fixture.store, "current", knowledgeAt, null);
      assert.equal(unscoped.transactions.find((transaction) => transaction.transactionId === transactionId)?.consumeDate, "2026-09-09", `report (${scan})`);
      const one = await queryCurrentTransactionById(fixture.store, knowledgeAt, transactionId);
      assert.equal(one?.consumeDate, "2026-09-09", `current transaction (${scan})`);
      const { rows: [pairing] } = await fixture.store.query<{ consume_date: string }>(
        "SELECT consume_date FROM current_spending_pairing_entries WHERE transaction_id = $1", [idBytes(transactionId)]);
      assert.equal(pairing?.consume_date, "2026-09-09", `pairing entry (${scan})`);
    }
  } finally {
    await fixture.close();
  }
});
