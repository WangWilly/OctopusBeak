import assert from "node:assert/strict";
import test from "node:test";
import { installFinancialStore } from "./store-layout.ts";
import { createSpendingCategoryFixture } from "./spending-test-fixture.ts";

const idBytes = (id: string) => Buffer.from(id.replaceAll("-", ""), "hex");

test("a loan row captured before its producer existed gets its Kind when the store next opens, once", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    // Projected with no recorded event, as every loan row was before ADR 0138.
    const interest = await fixture.addTransaction({
      amount: "1200", direction: "inflow", date: "2026-09-21", account: "mortgage",
      accountStream: { namespace: "yuanta", stream: "loan", accountType: "loan" },
    });
    await installFinancialStore(fixture.database);
    await fixture.store.query(
      `INSERT INTO loan_transaction_facts(transaction_id, revision_id, source_record_id, capture_id, commit_id, occurrence_index, event_kind, event_source_code, event_evidence_contract_version)
       SELECT revision.transaction_id, revision.revision_id, revision.source_record_id, revision.capture_id, revision.commit_id, 1, 'interest', 'FIXTURE', 'fixture/loan-event'
         FROM current_transactions current_row JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
        WHERE current_row.transaction_id = $1`,
      [idBytes(interest)],
    );
    await fixture.store.query("DELETE FROM pglite_operational_migrations WHERE migration_key LIKE 'kind-rederivation-%'");
    const kindOf = async () => (await fixture.store.query<{ value_text: string }>(
      "SELECT value_text FROM current_transaction_enrichment WHERE transaction_id = $1 AND field_name = 'kind'", [idBytes(interest)])).rows[0]?.value_text ?? null;
    assert.equal(await kindOf(), null);

    await installFinancialStore(fixture.database);
    assert.equal(await kindOf(), "interest.charged");

    const before = await fixture.knowledgeAt();
    await installFinancialStore(fixture.database);
    assert.equal(await fixture.knowledgeAt(), before, "a second open re-derives nothing");
  } finally {
    await fixture.close();
  }
});

test("Cathay labels, Cathay foreign-currency rows and TDCC deposits get their Kind, and a store projected without them gains it on open", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const withdrawal = await fixture.addTransaction({
      amount: "1000", direction: "outflow", date: "2026-09-21", account: "cathay-twd", description: "自行提款",
      accountStream: { namespace: "cathay", stream: "domestic-deposit", accountType: "depository", institutionKey: "cathay" },
    });
    const foreign = await fixture.addTransaction({
      amount: "30", direction: "outflow", date: "2026-09-22", account: "cathay-usd", description: "跨行匯款",
      accountStream: { namespace: "cathay", stream: "foreign-currency-deposit", accountType: "depository", institutionKey: "cathay" },
    });
    const settlement = await fixture.addTransaction({
      amount: "500", direction: "inflow", date: "2026-09-23", account: "tdcc-fubon", description: "行動換匯 · 0123",
      accountStream: { namespace: "tdcc", stream: "domestic-deposit", accountType: "depository", institutionKey: "fubon" },
    });
    const kinds = async () => Promise.all([withdrawal, foreign, settlement].map(async (id) => (await fixture.store.query<{ value_text: string }>(
      "SELECT value_text FROM current_transaction_enrichment WHERE transaction_id = $1 AND field_name = 'kind'", [idBytes(id)])).rows[0]?.value_text ?? null));
    const expected = ["cash.withdrawal", "transfer.external", "transfer.internal"];
    assert.deepEqual(await kinds(), expected);

    // A store projected before this change held no Kind for these rows.
    await installFinancialStore(fixture.database);
    await fixture.store.query("DELETE FROM current_transaction_enrichment WHERE field_name = 'kind'");
    await fixture.store.query("DELETE FROM pglite_operational_migrations WHERE migration_key = $1", ["kind-rederivation-deposit-kind-gaps-v1"]);
    assert.deepEqual(await kinds(), [null, null, null]);
    await installFinancialStore(fixture.database);
    assert.deepEqual(await kinds(), expected);
  } finally {
    await fixture.close();
  }
});
