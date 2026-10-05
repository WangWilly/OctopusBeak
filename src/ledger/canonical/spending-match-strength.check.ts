import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPendingCandidates,
  MERCHANT_SIMILARITY_STRONG_THRESHOLD,
  merchantSimilarity,
  type PendingCandidateFacts,
} from "./spending-match-strength.ts";

const pair = (overrides: Partial<PendingCandidateFacts> = {}): PendingCandidateFacts => ({
  invoiceId: "invoice-a",
  transactionId: "payment-a",
  dayDistance: 0,
  invoiceDateBasis: "purchase-date",
  transactionDateBasis: "purchase-date",
  sellerName: "全家便利商店",
  bankDescription: "全家便利商店 信義店",
  ...overrides,
});

const strengthOf = (pending: readonly PendingCandidateFacts[], invoiceId: string, transactionId: string) =>
  classifyPendingCandidates(pending).find((entry) => entry.invoiceId === invoiceId && entry.transactionId === transactionId)?.strength;

test("a unique same-day purchase-date pair with matching merchant text is strong", () => {
  const [classified] = classifyPendingCandidates([pair()]);
  assert.equal(classified?.strength, "strong");
  assert.deepEqual(classified?.reasons, { amountEqual: true, dayDistance: 0, merchantMatch: true });
});

test("one calendar day apart is still strong and two days is possible", () => {
  assert.equal(strengthOf([pair({ dayDistance: 1 })], "invoice-a", "payment-a"), "strong");
  const [twoDays] = classifyPendingCandidates([pair({ dayDistance: 2 })]);
  assert.equal(twoDays?.strength, "possible");
  assert.deepEqual(twoDays?.reasons, { amountEqual: true, dayDistance: 2, merchantMatch: true });
});

test("a posting-date fallback on either side is never strong", () => {
  assert.equal(strengthOf([pair({ transactionDateBasis: "posting-date-fallback" })], "invoice-a", "payment-a"), "possible");
  assert.equal(strengthOf([pair({ invoiceDateBasis: "posting-date-fallback" })], "invoice-a", "payment-a"), "possible");
});

test("a second pending pair on the invoice or on the payment demotes both pairs", () => {
  const sharedInvoice = [pair(), pair({ transactionId: "payment-b" })];
  assert.equal(strengthOf(sharedInvoice, "invoice-a", "payment-a"), "possible");
  assert.equal(strengthOf(sharedInvoice, "invoice-a", "payment-b"), "possible");
  const sharedPayment = [pair(), pair({ invoiceId: "invoice-b" })];
  assert.equal(strengthOf(sharedPayment, "invoice-a", "payment-a"), "possible");
  assert.equal(strengthOf(sharedPayment, "invoice-b", "payment-a"), "possible");
  const unrelated = [pair(), pair({ invoiceId: "invoice-b", transactionId: "payment-b" })];
  assert.equal(strengthOf(unrelated, "invoice-a", "payment-a"), "strong");
});

test("merchant text below the threshold keeps the pair possible without a merchant reason", () => {
  const [classified] = classifyPendingCandidates([pair({ sellerName: "測試商店", bankDescription: "不同商店" })]);
  assert.equal(classified?.strength, "possible");
  assert.equal(classified?.reasons.merchantMatch, false);
});

test("the threshold separates containment and shared tokens from unrelated text", () => {
  assert.equal(MERCHANT_SIMILARITY_STRONG_THRESHOLD, 0.5);
  assert.equal(merchantSimilarity("Shop", "shop"), 1);
  assert.equal(merchantSimilarity("網路家庭國際資訊", "網路家庭"), 0.75);
  assert.equal(merchantSimilarity("Uber Eats", "Uber Trip"), 0.5);
  assert.ok(merchantSimilarity("測試商店", "不同商店") < MERCHANT_SIMILARITY_STRONG_THRESHOLD);
  assert.ok(merchantSimilarity("全聯實業股份有限公司", "全聯福利中心") >= MERCHANT_SIMILARITY_STRONG_THRESHOLD, "a shared Chinese brand prefix matches across legal and store names");
  assert.ok(merchantSimilarity("統一超商股份有限公司", "統一超商 台北門市") >= MERCHANT_SIMILARITY_STRONG_THRESHOLD, "company suffixes are ignored");
  assert.ok(merchantSimilarity("樂購蝦皮股份有限公司", "蝦皮購物") >= MERCHANT_SIMILARITY_STRONG_THRESHOLD, "a shared Chinese brand bigram matches");
  assert.ok(merchantSimilarity("台灣電力股份有限公司", "中華電信") < MERCHANT_SIMILARITY_STRONG_THRESHOLD, "different companies stay below the threshold");
  assert.ok(merchantSimilarity("台北商店", "高雄商店") < MERCHANT_SIMILARITY_STRONG_THRESHOLD, "a shared generic suffix alone does not match");
  assert.equal(merchantSimilarity(null, "Shop"), 0);
});
