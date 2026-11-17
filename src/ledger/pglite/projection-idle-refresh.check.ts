import assert from "node:assert/strict";
import test from "node:test";
import { insertPGliteCanonicalCommit } from "./canonical-commit.ts";
import { refreshPGliteCurrentProjectionInTransaction } from "./projection.ts";
import { resolvePGliteCanonicalInvestmentFundingRelations } from "./relations.ts";
import { syncEInvoiceItemCategorizations } from "./einvoice-item-categorization.ts";
import { setPGliteSpendingPurchaseAllocationInTransaction, setPGliteSpendingPurchaseCategory } from "./purchase-category-command.ts";
import { addPGliteTransactionTag, writePGliteTransactionNote } from "./transaction-detail-command.ts";
import { createSpendingCategoryFixture, type SpendingCategoryFixture } from "./spending-test-fixture.ts";

test("a refresh for a commit that touches no transaction writes no Kind and no commit", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    for (const amount of ["101", "102", "103"]) await fixture.addTransaction({ amount, date: "2026-09-10" });
    const counts = async () => {
      const count = async (sql: string) => Number((await fixture.store.query<{ n: number | string }>(sql)).rows[0]!.n);
      return {
        outputs: await count("SELECT count(*) AS n FROM enrichment_run_outputs"),
        assertions: await count("SELECT count(*) AS n FROM assertions"),
        commits: await count("SELECT count(*) AS n FROM canonical_commits"),
      };
    };
    const before = await counts();
    // What a balance-only capture leaves behind: a commit with no transaction in it.
    const idleRefresh = () =>
      fixture.store.transaction(async (transaction) => {
        const commit = await insertPGliteCanonicalCommit(transaction, { kind: "user_assertion", authorityRoute: "user/local", time: { kind: "wall-clock" } });
        await refreshPGliteCurrentProjectionInTransaction(transaction, { commitId: commit.id, cutoffSequence: commit.sequence, transactionIds: [] });
      });
    await idleRefresh();
    assert.deepEqual(await counts(), { ...before, commits: before.commits + 1 });
  } finally {
    await fixture.close();
  }
});

test("planner statistics follow a table that grows, and are left alone when nothing is appended", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const tables = ["assertions", "assertion_transitions", "enrichment_run_outputs"];
    const statistics = async () =>
      (
        await fixture.store.query<{ table_name: string; pages: number; analyzed_pages: number; written_by: string }>(
          `SELECT relname AS table_name,
                  (pg_relation_size(oid) / current_setting('block_size')::int)::int AS pages,
                  relpages AS analyzed_pages,
                  (SELECT string_agg(statistic.xmin::text, ',' ORDER BY statistic.staattnum)
                     FROM pg_statistic statistic WHERE statistic.starelid = pg_class.oid) AS written_by
             FROM pg_class WHERE oid = ANY($1::regclass[]) ORDER BY relname`,
          [tables],
        )
      ).rows;
    for (let index = 0; index < 60; index += 1) await fixture.addTransaction({ amount: String(200 + index), date: "2026-09-10" });
    const grown = await statistics();
    for (const row of grown) {
      assert.ok(row.pages > 1, `${row.table_name} spans more than one page`);
      assert.ok(row.pages <= row.analyzed_pages * 1.1, `${row.table_name} statistics cover its size`);
    }
    const idleRefresh = () =>
      fixture.store.transaction(async (transaction) => {
        const commit = await insertPGliteCanonicalCommit(transaction, { kind: "user_assertion", authorityRoute: "user/local", time: { kind: "wall-clock" } });
        await refreshPGliteCurrentProjectionInTransaction(transaction, { commitId: commit.id, cutoffSequence: commit.sequence, transactionIds: [] });
      });
    await idleRefresh();
    assert.deepEqual(await statistics(), grown);
    // What a rolled-back ANALYZE leaves behind: the page count it recorded, without its statistics.
    await fixture.store.query("DELETE FROM pg_statistic WHERE starelid = 'assertions'::regclass");
    await idleRefresh();
    const restored = (await statistics()).find((row) => row.table_name === "assertions")!;
    assert.ok(restored.written_by, "assertions has statistics again");
  } finally {
    await fixture.close();
  }
});

test("an unsupported Kind is recorded once until what it was read from changes", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const cathay = { namespace: "cathay", stream: "domestic-deposit", accountType: "depository" } as const;
    const unsupported = await fixture.addTransaction({ amount: "301", account: "cathay", accountStream: cathay, description: "opaque provider note" });
    const id = Uint8Array.from(Buffer.from(unsupported.replaceAll("-", ""), "hex"));
    const outputs = async () =>
      (await fixture.store.query<{ output_state: string; source_value_text: string }>(
        `SELECT output.output_state, output.source_value_text
           FROM enrichment_run_outputs output
           JOIN canonical_commits written ON written.commit_id = output.commit_id
          WHERE output.field_name = 'kind' AND output.transaction_id = $1
          ORDER BY written.commit_sequence`,
        [id],
      )).rows.map((row) => `${row.output_state}:${row.source_value_text}`);
    assert.deepEqual(await outputs(), ["unsupported:opaque provider note"]);
    for (const amount of ["302", "303"]) await fixture.addTransaction({ amount, date: "2026-09-10" });
    assert.deepEqual(await outputs(), ["unsupported:opaque provider note"], "a refresh of other transactions writes nothing for it");
    await fixture.reviseTransaction(unsupported, { amount: "301", accountStream: cathay, description: "another opaque note" });
    assert.deepEqual(await outputs(), ["unsupported:opaque provider note", "unsupported:another opaque note"]);
    await fixture.reviseTransaction(unsupported, { amount: "301", accountStream: cathay, description: "transfer" });
    await fixture.reviseTransaction(unsupported, { amount: "301", accountStream: cathay, description: "another opaque note" });
    assert.deepEqual(await outputs(), [
      "unsupported:opaque provider note",
      "unsupported:another opaque note",
      "supported:transfer",
      "unsupported:another opaque note",
    ], "an unsupported Kind after a supported one is written again");
    const withdrawal = await fixture.store.query<{ withdrawn: number | string; current: number | string }>(
      `SELECT (SELECT count(*) FROM assertion_transitions WHERE transaction_id = $1 AND field_name = 'kind' AND event_kind = 'withdrawn') AS withdrawn,
              (SELECT count(*) FROM current_transaction_enrichment WHERE transaction_id = $1 AND field_name = 'kind') AS current`,
      [id],
    );
    assert.deepEqual(withdrawal.rows.map((row) => [Number(row.withdrawn), Number(row.current)]), [[1, 0]], "it withdraws the supported Kind");
  } finally {
    await fixture.close();
  }
});

test("deriving again from unchanged facts grows no table beyond its own commit", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const cathay = { namespace: "cathay", stream: "domestic-deposit", accountType: "depository" } as const;
    const loan = { namespace: "fubon", stream: "loan", accountType: "loan" } as const;
    const exchange = { namespace: "maicoin", stream: "investment", accountType: "investment" } as const;
    await fixture.addTransaction({ amount: "401", date: "2026-09-10" });
    await fixture.addTransaction({ amount: "402", direction: "inflow", date: "2026-09-11" });
    await fixture.addTransaction({ amount: "403", account: "cathay", accountStream: cathay, description: "opaque provider note" });
    await fixture.addTransaction({ amount: "404", account: "cathay", accountStream: cathay, description: "transfer" });
    await fixture.addTransaction({ amount: "405", direction: "inflow", account: "mortgage", accountStream: loan, event: { loan: "interest" } });
    await fixture.addTransaction({ amount: "406", account: "exchange", accountStream: exchange, event: { investment: "buy" } });
    await fixture.commitInvoice({ stableKey: "XM00000001:2026-09-12", date: "2026-09-12", sellerName: "Bakery", items: [{ sequence: 1, name: "電影票", amount: "600" }, { sequence: 2, name: "Unknown", amount: "100" }] });
    const derived = await fixture.store.query<{ target_kind: string; field_name: string }>(
      "SELECT DISTINCT target_kind, field_name FROM assertions WHERE origin = 'derived' ORDER BY 1, 2");
    assert.deepEqual(derived.rows.map((row) => `${row.target_kind}.${row.field_name}`), ["einvoice_item.category", "transaction.category", "transaction.kind"]);

    await assertDerivingAgainGrowsOnlyItsCommit(fixture);
  } finally {
    await fixture.close();
  }
});

test("deriving again keeps every user choice and grows no table beyond its own commit", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const categorized = await fixture.addTransaction({ amount: "501", date: "2026-09-10" });
    const allocated = await fixture.addTransaction({ amount: "500", date: "2026-09-11" });
    const invoice = await fixture.commitInvoice({ stableKey: "XM00000002:2026-09-12", date: "2026-09-12", sellerName: "Cinema", items: [{ sequence: 1, name: "電影票", amount: "300" }] });
    await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId: `transaction:${categorized}`, knowledgeAt: await fixture.knowledgeAt(), categoryCode: "dining" });
    await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId: `invoice:${invoice}`, knowledgeAt: await fixture.knowledgeAt(), categoryCode: "gifts_and_donations" });
    const knowledgeAt = await fixture.knowledgeAt();
    await fixture.store.transaction(async (transaction) => {
      await setPGliteSpendingPurchaseAllocationInTransaction(transaction, {
        purchaseId: `transaction:${allocated}`,
        knowledgeAt,
        components: [
          { categoryCode: "dining", amount: { coefficient: "300", scale: 0, currency: "TWD" } },
          { categoryCode: "healthcare", amount: { coefficient: "200", scale: 0, currency: "TWD" } },
        ],
      });
      await writePGliteTransactionNote(transaction, { transactionId: categorized, note: "a note" });
      await addPGliteTransactionTag(transaction, { transactionId: categorized, label: "a tag" });
    });
    const choices = async () => ({
      assertions: (await fixture.store.query<{ field_name: string; value_text: string; state: string }>(
        `SELECT assertion.target_kind || '.' || assertion.field_name AS field_name, assertion.value_text,
                (SELECT transition.event_kind FROM assertion_transitions transition
                   JOIN canonical_commits event_commit ON event_commit.commit_id = transition.commit_id
                  WHERE transition.assertion_id = assertion.assertion_id
                  ORDER BY event_commit.commit_sequence DESC, encode(transition.event_id, 'hex') DESC LIMIT 1) AS state
           FROM assertions assertion WHERE assertion.origin = 'user'
          ORDER BY 1, 2, encode(assertion.assertion_id, 'hex')`)).rows,
      note: (await fixture.store.query<{ value_text: string; origin: string; user_assertion_id: string }>(
        "SELECT value_text, origin, encode(user_assertion_id, 'hex') AS user_assertion_id FROM current_transaction_fields WHERE field_name = 'note'")).rows,
      // What Spending reads a transaction's category and allocation from.
      categorizations: (await fixture.store.query<{ mode: string; category_code: string; amount_coefficient: string | null }>(
        `SELECT encode(transaction_id, 'hex') AS transaction_id, encode(assertion_id, 'hex') AS assertion_id, mode, category_code,
                component_ordinal, amount_coefficient, amount_scale, amount_currency
           FROM projection_generation_transaction_categorizations
          WHERE generation_id = (SELECT generation_id FROM projection_generations WHERE status = 'active')
          ORDER BY 1, component_ordinal`)).rows,
      items: (await fixture.store.query(
        `SELECT encode(invoice_id, 'hex') AS invoice_id, item_sequence, encode(assertion_id, 'hex') AS assertion_id, category_code
           FROM current_einvoice_item_categorizations WHERE origin = 'user' ORDER BY 1, 2`)).rows,
      tags: (await fixture.store.query(
        `SELECT encode(transaction_id, 'hex') AS transaction_id, encode(assertion_id, 'hex') AS assertion_id, display_label
           FROM current_transaction_tags ORDER BY 1, 2`)).rows,
    });
    const chosen = await choices();
    assert.deepEqual(
      {
        assertions: chosen.assertions.map((row) => `${row.field_name}:${/^[0-9a-f-]{36}$/u.test(row.value_text) ? "<tag id>" : row.value_text}:${row.state}`).sort(),
        note: chosen.note.map((row) => `${row.origin}:${row.value_text}`),
        categorizations: chosen.categorizations.map((row) => `${row.mode}:${row.category_code}:${row.amount_coefficient ?? "-"}`).sort(),
        items: chosen.items.length,
        tags: chosen.tags.length,
      },
      {
        assertions: [
          "einvoice_item.category:gifts_and_donations:observed",
          "transaction.category:__allocation__:observed",
          "transaction.category:dining:observed",
          "transaction.note:<tag id>:observed",
          "transaction.note:a note:observed",
        ],
        note: ["user:a note"],
        categorizations: ["allocated:dining:300", "allocated:healthcare:200", "single:dining:-"],
        items: 1,
        tags: 1,
      },
    );
    await assertDerivingAgainGrowsOnlyItsCommit(fixture);
    assert.deepEqual(await choices(), chosen, "every user choice stays current, on the same assertion");
  } finally {
    await fixture.close();
  }
});

test("deriving again with a MaiCoin TWD funding relation present grows no table beyond its own commit", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const bank = { namespace: "fubon", stream: "domestic-deposit", accountType: "depository" } as const;
    const exchange = { namespace: "maicoin", stream: "investment", accountType: "investment" } as const;
    await fixture.addTransaction({ amount: "0", direction: "outflow", date: "2026-09-10", account: "exchange", accountStream: exchange, event: { investment: "corporate_action_out", twdQuantity: "5000" } });
    const deposit = await fixture.addTransaction({ amount: "5000", direction: "inflow", date: "2026-09-11", account: "savings", accountStream: bank });
    await resolvePGliteCanonicalInvestmentFundingRelations(fixture.store, {});
    const kind = await fixture.store.query<{ value_text: string }>(
      "SELECT value_text FROM current_transaction_enrichment WHERE transaction_id = $1 AND field_name = 'kind'",
      [Buffer.from(deposit.replaceAll("-", ""), "hex")]);
    assert.deepEqual(kind.rows.map((row) => row.value_text), ["transfer.investment_withdrawal"]);

    await assertDerivingAgainGrowsOnlyItsCommit(fixture);
  } finally {
    await fixture.close();
  }
});

/** Re-derives every Kind, category and invoice item category twice over, from facts that did not change. */
async function assertDerivingAgainGrowsOnlyItsCommit(fixture: SpendingCategoryFixture): Promise<void> {
  const tables = (await fixture.store.query<{ table_name: string }>(
    "SELECT tablename AS table_name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((row) => row.table_name);
  const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (table) =>
    [table, Number((await fixture.store.query<{ n: number | string }>(`SELECT count(*) AS n FROM "${table}"`)).rows[0]!.n)])));
  const invoices = (await fixture.store.query<{ invoice_id: Uint8Array }>("SELECT invoice_id FROM einvoice_invoices")).rows;
  const transactions = (await fixture.store.query<{ transaction_id: Uint8Array }>("SELECT transaction_id FROM financial_transactions")).rows;
  const derive = {
    "a full refresh": { refreshEnrichmentAll: true },
    "a refresh of every transaction": { transactionIds: transactions.map((row) => row.transaction_id) },
  } as const;
  for (const pass of [1, 2])
    for (const [name, scope] of Object.entries(derive)) {
      const before = await counts();
      await fixture.store.transaction(async (transaction) => {
        const commit = await insertPGliteCanonicalCommit(transaction, { kind: "user_assertion", authorityRoute: "user/local", time: { kind: "wall-clock" } });
        await refreshPGliteCurrentProjectionInTransaction(transaction, { commitId: commit.id, cutoffSequence: commit.sequence, ...scope });
        for (const { invoice_id } of invoices)
          await syncEInvoiceItemCategorizations(transaction, { invoiceId: invoice_id, commitId: commit.id, observedAt: "2026-09-30T00:00:00Z" });
      });
      const after = await counts();
      const grew = Object.fromEntries(tables.filter((table) => after[table] !== before[table]).map((table) => [table, after[table]! - before[table]!]));
      // The pass's own commit and the knowledge event that records it.
      assert.deepEqual(grew, { canonical_commits: 1, projection_generation_provenance: 1 }, `${name}, pass ${pass}`);
    }
}
