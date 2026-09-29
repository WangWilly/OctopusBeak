import assert from "node:assert/strict";
import test from "node:test";
import { createPGlitePairingPerformanceFixture } from "./spending-performance-fixture.ts";
import { createPGliteCanonicalOverviewQuery } from "./overview.ts";

test("overview batches lifecycle history without blocking reads and preserves withdrawal cutoffs", async () => {
  const fixture = await createPGlitePairingPerformanceFixture({ shape: { transactions: 1600, invoices: 3, links: 2 } });
  const { store } = fixture;
  try {
    // Reproduce statistics collected before a new source import.
    await store.exec("ANALYZE");
    await store.exec(`
      INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind)
      SELECT decode(md5('overview-commit-' || g), 'hex'), g, g, 'synthetic/overview', 'source_capture'
      FROM generate_series(3,600) AS series(g);
      INSERT INTO assertions(assertion_id,transaction_id,field_name,target_kind,origin,producer_id,rule_lineage,revision_id,created_commit_id)
      SELECT decode(md5('overview-assertion-' || encode(revision_id,'hex')), 'hex'), transaction_id,
             'transaction_revision','transaction','source','synthetic-overview','synthetic-overview/v1',revision_id,commit_id
      FROM transaction_revisions;
      INSERT INTO assertion_transitions(event_id,assertion_id,transaction_id,field_name,capture_id,commit_id,event_kind)
      SELECT decode(md5(encode(assertion.assertion_id,'hex') || '-' || g),'hex'), assertion.assertion_id,
             assertion.transaction_id,'transaction_revision',decode(repeat('05',16),'hex'),
             decode(md5('overview-commit-' || g),'hex'),
             CASE WHEN g=11 AND assertion.transaction_id IN (
               SELECT transaction_id FROM transaction_revisions ORDER BY transaction_id LIMIT 2
             ) THEN 'withdrawn'
             WHEN g=12 AND assertion.transaction_id=(SELECT transaction_id FROM transaction_revisions ORDER BY transaction_id LIMIT 1)
               THEN 'restored' ELSE 'observed' END
      FROM assertions assertion CROSS JOIN generate_series(3,12) AS series(g)
      WHERE assertion.origin='source' AND (g<=11 OR assertion.transaction_id=(SELECT transaction_id FROM transaction_revisions ORDER BY transaction_id LIMIT 1));
    `);
    const query = createPGliteCanonicalOverviewQuery(store);
    const started = performance.now();
    const current = await query.current();
    const elapsedMs = performance.now() - started;
    assert.equal(current.projection.transactions.length, 1599);
    assert.ok(elapsedMs < 2_000, `overview lifecycle read took ${Math.round(elapsedMs)} ms`);
    assert.equal((await query.historical({ knowledgeAt: 10 })).projection.transactions.length, 1600);
    assert.equal((await query.historical({ knowledgeAt: 11 })).projection.transactions.length, 1598);
    assert.equal((await query.historical({ knowledgeAt: 12 })).projection.transactions.length, 1599);
    assert.ok(performance.now() - started < 2_000, "current and historical lifecycle reads exceeded two seconds");
  } finally {
    await store.close();
  }
});
