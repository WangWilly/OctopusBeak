import assert from "node:assert/strict";
import test from "node:test";
import { BANK_ROUTE, createSpendingCategoryFixture, freshPage, setKind } from "./spending-test-fixture.ts";
import { createPGliteSpendingQuery } from "./spending-query.ts";
import { setPGliteSpendingPurchaseCategory } from "./purchase-category-command.ts";
import { applyPGliteFinancialPageAction, commitPGliteSpendingRefundRevision } from "./spending-command.ts";
import { queryCurrentSpendingRecordPage } from "./purchase-report.ts";

const RANGE = { startDate: "2026-08-01", endDate: "2026-09-30" };

test("the classify queue lists the range's Unclassified purchases that the user never categorized", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const plain = await fixture.addTransaction({ amount: "300", date: "2026-09-05", description: "全聯福利中心－台北民生", card: { consumeDate: "2026-09-05", cardMask: "1234" } });
    const userCategorized = await fixture.addTransaction({ amount: "120", date: "2026-09-06", description: "鼎泰豐" });
    const cleared = await fixture.addTransaction({ amount: "80", date: "2026-08-20", description: "大苑子" });
    const refunded = await fixture.addTransaction({ amount: "450", date: "2026-09-08", description: "Shoes" });
    const beforeRange = await fixture.addTransaction({ amount: "60", date: "2026-07-31", description: "Taxi" });
    const withheld = await fixture.addTransaction({ amount: "70", date: "2026-09-09", description: "扣繳稅款" });
    const linkedPayment = await fixture.addTransaction({ amount: "500", date: "2026-09-12", description: "PCHOME", card: { consumeDate: "2026-09-12" } });
    const linkedInvoice = await fixture.commitInvoice({ stableKey: "AB10000001:2026-09-12", date: "2026-09-12", sellerName: "網路家庭國際資訊股份有限公司", items: [{ sequence: 1, name: "Cable", amount: "500" }] });
    await fixture.link(linkedInvoice, linkedPayment);
    const derivedInvoice = await fixture.commitInvoice({ stableKey: "AB10000002:2026-09-14", date: "2026-09-14", sellerName: "全聯實業股份有限公司", items: [{ sequence: 1, name: "鮮奶", amount: "90" }] });
    const plainInvoice = await fixture.commitInvoice({ stableKey: "AB10000003:2026-09-15", date: "2026-09-15", sellerName: "某某工作室", items: [{ sequence: 1, name: "Widget", amount: "250" }] });
    const itemless = await fixture.commitInvoice({ stableKey: "AB10000005:2026-09-17", date: "2026-09-17", sellerName: "某某工作室", total: "120", items: [] });
    const negativeOnly = await fixture.commitInvoice({ stableKey: "AB10000006:2026-09-18", date: "2026-09-18", sellerName: "某某工作室", total: "80", items: [{ sequence: 1, name: "折讓", amount: "-20" }] });
    await setKind(fixture.store, withheld, "tax.withholding");

    let knowledgeAt = await fixture.knowledgeAt();
    knowledgeAt = (await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId: `transaction:${userCategorized}`, knowledgeAt, categoryCode: "dining" })).knowledgeAt;
    knowledgeAt = (await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId: `transaction:${cleared}`, knowledgeAt, categoryCode: "dining" })).knowledgeAt;
    knowledgeAt = (await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId: `transaction:${cleared}`, knowledgeAt, categoryCode: null })).knowledgeAt;
    const partlyUser = await fixture.commitInvoice({ stableKey: "AB10000004:2026-09-16", date: "2026-09-16", sellerName: "某某工作室", items: [{ sequence: 1, name: "Widget", amount: "250" }] });
    knowledgeAt = await fixture.knowledgeAt();
    await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId: `invoice:${partlyUser}`, knowledgeAt, categoryCode: "dining" });
    // A revision adds an item the user never saw: the items no longer agree, but item 1 keeps its user category.
    await fixture.commitInvoice({ stableKey: "AB10000004:2026-09-16", revisionNumber: 2, date: "2026-09-16", sellerName: "某某工作室", items: [{ sequence: 1, name: "Widget", amount: "250" }, { sequence: 2, name: "Gadget", amount: "100" }] });
    await fixture.store.transaction((transaction) => commitPGliteSpendingRefundRevision(transaction, {
      stableRefundKey: `refund/${refunded}`,
      transactionId: refunded,
      sourceRevisionKey: "refund-v1",
      revisionNumber: 1,
      revisionKind: "asserted",
      amount: { coefficient: "-450", scale: 0, currency: "TWD" },
      occurrence: { value: "2026-09-10", precision: "date", timeZone: "Asia/Taipei", basis: "source-occurrence" },
      authorityRoute: BANK_ROUTE,
      provenanceReference: "fixture/refund/1",
      evidence: { sourceProvesRefund: true },
    }));
    knowledgeAt = await fixture.knowledgeAt();

    const shown = await fixture.store.transaction((transaction) => Promise.all(["2026-08", "2026-09"].map((month) =>
      queryCurrentSpendingRecordPage(transaction, { knowledgeAt, month, limit: 100 }))));
    const unclassified = shown.flatMap((page) => page.records).filter((record) => record.category.mode === "absent");
    assert.ok(unclassified.some((record) => record.basis === "refund"), "Spending shows the refund as Unclassified");
    assert.ok(unclassified.some((record) => record.purchaseId === `transaction:${withheld}`), "Spending shows a withholding as Unclassified");
    assert.ok(unclassified.some((record) => record.purchaseId === `invoice:${partlyUser}`
      && record.itemCategorizations.some((item) => item.origin === "user")), "Spending shows a partly user-categorized invoice as Unclassified");
    for (const invoiceId of [itemless, negativeOnly])
      assert.ok(unclassified.some((record) => record.purchaseId === `invoice:${invoiceId}`), "Spending shows an invoice without a non-negative item as Unclassified");

    const query = createPGliteSpendingQuery(fixture.store);
    assert.deepEqual(await query.classifyQueue({ knowledgeAt: knowledgeAt - 1, ...RANGE }), { stale: true, knowledgeAt });
    const queue = freshPage(await query.classifyQueue({ knowledgeAt, ...RANGE }));
    assert.equal(queue.knowledgeAt, knowledgeAt, "the categorize action's dataVersion");
    const linked = shown.flatMap((page) => page.records).find((record) => record.basis === "linked")!;
    assert.deepEqual(
      [...queue.items].sort((left, right) => left.purchaseId.localeCompare(right.purchaseId)),
      [
        {
          purchaseId: `invoice:${plainInvoice}`, basis: "invoice", date: "2026-09-15", title: "某某工作室",
          amount: { currency: "TWD", coefficient: "250", scale: 0 }, payment: null,
          details: { time: "13:45", bankDescription: null, items: [
            { name: "Widget", quantity: { coefficient: "1", scale: 0 }, amount: { currency: "TWD", coefficient: "250", scale: 0 } },
          ] },
        },
        {
          purchaseId: linked.purchaseId, basis: "linked", date: "2026-09-12", title: "網路家庭國際資訊股份有限公司",
          amount: { currency: "TWD", coefficient: "500", scale: 0 }, payment: { stream: "credit-card", institution: "fubon", cardMask: null },
          details: { time: "13:45", bankDescription: "PCHOME", items: [
            { name: "Cable", quantity: { coefficient: "1", scale: 0 }, amount: { currency: "TWD", coefficient: "500", scale: 0 } },
          ] },
        },
        {
          purchaseId: `transaction:${cleared}`, basis: "bank-transaction", date: "2026-08-20", title: "大苑子",
          amount: { currency: "TWD", coefficient: "80", scale: 0 }, payment: { stream: "credit-card", institution: "fubon", cardMask: null },
          details: { time: null, bankDescription: null, items: [] },
        },
        {
          purchaseId: `transaction:${plain}`, basis: "bank-transaction", date: "2026-09-05", title: "全聯福利中心－台北民生",
          amount: { currency: "TWD", coefficient: "300", scale: 0 }, payment: { stream: "credit-card", institution: "fubon", cardMask: "****1234" },
          details: { time: null, bankDescription: null, items: [] }, // the bank's words are already the title
        },
      ].sort((left, right) => left.purchaseId.localeCompare(right.purchaseId)),
    );
    const queued = new Set(queue.items.map((item) => item.purchaseId));
    assert.ok(!queued.has(`transaction:${userCategorized}`), "a user category keeps a purchase out");
    assert.ok(!queued.has(`invoice:${partlyUser}`), "a user item category keeps an Unclassified purchase out, since clearing would withdraw it");
    assert.ok(!queued.has(`transaction:${beforeRange}`), "a purchase before the range stays out");
    assert.ok(!queued.has(`invoice:${derivedInvoice}`), "an automatically categorized purchase stays out");
    assert.ok(!queued.has(`invoice:${itemless}`), "an invoice without items stays out: a category on it would show nowhere");
    assert.ok(!queued.has(`invoice:${negativeOnly}`), "an invoice of only negative items stays out: the category reading skips them");
    assert.ok(!queued.has(`transaction:${withheld}`), "a Kind that accepts no category stays out");

    const september = freshPage(await query.classifyQueue({ knowledgeAt, startDate: "2026-09-05", endDate: "2026-09-05" }));
    assert.deepEqual(september.items.map((item) => item.purchaseId), [`transaction:${plain}`], "both range bounds are inclusive");
    await assert.rejects(query.classifyQueue({ knowledgeAt, startDate: "2026-09-30", endDate: "2026-09-01" }), /ends before it starts/u);
  } finally {
    await fixture.close();
  }
});

test("categorizing the whole queue empties it and clearing the same set restores it exactly", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    await fixture.addTransaction({ amount: "300", date: "2026-09-05", description: "全聯福利中心－台北民生" });
    await fixture.addTransaction({ amount: "80", date: "2026-08-20", description: "金融卡消費 · 大苑子" });
    const payment = await fixture.addTransaction({ amount: "500", date: "2026-09-12", description: "PCHOME", card: { consumeDate: "2026-09-12" } });
    const linked = await fixture.commitInvoice({ stableKey: "AB10000011:2026-09-12", date: "2026-09-12", sellerName: "網路家庭國際資訊股份有限公司", items: [{ sequence: 1, name: "Cable", amount: "500" }] });
    await fixture.link(linked, payment);
    await fixture.commitInvoice({ stableKey: "AB10000012:2026-09-15", date: "2026-09-15", sellerName: "某某工作室", items: [{ sequence: 1, name: "Widget", amount: "250" }, { sequence: 2, name: "Gadget", amount: "100" }] });
    const query = createPGliteSpendingQuery(fixture.store);
    const read = async () => freshPage(await query.classifyQueue({ knowledgeAt: await fixture.knowledgeAt(), ...RANGE }));
    const categorizeMany = (purchaseIds: readonly string[], categoryCode: string | null, dataVersion: number) =>
      applyPGliteFinancialPageAction(fixture.store, { action: "categorize", kind: "category_many", purchaseIds, categoryCode, dataVersion });

    const before = await read();
    const purchaseIds = before.items.map((item) => item.purchaseId);
    assert.equal(purchaseIds.length, 4);

    const applied = await categorizeMany(purchaseIds, "food_and_groceries", before.knowledgeAt);
    const categorized = await read();
    assert.equal(categorized.knowledgeAt, applied.knowledgeAt);
    assert.deepEqual(categorized.items.filter((item) => purchaseIds.includes(item.purchaseId)), [], "a categorized purchase leaves the queue");

    const undone = await categorizeMany(purchaseIds, null, categorized.knowledgeAt);
    const after = await read();
    assert.equal(after.knowledgeAt, undone.knowledgeAt);
    assert.deepEqual(after.items, before.items, "clearing returns every queued purchase exactly as it was");
  } finally {
    await fixture.close();
  }
});

test("a queued invoice carries every item, in invoice order", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const names = ["Widget", "Gadget", "Gizmo", "Sprocket", "Bracket", "Hinge", "Spring"];
    const invoice = await fixture.commitInvoice({
      stableKey: "AB20000001:2026-09-20", date: "2026-09-20", sellerName: "某某工作室",
      items: names.map((name, index) => ({ sequence: index + 1, name, amount: String(10 * (index + 1)) })),
    });
    const knowledgeAt = await fixture.knowledgeAt();
    const queue = freshPage(await createPGliteSpendingQuery(fixture.store).classifyQueue({ knowledgeAt, ...RANGE }));
    const details = queue.items.find((item) => item.purchaseId === `invoice:${invoice}`)!.details;
    assert.deepEqual(details.items.map((item) => item.name), names);
  } finally {
    await fixture.close();
  }
});
