import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBankTransactionKind } from "./transaction-kind-classifier.ts";

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
