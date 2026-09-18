import assert from "node:assert/strict";
import test from "node:test";
import { translations } from "../i18n/i18n.ts";
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

  assert.equal(spendingAmountText(amount, "en", translations.en.spending), "TWD 1,234");
  assert.equal(spendingAmountText(amount, "zh-TW", translations["zh-TW"].spending), "TWD 1,234");
  assert.equal(spendingAmountText(null, "en", translations.en.spending), "Amount unavailable");
  assert.equal(spendingAmountText(null, "zh-TW", translations["zh-TW"].spending), "金額未提供");
  assert.equal(spendingRecordLabel(baseRecord, translations.en.spending), "Merchant unavailable");
  assert.equal(spendingRecordLabel(baseRecord, translations["zh-TW"].spending), "未提供商家名稱");
  assert.equal(
    spendingRecordLabel(baseRecord, translations.en.spending, translations.en.spending.descriptionUnavailable),
    "Description unavailable",
  );
});

test("spending display helper keeps source-basis semantics shared", () => {
  assert.equal(spendingBasisLabel({ ...baseRecord, basis: "linked" }, translations.en.spending), "Linked purchase");
  assert.equal(spendingBasisLabel({ ...baseRecord, basis: "invoice" }, translations["zh-TW"].spending), "電子發票購買");
  assert.equal(spendingBasisLabel({ ...baseRecord, basis: "refund" }, translations.en.spending), "Refund");
  assert.equal(spendingBasisLabel({ ...baseRecord, basis: "bank-transaction" }, translations["zh-TW"].spending), "銀行交易");
  assert.equal(
    spendingBasisLabel({
      ...baseRecord,
      basis: "bank-transaction",
      transaction: { stream: "credit-card" } as unknown as SpendingPurchaseTransactionView,
    }, translations.en.spending),
    "Credit-card purchase",
  );
});
