import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createTestPGlite } from "./baseline-test-template.ts";
import { readPGliteCashFlow, type CashFlowReport } from "./cash-flow.ts";
import { commitCathay, commitTdccSettlement } from "./direct-source-precedence-fixture.ts";
import { applyManual, commitVerifiedDeposit, createManualAsset, twdSavings, writePreviewDeposits } from "./financial-pages.fixtures.ts";
import { applyPgliteManualAssetsSchema } from "./manual-assets.ts";
import { createPGlitePreviewFinancialData } from "./preview-financial-data.ts";
import { setPGliteSpendingPurchaseCategory } from "./purchase-category-command.ts";
import { createSpendingCategoryFixture, type FixtureTransactionInput, type SpendingCategoryFixture } from "./spending-test-fixture.ts";
import { PGliteStore } from "./transaction.ts";
import type { CashFlowClass } from "../canonical/cash-flow-inclusion.ts";

const SEPTEMBER = { startDate: "2026-09-01", endDate: "2026-09-30" } as const;
const idBytes = (id: string) => Buffer.from(id.replaceAll("-", ""), "hex");
const amount = (coefficient: string) => ({ coefficient, scale: 0 });
const unclassified = (coefficient: string) => [{ category: null, group: null, amount: amount(coefficient) }];

async function withFixture(run: (fixture: SpendingCategoryFixture) => Promise<void>) {
  const fixture = await createSpendingCategoryFixture();
  try {
    await applyPgliteManualAssetsSchema(fixture.store);
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

/** Replace the projected Kind, or remove it when `code` is null. */
async function setKind(store: PGliteStore, transactionId: string, code: string | null) {
  if (code === null) {
    await store.query("DELETE FROM current_transaction_enrichment WHERE transaction_id = $1 AND field_name = 'kind'", [idBytes(transactionId)]);
    return;
  }
  await store.query(
    "UPDATE current_transaction_enrichment SET taxonomy_code = $2, value_text = $2 WHERE transaction_id = $1 AND field_name = 'kind'",
    [idBytes(transactionId), code],
  );
}

async function addWithKind(fixture: SpendingCategoryFixture, code: string | null, input: FixtureTransactionInput) {
  const id = await fixture.addTransaction(input);
  await setKind(fixture.store, id, code);
  return id;
}

/** The source evidence a card refund carries when it names its original. */
async function relateRefund(store: PGliteStore, refundId: string, originalId: string) {
  await store.query(
    `INSERT INTO canonical_credit_card_relations(
       relation_id, integration_namespace, account_id, relation_kind, from_transaction_id, to_transaction_id,
       capture_id, evidence_source_record_id
     )
     SELECT $1, 'fubon', financial.account_id, 'refund_of', financial.transaction_id, $3, revision.capture_id, revision.source_record_id
       FROM financial_transactions financial
       JOIN current_transactions current_row ON current_row.transaction_id = financial.transaction_id
       JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
      WHERE financial.transaction_id = $2`,
    [idBytes(randomUUID()), idBytes(refundId), idBytes(originalId)],
  );
}

function classOf(report: CashFlowReport, transactionId: string): CashFlowClass | undefined {
  return report.transactions.find((transaction) => transaction.transactionId === transactionId)?.cashFlow;
}

test("each Kind class sorts its transaction into inflow, outflow, refund, not counted, or unresolved", async () => {
  await withFixture(async (fixture) => {
    const cases: readonly [string | null, "inflow" | "outflow", CashFlowClass][] = [
      ["income.employment.salary", "inflow", { class: "inflow", group: "income.employment.salary" }],
      ["income.dividend", "inflow", { class: "inflow", group: "income.dividend" }],
      ["interest.earned", "inflow", { class: "inflow", group: "interest.earned" }],
      ["receipt", "inflow", { class: "inflow", group: "other" }],
      ["purchase", "outflow", { class: "outflow", categories: unclassified("100") }],
      ["interest.charged", "outflow", { class: "outflow", categories: unclassified("100") }],
      ["fee.bank", "outflow", { class: "outflow", categories: unclassified("100") }],
      ["refund", "inflow", { class: "refund", categories: unclassified("100"), refundOf: null }],
      ["transfer.internal", "outflow", { class: "not_counted", reason: "transfer" }],
      ["payment.credit_card", "outflow", { class: "not_counted", reason: "card_payment" }],
      ["payment.loan", "outflow", { class: "not_counted", reason: "loan_principal" }],
      ["loan.disbursement", "inflow", { class: "not_counted", reason: "loan_disbursement" }],
      ["transfer.investment_contribution", "outflow", { class: "not_counted", reason: "investment_move" }],
      ["cash.withdrawal", "outflow", { class: "not_counted", reason: "cash_withdrawal" }],
      [null, "outflow", { class: "unresolved" }],
    ];
    const ids: string[] = [];
    for (const [code, direction] of cases) ids.push(await addWithKind(fixture, code, { amount: "100", direction, date: "2026-09-10" }));
    const report = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual(ids.map((id) => classOf(report, id)), cases.map(([, , expected]) => expected));
    const kindOf = (index: number) => report.transactions.find((transaction) => transaction.transactionId === ids[index])?.kind;
    assert.deepEqual(kindOf(0), { code: "income.employment.salary", basis: "evidence" });
    assert.deepEqual(kindOf(3), { code: "receipt", basis: "fallback" });
    assert.deepEqual(kindOf(4), { code: "purchase", basis: "fallback" });
    assert.equal(kindOf(14), null);
    const [twd] = report.totals;
    assert.deepEqual(twd?.unresolved, { amount: amount("100"), count: 1 });
    assert.deepEqual(twd?.inflow.amount, amount("400"));
  });
});

test("a card purchase counts on its consume date, and a pending authorization does not count", async () => {
  await withFixture(async (fixture) => {
    const charged = await fixture.addTransaction({ amount: "480", date: "2026-09-30", card: { consumeDate: "2026-09-30", postingDate: "2026-10-02" } });
    const pending = await fixture.addTransaction({ amount: "75", date: "2026-09-29" });
    await fixture.store.query("UPDATE transaction_revisions SET posting_status = 'pending' WHERE transaction_id = $1", [idBytes(pending)]);
    const september = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual(september.transactions.map((transaction) => [transaction.transactionId, transaction.date]), [[charged, "2026-09-30"]]);
    const october = await readPGliteCashFlow(fixture.store, { startDate: "2026-10-01", endDate: "2026-10-31" });
    assert.deepEqual(october.transactions, []);
  });
});

test("a cash withdrawal followed by manual cash spending counts the spending once", async () => {
  await withFixture(async (fixture) => {
    const withdrawal = await addWithKind(fixture, "cash.withdrawal", { amount: "3000", date: "2026-09-05" });
    const { assetId: wallet } = await applyManual(fixture.store, createManualAsset("cash", "Wallet", "TWD", "2026-09-01", "500", "counted"));
    const { assetId: jar } = await applyManual(fixture.store, createManualAsset("cash", "Jar", "TWD", "2026-09-01", "100", "counted"));
    const add = (accountId: string, transaction: object) => applyManual(fixture.store, { kind: "addTransaction", accountId, transaction });
    await add(wallet!, { kind: "purchase", personalCategory: "dining", occurredOn: "2026-09-06", amount: "1200", note: null });
    await add(wallet!, { kind: "receipt", occurredOn: "2026-09-07", amount: "300", note: null });
    await add(wallet!, { kind: "transfer", direction: "out", counterpartAccountId: jar, occurredOn: "2026-09-08", amount: "1000", note: null });

    const report = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual(classOf(report, withdrawal), { class: "not_counted", reason: "cash_withdrawal" });
    const manual = report.transactions.filter((transaction) => transaction.source === "manual")
      .map((transaction) => JSON.stringify([transaction.date, transaction.accountId, transaction.direction, transaction.cashFlow]));
    assert.deepEqual(manual.sort(), [
      ["2026-09-06", wallet, "outflow", { class: "outflow", categories: [{ category: "dining", group: "dining", amount: amount("1200") }] }],
      ["2026-09-07", wallet, "inflow", { class: "inflow", group: "other" }],
      ["2026-09-08", wallet, "outflow", { class: "not_counted", reason: "transfer" }],
      ["2026-09-08", jar, "inflow", { class: "not_counted", reason: "transfer" }],
    ].map((entry) => JSON.stringify(entry)).sort());
    const [twd] = report.totals;
    assert.deepEqual(twd?.outflow, { amount: amount("1200"), count: 1, groups: [{ group: "dining", amount: amount("1200"), count: 1 }] });
    assert.deepEqual(twd?.inflow.amount, amount("300"));
  });
});

test("a refund reduces its original's category only through refund_of, otherwise the Unclassified outflow", async () => {
  await withFixture(async (fixture) => {
    const original = await fixture.addTransaction({ amount: "1000", date: "2026-08-28" });
    await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId: `transaction:${original}`, knowledgeAt: await fixture.knowledgeAt(), categoryCode: "dining" });
    const outflow = await fixture.addTransaction({ amount: "600", date: "2026-09-02" });
    await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId: `transaction:${outflow}`, knowledgeAt: await fixture.knowledgeAt(), categoryCode: "dining" });
    const related = await fixture.addTransaction({ amount: "200", date: "2026-09-05", direction: "inflow" });
    await relateRefund(fixture.store, related, original);
    const loose = await fixture.addTransaction({ amount: "50", date: "2026-09-06", direction: "inflow" });

    const report = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual(classOf(report, related), {
      class: "refund", categories: [{ category: "dining", group: "dining", amount: amount("200") }], refundOf: original,
    }, "the original lies outside the range and still lends its category");
    assert.deepEqual(classOf(report, loose), { class: "refund", categories: unclassified("50"), refundOf: null });
    const [twd] = report.totals;
    assert.deepEqual(twd?.outflow.groups, [
      { group: null, amount: { coefficient: "-50", scale: 0 }, count: 1 },
      { group: "dining", amount: amount("400"), count: 2 },
    ]);
    assert.deepEqual(twd?.outflow.amount, amount("350"));
    assert.deepEqual(twd?.inflow, { amount: amount("0"), count: 0, groups: [] });
  });
});

test("a TDCC account that a direct source covers leaves Cash flow", async () => {
  const store = new PGliteStore(await createTestPGlite("full"));
  try {
    const august = { startDate: "2026-08-01", endDate: "2026-08-31" };
    await commitTdccSettlement(store, "013");
    const uncovered = await readPGliteCashFlow(store, august);
    assert.equal(uncovered.transactions.length, 2, "TDCC rows carry no Kind, so they count as unresolved while uncovered");
    assert.ok(uncovered.transactions.every((transaction) => transaction.cashFlow.class === "unresolved"));

    await commitCathay(store);
    assert.deepEqual((await readPGliteCashFlow(store, august)).transactions, []);
  } finally {
    await store.close();
  }
});

test("Preview Financial Data never enters Cash flow", async () => {
  const store = new PGliteStore(await createTestPGlite("full"));
  try {
    await commitVerifiedDeposit(store);
    await writePreviewDeposits(createPGlitePreviewFinancialData(store), twdSavings);
    const report = await readPGliteCashFlow(store, { startDate: "2026-10-01", endDate: "2026-10-31" });
    assert.deepEqual(report.transactions.map((transaction) => [transaction.source, transaction.amount.coefficient]), [["canonical", "100"]]);
  } finally {
    await store.close();
  }
});
