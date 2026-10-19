import assert from "node:assert/strict";
import test from "node:test";
import {
  groupDigits,
  localTime,
  previewRowValue,
  purchaseState,
  statementPayment,
  timeDepositTerms,
  totalIncomplete,
} from "./preview-account.ts";
import type { AccountRowDto, PreviewAccountDto, PreviewPurchaseRowDto, PreviewStatementRowDto } from "./types.ts";

function row(group: AccountRowDto["group"], preview: Partial<PreviewAccountDto> | null, amount: number | null): AccountRowDto {
  return {
    id: "row",
    label: "row",
    institution: "bank",
    product: "Credit card",
    group,
    kind: group === "liability" ? "credit-card" : "bank",
    typeLabel: "",
    amountLines: amount === null ? [] : [{ currency: "TWD", value: amount }],
    transactionCount: 0,
    assetPositionCount: 0,
    lastUpdated: null,
    valueAvailability: amount === null ? (group === "liability" || preview?.timeDeposit ? "unavailable" : "awaiting") : "available",
    ...(preview ? {
      preview: {
        sourceId: "synthetic",
        product: group === "liability" ? "credit_card" : "deposit",
        lastCollectedAt: "2026-10-05T03:00:00.000Z",
        balanceTime: null,
        transactions: [],
        ...preview,
      },
    } : {}),
  };
}

const deposit = { principal: "100000", interestRate: "1.725", maturityDate: "2027-04-01", closedAt: null };

test("a preview credit account with no used credit makes its totals incomplete; a verified or known one does not", () => {
  const unknown = row("liability", {}, null);
  assert.deepEqual(previewRowValue(unknown), { kind: "credit-unknown" });
  assert.equal(totalIncomplete([row("liability", {}, 300), unknown]), true);
  assert.equal(totalIncomplete([row("liability", {}, 300)]), false);
  assert.equal(totalIncomplete([row("liability", null, null)]), false, "a verified unavailable row is a source gap, not an unknown preview balance");
  assert.equal(totalIncomplete([row("asset", {}, null)]), false, "an awaiting preview asset counts as nothing, not as unknown");
});

test("a closed time deposit shows as closed on its closing date, before any other state", () => {
  const closed = row("asset", { product: "time_deposit", timeDeposit: { ...deposit, closedAt: "2026-10-05T03:00:00.000Z" } }, null);
  assert.deepEqual(previewRowValue(closed), { kind: "closed", closedOn: "2026-10-05" });
  assert.equal(totalIncomplete([closed]), false);
  assert.deepEqual(previewRowValue(row("asset", {}, 1000)), { kind: "amount" });
  assert.deepEqual(previewRowValue(row("asset", {}, null)), { kind: "awaiting" });
  assert.equal(previewRowValue(row("asset", null, 1000)), null);
});

test("time-deposit terms list only what the source reported", () => {
  assert.deepEqual(timeDepositTerms(deposit), [
    { kind: "maturity", date: "2027-04-01" },
    { kind: "principal", amount: "100000" },
    { kind: "rate", percent: "1.725" },
  ]);
  assert.deepEqual(timeDepositTerms({ principal: null, interestRate: "0", maturityDate: null, closedAt: null }), [
    { kind: "rate", percent: "0" },
  ]);
});

test("purchase state follows posting and billing", () => {
  const purchase = (posting: PreviewPurchaseRowDto["posting"]): PreviewPurchaseRowDto => ({
    sourceRowKey: "p", amount: "120", currency: "TWD", direction: "outflow", posting,
    consumedAt: { precision: "minute", value: "2026-10-04T09:30" }, authorizedAt: null,
    sourceCardKey: "c1", statementKey: null, description: null,
  });
  assert.equal(purchaseState(purchase({ status: "pending" })), "pending");
  assert.equal(purchaseState(purchase({ status: "posted", billing: "unbilled", postingDate: null })), "unbilled");
  assert.equal(purchaseState(purchase({ status: "posted", billing: "billed", postingDate: "2026-10-06" })), "billed");
  assert.equal(localTime({ value: "2026-10-04T09:30" }), "2026-10-04 09:30");
  assert.equal(localTime({ value: "2026-10-04" }), "2026-10-04");
});

test("exact amounts group their digits without losing precision", () => {
  assert.equal(groupDigits("1234567.891"), "1,234,567.891");
  assert.equal(groupDigits("-49700"), "-49,700");
  assert.equal(groupDigits("+300"), "+300");
  assert.equal(groupDigits("12345678901234567890.01"), "12,345,678,901,234,567,890.01");
});

test("statement payment state is shown only when the source reported it", () => {
  const statement = (paid: boolean | null, paidAmount: string | null, noPaymentNeeded: boolean | null): PreviewStatementRowDto => ({
    statementKey: "s", billingPeriod: "2026-09", cycleStart: "2026-08-20", cycleEnd: "2026-09-19",
    closingDate: "2026-09-19", dueDate: "2026-10-04", amount: "5000", currency: "TWD", minimumPayment: "500",
    paidAmount, paid, noPaymentNeeded,
  });
  assert.equal(statementPayment(statement(true, "5000", false)), "paid");
  assert.equal(statementPayment(statement(false, "1000", false)), "partially-paid");
  assert.equal(statementPayment(statement(false, "0", null)), "unpaid");
  assert.equal(statementPayment(statement(false, null, null)), "unpaid");
  assert.equal(statementPayment(statement(null, null, true)), "no-payment-needed");
  assert.equal(statementPayment(statement(null, "5000", null)), null);
});
