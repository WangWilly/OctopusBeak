import assert from "node:assert/strict";
import test from "node:test";
import {
  CASH_FLOW_KIND_INCLUSION,
  canonicalCashFlowKind,
  cashFlowRule,
  cashFlowTotals,
  categoryShare,
  type CashFlowTransaction,
} from "./cash-flow-inclusion.ts";
import { TRANSACTION_KINDS } from "./transaction-taxonomy.ts";

test("the inclusion table places every Kind the published registry holds, and nothing else", () => {
  assert.deepEqual(
    Object.keys(CASH_FLOW_KIND_INCLUSION).sort(),
    TRANSACTION_KINDS.map((kind) => kind.code).sort(),
  );
});

test("the PRD's counting rules hold in the table", () => {
  const rule = (code: string, direction: "inflow" | "outflow") => cashFlowRule(code, direction);
  for (const code of ["transfer.internal", "transfer.external", "payment.credit_card", "payment.loan", "loan.disbursement",
    "transfer.investment_contribution", "transfer.investment_withdrawal", "cash.withdrawal"]) {
    assert.equal(rule(code, "outflow").class, "not_counted", code);
    assert.equal(rule(code, "inflow").class, "not_counted", code);
  }
  for (const code of ["purchase", "payment.bill", "interest.charged", "fee.bank", "fee.card", "fee.loan", "fee.investment"])
    assert.deepEqual(rule(code, "outflow"), { class: "outflow" }, code);
  for (const code of ["income.employment.salary", "income.dividend", "income.investment_distribution", "interest.earned"])
    assert.deepEqual(rule(code, "inflow"), { class: "inflow", group: code }, code);
  assert.deepEqual(rule("receipt", "inflow"), { class: "inflow", group: "other" });
  assert.deepEqual(rule("refund", "inflow"), { class: "refund" });
});

test("an absent, unregistered, or direction-contradicting Kind is unresolved", () => {
  assert.deepEqual(cashFlowRule(null, "outflow"), { class: "unresolved" });
  assert.deepEqual(cashFlowRule("income.lottery", "inflow"), { class: "unresolved" });
  assert.deepEqual(cashFlowRule("income.employment.salary", "outflow"), { class: "unresolved" });
  assert.deepEqual(cashFlowRule("purchase", "inflow"), { class: "unresolved" });
});

test("a Kind read from direction, or the bank rule's purchase or receipt, is a fallback", () => {
  assert.deepEqual(canonicalCashFlowKind("purchase", "direction"), { code: "purchase", basis: "fallback" });
  assert.deepEqual(canonicalCashFlowKind("refund", "direction"), { code: "refund", basis: "fallback" });
  assert.deepEqual(canonicalCashFlowKind("purchase", "bank-rule"), { code: "purchase", basis: "fallback" });
  assert.deepEqual(canonicalCashFlowKind("receipt", "bank-rule"), { code: "receipt", basis: "fallback" });
  assert.deepEqual(canonicalCashFlowKind("refund", "bank-rule"), { code: "refund", basis: "evidence" });
  assert.deepEqual(canonicalCashFlowKind("transfer.internal", "bank-rule"), { code: "transfer.internal", basis: "evidence" });
  assert.deepEqual(canonicalCashFlowKind("payment.credit_card", "credit-card-statement-relation"), { code: "payment.credit_card", basis: "evidence" });
  assert.equal(canonicalCashFlowKind(null, null), null);
});

test("totals stay per currency, and a refund reduces its category group's outflow", () => {
  const row = (id: string, currency: string, coefficient: string, cashFlow: CashFlowTransaction["cashFlow"]): CashFlowTransaction => ({
    transactionId: id, source: "canonical", accountId: "account", date: "2026-09-01",
    amount: { coefficient, scale: 0, currency }, direction: cashFlow.class === "outflow" ? "outflow" : "inflow", kind: null, cashFlow,
  });
  const amount = (coefficient: string) => ({ coefficient, scale: 0 });
  const totals = cashFlowTotals([
    row("a", "TWD", "1000", { class: "outflow", categories: [categoryShare("dining", amount("600")), categoryShare("food_and_groceries", amount("400"))] }),
    row("b", "TWD", "100", { class: "refund", categories: [categoryShare("dining", amount("100"))], refundOf: "a" }),
    row("c", "TWD", "5000", { class: "inflow", group: "income.employment.salary" }),
    row("d", "USD", "20", { class: "outflow", categories: [categoryShare(null, amount("20"))] }),
    row("e", "TWD", "70", { class: "unresolved" }),
    row("f", "TWD", "3000", { class: "not_counted", reason: "cash_withdrawal" }),
  ]);
  assert.deepEqual(totals.map((total) => total.currency), ["TWD", "USD"]);
  const twd = totals[0]!;
  assert.deepEqual(twd.outflow.amount, amount("900"));
  assert.deepEqual(twd.outflow.groups.map(({ group, amount: value, count }) => [group, value.coefficient, count]), [
    ["daily", "400", 1],
    ["dining", "500", 2],
  ]);
  assert.deepEqual(twd.inflow.groups.map(({ group, amount: value }) => [group, value.coefficient]), [["income.employment.salary", "5000"]]);
  assert.deepEqual(twd.unresolved, { amount: amount("70"), count: 1 });
  assert.deepEqual(twd.notCounted, [{ reason: "cash_withdrawal", amount: amount("3000"), count: 1 }]);
  assert.deepEqual(totals[1]!.outflow.groups, [{ group: null, amount: amount("20"), count: 1 }]);
});
