import assert from "node:assert/strict";
import test from "node:test";
import { insertPGliteCanonicalCommit } from "./canonical-commit.ts";
import { installFinancialStore } from "./store-layout.ts";
import { createSpendingCategoryFixture, type SpendingCategoryFixture } from "./spending-test-fixture.ts";

const idBytes = (id: string) => Buffer.from(id.replaceAll("-", ""), "hex");
const newId = "decode(replace(gen_random_uuid()::text, '-', ''), 'hex')";

/** What the refresh bug left behind: the transaction's Kind written again, unchanged, in a later commit. */
async function repeatKind(fixture: SpendingCategoryFixture, transactionId: string): Promise<void> {
  await fixture.store.transaction(async (transaction) => {
    const commit = await insertPGliteCanonicalCommit(transaction, { kind: "user_assertion", authorityRoute: "user/local", time: { kind: "wall-clock" } });
    const current = (await transaction.query<{ assertion_id: Uint8Array; run_id: Uint8Array }>(
      `SELECT assertion.assertion_id, output.run_id
         FROM assertions assertion JOIN enrichment_run_outputs output ON output.assertion_id = assertion.assertion_id
        WHERE assertion.transaction_id = $1 AND assertion.field_name = 'kind'
        ORDER BY (SELECT commit_sequence FROM canonical_commits WHERE commit_id = assertion.created_commit_id) DESC LIMIT 1`,
      [idBytes(transactionId)],
    )).rows[0]!;
    const ids = (await transaction.query<{ assertion_id: Uint8Array; run_id: Uint8Array }>(`SELECT ${newId} AS assertion_id, ${newId} AS run_id`)).rows[0]!;
    const [from, run, to, toRun, at] = [current.assertion_id, current.run_id, ids.assertion_id, ids.run_id, commit.id];
    await transaction.query(
      `INSERT INTO enrichment_runs(run_id, source_connection_id, identity_epoch_id, stream, producer_id, producer_version, origin, rule_lineage, observed_at, commit_id, status, complete_scope)
       SELECT $2, source_connection_id, identity_epoch_id, stream, producer_id, producer_version, origin, rule_lineage, observed_at, $3, status, complete_scope
         FROM enrichment_runs WHERE run_id = $1`,
      [run, toRun, at],
    );
    await transaction.query(
      `INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id)
       SELECT $2, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, $3
         FROM assertions WHERE assertion_id = $1`,
      [from, to, at],
    );
    await transaction.query(
      `INSERT INTO enrichment_run_outputs(output_id, run_id, transaction_id, field_name, output_state, origin, value_text, confidence_basis_points, route_id, source_record_id, source_field, source_value_text, provenance_json, assertion_id, commit_id)
       SELECT ${newId}, $3, transaction_id, field_name, output_state, origin, value_text, confidence_basis_points, route_id, source_record_id, source_field, source_value_text, provenance_json, $4, $5
         FROM enrichment_run_outputs WHERE assertion_id = $1 AND run_id = $2`,
      [from, run, toRun, to, at],
    );
    await transaction.query(
      "INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id) VALUES ($1, NULL, NULL, $2, NULL, $3)",
      [to, toRun, at],
    );
    await transaction.query(
      `INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, enrichment_run_id, coordinate_id, user_id, commit_id, event_kind)
       SELECT ${newId}, $2, transaction_id, field_name, NULL, NULL, NULL, $3, NULL, NULL, $4, 'observed'
         FROM assertions WHERE assertion_id = $1`,
      [from, to, toRun, at],
    );
    await transaction.query(
      `INSERT INTO enrichment_taxonomy_assertion_values(assertion_id, field_name, taxonomy_id, taxonomy_version, taxonomy_dimension, taxonomy_code, route_id, run_id, source_record_id, provenance_json)
       SELECT $2, field_name, taxonomy_id, taxonomy_version, taxonomy_dimension, taxonomy_code, route_id, $3, source_record_id, provenance_json
         FROM enrichment_taxonomy_assertion_values WHERE assertion_id = $1`,
      [from, to, toRun],
    );
    await transaction.query(
      "UPDATE current_transaction_enrichment SET assertion_id = $2 WHERE transaction_id = $1 AND field_name = 'kind'",
      [idBytes(transactionId), to],
    );
  });
}

test("a Kind written again unchanged is removed once, and every Kind, its evidence and the knowledge point stay (ADR 0144)", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const deposit = { namespace: "fubon", stream: "domestic-deposit", accountType: "depository" } as const;
    const fee = await fixture.addTransaction({ amount: "15", direction: "outflow", date: "2026-09-10", description: "手續費", account: "salary-account", accountStream: deposit });
    const card = await fixture.addTransaction({ amount: "320", date: "2026-09-11" });
    await installFinancialStore(fixture.database);
    for (let index = 0; index < 4; index += 1) for (const id of [fee, card]) await repeatKind(fixture, id);

    const kindRows = async () => Number((await fixture.store.query<{ n: number | string }>(
      "SELECT count(*) AS n FROM assertions WHERE field_name = 'kind' AND transaction_id = ANY($1::bytea[])", [[idBytes(fee), idBytes(card)]])).rows[0]!.n);
    const current = async () => (await fixture.store.query(
      `SELECT current.transaction_id, current.value_text, current.taxonomy_code, current.route_id, current.producer_version, current.projection_commit_id,
              (SELECT output.provenance_json::jsonb->>'evidenceKind'
                 FROM assertion_provenance provenance
                 JOIN enrichment_run_outputs output ON output.run_id = provenance.enrichment_run_id AND output.assertion_id = current.assertion_id
                WHERE provenance.assertion_id = current.assertion_id AND provenance.enrichment_run_id IS NOT NULL) AS evidence_kind
         FROM current_transaction_enrichment current ORDER BY current.transaction_id, current.field_name`,
    )).rows;
    assert.equal(await kindRows(), 10);
    const before = await current();
    const knowledge = await fixture.knowledgeAt();

    await fixture.store.query("DELETE FROM pglite_operational_migrations WHERE migration_key = $1", ["kind-duplicate-cleanup-v1"]);
    await installFinancialStore(fixture.database);
    assert.equal(await kindRows(), 2, "one Kind assertion per transaction");
    assert.deepEqual(await current(), before);
    assert.equal(await fixture.knowledgeAt(), knowledge, "the cleanup writes no commit");

    for (const id of [fee, card]) await repeatKind(fixture, id);
    await installFinancialStore(fixture.database);
    assert.equal(await kindRows(), 4, "a second open removes nothing");
  } finally {
    await fixture.close();
  }
});
