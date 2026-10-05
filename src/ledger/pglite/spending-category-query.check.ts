import assert from "node:assert/strict";
import test from "node:test";
import { createSpendingCategoryFixture, type SpendingCategoryFixture } from "./spending-test-fixture.ts";
import { setPGliteSpendingPurchaseCategory } from "./purchase-category-command.ts";
import { createPGliteSpendingQuery } from "./spending-query.ts";
import { applyPGliteSpendingPageAction } from "./spending-command.ts";
import { applySpendingSummaryDelta, SPENDING_UNCLASSIFIED_CATEGORY_SELECTOR } from "../../lib/spending/model.ts";

type Seeded = Readonly<{
  fixture: SpendingCategoryFixture;
  uncategorizedBank: string;
  userBank: string;
  linkedBank: string;
  splitInvoice: string;
  agreedInvoice: string;
  linkedInvoice: string;
  linkEventId: string;
}>;

async function seed(): Promise<Seeded> {
  const fixture = await createSpendingCategoryFixture();
  const uncategorizedBank = await fixture.addTransaction({ amount: "350", date: "2026-09-03" });
  const userBank = await fixture.addTransaction({ amount: "200", date: "2026-09-04" });
  const linkedBank = await fixture.addTransaction({ amount: "150", date: "2026-09-05" });
  const splitInvoice = await fixture.commitInvoice({
    stableKey: "AB10000001:2026-09-01",
    date: "2026-09-01",
    items: [{ sequence: 1, name: "拿鐵", amount: "120" }, { sequence: 2, name: "衛生紙", amount: "80" }],
  });
  const agreedInvoice = await fixture.commitInvoice({
    stableKey: "AB10000002:2026-09-02",
    date: "2026-09-02",
    items: [{ sequence: 1, name: "拿鐵", amount: "60" }, { sequence: 2, name: "美式", amount: "40" }],
  });
  const linkedInvoice = await fixture.commitInvoice({
    stableKey: "AB10000003:2026-09-05",
    date: "2026-09-05",
    items: [{ sequence: 1, name: "拿鐵", amount: "150" }],
  });
  const linkEventId = await fixture.link(linkedInvoice, linkedBank);
  await setPGliteSpendingPurchaseCategory(fixture.store, { purchaseId: `transaction:${userBank}`, knowledgeAt: await fixture.knowledgeAt(), categoryCode: "healthcare" });
  return { fixture, uncategorizedBank, userBank, linkedBank, splitInvoice, agreedInvoice, linkedInvoice, linkEventId };
}

function categoryTotal(totals: readonly { month: string; currency: string; categoryCode: string | null; coefficient: string; scale: number; count: number }[], code: string | null) {
  const row = totals.find((entry) => entry.month === "2026-09" && entry.currency === "TWD" && entry.categoryCode === code);
  return row ? { coefficient: row.coefficient, scale: row.scale, count: row.count } : null;
}

test("record pages carry each purchase's category and the summary totals per month and code", async () => {
  const seeded = await seed();
  const { fixture } = seeded;
  try {
    const query = createPGliteSpendingQuery(fixture.store);
    const knowledgeAt = await fixture.knowledgeAt();
    const page = await query.recordPage({ knowledgeAt, month: "2026-09" });
    const byId = new Map(page.records.map((record) => [record.purchaseId, record]));
    assert.deepEqual(byId.get(`transaction:${seeded.uncategorizedBank}`)?.category, { mode: "absent" });
    const user = byId.get(`transaction:${seeded.userBank}`)?.category;
    assert.deepEqual(user, { mode: "single", origin: "user", subject: "transaction", categoryCode: "healthcare", labels: { en: "Healthcare", zhHant: "醫療保健" }, taxonomyId: "transaction-taxonomy", taxonomyVersion: "v1" });
    const split = byId.get(`invoice:${seeded.splitInvoice}`)?.category;
    assert.equal(split?.mode, "split");
    assert.deepEqual(split?.mode === "split" && split.components.map((component) => [component.categoryCode, component.amount.coefficient]), [["dining", "120"], ["household_goods_and_services", "80"]]);
    const agreed = byId.get(`invoice:${seeded.agreedInvoice}`)?.category;
    assert.deepEqual(agreed?.mode === "single" && [agreed.categoryCode, agreed.origin, agreed.subject], ["dining", "derived", "items"]);
    const linked = byId.get(`link:${seeded.linkEventId}`);
    assert.equal(linked?.basis, "linked");
    assert.deepEqual(linked?.category.mode === "single" && [linked.category.categoryCode, linked.category.subject], ["dining", "items"]);
    assert.deepEqual(linked?.itemCategorizations.map((item) => [item.sequence, item.categoryCode, item.origin]), [[1, "dining", "derived"]]);

    const summary = await query.summary({ knowledgeAt });
    const totals = summary.purchaseReport.categoryTotalsByMonth;
    assert.deepEqual(categoryTotal(totals, "dining"), { coefficient: "370", scale: 0, count: 3 }, "a split counts once under each code it touches with that code's amount");
    assert.deepEqual(categoryTotal(totals, "household_goods_and_services"), { coefficient: "80", scale: 0, count: 1 });
    assert.deepEqual(categoryTotal(totals, "healthcare"), { coefficient: "200", scale: 0, count: 1 });
    assert.deepEqual(categoryTotal(totals, null), { coefficient: "350", scale: 0, count: 1 }, "Unclassified is separate from every code");
    assert.equal(totals.filter((row) => row.month !== "2026-09").length, 0);
  } finally {
    await fixture.close();
  }
});

test("record pages filter by code lists, with an Unclassified selector, and reject cursors from another filter", async () => {
  const seeded = await seed();
  const { fixture } = seeded;
  try {
    const query = createPGliteSpendingQuery(fixture.store);
    const knowledgeAt = await fixture.knowledgeAt();
    const ids = async (categoryCodes: readonly string[]) =>
      (await query.recordPage({ knowledgeAt, month: "2026-09", categoryCodes })).records.map((record) => record.purchaseId).sort();
    assert.deepEqual(await ids(["dining"]), [`invoice:${seeded.agreedInvoice}`, `invoice:${seeded.splitInvoice}`, `link:${seeded.linkEventId}`].sort());
    assert.deepEqual(await ids([SPENDING_UNCLASSIFIED_CATEGORY_SELECTOR]), [`transaction:${seeded.uncategorizedBank}`]);
    assert.deepEqual(await ids(["household_goods_and_services", SPENDING_UNCLASSIFIED_CATEGORY_SELECTOR]), [`invoice:${seeded.splitInvoice}`, `transaction:${seeded.uncategorizedBank}`].sort());
    assert.deepEqual(await ids(["travel"]), []);
    const filtered = await query.recordPage({ knowledgeAt, month: "2026-09", categoryCodes: ["dining"], limit: 1 });
    assert.equal(filtered.records.length, 1);
    assert.deepEqual(filtered.categoryCodes, ["dining"]);
    assert.ok(filtered.nextCursor, "a filtered page keeps paging within the filter");
    const next = await query.recordPage({ knowledgeAt, month: "2026-09", categoryCodes: ["dining"], cursor: filtered.nextCursor, limit: 5 });
    assert.equal(next.records.length, 2);
    await assert.rejects(
      query.recordPage({ knowledgeAt, month: "2026-09", cursor: filtered.nextCursor }),
      /cursor is stale or invalid/u,
      "a cursor minted under one filter cannot page another",
    );
  } finally {
    await fixture.close();
  }
});

test("a direct confirmation's summary delta reproduces the recomputed category totals", async () => {
  const seeded = await seed();
  const { fixture } = seeded;
  try {
    const fuelInvoice = await fixture.commitInvoice({
      stableKey: "AB10000004:2026-09-03",
      date: "2026-09-03",
      items: [{ sequence: 1, name: "汽油", amount: "350" }],
    });
    const query = createPGliteSpendingQuery(fixture.store);
    const before = await query.summary({ knowledgeAt: await fixture.knowledgeAt() });
    assert.deepEqual(categoryTotal(before.purchaseReport.categoryTotalsByMonth, "transportation"), { coefficient: "350", scale: 0, count: 1 });
    assert.deepEqual(categoryTotal(before.purchaseReport.categoryTotalsByMonth, null), { coefficient: "350", scale: 0, count: 1 });

    const result = await applyPGliteSpendingPageAction(fixture.store, {
      action: "confirm",
      kind: "direct",
      invoiceIdentityId: fuelInvoice,
      transactionIdentityId: seeded.uncategorizedBank,
      dataVersion: before.knowledgeAt,
    });
    assert.deepEqual(result.summaryDelta.before.map((line) => line.category.mode === "single" ? line.category.categoryCode : line.category.mode).sort(), ["absent", "transportation"]);
    assert.deepEqual(result.summaryDelta.after.map((line) => line.category.mode === "single" ? [line.category.categoryCode, line.category.subject] : line.category.mode), [["transportation", "items"]]);

    const patched = applySpendingSummaryDelta(before.purchaseReport, result.baseKnowledgeAt, result.knowledgeAt, result.summaryDelta);
    const after = await query.summary({ knowledgeAt: result.knowledgeAt });
    assert.deepEqual(patched.categoryTotalsByMonth, after.purchaseReport.categoryTotalsByMonth);
    assert.deepEqual(categoryTotal(after.purchaseReport.categoryTotalsByMonth, "transportation"), { coefficient: "350", scale: 0, count: 1 }, "the linked purchase takes the items' code once on the bank amount");
    assert.equal(categoryTotal(after.purchaseReport.categoryTotalsByMonth, null), null, "the bank-only Unclassified row is gone");
  } finally {
    await fixture.close();
  }
});
