import assert from "node:assert/strict";
import test from "node:test";
import {
  spendingAmountText,
  spendingBasisLabel,
  spendingRecordLabel,
} from "./spending-display.ts";
import type {
  SpendingPurchaseRecordView,
  SpendingPurchaseTransactionView,
} from "./purchase-matching.ts";

const baseRecord = {
  purchaseId: "purchase-1",
  basis: "bank-transaction",
  amount: null,
  occurrence: {
    value: "2026-09-18T00:00:00.000Z",
    precision: "date",
    timeZone: "Asia/Taipei",
    basis: "purchase-date",
  },
  description: null,
  invoice: null,
  transaction: null,
  items: [],
  possibleDuplicate: false,
  candidateIds: [],
  link: null,
  difference: null,
  refund: null,
} as unknown as SpendingPurchaseRecordView;

test("spending display helper preserves amount and fallback labels by locale", () => {
  const amount = { coefficient: "1234", scale: 0, currency: "TWD" };

  assert.equal(spendingAmountText(amount, "en"), "TWD 1,234");
  assert.equal(spendingAmountText(amount, "zh-TW"), "TWD 1,234");
  assert.equal(spendingAmountText(null, "en"), "Amount unavailable");
  assert.equal(spendingAmountText(null, "zh-TW"), "金額未提供");
  assert.equal(spendingRecordLabel(baseRecord, "en"), "Merchant unavailable");
  assert.equal(spendingRecordLabel(baseRecord, "zh-TW"), "未提供商家名稱");
  assert.equal(spendingRecordLabel(baseRecord, "en", "Description unavailable"), "Description unavailable");
});

test("spending display helper keeps source-basis semantics shared", () => {
  assert.equal(spendingBasisLabel({ ...baseRecord, basis: "linked" }, "en"), "Linked purchase");
  assert.equal(spendingBasisLabel({ ...baseRecord, basis: "invoice" }, "zh-TW"), "電子發票購買");
  assert.equal(spendingBasisLabel({ ...baseRecord, basis: "refund" }, "en"), "Refund");
  assert.equal(spendingBasisLabel({ ...baseRecord, basis: "bank-transaction" }, "zh-TW"), "銀行交易");
  assert.equal(
    spendingBasisLabel({
      ...baseRecord,
      basis: "bank-transaction",
      transaction: { stream: "credit-card" } as unknown as SpendingPurchaseTransactionView,
    }, "en"),
    "Credit-card purchase",
  );
});
