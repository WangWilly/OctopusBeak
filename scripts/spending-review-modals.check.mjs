import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { createSpendingViteServer, spendingDesktopApiInitScript } from "./spending-browser-harness.mjs";

const TWD = (value) => ({ currency: "TWD", coefficient: String(value), scale: 0 });
const total = { ...TWD(3150), count: 3 };
const day = (value) => ({ value, precision: "date", timeZone: "Asia/Taipei", basis: "purchase-date" });
const month = "2026-10";

function purchase(id, basis, fields) {
  return {
    purchaseId: id, basis, amount: TWD(fields.amount), occurrence: day(fields.date), description: fields.description,
    invoice: fields.invoice ?? null, transaction: fields.transaction ?? null, items: fields.invoice?.revision.items ?? [],
    possibleDuplicate: Boolean(fields.candidateIds?.length), candidateIds: fields.candidateIds ?? [], link: fields.link ?? null,
    difference: null, refund: null, category: fields.category ?? { mode: "absent" }, itemCategorizations: [], paymentSource: fields.paymentSource ?? null,
  };
}
const invoice = { invoiceId: "inv-1", revision: { invoiceNumber: "AB-38201745", seller: { name: "全聯實業股份有限公司" }, occurrence: day("2026-10-03"), total: TWD(1444), items: [{ itemId: "i1", name: "林鳳營鮮乳", quantity: { coefficient: "2", scale: 0 }, amount: TWD(1444), sourceFacts: {} }] } };
const payment = { transactionId: "tx-1", effectiveOn: "2026-10-03", consumeDate: "2026-10-03", postingDate: "2026-10-04", description: "全聯福利中心", amount: TWD(1444), stream: "credit-card", effectiveDateBasis: "consume-date" };
const records = [
  purchase("transaction:tx-1", "bank-transaction", { amount: 1444, date: "2026-10-03", description: "全聯福利中心", transaction: payment, candidateIds: ["cand-1"], paymentSource: { institution: "esun", cardMask: "****5512", billingPeriod: null }, category: { mode: "single", origin: "derived", subject: "transaction", categoryCode: "food_and_groceries", labels: null, taxonomyId: "t", taxonomyVersion: "v1" } }),
  purchase("invoice:inv-1", "invoice", { amount: 1444, date: "2026-10-03", description: "全聯實業股份有限公司", invoice, candidateIds: ["cand-1"] }),
  purchase("transaction:tx-2", "bank-transaction", { amount: 262, date: "2026-10-02", description: "路易莎咖啡", transaction: { ...payment, transactionId: "tx-2", description: "路易莎咖啡", amount: TWD(262) } }),
];
const pair = { candidateId: "cand-1", invoiceIdentityId: "inv-1", transactionIdentityId: "tx-1" };
const model = {
  canonical: { availability: "available", knowledgePoint: 7, totalsByCurrency: [], totalStatus: "complete" },
  invoices: [],
  purchaseReport: {
    status: "ok", kind: "current", knowledgeAt: 7, financialAt: null, records: [], candidates: [], totalsByCurrency: [total], totalStatus: "includes-pending-confirmation",
    summary: {
      recordCount: 3, candidateCount: null, pendingCandidateCount: null, candidateState: "unloaded", currencies: ["TWD"], totalsByCurrency: [total],
      monthTotals: [{ month, recordCount: 3, activeDayCount: 2, pendingCandidateCount: null, totalsByCurrency: [total] }],
      dayTotals: [
        { month, date: "2026-10-02", recordCount: 1, totalsByCurrency: [{ ...TWD(262), count: 1 }] },
        { month, date: "2026-10-03", recordCount: 2, totalsByCurrency: [{ ...TWD(2888), count: 2 }] },
      ],
      categoryTotalsByMonth: [
        { month, currency: "TWD", categoryCode: "food_and_groceries", coefficient: "1444", scale: 0, count: 1 },
        { month, currency: "TWD", categoryCode: null, coefficient: "1706", scale: 0, count: 2 },
      ],
    },
  },
};

function installReads({ records, pair }) {
  const spending = window.octopusBeak.spending;
  window.__calls = { actions: [], strong: [], categories: [] };
  const item = { candidate: { candidateId: pair.candidateId, algorithm: "fixture", algorithmVersion: "1", status: "candidate", invoiceId: pair.invoiceIdentityId, transactionId: pair.transactionIdentityId, strength: "strong", reasons: { amountEqual: true, dayDistance: 0, merchantMatch: true } }, invoiceRecord: records[1], paymentRecord: records[0] };
  spending.loadRecordPage = async (input) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, month: input.month ?? null, day: null, categoryCodes: null, query: null, basis: input.basis ?? null, records: input.basis === "linked" ? [] : records, nextCursor: null });
  spending.loadCandidatePage = async (input) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, month: input.month, items: [item], totalCandidateCount: 1, strongCandidateCount: 1, nextOffset: null });
  spending.cancelCandidatePage = async () => true;
  spending.loadPendingOverview = async (input) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, pendingCount: 4, strongCount: 2, affectedByCurrency: [{ currency: "TWD", coefficient: "4658", scale: 0, count: 3 }], strongPairs: [pair, { candidateId: "cand-9", invoiceIdentityId: "inv-9", transactionIdentityId: "tx-9" }] });
  spending.confirmStrongCandidates = async (input) => {
    window.__calls.strong.push(input);
    return window.__calls.strong.length === 1
      ? { status: "conflict", knowledgeAt: 7, conflicts: [input.pairs[1]], strongPairs: [input.pairs[0]] }
      : { status: "committed", baseKnowledgeAt: 7, knowledgeAt: 8, confirmed: [] };
  };
  spending.applyPageAction = async (input) => {
    window.__calls.actions.push(input);
    return new Promise(() => {});
  };
  spending.setPurchaseCategory = async (input) => {
    window.__calls.categories.push(input);
    return { purchaseId: input.purchaseId, subject: "transaction", categoryCode: input.categoryCode, baseKnowledgeAt: input.knowledgeAt, knowledgeAt: input.knowledgeAt };
  };
}

async function openPage(browser, server, { hidden = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(spendingDesktopApiInitScript(model) + `;(${installReads.toString()})(${JSON.stringify({ records, pair })});`);
  await page.addInitScript((valuesVisible) => {
    localStorage.setItem("octopusbeak-locale", "zh-TW");
    localStorage.setItem("octopusbeak-values-visible", valuesVisible);
  }, hidden ? "0" : "1");
  await page.goto(server.resolvedUrls.local[0] + "#/spending");
  await page.locator("[data-purchase-record]").first().waitFor();
  return { page, errors };
}

async function visibleUnblurredAmounts(page) {
  return page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent?.trim() ?? "";
      if (!/TWD\s?[\d,]+|^[\d,]{3,}$/u.test(text)) continue;
      const element = walker.currentNode.parentElement;
      if (!element || element.closest("[aria-hidden='true'], .visually-hidden, option")) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      let blurred = false;
      for (let current = element; current && !blurred; current = current.parentElement) blurred = getComputedStyle(current).filter.includes("blur");
      if (!blurred) out.push(text);
    }
    return out;
  });
}

test("the 帳目合併 and 消費明細 modals act on the pairs and purchase they show", async (t) => {
  const server = await createSpendingViteServer();
  const browser = await chromium.launch({ headless: true });
  try {
    await t.test("merge modal", async () => {
      const { page, errors } = await openPage(browser, server);
      await page.locator("[data-pending-overview-count]").filter({ hasText: "4" }).waitFor();
      await page.locator("[data-open-merge]").click();
      await page.locator("[data-merge-modal] [data-pair-id='cand-1']").waitFor();
      assert.deepEqual(await page.locator("[data-merge-tab]").allTextContents(), ["待合併1", "已合併0"].map((text) => text), "only the 待合併 and 已合併 tabs");
      await page.locator("[data-merge-later]").click();
      await page.locator("[data-merge-modal]").waitFor({ state: "detached" });
      assert.deepEqual(await page.evaluate(() => window.__calls), { actions: [], strong: [], categories: [] }, "稍後處理 only closes");

      await page.locator("[data-open-merge]").click();
      await page.locator("[data-merge-all-strong]").filter({ hasText: "2 組" }).click();
      await page.locator("[data-strong-conflict]").waitFor();
      await page.locator("[data-merge-all-strong]").filter({ hasText: "1 組" }).click();
      await page.waitForFunction(() => window.__calls.strong.length === 2);
      const strong = await page.evaluate(() => window.__calls.strong);
      assert.equal(strong[0].pairs.length, 2);
      assert.match(strong[0].month ?? "", /^\d{4}-\d{2}$/u, "the batch carries the page's month");
      assert.deepEqual(strong[1], { shownKnowledgeAt: 7, month: strong[0].month, pairs: [strong[0].pairs[0]] }, "the second press confirms the recomputed set in the same month");

      await page.locator("[data-merge-modal] [data-pair-id='cand-1'] [data-confirm-candidate]").click();
      await page.waitForFunction(() => window.__calls.actions.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__calls.actions[0]), {
        action: "confirm", kind: "candidate", candidateId: "cand-1", invoiceIdentityId: "inv-1", transactionIdentityId: "tx-1", dataVersion: 7,
      });
      assert.deepEqual(errors, []);
      await page.close();
    });

    await t.test("purchase modal", async () => {
      const { page, errors } = await openPage(browser, server);
      await page.waitForTimeout(1400);
      await page.locator("[data-purchase-record][data-basis='bank-transaction']").first().click();
      const modal = page.locator("[data-purchase-modal]");
      await modal.locator("[data-pending-match='cand-1']").waitFor();
      assert.match(await modal.textContent() ?? "", /玉山銀行信用卡 末碼 5512/u);
      assert.match(await modal.textContent() ?? "", /電子發票 AB-38201745/u);
      await modal.locator("[data-change-category]").click();
      await modal.locator("[data-category-code='dining']").click();
      await page.waitForFunction(() => window.__calls.categories.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__calls.categories[0]), { purchaseId: "transaction:tx-1", knowledgeAt: 7, categoryCode: "dining" });
      await modal.locator("[data-change-category]").click();
      await modal.locator("[data-clear-category]").click();
      await page.waitForFunction(() => window.__calls.categories.length === 2);
      assert.equal(await page.evaluate(() => window.__calls.categories[1].categoryCode), null, "clearing falls back to the automatic category");

      await modal.locator("[data-previous-purchase]").click();
      await page.locator("[data-purchase-modal][data-purchase-id='invoice:inv-1']").waitFor();
      await page.locator("[data-purchase-modal] [data-view-in-merge]").click();
      await page.locator("[data-merge-modal]").waitFor();
      assert.equal(await page.locator("[data-purchase-modal]").count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
    });

    await t.test("values hidden", async () => {
      const { page } = await openPage(browser, server, { hidden: true });
      await page.waitForTimeout(1400);
      assert.deepEqual(await visibleUnblurredAmounts(page), [], "page amounts blur");
      await page.locator("[data-open-merge]").click();
      await page.locator("[data-merge-modal] [data-pair-id='cand-1']").waitFor();
      assert.deepEqual(await visibleUnblurredAmounts(page), [], "merge modal amounts blur");
      await page.keyboard.press("Escape");
      await page.locator("[data-purchase-record]").first().click();
      await page.locator("[data-purchase-modal] [data-pending-match]").waitFor();
      assert.deepEqual(await visibleUnblurredAmounts(page), [], "purchase modal amounts blur");
      await page.close();
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
