import assert from "node:assert/strict";
import test from "node:test";
import { BANK_ROUTE, createSpendingCategoryFixture } from "./spending-test-fixture.ts";
import {
  decide,
  queryCurrentSpending,
  queryMonthPurchaseFacts,
  queryCurrentSpendingRecordPage,
  queryCurrentSpendingSummary,
} from "./purchase-report.ts";
import { applyPGliteFinancialPageAction, commitPGliteSpendingRefundRevision, confirmPGliteSpendingDedupLink } from "./spending-command.ts";
import { applySpendingSummaryDelta } from "../../lib/spending/model.ts";
import type { PGliteStore } from "./transaction.ts";

/**
 * Interface checks for the Purchase report: every read applies the same
 * purchase rules, whether it runs as SQL (summary, record page, month facts)
 * or through the record builder (complete report, Pairing decisions).
 */

type Fixture = Awaited<ReturnType<typeof createSpendingCategoryFixture>>;

function categoryTotal(totals: readonly { month: string; currency: string; categoryCode: string | null; coefficient: string; scale: number; count: number }[], code: string | null) {
  const row = totals.find((entry) => entry.month === "2026-09" && entry.currency === "TWD" && entry.categoryCode === code);
  return row ? { coefficient: row.coefficient, scale: row.scale, count: row.count } : null;
}

/** The complete report and every SQL read agree on records, dates, and money in each month. */
async function assertReadsAgree(fixture: Fixture, months: readonly string[]) {
  const knowledgeAt = await fixture.knowledgeAt();
  const complete = await fixture.store.transaction((transaction) => queryCurrentSpending(transaction));
  const summary = await fixture.store.transaction((transaction) => queryCurrentSpendingSummary(transaction));
  assert.equal(summary.purchaseReport.recordCount, complete.purchaseReport.records.length);
  assert.deepEqual(summary.purchaseReport.totalsByCurrency, complete.purchaseReport.totalsByCurrency);
  for (const month of months) {
    const expected = complete.purchaseReport.records.filter((record) => record.occurrence.value.startsWith(`${month}-`));
    const page = await fixture.store.transaction((transaction) => queryCurrentSpendingRecordPage(transaction, { knowledgeAt, month, limit: 100 }));
    assert.deepEqual(page.records.map((record) => record.purchaseId).sort(), expected.map((record) => record.purchaseId).sort(), month);
    const facts = await fixture.store.transaction((transaction) => queryMonthPurchaseFacts(transaction, knowledgeAt, { month }));
    assert.deepEqual(
      facts.map((fact) => fact.purchaseId).sort(),
      expected.filter((record) => record.basis !== "refund").map((record) => record.purchaseId).sort(),
      `${month} month facts`,
    );
    assert.equal(summary.purchaseReport.monthTotals.find((entry) => entry.month === month)?.recordCount ?? 0, expected.length, `${month} record count`);
  }
  return complete.purchaseReport;
}

test("month-scoped purchase reads match the complete report in every month", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const lateInvoice = await fixture.commitInvoice({ stableKey: "XM00000001:2026-09-30", date: "2026-09-30", sellerName: "Bakery", items: [{ sequence: 1, name: "Bread", amount: "600" }] });
    const earlyPayment = await fixture.addTransaction({ amount: "600", date: "2026-10-02", description: "Bakery", card: { consumeDate: "2026-10-01" } });
    await fixture.link(lateInvoice, earlyPayment);
    const septemberInvoice = await fixture.commitInvoice({ stableKey: "XM00000002:2026-09-28", date: "2026-09-28", sellerName: "Books", items: [{ sequence: 1, name: "Book", amount: "700" }] });
    const novemberPayment = await fixture.addTransaction({ amount: "700", date: "2026-11-05", description: "Books", card: { consumeDate: "2026-11-05" } });
    await fixture.link(septemberInvoice, novemberPayment);
    const revokedInvoice = await fixture.commitInvoice({ stableKey: "XM00000003:2026-09-12", date: "2026-09-12", sellerName: "Deli", items: [{ sequence: 1, name: "Sandwich", amount: "800" }] });
    const orphanedPayment = await fixture.addTransaction({ amount: "800", date: "2026-10-12", description: "Deli", card: { consumeDate: "2026-10-12" } });
    await fixture.link(revokedInvoice, orphanedPayment);
    await fixture.commitInvoice({ stableKey: "XM00000003:2026-09-12", revisionNumber: 2, revoked: true, date: "2026-09-12", sellerName: "Deli", items: [] });
    await fixture.commitInvoice({ stableKey: "XM00000004:2026-09-03", date: "2026-09-03", sellerName: "Cafe", items: [{ sequence: 1, name: "Latte", amount: "90" }] });
    await fixture.addTransaction({ amount: "55", date: "2026-11-20", description: "Taxi" });
    await fixture.addTransaction({ amount: "1000", date: "2026-09-21", description: "Salary", direction: "inflow" });

    const complete = await assertReadsAgree(fixture, ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]);
    const knowledgeAt = await fixture.knowledgeAt();
    const october = await fixture.store.transaction((transaction) => queryCurrentSpendingRecordPage(transaction, { knowledgeAt, month: "2026-10", limit: 100 }));
    assert.ok(october.records.some((record) => record.basis === "bank-transaction" && record.transaction?.transactionId === orphanedPayment),
      "a payment whose invoice was revoked stands alone in its own month");
    assert.ok(!october.records.some((record) => record.transaction?.transactionId === earlyPayment),
      "a payment linked to a September invoice is counted in September only");
    const linked = complete.records.find((record) => record.transaction?.transactionId === earlyPayment)!;
    const september = await fixture.store.transaction((transaction) => queryCurrentSpendingRecordPage(transaction, { knowledgeAt, month: "2026-09", limit: 100 }));
    assert.deepEqual(
      september.records.find((record) => record.purchaseId === linked.purchaseId),
      linked,
      "the complete report and the record page build the same linked record",
    );
    assert.deepEqual([linked.candidateIds, linked.possibleDuplicate, linked.paymentSource?.institution], [[], false, "fubon"]);
  } finally {
    await fixture.close();
  }
});

async function refund(store: PGliteStore, transactionId: string, revisionNumber: number, revoked = false) {
  return store.transaction((transaction) => commitPGliteSpendingRefundRevision(transaction, {
    stableRefundKey: `refund/${transactionId}`,
    transactionId,
    sourceRevisionKey: `refund-v${revisionNumber}`,
    revisionNumber,
    revisionKind: revoked ? "revoked" : revisionNumber === 1 ? "asserted" : "revised",
    amount: revoked ? null : { coefficient: "-100", scale: 0, currency: "TWD" },
    occurrence: revoked ? null : { value: "2026-09-10", precision: "date", timeZone: "Asia/Taipei", basis: "source-occurrence" },
    authorityRoute: BANK_ROUTE,
    provenanceReference: `fixture/refund/${revisionNumber}`,
    evidence: { sourceProvesRefund: true },
  }));
}

test("an active refund replaces its purchase and a withdrawn one leaves it standing in every read", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const refunded = await fixture.addTransaction({ amount: "300", date: "2026-09-08", description: "Shoes" });
    await fixture.addTransaction({ amount: "120", date: "2026-09-09", description: "Lunch" });

    await refund(fixture.store, refunded, 1);
    const active = await assertReadsAgree(fixture, ["2026-09"]);
    assert.deepEqual(active.records.map((record) => record.basis).sort(), ["bank-transaction", "refund"]);
    assert.deepEqual(active.totalsByCurrency, [{ currency: "TWD", coefficient: "20", scale: 0, count: 2 }]);

    await refund(fixture.store, refunded, 2, true);
    const withdrawn = await assertReadsAgree(fixture, ["2026-09"]);
    assert.deepEqual(withdrawn.records.map((record) => record.basis).sort(), ["bank-transaction", "bank-transaction"]);
    assert.ok(withdrawn.records.some((record) => record.transaction?.transactionId === refunded));
    assert.deepEqual(withdrawn.totalsByCurrency, [{ currency: "TWD", coefficient: "420", scale: 0, count: 2 }]);
  } finally {
    await fixture.close();
  }
});

test("a category page action returns the summary delta that reproduces the recomputed totals", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const bank = await fixture.addTransaction({ amount: "350", date: "2026-09-03" });
    const invoice = await fixture.commitInvoice({
      stableKey: "AB10000005:2026-09-04",
      date: "2026-09-04",
      items: [{ sequence: 1, name: "鮮奶", amount: "90" }],
    });
    for (const [purchaseId, recordId] of [[`transaction:${bank}`, bank], [`invoice:${invoice}`, invoice]] as const) {
      const before = await fixture.store.transaction((transaction) => queryCurrentSpendingSummary(transaction));
      const result = await applyPGliteFinancialPageAction(fixture.store, {
        action: "categorize",
        kind: "category",
        purchaseId,
        categoryCode: "dining",
        dataVersion: before.knowledgeAt,
      });
      assert.equal(result.knowledgeAt, before.knowledgeAt + 1);
      assert.deepEqual(result.affectedRecords.map((record) => record.purchaseId), [purchaseId]);
      assert.ok(
        result.affectedRecords.every((record) => record.invoice?.invoiceId === recordId || record.transaction?.transactionId === recordId),
        "the action reads only its own purchase",
      );
      const patched = applySpendingSummaryDelta(before.purchaseReport, result.baseKnowledgeAt, result.knowledgeAt, result.summaryDelta);
      const after = await fixture.store.transaction((transaction) => queryCurrentSpendingSummary(transaction));
      assert.equal(after.knowledgeAt, result.knowledgeAt);
      assert.deepEqual(patched.categoryTotalsByMonth, after.purchaseReport.categoryTotalsByMonth);
      assert.deepEqual(patched.totalsByCurrency, after.purchaseReport.totalsByCurrency);

      const repeat = await applyPGliteFinancialPageAction(fixture.store, {
        action: "categorize",
        kind: "category",
        purchaseId,
        categoryCode: "dining",
        dataVersion: result.knowledgeAt,
      });
      assert.equal(repeat.knowledgeAt, repeat.baseKnowledgeAt, "an unchanged category writes no commit");
      assert.deepEqual(repeat.summaryDelta, { before: [], after: [] });
    }
    assert.equal(categoryTotal((await fixture.store.transaction((transaction) => queryCurrentSpendingSummary(transaction))).purchaseReport.categoryTotalsByMonth, "dining")?.count, 2);
  } finally {
    await fixture.close();
  }
});

test("a category page action on a linked purchase moves the linked record's line, not a bank-only one", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    // The invoice and the bank posting fall in different months, so a delta
    // built from the bank-only record would move the wrong month's totals.
    const bank = await fixture.addTransaction({ amount: "350", date: "2026-10-02" });
    const invoice = await fixture.commitInvoice({ stableKey: "AB10000006:2026-09-29", date: "2026-09-29", items: [{ sequence: 1, name: "汽油", amount: "350" }] });
    await fixture.addTransaction({ amount: "500", date: "2026-10-05" });
    const linkedAt = await fixture.knowledgeAt();
    await fixture.store.transaction((transaction) => confirmPGliteSpendingDedupLink(transaction, {
      invoiceId: invoice,
      transactionId: bank,
      decisionKey: `check/category-linked/${invoice}/${bank}`,
      origin: { kind: "user", userId: "local-user" },
      evidenceKnowledgeSequence: linkedAt,
      evidence: { check: true },
    }));
    const linked = (await fixture.store.transaction((transaction) => queryCurrentSpending(transaction)))
      .purchaseReport.records.find((record) => record.basis === "linked");
    assert.ok(linked, "the pair is one linked purchase");
    const before = await fixture.store.transaction((transaction) => queryCurrentSpendingSummary(transaction));
    const result = await applyPGliteFinancialPageAction(fixture.store, {
      action: "categorize",
      kind: "category",
      purchaseId: linked.purchaseId,
      categoryCode: "dining",
      dataVersion: before.knowledgeAt,
    });
    assert.deepEqual(result.affectedRecords.map((record) => [record.purchaseId, record.basis]), [[linked.purchaseId, "linked"]]);
    const patched = applySpendingSummaryDelta(before.purchaseReport, result.baseKnowledgeAt, result.knowledgeAt, result.summaryDelta);
    const after = await fixture.store.transaction((transaction) => queryCurrentSpendingSummary(transaction));
    assert.deepEqual(patched.categoryTotalsByMonth, after.purchaseReport.categoryTotalsByMonth);
    assert.deepEqual(patched.totalsByCurrency, after.purchaseReport.totalsByCurrency);
  } finally {
    await fixture.close();
  }
});

test("decide returns the summary delta that reproduces the recomputed category totals", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const bank = await fixture.addTransaction({ amount: "350", date: "2026-09-03" });
    const fuelInvoice = await fixture.commitInvoice({
      stableKey: "AB10000004:2026-09-03",
      date: "2026-09-03",
      items: [{ sequence: 1, name: "汽油", amount: "350" }],
    });
    const before = await fixture.store.transaction((transaction) => queryCurrentSpendingSummary(transaction));
    assert.deepEqual(categoryTotal(before.purchaseReport.categoryTotalsByMonth, "transportation"), { coefficient: "350", scale: 0, count: 1 });
    assert.deepEqual(categoryTotal(before.purchaseReport.categoryTotalsByMonth, null), { coefficient: "350", scale: 0, count: 1 });

    const decision = await fixture.store.transaction((transaction) => decide(
      transaction,
      { invoiceIds: [fuelInvoice], transactionIds: [bank] },
      (tx) => confirmPGliteSpendingDedupLink(tx, {
        invoiceId: fuelInvoice,
        transactionId: bank,
        decisionKey: `check/decide/${fuelInvoice}/${bank}`,
        origin: { kind: "user", userId: "local-user" },
        evidenceKnowledgeSequence: before.knowledgeAt,
        evidence: { check: true },
      }),
    ));
    assert.equal(decision.baseKnowledgeAt, before.knowledgeAt);
    assert.deepEqual(decision.beforeRecords.map((record) => record.basis).sort(), ["bank-transaction", "invoice"]);
    assert.deepEqual(decision.affectedRecords.map((record) => record.basis), ["linked"]);
    assert.deepEqual(decision.summaryDelta.before.map((line) => line.category.mode === "single" ? line.category.categoryCode : line.category.mode).sort(), ["absent", "transportation"]);
    assert.deepEqual(decision.summaryDelta.after.map((line) => line.category.mode === "single" ? [line.category.categoryCode, line.category.subject] : line.category.mode), [["transportation", "items"]]);

    const patched = applySpendingSummaryDelta(before.purchaseReport, decision.baseKnowledgeAt, decision.knowledgeAt, decision.summaryDelta);
    const after = await fixture.store.transaction((transaction) => queryCurrentSpendingSummary(transaction));
    assert.equal(after.knowledgeAt, decision.knowledgeAt);
    assert.deepEqual(patched.categoryTotalsByMonth, after.purchaseReport.categoryTotalsByMonth);
    assert.deepEqual(patched.totalsByCurrency, after.purchaseReport.totalsByCurrency);
    assert.deepEqual(categoryTotal(after.purchaseReport.categoryTotalsByMonth, "transportation"), { coefficient: "350", scale: 0, count: 1 }, "the linked purchase takes the items' code once on the bank amount");
    assert.equal(categoryTotal(after.purchaseReport.categoryTotalsByMonth, null), null, "the bank-only Unclassified row is gone");
  } finally {
    await fixture.close();
  }
});
