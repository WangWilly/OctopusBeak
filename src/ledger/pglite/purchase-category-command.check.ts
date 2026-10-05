import assert from "node:assert/strict";
import test from "node:test";
import { createSpendingCategoryFixture, type SpendingCategoryFixture } from "./spending-test-fixture.ts";
import { createPGliteSpendingQuery } from "./spending-query.ts";
import {
  parsePurchaseIdentity,
  setPGliteSpendingPurchaseCategory,
  SpendingPurchaseCategoryError,
} from "./purchase-category-command.ts";

async function transactionUserCategory(fixture: SpendingCategoryFixture, transactionId: string) {
  const rows = await fixture.store.query<{ category_code: string | null; mode: string }>(
    `SELECT projected.category_code, projected.mode
       FROM projection_generation_transaction_categorizations projected
       JOIN active_projection_generation active ON active.generation_id = projected.generation_id
      WHERE projected.transaction_id = decode(replace($1, '-', ''), 'hex')
      ORDER BY projected.component_ordinal`,
    [transactionId],
  );
  return rows.rows.map((row) => ({ code: row.category_code, mode: row.mode }));
}

async function userLineage(fixture: SpendingCategoryFixture, transactionId: string) {
  const rows = await fixture.store.query<{ value_text: string; events: string[] }>(
    `SELECT assertion.value_text,
            ARRAY(SELECT transition.event_kind FROM assertion_transitions transition
                   JOIN canonical_commits commit_row ON commit_row.commit_id = transition.commit_id
                  WHERE transition.assertion_id = assertion.assertion_id
                  ORDER BY commit_row.commit_sequence) AS events
       FROM assertions assertion
       JOIN canonical_commits created ON created.commit_id = assertion.created_commit_id
      WHERE assertion.transaction_id = decode(replace($1, '-', ''), 'hex')
        AND assertion.origin = 'user' AND assertion.field_name = 'category'
      ORDER BY created.commit_sequence`,
    [transactionId],
  );
  return rows.rows.map((row) => ({ code: row.value_text, events: row.events }));
}

async function itemRows(fixture: SpendingCategoryFixture) {
  const rows = await fixture.store.query<{ item_sequence: number | string; origin: string; category_code: string }>(
    "SELECT item_sequence, origin, category_code FROM current_einvoice_item_categorizations ORDER BY item_sequence",
  );
  return rows.rows.map((row) => [Number(row.item_sequence), row.origin, row.category_code]);
}

test("purchase ids parse into typed identities and unknown bases are rejected", () => {
  const id = "0123456789abcdef0123456789abcdef";
  const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  assert.deepEqual(parsePurchaseIdentity(`transaction:${uuid}`), { basis: "bank-transaction", transactionId: uuid });
  assert.deepEqual(parsePurchaseIdentity(`link:${uuid}`), { basis: "linked", eventId: uuid });
  assert.deepEqual(parsePurchaseIdentity(`invoice:${uuid}`), { basis: "invoice", invoiceId: uuid });
  assert.deepEqual(parsePurchaseIdentity(`refund:${uuid}`), { basis: "refund", refundId: uuid });
  assert.throws(() => parsePurchaseIdentity(`candidate:${uuid}`), /unknown basis/u);
  assert.throws(() => parsePurchaseIdentity("transaction:not-a-uuid"), /canonical UUID/u);
});

test("a bank-only purchase writes, supersedes, and clears one user transaction category", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const transactionId = await fixture.addTransaction({ amount: "350", description: "Fixture purchase" });
    const purchaseId = `transaction:${transactionId}`;
    const base = await fixture.knowledgeAt();

    await assert.rejects(
      setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId, knowledgeAt: base - 1, categoryCode: "dining" }),
      (error: unknown) => error instanceof SpendingPurchaseCategoryError && error.code === "stale",
    );
    await assert.rejects(
      setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId, knowledgeAt: base, categoryCode: "other" }),
      (error: unknown) => error instanceof SpendingPurchaseCategoryError && error.code === "invalid",
    );
    assert.equal(await fixture.knowledgeAt(), base, "rejected requests write no commit");

    const first = await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId, knowledgeAt: base, categoryCode: "dining" });
    assert.deepEqual(first, { purchaseId, subject: "transaction", categoryCode: "dining", baseKnowledgeAt: base, knowledgeAt: base + 1 });
    assert.deepEqual(await transactionUserCategory(fixture, transactionId), [{ code: "dining", mode: "single" }]);

    const repeat = await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId, knowledgeAt: base + 1, categoryCode: "dining" });
    assert.equal(repeat.knowledgeAt, base + 1, "setting the same code again writes no commit");

    const second = await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId, knowledgeAt: base + 1, categoryCode: "healthcare" });
    assert.equal(second.knowledgeAt, base + 2);
    assert.deepEqual(await transactionUserCategory(fixture, transactionId), [{ code: "healthcare", mode: "single" }]);

    const cleared = await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId, knowledgeAt: base + 2, categoryCode: null });
    assert.equal(cleared.knowledgeAt, base + 3);
    assert.deepEqual(await transactionUserCategory(fixture, transactionId), []);
    assert.deepEqual(await userLineage(fixture, transactionId), [
      { code: "dining", events: ["observed", "superseded"] },
      { code: "healthcare", events: ["observed", "withdrawn"] },
    ]);
    const clearedAgain = await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId, knowledgeAt: base + 3, categoryCode: null });
    assert.equal(clearedAgain.knowledgeAt, base + 3, "clearing an absent user category is a no-op");
  } finally {
    await fixture.close();
  }
});

test("a category incompatible with the transaction Kind is rejected without a write", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const transactionId = await fixture.addTransaction({ amount: "900", direction: "inflow", description: "Fixture refund" });
    const kind = await fixture.store.query<{ taxonomy_code: string }>(
      "SELECT taxonomy_code FROM current_transaction_enrichment WHERE field_name = 'kind' AND transaction_id = decode(replace($1, '-', ''), 'hex')",
      [transactionId],
    );
    assert.equal(kind.rows[0]?.taxonomy_code, "refund");
    const base = await fixture.knowledgeAt();
    await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId: `transaction:${transactionId}`, knowledgeAt: base, categoryCode: "dining" });
    assert.deepEqual(await transactionUserCategory(fixture, transactionId), [{ code: "dining", mode: "single" }], "Kind refund accepts a category even though an inflow is not a Spending purchase row");
    const outflow = await fixture.addTransaction({ amount: "100", description: "Fixture purchase" });
    const current = await fixture.knowledgeAt();
    await fixture.store.query(
      `UPDATE current_transaction_enrichment SET taxonomy_code = 'transfer.internal', value_text = 'transfer.internal'
        WHERE field_name = 'kind' AND transaction_id = decode(replace($1, '-', ''), 'hex')`,
      [outflow],
    );
    await assert.rejects(
      setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId: `transaction:${outflow}`, knowledgeAt: current, categoryCode: "dining" }),
      (error: unknown) => error instanceof SpendingPurchaseCategoryError && error.code === "ineligible" && /incompatible with Kind transfer.internal/u.test(error.message),
    );
    assert.equal(await fixture.knowledgeAt(), current);
  } finally {
    await fixture.close();
  }
});

test("an invoice-only purchase writes every item and clearing falls back to the Derived items", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const invoiceId = await fixture.commitInvoice({
      stableKey: "AB11111111:2026-09-01",
      sellerName: "全聯實業股份有限公司",
      items: [{ sequence: 1, name: "鮮奶", amount: "90" }, { sequence: 2, name: "Unlabelled", amount: "60" }],
    });
    assert.deepEqual(await itemRows(fixture), [[1, "derived", "food_and_groceries"], [2, "derived", "food_and_groceries"]]);
    const purchaseId = `invoice:${invoiceId}`;
    const base = await fixture.knowledgeAt();
    const set = await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId, knowledgeAt: base, categoryCode: "gifts_and_donations" });
    assert.deepEqual(set, { purchaseId, subject: "items", categoryCode: "gifts_and_donations", baseKnowledgeAt: base, knowledgeAt: base + 1 });
    assert.deepEqual(await itemRows(fixture), [[1, "user", "gifts_and_donations"], [2, "user", "gifts_and_donations"]]);
    const again = await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId, knowledgeAt: base + 1, categoryCode: "gifts_and_donations" });
    assert.equal(again.knowledgeAt, base + 1, "repeating the same item category writes no commit");
    const cleared = await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId, knowledgeAt: base + 1, categoryCode: null });
    assert.equal(cleared.knowledgeAt, base + 2);
    assert.deepEqual(await itemRows(fixture), [[1, "derived", "food_and_groceries"], [2, "derived", "food_and_groceries"]]);
    const commits = await fixture.store.query<{ commit_kind: string }>("SELECT commit_kind FROM canonical_commits WHERE commit_sequence > $1 ORDER BY commit_sequence", [base]);
    assert.deepEqual(commits.rows.map((row) => row.commit_kind), ["user_assertion", "user_assertion"]);
  } finally {
    await fixture.close();
  }
});

test("a linked purchase writes the transaction subject, not the items, and refunds are rejected", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const transactionId = await fixture.addTransaction({ amount: "150" });
    const invoiceId = await fixture.commitInvoice({
      stableKey: "AB22222222:2026-09-01",
      items: [{ sequence: 1, name: "拿鐵", amount: "150" }],
    });
    const eventId = await fixture.link(invoiceId, transactionId);
    const base = await fixture.knowledgeAt();
    await assert.rejects(
      setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId: `invoice:${invoiceId}`, knowledgeAt: base, categoryCode: "dining" }),
      (error: unknown) => error instanceof SpendingPurchaseCategoryError && error.code === "stale",
      "the invoice purchase id is stale once linked",
    );
    const result = await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId: `link:${eventId}`, knowledgeAt: base, categoryCode: "healthcare" });
    assert.equal(result.subject, "transaction");
    assert.deepEqual(await transactionUserCategory(fixture, transactionId), [{ code: "healthcare", mode: "single" }]);
    assert.deepEqual(await itemRows(fixture), [[1, "derived", "dining"]], "items keep their Derived reading");
    await assert.rejects(
      setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId: `refund:${invoiceId}`, knowledgeAt: result.knowledgeAt, categoryCode: "dining" }),
      (error: unknown) => error instanceof SpendingPurchaseCategoryError && error.code === "ineligible",
    );
  } finally {
    await fixture.close();
  }
});

test("the record page reads an invoice-only purchase's user category after the change", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const invoiceId = await fixture.commitInvoice({
      stableKey: "AB22222222:2026-09-02",
      sellerName: "全聯實業股份有限公司",
      items: [{ sequence: 1, name: "鮮奶", amount: "90" }],
    });
    const purchaseId = `invoice:${invoiceId}`;
    const query = createPGliteSpendingQuery(fixture.store as never);
    const read = async (knowledgeAt: number) =>
      (await query.recordPage({ knowledgeAt, month: "2026-09", limit: 50 })).records.find((record) => record.purchaseId === purchaseId)?.category;
    const base = await fixture.knowledgeAt();
    assert.deepEqual(pickCategory(await read(base)), { mode: "single", origin: "derived", categoryCode: "food_and_groceries" });
    const set = await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId, knowledgeAt: base, categoryCode: "gifts_and_donations" });
    assert.deepEqual(pickCategory(await read(set.knowledgeAt)), { mode: "single", origin: "user", categoryCode: "gifts_and_donations" });
    const summary = (await query.summaryPage()).purchaseReport.summary;
    assert.ok(
      summary?.categoryTotalsByMonth?.some((row) => row.month === "2026-09" && row.categoryCode === "gifts_and_donations"),
      "the month totals move to the user's category",
    );
  } finally {
    await fixture.close();
  }
});

function pickCategory(category: unknown) {
  const value = category as { mode: string; origin?: string; categoryCode?: string } | undefined;
  return value && { mode: value.mode, origin: value.origin, categoryCode: value.categoryCode };
}
