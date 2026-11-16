import assert from "node:assert/strict";
import test from "node:test";
import { readPGliteCashFlow } from "./cash-flow.ts";
import { applyPgliteCashFlowTransferSchema } from "./cash-flow-transfer.ts";
import { applyPgliteManualAssetsSchema } from "./manual-assets.ts";
import { queryCurrentSpending, queryCurrentSpendingRecordPage, queryCurrentSpendingSummary } from "./purchase-report.ts";
import { setPGliteSpendingPurchaseCategory } from "./purchase-category-command.ts";
import { querySpendingReport } from "./spending-facts.ts";
import { queryPendingSpendingCandidates, queryPGliteSpendingDirectPair } from "./spending-query.ts";
import { createSpendingCategoryFixture, type SpendingCategoryFixture } from "./spending-test-fixture.ts";
import { KIND_CATEGORY_ENRICHMENT_PRODUCER_ID, KIND_CATEGORY_ENRICHMENT_ROUTE_ID } from "../canonical/transaction-taxonomy.ts";
import { addExact, normalizeExact, type ExactAmount } from "../../lib/shared-money/exact-money.ts";

const SEPTEMBER = { startDate: "2026-09-01", endDate: "2026-09-30" } as const;
const FUBON_LOAN = { namespace: "fubon", stream: "loan", accountType: "loan" } as const;
const FUBON_DEPOSIT = { namespace: "fubon", stream: "domestic-deposit", accountType: "depository" } as const;
const idBytes = (id: string) => Buffer.from(id.replaceAll("-", ""), "hex");

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

const loanRow = (fixture: SpendingCategoryFixture, amount: string, event: "payment" | "interest" | "fee" | "disbursement") =>
  fixture.addTransaction({ amount, direction: "inflow", date: "2026-09-21", account: "mortgage", accountStream: FUBON_LOAN, event: { loan: event } });
const depositRow = (fixture: SpendingCategoryFixture, amount: string, description: string, date = "2026-09-10") =>
  fixture.addTransaction({ amount, direction: "outflow", date, description, account: "salary-account", accountStream: FUBON_DEPOSIT });

/** The transaction's current category enrichment, as both pages read it. */
async function categoryEnrichment(fixture: SpendingCategoryFixture, transactionId: string) {
  return (await fixture.store.query<{ taxonomy_code: string; origin: string; producer_id: string; route_id: string; provenance: string }>(
    `SELECT enrichment.taxonomy_code, enrichment.origin, enrichment.producer_id, enrichment.route_id,
            output.provenance_json AS provenance
       FROM current_transaction_enrichment enrichment
       JOIN enrichment_run_outputs output ON output.assertion_id = enrichment.assertion_id
      WHERE enrichment.transaction_id = $1 AND enrichment.field_name = 'category'`,
    [idBytes(transactionId)])).rows[0] ?? null;
}

async function kindAssertion(fixture: SpendingCategoryFixture, transactionId: string): Promise<string> {
  const row = (await fixture.store.query<{ assertion_id: Uint8Array }>(
    "SELECT assertion_id FROM current_transaction_enrichment WHERE transaction_id = $1 AND field_name = 'kind'", [idBytes(transactionId)])).rows[0]!;
  const hex = Buffer.from(row.assertion_id).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

test("interest charged and bank, card and loan fees carry a Derived interest-and-fees category that names the Kind it read (ADR 0141)", async () => {
  await withFixture(async (fixture) => {
    const bankInterest = await depositRow(fixture, "35", "扣繳利息");
    const bankFee = await depositRow(fixture, "15", "手續費");
    const cardFee = await depositRow(fixture, "300", "信用卡 手續費");
    const loanInterest = await loanRow(fixture, "1200", "interest");
    const loanFee = await loanRow(fixture, "100", "fee");
    const principal = await loanRow(fixture, "9000", "payment");
    const purchase = await fixture.addTransaction({ amount: "250", date: "2026-09-05" });
    const derived = [[bankInterest, "interest.charged"], [bankFee, "fee.bank"], [cardFee, "fee.card"], [loanInterest, "interest.charged"], [loanFee, "fee.loan"]] as const;
    for (const [id, kind] of derived) {
      const category = await categoryEnrichment(fixture, id);
      assert.deepEqual(
        category && { code: category.taxonomy_code, origin: category.origin, producer: category.producer_id, route: category.route_id },
        { code: "interest_and_fees", origin: "derived", producer: KIND_CATEGORY_ENRICHMENT_PRODUCER_ID, route: KIND_CATEGORY_ENRICHMENT_ROUTE_ID },
        kind,
      );
      const provenance = JSON.parse(category!.provenance) as Record<string, unknown>;
      assert.deepEqual([provenance.evidenceKind, provenance.sourceField, provenance.sourceValue, provenance.evidenceAssertionId],
        ["kind", "kind", kind, await kindAssertion(fixture, id)]);
    }
    assert.equal(await categoryEnrichment(fixture, principal), null, "a loan's principal takes no category from its Kind");
    assert.equal(await categoryEnrichment(fixture, purchase), null, "a purchase takes no category from its Kind");

    const before = await fixture.knowledgeAt();
    await fixture.store.transaction(async (transaction) => {
      const { refreshPGliteCurrentProjectionInTransaction } = await import("./projection.ts");
      const latest = (await transaction.query<{ commit_id: Uint8Array; commit_sequence: number }>(
        "SELECT commit_id, commit_sequence FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1")).rows[0]!;
      await refreshPGliteCurrentProjectionInTransaction(transaction, {
        commitId: latest.commit_id, cutoffSequence: Number(latest.commit_sequence), transactionIds: [], refreshEnrichmentAll: true,
      });
    });
    assert.equal(await fixture.knowledgeAt(), before, "an unchanged Kind writes no new category");
  });
});

test("a row whose Kind stops being interest or a fee loses its Derived category, and gains it back with the Kind (ADR 0141)", async () => {
  await withFixture(async (fixture) => {
    const debit = await depositRow(fixture, "800", "扣繳利息");
    assert.equal((await categoryEnrichment(fixture, debit))?.taxonomy_code, "interest_and_fees");
    await fixture.reviseTransaction(debit, { amount: "800", direction: "outflow", date: "2026-09-10", description: "房貸 扣款", accountStream: FUBON_DEPOSIT });
    assert.equal(await categoryEnrichment(fixture, debit), null, "a loan repayment takes no category from its Kind");
    const withdrawn = await fixture.store.query<{ event_kind: string }>(
      `SELECT transition.event_kind FROM assertion_transitions transition
         JOIN assertions assertion ON assertion.assertion_id = transition.assertion_id
        WHERE assertion.transaction_id = $1 AND assertion.field_name = 'category'
        ORDER BY transition.commit_id`, [idBytes(debit)]);
    assert.deepEqual(withdrawn.rows.map((row) => row.event_kind).sort(), ["observed", "withdrawn"]);
    await fixture.reviseTransaction(debit, { amount: "800", direction: "outflow", date: "2026-09-10", description: "扣繳利息", accountStream: FUBON_DEPOSIT });
    assert.equal((await categoryEnrichment(fixture, debit))?.taxonomy_code, "interest_and_fees");
  });
});

test("a category the person sets wins over the Derived one, and clearing it falls back to it (ADR 0141)", async () => {
  await withFixture(async (fixture) => {
    const loanInterest = await loanRow(fixture, "1200", "interest");
    const purchaseId = `transaction:${loanInterest}`;
    const read = async () => (await querySpendingReport(fixture.store, "current", await fixture.knowledgeAt(), null, SEPTEMBER))
      .transactions.find((transaction) => transaction.transactionId === loanInterest)?.categorization;
    assert.deepEqual([(await read())?.origin, (await read())?.categoryCode], ["derived", "interest_and_fees"]);

    await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId, knowledgeAt: await fixture.knowledgeAt(), categoryCode: "work_and_business" });
    assert.deepEqual([(await read())?.origin, (await read())?.categoryCode], ["user", "work_and_business"]);
    const cashFlow = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    const row = cashFlow.transactions.find((transaction) => transaction.transactionId === loanInterest);
    assert.deepEqual(row?.cashFlow, { class: "outflow", categories: [{ category: "work_and_business", group: "other", amount: { coefficient: "1200", scale: 0 } }] });
    assert.deepEqual([row?.details.edit?.purchaseId, row?.details.edit?.spendingPurchase], [purchaseId, true], "a category set from Cash flow shows in Spending");

    await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId, knowledgeAt: await fixture.knowledgeAt(), categoryCode: null });
    assert.deepEqual([(await read())?.origin, (await read())?.categoryCode], ["derived", "interest_and_fees"]);
  });
});

test("Spending counts a loan's interest and fee as bank-only purchases, and neither its principal, its disbursement nor the deposit repayment (ADR 0141)", async () => {
  await withFixture(async (fixture) => {
    const interest = await loanRow(fixture, "1200", "interest");
    const fee = await loanRow(fixture, "100", "fee");
    await loanRow(fixture, "9000", "payment");
    await loanRow(fixture, "500000", "disbursement");
    // The deposit-side debit for the whole instalment, read as a loan repayment by its label.
    const repayment = await depositRow(fixture, "10300", "房貸 扣款", "2026-09-21");
    const knowledgeAt = await fixture.knowledgeAt();

    const { purchaseReport } = await queryCurrentSpending(fixture.store);
    assert.deepEqual(
      purchaseReport.records.map((record) => [record.purchaseId, record.basis, record.amount?.coefficient, record.occurrence.value, record.category.mode === "single" ? record.category.categoryCode : null]),
      [[`transaction:${fee}`, "bank-transaction", "100", "2026-09-21", "interest_and_fees"], [`transaction:${interest}`, "bank-transaction", "1200", "2026-09-21", "interest_and_fees"]]
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    );
    assert.equal(purchaseReport.records.some((record) => record.transaction?.transactionId === repayment), false);

    const summary = await queryCurrentSpendingSummary(fixture.store, { knowledgeAt });
    assert.deepEqual(summary.purchaseReport.categoryTotalsByMonth.map((row) => [row.month, row.categoryCode, row.coefficient, row.count]), [["2026-09", "interest_and_fees", "1300", 2]]);
    const page = await queryCurrentSpendingRecordPage(fixture.store, { knowledgeAt, month: "2026-09", categoryCodes: ["interest_and_fees"] });
    assert.deepEqual(page.records.map((record) => record.purchaseId).sort(), [`transaction:${interest}`, `transaction:${fee}`].sort());
  });
});

test("a loan's interest is never a candidate for a same-amount invoice, while a card payment is (ADR 0141)", async () => {
  await withFixture(async (fixture) => {
    const interest = await loanRow(fixture, "1200", "interest");
    const card = await fixture.addTransaction({ amount: "480", date: "2026-09-20" });
    const loanInvoice = await fixture.commitInvoice({ stableKey: "AB12345680", date: "2026-09-21", items: [{ sequence: 1, name: "測試品項", amount: "1200" }] });
    await fixture.commitInvoice({ stableKey: "AB12345679", date: "2026-09-20", items: [{ sequence: 1, name: "測試品項", amount: "480" }] });
    const knowledgeAt = await fixture.knowledgeAt();

    const pending = await queryPendingSpendingCandidates(fixture.store, knowledgeAt);
    assert.deepEqual(pending.pairs.map((pair) => pair.transactionId), [card], "only the card payment pairs");
    const { purchaseReport } = await queryCurrentSpending(fixture.store);
    const interestRecord = purchaseReport.records.find((record) => record.purchaseId === `transaction:${interest}`);
    assert.deepEqual([interestRecord?.possibleDuplicate, interestRecord?.candidateIds], [false, []]);
    assert.equal(purchaseReport.candidates.some((candidate) => candidate.transactionId === interest), false);
    await assert.rejects(queryPGliteSpendingDirectPair(fixture.store, loanInvoice, interest, knowledgeAt), /ineligible/u);
    const pairing = await fixture.store.query("SELECT 1 FROM current_spending_pairing_entries WHERE transaction_id = $1", [idBytes(interest)]);
    assert.equal(pairing.rows.length, 0);
  });
});

test("for one period and currency, Cash flow's interest-and-fees outflow equals Spending's interest-and-fees total (ADR 0141)", async () => {
  await withFixture(async (fixture) => {
    await depositRow(fixture, "35", "扣繳利息");
    await depositRow(fixture, "15", "手續費");
    await depositRow(fixture, "300", "信用卡 手續費");
    await loanRow(fixture, "1200", "interest");
    await loanRow(fixture, "100", "fee");
    await loanRow(fixture, "9000", "payment");
    await depositRow(fixture, "10300", "房貸 扣款", "2026-09-21");
    await fixture.addTransaction({ amount: "250", date: "2026-09-05" });
    const knowledgeAt = await fixture.knowledgeAt();

    const cashFlow = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    let cashFlowTotal: ExactAmount = { coefficient: "0", scale: 0 };
    for (const row of cashFlow.transactions)
      if (row.cashFlow.class === "outflow")
        for (const share of row.cashFlow.categories)
          if (share.category === "interest_and_fees") cashFlowTotal = addExact(cashFlowTotal, share.amount);

    const summary = await queryCurrentSpendingSummary(fixture.store, { knowledgeAt });
    const spendingRow = summary.purchaseReport.categoryTotalsByMonth.find((row) => row.month === "2026-09" && row.currency === "TWD" && row.categoryCode === "interest_and_fees");
    assert.deepEqual(normalizeExact(cashFlowTotal), { coefficient: "1650", scale: 0 });
    assert.deepEqual(spendingRow && normalizeExact({ coefficient: spendingRow.coefficient, scale: spendingRow.scale }), normalizeExact(cashFlowTotal));
    const { purchaseReport } = await queryCurrentSpending(fixture.store);
    let recordTotal: ExactAmount = { coefficient: "0", scale: 0 };
    for (const record of purchaseReport.records)
      if (record.category.mode === "single" && record.category.categoryCode === "interest_and_fees" && record.amount) recordTotal = addExact(recordTotal, record.amount);
    assert.deepEqual(normalizeExact(recordTotal), normalizeExact(cashFlowTotal), "the built records agree with the summary");
  });
});

const cardRow = (fixture: SpendingCategoryFixture, amount: string, description: string, date = "2026-09-12") =>
  fixture.addTransaction({ amount, date, description });

async function kindCode(fixture: SpendingCategoryFixture, transactionId: string): Promise<string | null> {
  return (await fixture.store.query<{ taxonomy_code: string }>(
    "SELECT taxonomy_code FROM current_transaction_enrichment WHERE transaction_id = $1 AND field_name = 'kind'", [idBytes(transactionId)])).rows[0]?.taxonomy_code ?? null;
}

test("a card's own interest and fee lines read interest.charged and fee.card and take the Derived interest-and-fees category, and a merchant's 年費 stays a purchase (ADR 0142)", async () => {
  await withFixture(async (fixture) => {
    const interest = await cardRow(fixture, "321", "循環利息");
    const fee = await cardRow(fixture, "45", "國外交易服務費");
    const membership = await cardRow(fixture, "1200", "測試健身房會員年費");
    assert.deepEqual([await kindCode(fixture, interest), await kindCode(fixture, fee), await kindCode(fixture, membership)],
      ["interest.charged", "fee.card", "purchase"]);
    for (const id of [interest, fee])
      assert.deepEqual((await categoryEnrichment(fixture, id))?.taxonomy_code, "interest_and_fees");
    assert.equal(await categoryEnrichment(fixture, membership), null);

    const cashFlow = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    const row = cashFlow.transactions.find((transaction) => transaction.transactionId === fee);
    assert.deepEqual(row?.cashFlow, { class: "outflow", categories: [{ category: "interest_and_fees", group: "other", amount: { coefficient: "45", scale: 0 } }] });

    const purchaseId = `transaction:${fee}`;
    await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId, knowledgeAt: await fixture.knowledgeAt(), categoryCode: "travel" });
    const read = async () => (await querySpendingReport(fixture.store, "current", await fixture.knowledgeAt(), null, SEPTEMBER))
      .transactions.find((transaction) => transaction.transactionId === fee)?.categorization;
    assert.deepEqual([(await read())?.origin, (await read())?.categoryCode], ["user", "travel"], "the person's category wins");
  });
});

test("a card's fee is never a candidate for a same-amount invoice, stays a Spending purchase, and an earlier confirmed link still stands (ADR 0142)", async () => {
  await withFixture(async (fixture) => {
    const fee = await cardRow(fixture, "300", "年費", "2026-09-20");
    const purchase = await cardRow(fixture, "480", "測試商店", "2026-09-20");
    const earlier = await cardRow(fixture, "90", "測試商店", "2026-09-15");
    const feeInvoice = await fixture.commitInvoice({ stableKey: "AB12345681", date: "2026-09-21", items: [{ sequence: 1, name: "測試品項", amount: "300" }] });
    await fixture.commitInvoice({ stableKey: "AB12345682", date: "2026-09-20", items: [{ sequence: 1, name: "測試品項", amount: "480" }] });
    const linkedInvoice = await fixture.commitInvoice({ stableKey: "AB12345683", date: "2026-09-15", items: [{ sequence: 1, name: "測試品項", amount: "90" }] });
    await fixture.link(linkedInvoice, earlier);
    await fixture.reviseTransaction(earlier, { amount: "90", direction: "outflow", date: "2026-09-15", description: "滯納金" });
    assert.equal(await kindCode(fixture, earlier), "fee.card");
    const knowledgeAt = await fixture.knowledgeAt();

    const pending = await queryPendingSpendingCandidates(fixture.store, knowledgeAt);
    assert.deepEqual(pending.pairs.map((pair) => pair.transactionId), [purchase], "only the card purchase pairs");
    const { purchaseReport } = await queryCurrentSpending(fixture.store);
    const feeRecord = purchaseReport.records.find((record) => record.purchaseId === `transaction:${fee}`);
    assert.deepEqual([feeRecord?.basis, feeRecord?.possibleDuplicate, feeRecord?.candidateIds], ["bank-transaction", false, []]);
    assert.equal(purchaseReport.candidates.some((candidate) => candidate.transactionId === fee), false);
    await assert.rejects(queryPGliteSpendingDirectPair(fixture.store, feeInvoice, fee, knowledgeAt), /ineligible/u);
    const linked = purchaseReport.records.find((record) => record.transaction?.transactionId === earlier);
    assert.deepEqual([linked?.basis, linked?.link?.invoiceId], ["linked", linkedInvoice], "a link the person confirmed before stays");
    const summary = await queryCurrentSpendingSummary(fixture.store, { knowledgeAt });
    assert.equal(summary.purchaseReport.recordCount, purchaseReport.records.length, "the summary and the built records agree");
  });
});
