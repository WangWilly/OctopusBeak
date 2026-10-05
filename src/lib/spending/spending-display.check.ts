import assert from "node:assert/strict";
import test from "node:test";
import { translations } from "../i18n/i18n.ts";
import { PERSONAL_CATEGORY_CODES } from "../../ledger/canonical/personal-category-codes.ts";
import { personalCategoryLabels } from "../../ledger/canonical/transaction-taxonomy.ts";
import {
  decidedAtText,
  mergedReasons,
  paymentMethodText,
  purchaseTimeText,
  reasonTexts,
  recordCategoryText,
  recordGroups,
  recordMerchant,
} from "./spending-display.ts";
import type { SpendingPurchaseRecordView } from "./purchase-matching.ts";

const zh = translations["zh-TW"];
const en = translations.en;
const amount = { currency: "TWD", coefficient: "1444", scale: 0 };

function record(overrides: Partial<Record<keyof SpendingPurchaseRecordView, unknown>> = {}): SpendingPurchaseRecordView {
  return {
    purchaseId: "transaction:t1",
    basis: "bank-transaction",
    amount,
    occurrence: { value: "2026-10-03", precision: "date", timeZone: "Asia/Taipei", basis: "purchase-date" },
    description: "全聯福利中心",
    invoice: null,
    transaction: { transactionId: "t1", effectiveOn: "2026-10-04", consumeDate: "2026-10-03", postingDate: "2026-10-04", description: "全聯福利中心", amount, stream: "credit-card", effectiveDateBasis: "consume-date" },
    items: [],
    possibleDuplicate: false,
    candidateIds: [],
    link: null,
    difference: null,
    refund: null,
    category: { mode: "absent" },
    itemCategorizations: [],
    paymentSource: { institution: "esun", cardMask: "****5512", billingPeriod: null },
    ...overrides,
  } as SpendingPurchaseRecordView;
}

test("the payment method names the institution, the card's last four and the merged sources", () => {
  assert.equal(paymentMethodText(zh, record()), "玉山銀行信用卡 末碼 5512");
  assert.equal(paymentMethodText(en, record()), "E.SUN Bank card ending 5512");
  const debit = record({
    transaction: { ...record().transaction!, stream: "checking" },
    paymentSource: { institution: "fubon", cardMask: null, billingPeriod: null },
  });
  assert.equal(paymentMethodText(zh, debit), "台北富邦銀行帳戶扣款");
  assert.equal(paymentMethodText(zh, { ...debit, basis: "linked" }), "電子發票＋台北富邦銀行帳戶扣款");
  assert.equal(paymentMethodText(zh, record({ basis: "linked" })), "電子發票＋玉山銀行信用卡", "a merged row never repeats the card digits");
  assert.equal(paymentMethodText(zh, record({ paymentSource: null })), "信用卡", "an unknown institution falls back to the stream");
  assert.equal(paymentMethodText(zh, record({ paymentSource: { institution: "esun", cardMask: "****12x4", billingPeriod: null } })), "玉山銀行信用卡", "only four digits count as a mask");
  assert.equal(paymentMethodText(zh, record({ basis: "invoice", transaction: null, paymentSource: null })), "電子發票");
});

test("category text rolls codes into display groups and says when a purchase is split or unclassified", () => {
  assert.equal(recordCategoryText(zh, record()), "未分類");
  const single = record({ category: { mode: "single", origin: "derived", subject: "items", categoryCode: "food_and_groceries", labels: null, taxonomyId: "t", taxonomyVersion: "v1" } });
  assert.equal(recordCategoryText(zh, single), "日常");
  const split = record({
    category: {
      mode: "split", origin: "derived", subject: "items",
      components: [
        { categoryCode: "dining", labels: null, taxonomyId: "t", taxonomyVersion: "v1", amount: { ...amount, coefficient: "100" } },
        { categoryCode: "household_goods_and_services", labels: null, taxonomyId: "t", taxonomyVersion: "v1", amount: { ...amount, coefficient: "900" } },
        { categoryCode: "information_and_communication", labels: null, taxonomyId: "t", taxonomyVersion: "v1", amount: { ...amount, coefficient: "50" } },
      ],
    },
  });
  assert.deepEqual(recordGroups(split), ["home", "dining"]);
  assert.equal(recordCategoryText(zh, split), "分拆：居家、餐飲");
});

test("reason chips read 金額相同, 同一天 or 相差 N 天, and 商家相符 only when it passed", () => {
  assert.deepEqual(reasonTexts(zh, { amountEqual: true, dayDistance: 0, merchantMatch: true }), ["金額相同", "同一天", "商家相符"]);
  assert.deepEqual(reasonTexts(zh, { amountEqual: true, dayDistance: 1, merchantMatch: false }), ["金額相同", "相差 1 天"]);
  assert.deepEqual(reasonTexts(en, { amountEqual: false, dayDistance: null, merchantMatch: false }), []);
});

test("a merged purchase shows recorded reasons, or only what both sides still prove", () => {
  const link = { invoiceId: "i", transactionId: "t1", eventId: "e", origin: "user", evidenceKnowledgeSequence: 1, decidedAt: "2026-10-05T13:04:00Z" };
  const invoice = { invoiceId: "i", revision: { invoiceNumber: "GH-20451187", seller: { name: "台灣電力" }, occurrence: { value: "2026-10-05" }, total: amount, items: [] } };
  const linked = record({ basis: "linked", invoice, difference: { invoiceAmount: amount, bankAmount: amount, sameCurrency: true, exactAmountEqual: true } });
  assert.deepEqual(
    mergedReasons({ ...linked, link: { ...link, evidence: { reasons: { amountEqual: true, dayDistance: 0, merchantMatch: true } } } }),
    { amountEqual: true, dayDistance: 0, merchantMatch: true },
  );
  assert.deepEqual(mergedReasons({ ...linked, link: { ...link, evidence: { decisionOrigin: "local-user" } } }), {
    amountEqual: true,
    dayDistance: 2,
    merchantMatch: false,
  });
  assert.equal(mergedReasons(record()), null);
});

test("purchase time shows minutes only at minute precision and decision times read in Taipei", () => {
  assert.equal(purchaseTimeText({ value: "2026-10-03T18:21:00+08:00", precision: "minute", timeZone: "Asia/Taipei", basis: "purchase-date" }), "2026/10/3 18:21");
  assert.equal(purchaseTimeText({ value: "2026-10-03T00:00:00+08:00", precision: "date", timeZone: "Asia/Taipei", basis: "purchase-date" }), "2026/10/3");
  assert.equal(decidedAtText("2026-10-05T13:04:00Z"), "10/5 21:04");
});

test("the category picker's labels are the taxonomy's own labels in both languages", () => {
  for (const code of PERSONAL_CATEGORY_CODES) {
    const labels = personalCategoryLabels(code);
    assert.ok(labels, code);
    assert.equal(en.spending.personalCategories[code], labels.en, code);
    assert.equal(zh.spending.personalCategories[code], labels.zhHant, code);
  }
});

test("purchase titles read like the design: the store for merged purchases, the short seller name for invoices", () => {
  const seller = "統一超商股份有限公司宜蘭縣第一三二分公司";
  const invoice = { revision: { seller: { name: seller, taxId: "12345678" } } };
  assert.equal(
    recordMerchant(zh, record({ basis: "linked", description: seller, invoice, transaction: { ...record().transaction, description: "統一超商－蘭雲" } })),
    "統一超商－蘭雲",
  );
  assert.equal(recordMerchant(zh, record({ basis: "invoice", description: seller, invoice, transaction: null })), "統一超商");
  assert.equal(recordMerchant(zh, record({ basis: "invoice", description: "明口小吃店", invoice: { revision: { seller: { name: "明口小吃店", taxId: "1" } } }, transaction: null })), "明口小吃店");
  assert.equal(recordMerchant(zh, record()), "全聯福利中心");
  assert.equal(recordMerchant(zh, record({ description: "全聯實業股份有限公司頭城青雲分公司" })), "全聯實業", "card descriptions drop the legal-entity tail too");
});
