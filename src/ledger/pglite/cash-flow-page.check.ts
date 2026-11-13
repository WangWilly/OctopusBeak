import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { previousCashFlowPeriod, readCashFlowPage } from "./cash-flow-page.ts";
import { readPGliteCashFlow, shiftDate } from "./cash-flow.ts";
import { amountQuery, cashFlowMatches, readCashFlowSearchMatches } from "./cash-flow-search.ts";
import { applyPgliteCashFlowTransferSchema } from "./cash-flow-transfer.ts";
import { applyManual, createManualAsset } from "./financial-pages.fixtures.ts";
import { readKnowledgePoint } from "./knowledge-point.ts";
import { applyPgliteManualAssetsSchema } from "./manual-assets.ts";
import { setPGliteSpendingPurchaseCategory } from "./purchase-category-command.ts";
import { applyPGliteFinancialPageAction } from "./spending-command.ts";
import { createSpendingCategoryFixture, setKind, type FixtureTransactionInput, type SpendingCategoryFixture } from "./spending-test-fixture.ts";
import type { PGliteStore } from "./transaction.ts";
import type { FinancialPageActionRequest } from "../../lib/financial/page-actions.ts";
import { pickerChoice, pickerQuick, quickChoice, quickRange, rollRange } from "../../lib/cash-flow/period.ts";

const OCTOBER = { startDate: "2026-10-01", endDate: "2026-10-10" } as const;
const idBytes = (id: string) => Buffer.from(id.replaceAll("-", ""), "hex");
const amount = (coefficient: string) => ({ coefficient, scale: 0 });

async function withFixture(run: (fixture: SpendingCategoryFixture) => Promise<void>) {
  const fixture = await createSpendingCategoryFixture();
  try {
    await applyPgliteManualAssetsSchema(fixture.store);
    await applyPgliteCashFlowTransferSchema(fixture.store);
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

/** Every `addTransaction` re-projects all Kinds, so Kinds are set after the last one. */
async function addWithKinds(fixture: SpendingCategoryFixture, entries: readonly (readonly [string, FixtureTransactionInput])[]) {
  const ids: string[] = [];
  for (const [, input] of entries) ids.push(await fixture.addTransaction(input));
  for (const [index, [code]] of entries.entries()) {
    await fixture.store.query(
      "UPDATE current_transaction_enrichment SET taxonomy_code = $2, value_text = $2 WHERE transaction_id = $1 AND field_name = 'kind'",
      [idBytes(ids[index]!), code],
    );
  }
  return ids;
}

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

async function categorize(fixture: SpendingCategoryFixture, transactionId: string, categoryCode: string) {
  await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId: `transaction:${transactionId}`, knowledgeAt: await fixture.knowledgeAt(), categoryCode });
}

async function setCounterparty(store: PGliteStore, transactionId: string, value: string) {
  await store.query(
    `INSERT INTO current_transaction_enrichment(
       transaction_id, field_name, assertion_id, value_text, origin, producer_id, producer_version, route_id,
       taxonomy_id, taxonomy_version, taxonomy_dimension, taxonomy_code, projection_commit_id
     )
     SELECT transaction_id, 'counterparty_display', assertion_id, $2, origin, producer_id, producer_version, route_id,
            taxonomy_id, taxonomy_version, 'counterparty_display', NULL, projection_commit_id
       FROM current_transaction_enrichment
      WHERE transaction_id = $1 AND field_name = 'kind'`,
    [idBytes(transactionId), value],
  );
}

/** A user note on a canonical row, through the same assertion the projection reads. */
async function setNote(store: PGliteStore, transactionId: string, value: string) {
  const assertionId = idBytes(randomUUID());
  await store.query(
    `INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, value_text, created_commit_id)
     SELECT $1, transaction_id, 'note', 'transaction', 'user', 'check', 'check', $3, commit_id FROM current_transactions WHERE transaction_id = $2`,
    [assertionId, idBytes(transactionId), value],
  );
  await store.query(
    `INSERT INTO current_transaction_fields(transaction_id, field_name, value_text, origin, user_assertion_id, projection_commit_id)
     SELECT transaction_id, 'note', $3, 'user', $1, projection_commit_id FROM current_transactions WHERE transaction_id = $2`,
    [assertionId, idBytes(transactionId), value],
  );
}

async function setTime(store: PGliteStore, transactionId: string, local: string, precision: string, origin: string) {
  await store.query(
    `UPDATE transaction_revisions SET transaction_date_time_local = $2, time_precision = $3, time_origin = $4
      WHERE revision_id = (SELECT revision_id FROM current_transactions WHERE transaction_id = $1)`,
    [idBytes(transactionId), local, precision, origin],
  );
}

test("the previous period has the same number of days and ends the day before", () => {
  assert.deepEqual(previousCashFlowPeriod(OCTOBER), { startDate: "2026-09-21", endDate: "2026-09-30", days: 10 });
  assert.deepEqual(previousCashFlowPeriod({ startDate: "2026-03-01", endDate: "2026-03-31" }), { startDate: "2026-01-29", endDate: "2026-02-28", days: 31 });
});

test("totals net refunds into their category, keep transfers out, and compare with the previous period", async () => {
  await withFixture(async (fixture) => {
    const [, previousPurchase, salary, purchase, refund, transfer] = await addWithKinds(fixture, [
      ["income.employment.salary", { amount: "1000", direction: "inflow", date: "2026-09-25" }],
      ["purchase", { amount: "500", date: "2026-09-26" }],
      ["income.employment.salary", { amount: "1000", direction: "inflow", date: "2026-10-02" }],
      ["purchase", { amount: "300", date: "2026-10-03" }],
      ["refund", { amount: "100", direction: "inflow", date: "2026-10-04" }],
      ["transfer.internal", { amount: "500", date: "2026-10-05" }],
    ]);
    await categorize(fixture, previousPurchase!, "dining");
    await categorize(fixture, purchase!, "dining");
    await relateRefund(fixture.store, refund!, purchase!);

    const page = await readCashFlowPage(fixture.store, OCTOBER);
    assert.equal(page.currencies.length, 1);
    const twd = page.currencies[0]!;
    assert.deepEqual(twd.inflow.amount, amount("1000"));
    assert.deepEqual(twd.outflow.amount, amount("200"), "the refund nets its original's category");
    assert.deepEqual(twd.outflow.groups, [{ group: "dining", amount: amount("200"), count: 2, previous: amount("500") }]);
    assert.deepEqual(twd.kept, amount("800"));
    assert.equal(twd.keptRatio, 0.8);
    assert.deepEqual(twd.transfers.unpaired, { amount: amount("500"), count: 1 });
    assert.equal(twd.transfers.pairs.count, 0);
    assert.deepEqual(twd.previous, { inflow: amount("1000"), outflow: amount("500"), kept: amount("500"), keptRatio: 0.5 });
    assert.deepEqual(page.transactions.map((row) => row.transactionId), [transfer, refund, purchase, salary], "newest first");
    assert.equal(page.transactionCount, 4);
    assert.equal(page.search, null);
    // Transfers move the account even though they are not counted.
    assert.deepEqual(page.accounts.map((change) => [change.account.mask, change.amount, change.count]), [["0001", amount("300"), 4]]);
  });
});

test("search matches description, counterparty, category, account and note, and an amount only exactly", async () => {
  await withFixture(async (fixture) => {
    const [coffee, groceries, large, bonus] = await addWithKinds(fixture, [
      ["purchase", { amount: "300", date: "2026-10-02", description: "Blue Bottle COFFEE" }],
      ["purchase", { amount: "3000", date: "2026-10-03", description: "Market" }],
      ["purchase", { amount: "1300", date: "2026-10-04", description: "Store 300" }],
      ["income.employment.bonus", { amount: "1000", direction: "inflow", date: "2026-10-05", description: "Payroll" }],
    ]);
    await categorize(fixture, groceries!, "dining");
    await setCounterparty(fixture.store, large!, "全聯福利中心");
    const { assetId: wallet } = await applyManual(fixture.store, createManualAsset("cash", "Wallet", "TWD", "2026-10-01", "500", "counted"));
    await applyManual(fixture.store, { kind: "addTransaction", accountId: wallet, transaction: { kind: "purchase", personalCategory: "transportation", occurredOn: "2026-10-06", amount: "80", note: "Taxi with team" } });

    const ids = async (query: string) => (await readCashFlowPage(fixture.store, { ...OCTOBER, query })).transactions
      .map((row) => row.transactionId);
    assert.deepEqual(await ids("coffee"), [coffee], "description, case-insensitive");
    assert.deepEqual(await ids("全聯"), [large], "counterparty display");
    assert.deepEqual(await ids("餐飲"), [groceries], "category group label");
    assert.deepEqual(await ids("dining"), [groceries], "category label in English");
    assert.deepEqual(await ids("獎金"), [bonus], "income group label");
    const team = await readCashFlowPage(fixture.store, { ...OCTOBER, query: "TEAM" });
    assert.deepEqual(team.transactions.map((row) => row.details.note), ["Taxi with team"], "note");
    assert.equal((await ids("wallet")).length, 1, "a Manual Account's name");
    assert.equal((await ids("富邦")).length, 4, "the institution's name");
    assert.equal((await ids("0001")).length, 4, "the account number's last digits");

    const amountSearch = await readCashFlowPage(fixture.store, { ...OCTOBER, query: "300" });
    assert.deepEqual(amountSearch.transactions.map((row) => row.transactionId).sort(), [coffee, large].sort(),
      "300 matches the 300 purchase and the description 'Store 300', never 3,000 or 1,300 by amount");
    assert.equal(amountSearch.search?.fields.amount, 1);
    assert.equal(amountSearch.search?.fields.description, 1);
    assert.deepEqual((await ids("1,000")), [bonus], "grouping commas parse as an amount");
    assert.deepEqual(amountQuery("NT$1,234.50"), { amount: { coefficient: "12345", scale: 1 }, currency: "TWD" });
    assert.equal(amountQuery("7-ELEVEN"), null);
    // A search narrows the list, never the summary.
    assert.deepEqual(amountSearch.currencies[0]?.outflow.amount, amount("4680"));
    assert.equal(amountSearch.transactionCount, 5);
  });
});

test("a period search counts its matches across all periods", async () => {
  await withFixture(async (fixture) => {
    const [, , october] = await addWithKinds(fixture, [
      ["purchase", { amount: "120", date: "2026-08-14", description: "Shopee order" }],
      ["purchase", { amount: "90", date: "2026-09-20", description: "shopee refund fee" }],
      ["purchase", { amount: "399", date: "2026-10-03", description: "SHOPEE" }],
      ["purchase", { amount: "50", date: "2026-10-04", description: "Bakery" }],
    ]);
    const page = await readCashFlowPage(fixture.store, { ...OCTOBER, query: " shopee " });
    assert.deepEqual(page.transactions.map((row) => row.transactionId), [october]);
    assert.deepEqual(page.search, {
      query: "shopee",
      fields: { description: 1, counterparty: 0, category: 0, account: 0, amount: 0, note: 0 },
      allPeriods: { matches: 3, firstDate: "2026-08-14", lastDate: "2026-10-03" },
    });
  });
});

test("a row shows a time only when the source reported a minute or second on its own date", async () => {
  await withFixture(async (fixture) => {
    const [reported, minute, midnight, dateOnly, otherDay] = await addWithKinds(fixture, [
      ["purchase", { amount: "1", date: "2026-10-02" }],
      ["purchase", { amount: "2", date: "2026-10-02" }],
      ["purchase", { amount: "3", date: "2026-10-02" }],
      ["purchase", { amount: "4", date: "2026-10-02" }],
      ["purchase", { amount: "5", date: "2026-10-02" }],
    ]);
    await setTime(fixture.store, reported!, "2026-10-02T16:05:42", "second", "source_reported");
    await setTime(fixture.store, minute!, "2026-10-02T09:12", "minute", "source_reported");
    await setTime(fixture.store, midnight!, "2026-10-02T00:00:00", "second", "defaulted_local_midnight");
    await setTime(fixture.store, dateOnly!, "2026-10-02T00:00:00", "date", "source_reported");
    await setTime(fixture.store, otherDay!, "2026-10-05T08:30:00", "second", "source_reported");
    const page = await readCashFlowPage(fixture.store, OCTOBER);
    const timeOf = (id: string) => page.transactions.find((row) => row.transactionId === id)?.details.time;
    assert.equal(timeOf(reported!), "16:05");
    assert.equal(timeOf(minute!), "09:12");
    assert.equal(timeOf(midnight!), null, "a defaulted midnight is never shown");
    assert.equal(timeOf(dateOnly!), null);
    assert.equal(timeOf(otherDay!), null, "a time on another day than the row's date");
    assert.deepEqual(page.transactions.slice(0, 2).map((row) => row.details.time), ["16:05", "09:12"]);
  });
});

test("the request must be a valid, ordered date range", async () => {
  await withFixture(async (fixture) => {
    await assert.rejects(readCashFlowPage(fixture.store, { startDate: "2026-10-10", endDate: "2026-10-01" }));
    await assert.rejects(readCashFlowPage(fixture.store, { startDate: "2026-02-30", endDate: "2026-03-01" }));
  });
});

/** Confirm a pair the way the page's transfer action does. */
async function confirmTransfer(store: PGliteStore, outflowTransactionId: string, inflowTransactionId: string) {
  const request = {
    action: "confirm", kind: "transfer_confirm", outflowTransactionId, inflowTransactionId, dataVersion: await readKnowledgePoint(store),
  } as FinancialPageActionRequest;
  await applyPGliteFinancialPageAction(store, request as Exclude<FinancialPageActionRequest, Readonly<{ kind: "strong" }>>);
}

/** Add every transaction, then set Kinds and their evidence: each addition re-projects them all. */
async function addSides(fixture: SpendingCategoryFixture, entries: readonly (readonly [code: string | null, input: FixtureTransactionInput])[]) {
  const ids: string[] = [];
  for (const [, input] of entries) ids.push(await fixture.addTransaction(input));
  for (const [index, [code]] of entries.entries()) await setKind(fixture.store, ids[index]!, code);
  return ids;
}

test("a linked transfer counts once at its outflow amount, and an external transfer counts as flow", async () => {
  await withFixture(async (fixture) => {
    const [out, into, unpaired, external, bare, externalIn] = await addSides(fixture, [
      ["purchase", { amount: "30000", date: "2026-10-03", account: "bank-a", description: "Move" }],
      ["receipt", { amount: "30000", date: "2026-10-04", account: "bank-b", direction: "inflow", description: "Move" }],
      ["transfer.internal", { amount: "1000", date: "2026-10-05", account: "bank-a" }],
      ["transfer.external", { amount: "2000", date: "2026-10-06", account: "bank-a", description: "Rent" }],
      ["transfer", { amount: "500", date: "2026-10-07", account: "bank-a" }],
      ["transfer.external", { amount: "700", date: "2026-10-08", account: "bank-a", direction: "inflow", description: "From a friend" }],
    ]);
    await confirmTransfer(fixture.store, out!, into!);
    const page = await readCashFlowPage(fixture.store, OCTOBER);
    assert.deepEqual(page.currencies[0]?.transfers, {
      pairs: { amount: amount("30000"), count: 1, origins: { evidence: 0, confirmed: 1, manual: 0 } },
      unpaired: { amount: amount("1000"), count: 1 },
    }, "one 30,000 transfer is one pair of 30,000, not 60,000");
    const twd = page.currencies[0]!;
    assert.deepEqual(twd.outflow.groups, [{ group: "transfers_out", amount: amount("2500"), count: 2, previous: amount("0") }],
      "an external or unspecified transfer out is 轉帳支出");
    assert.deepEqual(twd.inflow.groups, [{ group: "transfers_in", amount: amount("700"), count: 1 }], "an external transfer in is 其他轉入");

    // Only the inflow side is in this period; the link still counts once.
    const inflowOnly = await readCashFlowPage(fixture.store, { startDate: "2026-10-04", endDate: "2026-10-04" });
    assert.deepEqual(inflowOnly.currencies[0]?.transfers.pairs, { amount: amount("30000"), count: 1, origins: { evidence: 0, confirmed: 1, manual: 0 } });

    const ids = async (query: string) => (await readCashFlowPage(fixture.store, { ...OCTOBER, query })).transactions
      .map((row) => row.transactionId).sort();
    assert.deepEqual(await ids("內部轉帳"), [out, into, unpaired].sort(), "external transfers are never labelled internal");
    assert.deepEqual(await ids("轉帳支出"), [external, bare].sort());
    assert.deepEqual(await ids("transfers out"), [external, bare].sort());
    assert.deepEqual(await ids("其他轉入"), [externalIn]);
    assert.deepEqual(await ids("internal transfer"), [out, into, unpaired].sort());
  });
});

test("two external transfers between the person's own accounts count until the person confirms the pair", async () => {
  await withFixture(async (fixture) => {
    const [out, into] = await addSides(fixture, [
      ["transfer.external", { amount: "30000", date: "2026-10-03", account: "bank-a", description: "跨行轉帳" }],
      ["transfer.external", { amount: "30000", date: "2026-10-03", account: "bank-b", direction: "inflow", description: "跨行轉入" }],
    ]);
    const before = await readCashFlowPage(fixture.store, OCTOBER);
    assert.deepEqual([before.currencies[0]?.inflow.amount, before.currencies[0]?.outflow.amount], [amount("30000"), amount("30000")]);
    assert.equal(before.currencies[0]?.transfers.pairs.count, 0, "keyword Kinds never pair by evidence");

    await confirmTransfer(fixture.store, out!, into!);
    const after = await readCashFlowPage(fixture.store, OCTOBER);
    assert.deepEqual([after.currencies[0]?.inflow.amount, after.currencies[0]?.outflow.amount], [amount("0"), amount("0")]);
    assert.deepEqual(after.currencies[0]?.transfers.pairs, { amount: amount("30000"), count: 1, origins: { evidence: 0, confirmed: 1, manual: 0 } });
  });
});

test("a confirmed link pairs a weak or fallback side with an internal transfer, and no evidence-backed side of another Kind", async () => {
  await withFixture(async (fixture) => {
    const [internal, external, internalToo, receipt, card, cardIn, purchase, salary, internalOut, salaryIn] = await addSides(fixture, [
      ["transfer.internal", { amount: "4000", date: "2026-10-03", account: "bank-a", description: "本人轉帳" }],
      ["transfer.external", { amount: "4000", date: "2026-10-03", account: "bank-b", direction: "inflow", description: "跨行轉入" }],
      ["transfer.internal", { amount: "5000", date: "2026-10-04", account: "bank-a" }],
      ["receipt", { amount: "5000", date: "2026-10-04", account: "bank-b", direction: "inflow" }],
      ["payment.credit_card", { amount: "6000", date: "2026-10-05", account: "bank-a" }],
      ["transfer.external", { amount: "6000", date: "2026-10-05", account: "bank-b", direction: "inflow" }],
      ["purchase", { amount: "7000", date: "2026-10-06", account: "bank-a" }],
      ["income.employment.salary", { amount: "7000", date: "2026-10-06", account: "bank-b", direction: "inflow" }],
      ["transfer.internal", { amount: "8000", date: "2026-10-07", account: "bank-a" }],
      ["income.employment.salary", { amount: "8000", date: "2026-10-07", account: "bank-b", direction: "inflow" }],
    ]);
    for (const [out, into] of [[internal, external], [internalToo, receipt], [card, cardIn], [purchase, salary], [internalOut, salaryIn]])
      await confirmTransfer(fixture.store, out!, into!);
    const page = await readCashFlowPage(fixture.store, OCTOBER);
    const rowOf = (id: string) => page.transactions.find((row) => row.transactionId === id)!;
    const transfer = { class: "not_counted", reason: "transfer" };
    for (const id of [internal!, external!, internalToo!, receipt!]) {
      assert.deepEqual(rowOf(id).cashFlow, transfer, "an internal transfer proves the move for its weak or fallback counterpart");
      assert.notEqual(rowOf(id).transferLinkId, null);
    }
    assert.deepEqual(rowOf(card!).cashFlow, { class: "not_counted", reason: "card_payment" });
    assert.deepEqual(rowOf(cardIn!).cashFlow, { class: "inflow", group: "transfers_in" }, "a card payment keeps its weak counterpart counted");
    assert.equal(rowOf(purchase!).cashFlow.class, "outflow", "an evidence-backed income keeps its fallback counterpart counted");
    assert.deepEqual(rowOf(salary!).cashFlow, { class: "inflow", group: "income.employment.salary" });
    assert.deepEqual(rowOf(internalOut!).cashFlow, transfer);
    for (const id of [card!, cardIn!, purchase!, salary!, internalOut!, salaryIn!]) assert.equal(rowOf(id).transferLinkId, null, "a link that leaves a side counted is no pair");

    const twd = page.currencies[0]!;
    assert.deepEqual([twd.inflow.amount, twd.outflow.amount], [amount("21000"), amount("7000")]);
    assert.deepEqual(twd.transfers, {
      pairs: { amount: amount("9000"), count: 2, origins: { evidence: 0, confirmed: 2, manual: 0 } },
      unpaired: { amount: amount("8000"), count: 1 },
    }, "the note holds only links whose sides both stay out of the totals");
  });
});

test("evidence links read as paired automatically", async () => {
  await withFixture(async (fixture) => {
    await addSides(fixture, [
      ["transfer.internal", { amount: "5000", date: "2026-10-03", account: "bank-a" }],
      ["transfer.internal", { amount: "5000", date: "2026-10-03", account: "bank-b", direction: "inflow" }],
    ]);
    const page = await readCashFlowPage(fixture.store, OCTOBER);
    assert.deepEqual(page.currencies[0]?.transfers.pairs, { amount: amount("5000"), count: 1, origins: { evidence: 1, confirmed: 0, manual: 0 } });
    assert.equal(page.currencies[0]?.transfers.unpaired.count, 0);
  });
});

test("an amount search keeps to the currency the query names", async () => {
  await withFixture(async (fixture) => {
    const [twd, usd] = await addWithKinds(fixture, [
      ["purchase", { amount: "300", date: "2026-10-02" }],
      ["purchase", { amount: "300", currency: "USD", date: "2026-10-03" }],
    ]);
    const ids = async (query: string) => (await readCashFlowPage(fixture.store, { ...OCTOBER, query })).transactions
      .map((row) => row.transactionId).sort();
    assert.deepEqual(await ids("300"), [twd, usd].sort(), "no currency matches any currency");
    assert.deepEqual(await ids("$300"), [twd, usd].sort());
    assert.deepEqual(await ids("NT$300"), [twd]);
    assert.deepEqual(await ids("TWD 300"), [twd]);
    assert.deepEqual(await ids("US$300"), [usd]);
    assert.deepEqual(await ids("usd300"), [usd]);
    const page = await readCashFlowPage(fixture.store, { ...OCTOBER, query: "USD 300" });
    assert.equal(page.search?.allPeriods.matches, 1, "the all-periods count keeps the currency too");
  });
});

test("the all-periods count reads the same matches as classifying every period", async () => {
  await withFixture(async (fixture) => {
    const [dining, , out, into, , , salary, , refund, , cents] = await addSides(fixture, [
      ["purchase", { amount: "300", date: "2025-08-02", description: "Coffee" }],
      ["purchase", { amount: "300", currency: "USD", date: "2026-01-15", description: "Lunch" }],
      ["purchase", { amount: "7000", date: "2026-09-10", account: "bank-a", description: "Move" }],
      ["receipt", { amount: "7000", date: "2026-09-11", account: "bank-b", direction: "inflow" }],
      [null, { amount: "42", date: "2026-10-02", description: "Mystery" }],
      ["transfer.external", { amount: "800", date: "2026-10-03", account: "bank-a" }],
      ["income.employment.salary", { amount: "50000", date: "2026-10-05", account: "bank-b", direction: "inflow", description: "Payroll" }],
      ["purchase", { amount: "120", date: "2027-01-20", description: "Coffee preorder" }],
      ["refund", { amount: "100", date: "2025-08-05", direction: "inflow", description: "Return" }],
      ["transfer.external", { amount: "650", date: "2026-02-03", account: "bank-b", direction: "inflow" }],
      ["purchase", { amount: "12345", scale: 2, date: "2026-03-04", description: "Cents" }],
    ]);
    await categorize(fixture, dining!, "dining");
    await relateRefund(fixture.store, refund!, dining!);
    await setCounterparty(fixture.store, dining!, "路易莎咖啡");
    await setNote(fixture.store, salary!, "年終 bonus");
    assert.deepEqual((await readPGliteCashFlow(fixture.store, { startDate: "2026-03-04", endDate: "2026-03-04" })).transactions
      .find((row) => row.transactionId === cents)?.amount, { coefficient: "12345", scale: 2, currency: "TWD" }, "a scale-2 stored amount");
    await confirmTransfer(fixture.store, out!, into!);
    const { assetId: wallet } = await applyManual(fixture.store, createManualAsset("cash", "Wallet", "TWD", "2025-01-01", "500", "counted"));
    await applyManual(fixture.store, { kind: "addTransaction", accountId: wallet, transaction: { kind: "purchase", personalCategory: "dining", occurredOn: "2025-03-06", amount: "300", note: "Coffee beans" } });

    const everything = await readPGliteCashFlow(fixture.store, { startDate: "0001-01-01", endDate: "9999-12-31" });
    const knowledgeAt = await readKnowledgePoint(fixture.store);
    for (const query of ["coffee", "300", "NT$300", "USD300", "內部轉帳", "轉帳支出", "其他轉入", "餐飲", "類型未定", "富邦", "0001", "wallet", "薪資", "move", "a",
      "路易莎", "年終", "fubon", "台北富邦", "未分類", "退款", "refund", "123.45", "NT$123.45"]) {
      const expected = everything.transactions.filter((row) => cashFlowMatches(row, query).length > 0).map((row) => row.transactionId).sort();
      const actual = (await readCashFlowSearchMatches(fixture.store, knowledgeAt, query)).map((row) => row.transactionId).sort();
      assert.deepEqual(actual, expected, `query ${query}`);
      assert.ok(expected.length > 0, `query ${query} matches something`);
    }
    const coffee = await readCashFlowPage(fixture.store, { ...OCTOBER, query: "coffee" });
    assert.deepEqual(coffee.search?.allPeriods, { matches: 3, firstDate: "2025-03-06", lastDate: "2027-01-20" }, "future-dated matches count, and the dates span them");
  });
});

test("the pairing window stays within the years an ISO date can name", () => {
  assert.equal(shiftDate("0001-01-03", -6), "0001-01-01");
  assert.equal(shiftDate("9999-12-29", 6), "9999-12-31");
  assert.equal(shiftDate("2026-10-01", -6), "2026-09-25");
});

test("a preset period follows the date past midnight; a custom one stays", () => {
  const november = { startDate: "2026-11-01", endDate: "2026-11-30" };
  assert.deepEqual(rollRange(november, "month", "2026-12-01"), { startDate: "2026-12-01", endDate: "2026-12-01" }, "本月");
  assert.deepEqual(rollRange({ startDate: "2026-10-31", endDate: "2026-11-29" }, "last30", "2026-11-30"), { startDate: "2026-11-01", endDate: "2026-11-30" }, "近 30 天");
  assert.deepEqual(rollRange({ startDate: "2026-11-23", endDate: "2026-11-29" }, "week", "2026-11-30"), { startDate: "2026-11-30", endDate: "2026-11-30" }, "本週 starts again on Monday");
  assert.deepEqual(rollRange({ startDate: "2026-11-03", endDate: "2026-11-10" }, "custom", "2026-11-30"), { startDate: "2026-11-03", endDate: "2026-11-10" }, "custom");
  assert.deepEqual(rollRange(november, "month", "2026-11-30"), november);
});

test("the chosen preset rolls, even when another preset gave the same range", () => {
  // On 11/30, 近 30 天 is 11/01–11/30, the same range as 本月.
  const last30 = quickRange("last30", "2026-11-30");
  assert.deepEqual(last30, quickRange("month", "2026-11-30"));
  assert.deepEqual(rollRange(last30, "last30", "2026-12-01"), { startDate: "2026-11-02", endDate: "2026-12-01" });
  // June 2026 starts on a Monday, so on 06/07 本月 is 06/01–06/07, the same range as 本週.
  const june = quickRange("month", "2026-06-07");
  assert.deepEqual(june, quickRange("week", "2026-06-07"));
  assert.deepEqual(rollRange(june, "month", "2026-06-08"), { startDate: "2026-06-01", endDate: "2026-06-08" });
});

test("a quick choice applied from the picker rolls as its preset; a fixed range stays custom", () => {
  assert.equal(quickChoice("week"), "week");
  assert.equal(quickChoice("month"), "month");
  assert.equal(quickChoice("lastMonth"), "custom", "上個月 is a fixed range");
  assert.equal(quickChoice("last90"), "custom", "no preset rolls 90 days");
  assert.equal(quickChoice("year"), "custom", "no preset rolls the year");
  assert.equal(quickChoice(null), "custom", "days picked by hand");
  // 本月 picked on 06/07 gives 本週's range, and still rolls as 本月.
  assert.deepEqual(rollRange(quickRange("month", "2026-06-07"), quickChoice("month"), "2026-06-08"), { startDate: "2026-06-01", endDate: "2026-06-08" });
  for (const current of ["week", "month", "last30", "custom"] as const) {
    assert.equal(pickerChoice(current, pickerQuick(current), false), current, `applying ${current} untouched keeps it`);
  }
  assert.equal(pickerChoice("last30", null, true), "custom", "days picked by hand");
  assert.equal(pickerChoice("custom", "month", true), "month", "本月 tapped in the picker");
});

/** Send one transfer decision the way the pairing panel does. */
async function decide(store: PGliteStore, action: "confirm" | "deny" | "pair", outflowTransactionId: string, inflowTransactionId: string) {
  const request = {
    action, kind: `transfer_${action}`, outflowTransactionId, inflowTransactionId, dataVersion: await readKnowledgePoint(store),
  } as FinancialPageActionRequest;
  await applyPGliteFinancialPageAction(store, request as Exclude<FinancialPageActionRequest, Readonly<{ kind: "strong" }>>);
}

test("the pairing panel lists links with both sides, candidates, suspended links and denials", async () => {
  await withFixture(async (fixture) => {
    const entries = [
      ["transfer.internal", { amount: "5000", date: "2026-10-03", account: "bank-a", description: "本人轉帳" }],
      ["transfer.internal", { amount: "5000", date: "2026-10-03", account: "bank-b", direction: "inflow", description: "本人轉入" }],
      ["purchase", { amount: "3000", date: "2026-09-29", account: "bank-a", description: "Move out" }],
      ["receipt", { amount: "3000", date: "2026-10-01", account: "bank-b", direction: "inflow", description: "Move in" }],
      ["purchase", { amount: "700", date: "2026-10-05", account: "bank-a" }],
      ["receipt", { amount: "700", date: "2026-10-07", account: "bank-b", direction: "inflow" }],
      ["purchase", { amount: "900", date: "2026-10-06", account: "bank-a" }],
      ["receipt", { amount: "900", date: "2026-10-06", account: "bank-b", direction: "inflow" }],
      ["purchase", { amount: "1200", date: "2026-10-08", account: "bank-a" }],
      ["receipt", { amount: "1200", date: "2026-10-08", account: "bank-b", direction: "inflow" }],
      ["purchase", { amount: "8000", date: "2026-10-02", account: "bank-a" }],
      ["receipt", { amount: "8000", date: "2026-10-09", account: "bank-b", direction: "inflow" }],
    ] as const;
    const ids = await addSides(fixture, entries);
    const [evidenceOut, evidenceIn, farOut, nearIn, candidateOut, candidateIn, deniedOut, deniedIn, pausedOut, pausedIn, manualOut, manualIn] = ids as [
      string, string, string, string, string, string, string, string, string, string, string, string];
    await decide(fixture.store, "confirm", farOut, nearIn);
    await decide(fixture.store, "deny", deniedOut, deniedIn);
    await decide(fixture.store, "confirm", pausedOut, pausedIn);
    await decide(fixture.store, "pair", manualOut, manualIn);
    // A revised amount suspends the 1,200 link; every revision re-projects the Kinds, so they are set again.
    await fixture.reviseTransaction(pausedIn, { amount: "1100", date: "2026-10-08", direction: "inflow" });
    for (const [index, [code]] of entries.entries()) await setKind(fixture.store, ids[index]!, code);

    const page = await readCashFlowPage(fixture.store, OCTOBER);
    const panel = page.transferPanel;
    assert.deepEqual(
      panel.links.map((link) => [link.linkId, link.origin, link.dayGap, link.paired, link.outflow.inPeriod, link.inflow.inPeriod]),
      [
        [`${evidenceOut}/${evidenceIn}`, "evidence", 0, true, true, true],
        [`${manualOut}/${manualIn}`, "manual", 7, true, true, true],
        [`${farOut}/${nearIn}`, "confirmed", 2, true, false, true],
      ],
      "newest outflow first; a side dated before the period is still listed",
    );
    const far = panel.links.find((link) => link.origin === "confirmed")!;
    assert.equal(far.outflow.details.description, "Move out", "the side outside the period carries its own details");
    assert.deepEqual(far.outflow.amount, { ...amount("3000"), currency: "TWD" });
    assert.deepEqual([far.outflow.cashFlow.class, far.outflow.ownCashFlow.class], ["not_counted", "outflow"], "ownCashFlow is the class without the link");
    assert.ok(!page.transactions.some((row) => row.transactionId === farOut), "the far side is not a row of the period");
    const evidence = panel.links[0]!;
    assert.deepEqual([evidence.outflow.ownCashFlow, evidence.inflow.ownCashFlow], [
      { class: "not_counted", reason: "transfer" }, { class: "not_counted", reason: "transfer" },
    ]);

    assert.deepEqual(panel.candidates.map((candidate) => [candidate.pairId, candidate.dayGap, candidate.outflow.details.account.id === candidate.inflow.details.account.id]),
      [[`${candidateOut}/${candidateIn}`, 2, false]]);
    assert.deepEqual(panel.candidates[0]?.ifLinked, {
      outflow: { class: "not_counted", reason: "transfer" }, inflow: { class: "not_counted", reason: "transfer" },
    }, "confirming two fallback sides takes both out");
    assert.deepEqual([panel.candidates[0]?.outflow.ownCashFlow.class, panel.candidates[0]?.inflow.ownCashFlow.class], ["outflow", "inflow"]);
    assert.deepEqual(panel.suspended.map((link) => [link.linkId, link.origin, link.suspension, link.outflow?.transactionId, link.inflow?.transactionId]),
      [[`${pausedOut}/${pausedIn}`, "confirmed", { reason: "amount" }, pausedOut, pausedIn]]);
    assert.deepEqual(panel.deniedPairs, [`${deniedOut}/${deniedIn}`]);

    assert.equal(page.periodTransactions, null, "without a search the period's rows are the list's");
    const searched = await readCashFlowPage(fixture.store, { ...OCTOBER, query: "Move" });
    assert.deepEqual(searched.transactions.map((row) => row.transactionId), [nearIn]);
    assert.equal(searched.periodTransactions?.length, page.transactions.length, "a search still sends every row of the period, for an export");
  });
});
