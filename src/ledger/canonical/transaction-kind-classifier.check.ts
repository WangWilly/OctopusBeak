import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBankTransactionKind, classifyCreditCardInflowKind } from "./transaction-kind-classifier.ts";

const fubonDeposit = { institutionKey: "fubon", stream: "domestic-deposit" } as const;

test("a Fubon currency exchange moves money between the person's own accounts", () => {
  for (const direction of ["outflow", "inflow"] as const) {
    for (const description of ["行動換匯 · 01234567890123測試分行 更多", "網路換匯 · 01234567890123測試分行", "換匯"]) {
      assert.equal(
        classifyBankTransactionKind({ ...fubonDeposit, direction, description }).value,
        "transfer.internal",
        `${direction} ${description}`,
      );
    }
  }
});

test("a Fubon description that only mentions an exchange later stays a purchase", () => {
  assert.equal(
    classifyBankTransactionKind({ ...fubonDeposit, direction: "outflow", description: "行動支付 · 換匯小舖" }).value,
    "purchase",
  );
});

test("Fubon's label rules follow the Institution, not the source that reported the row", () => {
  // A Fubon account TDCC reports carries Fubon's own labels.
  assert.equal(classifyBankTransactionKind({ ...fubonDeposit, direction: "outflow", description: "放款繳款 · 測試" }).value, "payment.loan");
  // Another bank's row with the same words keeps the shared rules.
  const other = { institutionKey: "bank-007", stream: "domestic-deposit" } as const;
  assert.equal(classifyBankTransactionKind({ ...other, direction: "outflow", description: "放款繳款 · 測試" }).value, "purchase");
});

test("a card inflow's issuer label names what it is", () => {
  for (const [description, value] of [
    ["網路繳款", "payment.credit_card"],
    ["行動銀行繳款", "payment.credit_card"],
    ["自動扣繳 謝謝", "payment.credit_card"],
    ["繳款-謝謝", "payment.credit_card"],
    ["PAYMENT - THANK YOU", "payment.credit_card"],
    ["沖正", "reversal"],
    ["現金回饋", "income.reward"],
    ["鑽金紅利回饋", "income.reward"],
  ] as const)
    assert.equal(classifyCreditCardInflowKind(description)?.value, value, description);
});

test("a merchant's credit, a refund, or a label naming nothing gets no Kind from its description", () => {
  for (const description of [
    "中華電信繳費", "台灣大哥大電信繳費", "GOOGLE PAYMENT", "AMAZON PAYMENTS", "STRIPE PAYMENT",
    "街口支付扣款", "台電電費自動扣繳", "中華電信自動扣繳", "悠遊卡自動加值扣款", "溢繳款退回", "全聯福利中心 退貨", "刷退 統一超商", "全聯福利中心", "", null,
  ])
    assert.equal(classifyCreditCardInflowKind(description), null, String(description));
});

const deposit = (direction: "inflow" | "outflow", description: string, sourcePayload: string | null = null) =>
  classifyBankTransactionKind({ institutionKey: "bank-999", stream: "foreign-currency-deposit", direction, description, sourcePayload }).value;

test("a payload's field names are not words: a feeAmount key does not make a row a fee", () => {
  const payload = JSON.stringify({ feeAmount: "0", description: "轉帳", contentHash: "sha256:fee-ach-atm-0123" });
  assert.equal(deposit("outflow", "轉帳", payload), "purchase");
  assert.equal(deposit("inflow", "轉帳", payload), "receipt");
  // The payload's own text still counts.
  assert.equal(deposit("outflow", "轉帳", JSON.stringify({ sourcePayload: { memo: "跨行手續費" } })), "transfer.external");
  assert.equal(deposit("outflow", "扣款", JSON.stringify({ sourcePayload: { memo: "手續費" } })), "fee.bank");
});

test("any bank's currency exchange label moves money between the person's own accounts", () => {
  for (const direction of ["inflow", "outflow"] as const)
    for (const description of ["手機換匯", "行動換匯 · 0123", "網路換匯", "換匯"])
      assert.equal(deposit(direction, description, JSON.stringify({ feeAmount: "1" })), "transfer.internal", `${direction} ${description}`);
  assert.equal(deposit("outflow", "換匯手續費"), "fee.bank", "an exchange's own fee row stays a fee");
  assert.equal(deposit("outflow", "換匯 · 手續費"), "fee.bank", "a fee written after the exchange label stays a fee");
  assert.equal(deposit("outflow", "網購 · 換匯優惠"), "purchase", "the word elsewhere is not the label");
});

test("investment settlement, dividend and deposit interest labels name their Kind", () => {
  for (const [direction, description, value] of [
    ["outflow", "複委託 · 股票", "transfer.investment_contribution"],
    ["inflow", "複委託 · 股票", "transfer.investment_withdrawal"],
    ["outflow", "Debit 交割股款", "transfer.investment_contribution"],
    ["inflow", "Credit 交割股款", "transfer.investment_withdrawal"],
    ["inflow", "Credit ABCD 息", "income.dividend"],
    ["inflow", "基金配息", "income.dividend"],
    ["inflow", "存款息", "interest.earned"],
    ["inflow", "活存息", "interest.earned"],
  ] as const)
    assert.equal(deposit(direction, description), value, `${direction} ${description}`);
  assert.equal(deposit("outflow", "Debit ABCD 息"), "purchase", "a dividend label on an outflow is not income");
  assert.equal(deposit("outflow", "活存息"), "purchase", "an interest label on an outflow is not earned interest");
});
