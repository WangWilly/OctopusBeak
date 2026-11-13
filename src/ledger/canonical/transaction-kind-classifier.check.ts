import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBankTransactionKind, classifyCreditCardInflowKind } from "./transaction-kind-classifier.ts";

const fubonDeposit = { integrationNamespace: "fubon", stream: "domestic-deposit" } as const;

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

test("a card inflow's own label names what it is", () => {
  for (const [description, value] of [
    ["網路繳款", "payment.credit_card"],
    ["自動扣繳 謝謝", "payment.credit_card"],
    ["PAYMENT - THANK YOU", "payment.credit_card"],
    ["全聯福利中心 退貨", "refund"],
    ["刷退 統一超商", "refund"],
    ["沖正", "reversal"],
    ["現金回饋", "income.reward"],
  ] as const)
    assert.equal(classifyCreditCardInflowKind(description)?.value, value, description);
});

test("a card inflow whose label names nothing gets no Kind from its description", () => {
  for (const description of ["全聯福利中心", "UBER *TRIP", "", null])
    assert.equal(classifyCreditCardInflowKind(description), null, String(description));
});
