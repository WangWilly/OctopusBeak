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

test("rows whose Kind is interest or a fee, projected before the Kind decided a category, get it when the store next opens, once (ADR 0141)", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const deposit = { namespace: "fubon", stream: "domestic-deposit", accountType: "depository" } as const;
    const fee = await fixture.addTransaction({ amount: "15", direction: "outflow", date: "2026-09-10", description: "手續費", account: "salary-account", accountStream: deposit });
    const interest = await fixture.addTransaction({
      amount: "1200", direction: "inflow", date: "2026-09-21", account: "mortgage",
      accountStream: { namespace: "fubon", stream: "loan", accountType: "loan" }, event: { loan: "interest" },
    });
    await installFinancialStore(fixture.database);
    // A store projected before ADR 0141 held no category for these rows.
    await fixture.store.query("DELETE FROM current_transaction_enrichment WHERE field_name = 'category'");
    const tables = ["enrichment_taxonomy_assertion_values", "assertion_transitions", "assertion_provenance", "enrichment_run_outputs", "assertions"];
    for (const table of tables) await fixture.store.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    const scope = "SELECT assertion_id FROM assertions WHERE field_name = 'category' AND producer_id = $1";
    const producer = ["kind/category-enrichment"];
    await fixture.store.query(`DELETE FROM enrichment_taxonomy_assertion_values WHERE assertion_id IN (${scope})`, producer);
    await fixture.store.query(`DELETE FROM assertion_transitions WHERE assertion_id IN (${scope})`, producer);
    await fixture.store.query(`DELETE FROM assertion_provenance WHERE assertion_id IN (${scope})`, producer);
    await fixture.store.query("DELETE FROM enrichment_run_outputs WHERE field_name = 'category' AND route_id = $1", ["global/kind-category-enrichment/v1/category"]);
    await fixture.store.query("DELETE FROM assertions WHERE field_name = 'category' AND producer_id = $1", producer);
    for (const table of tables) await fixture.store.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    await fixture.store.query("DELETE FROM pglite_operational_migrations WHERE migration_key = $1", ["kind-rederivation-interest-and-fees-category-v1"]);
    const categories = async () => Promise.all([fee, interest].map(async (id) => (await fixture.store.query<{ taxonomy_code: string; origin: string }>(
      "SELECT taxonomy_code, origin FROM current_transaction_enrichment WHERE transaction_id = $1 AND field_name = 'category'", [idBytes(id)])).rows[0] ?? null));
    assert.deepEqual(await categories(), [null, null]);

    await installFinancialStore(fixture.database);
    assert.deepEqual(await categories(), [{ taxonomy_code: "interest_and_fees", origin: "derived" }, { taxonomy_code: "interest_and_fees", origin: "derived" }]);
    const before = await fixture.knowledgeAt();
    await installFinancialStore(fixture.database);
    assert.equal(await fixture.knowledgeAt(), before, "a second open re-derives nothing");
  } finally {
    await fixture.close();
  }
});

test("a card's interest or fee line projected as a purchase gets its Kind and the interest-and-fees category when the store next opens, once (ADR 0142)", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    // Projected before the card outflow classifier: the issuer's label read as a purchase.
    const fee = await fixture.addTransaction({ amount: "45", date: "2026-09-12", description: "測試商店" });
    await installFinancialStore(fixture.database);
    await fixture.store.query("ALTER TABLE transaction_revisions DISABLE TRIGGER USER");
    await fixture.store.query(
      `UPDATE transaction_revisions SET description = $2
        WHERE revision_id = (SELECT revision_id FROM current_transactions WHERE transaction_id = $1)`,
      [idBytes(fee), "國外交易服務費"],
    );
    await fixture.store.query("ALTER TABLE transaction_revisions ENABLE TRIGGER USER");
    await fixture.store.query("DELETE FROM pglite_operational_migrations WHERE migration_key = $1", ["kind-rederivation-credit-card-charge-kinds-v1"]);
    const read = async (field: string) => (await fixture.store.query<{ taxonomy_code: string }>(
      "SELECT taxonomy_code FROM current_transaction_enrichment WHERE transaction_id = $1 AND field_name = $2", [idBytes(fee), field])).rows[0]?.taxonomy_code ?? null;
    assert.deepEqual([await read("kind"), await read("category")], ["purchase", null]);

    await installFinancialStore(fixture.database);
    assert.deepEqual([await read("kind"), await read("category")], ["fee.card", "interest_and_fees"]);
    const before = await fixture.knowledgeAt();
    await installFinancialStore(fixture.database);
    assert.equal(await fixture.knowledgeAt(), before, "a second open re-derives nothing");
  } finally {
    await fixture.close();
  }
});
