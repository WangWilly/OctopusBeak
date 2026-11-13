import assert from "node:assert/strict";
import test from "node:test";
import type { CashFlowRow } from "./model.ts";
import { allocationDraftState, detailRefusal, editableRow, initialAllocationLines, plainAmount } from "./transaction-detail.ts";

const account = { id: "card", source: "canonical", institutionKey: null, stream: null, mask: null, name: null } as const;

function row(id: string, overrides: Partial<CashFlowRow> = {}): CashFlowRow {
  return {
    transactionId: id,
    source: "canonical",
    accountId: "card",
    direction: "outflow",
    date: "2026-09-08",
    amount: { coefficient: "125050", scale: 2, currency: "TWD" },
    kind: { code: "purchase", basis: "evidence" },
    cashFlow: { class: "outflow", categories: [{ category: "dining", group: "dining", amount: { coefficient: "125050", scale: 2 } }] },
    details: {
      description: "Costco", counterparty: null, note: null, time: null, account,
      edit: { purchaseId: `transaction:${id}`, categorizable: true, categorization: { mode: "single", origin: "derived", categoryCode: "dining" }, userNote: false, tags: [] },
    },
    transferLinkId: null,
    ...overrides,
  } as CashFlowRow;
}

test("the draft shows the exact remainder and sends only what the worker would accept", () => {
  const costco = row("a");
  const under = allocationDraftState(costco, [{ categoryCode: "food_and_groceries", amountText: "1,000" }, { categoryCode: "household_goods_and_services", amountText: "250" }]);
  assert.equal(under.balance, -1);
  assert.deepEqual(under.remainder, { coefficient: "5", scale: 1 });
  assert.equal(under.problem, "sum");
  const exact = allocationDraftState(costco, [{ categoryCode: "food_and_groceries", amountText: "1000" }, { categoryCode: "household_goods_and_services", amountText: "250.50" }]);
  assert.equal(exact.balance, 0);
  assert.equal(exact.problem, null);
  assert.deepEqual(exact.components, [
    { categoryCode: "food_and_groceries", amount: { coefficient: "1000", scale: 0, currency: "TWD" } },
    { categoryCode: "household_goods_and_services", amount: { coefficient: "2505", scale: 1, currency: "TWD" } },
  ]);
  const over = allocationDraftState(costco, [{ categoryCode: "food_and_groceries", amountText: "1000" }, { categoryCode: "travel", amountText: "300" }]);
  assert.equal(over.balance, 1);
  assert.equal(allocationDraftState(costco, [{ categoryCode: "", amountText: "1250.50" }, { categoryCode: "travel", amountText: "0" }]).problem, "category");
  assert.equal(allocationDraftState(costco, [{ categoryCode: "dining", amountText: "abc" }, { categoryCode: "travel", amountText: "1" }]).problem, "amount");
});

test("the editor starts from the row's single category taking the whole amount", () => {
  const costco = row("a");
  assert.ok(editableRow(costco));
  assert.deepEqual(initialAllocationLines(costco, plainAmount), [
    { categoryCode: "dining", amountText: "1250.50" },
    { categoryCode: "", amountText: "" },
  ]);
  assert.equal(plainAmount({ coefficient: "5", scale: 2 }), "0.05");
});

test("a failed write names its refusal from the page read again", () => {
  const manual = row("m", { source: "manual", details: { ...row("m").details, edit: null } });
  assert.equal(detailRefusal("a", [row("a")]), null, "still there: the store moved on, try again");
  assert.equal(detailRefusal("a", [row("b")]), "gone");
  assert.equal(detailRefusal("m", [manual]), "not_editable");
  assert.equal(editableRow(manual), false);
});
