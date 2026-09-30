import assert from "node:assert/strict";
import test from "node:test";
import { createPGlitePairingPerformanceFixture } from "./spending-performance-fixture.ts";
import { refreshPGliteCurrentProjectionInTransaction } from "./projection.ts";

test("projection refreshes stale import statistics before planning and preserves lifecycle cutoffs", async () => {
  const fixture = await createPGlitePairingPerformanceFixture({ shape: { transactions: 300, invoices: 3, links: 2 } });
  const { store } = fixture;
  try {
    // Reproduce statistics collected before a new source import.
    await store.exec("ANALYZE");
    await store.exec(`
      INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind)
      SELECT decode(md5('projection-commit-' || g), 'hex'), g, g, 'synthetic/projection', 'source_capture'
      FROM generate_series(3,600) AS series(g);
      INSERT INTO assertions(assertion_id,transaction_id,field_name,target_kind,origin,producer_id,rule_lineage,revision_id,created_commit_id)
      SELECT decode(md5('projection-assertion-' || encode(revision_id,'hex')), 'hex'), transaction_id,
             'transaction_revision','transaction','source','synthetic-projection','synthetic-projection/v1',revision_id,commit_id
      FROM transaction_revisions;
      INSERT INTO assertion_transitions(event_id,assertion_id,transaction_id,field_name,capture_id,commit_id,event_kind)
      SELECT decode(md5(encode(assertion.assertion_id,'hex') || '-' || g),'hex'), assertion.assertion_id,
             assertion.transaction_id,'transaction_revision',decode(repeat('05',16),'hex'),
             decode(md5('projection-commit-' || g),'hex'),
             CASE WHEN g=11 AND assertion.transaction_id IN (
               SELECT transaction_id FROM transaction_revisions ORDER BY transaction_id LIMIT 2
             ) THEN 'withdrawn'
             WHEN g=12 AND assertion.transaction_id=(SELECT transaction_id FROM transaction_revisions ORDER BY transaction_id LIMIT 1)
               THEN 'restored' ELSE 'observed' END
      FROM assertions assertion CROSS JOIN generate_series(3,12) AS series(g)
      WHERE assertion.origin='source' AND (g<=11 OR assertion.transaction_id=(SELECT transaction_id FROM transaction_revisions ORDER BY transaction_id LIMIT 1));
    `);
    const ids = (await store.query<{ transaction_id: Uint8Array }>(
      "SELECT transaction_id FROM financial_transactions",
    )).rows.map((row) => row.transaction_id);
    const assertionCount = Number((await store.query<{ count: string }>(
      "SELECT count(*) AS count FROM assertions",
    )).rows[0]!.count);
    for (const [cutoffSequence, expectedCount] of [[10, 300], [11, 298], [12, 299]] as const) {
      let statisticsChecked = false;
      await store.transaction((transaction) => refreshPGliteCurrentProjectionInTransaction({
        ...transaction,
        query: async (sql, params, options) => {
          if (sql.includes("SELECT revision.transaction_id, revision.revision_id")) {
            statisticsChecked = true;
            // Assert at the actual planner boundary, before a slow query can
            // block the worker. Bulk imports must refresh stale table estimates.
            const estimated = Number((await transaction.query<{ reltuples: number }>(
              "SELECT reltuples FROM pg_class WHERE oid = 'assertions'::regclass",
            )).rows[0]!.reltuples);
            assert.ok(estimated >= assertionCount * 0.9,
              `projection used stale assertion estimate ${estimated} for ${assertionCount} rows`);
          }
          return transaction.query(sql, params, options);
        },
      }, {
        commitId: Uint8Array.from(Buffer.from("01".repeat(16), "hex")),
        cutoffSequence,
        transactionIds: ids,
      }));
      assert.equal(statisticsChecked, true, "projection planner boundary was not exercised");
      assert.equal(Number((await store.query<{ count: string }>(
        "SELECT count(*) AS count FROM current_transactions",
      )).rows[0]!.count), expectedCount);
    }
  } finally {
    await store.close();
  }
});
