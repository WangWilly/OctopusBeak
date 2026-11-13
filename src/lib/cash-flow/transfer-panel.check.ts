import assert from "node:assert/strict";
import test from "node:test";
import type { CashFlowClass, CashFlowKind } from "../../ledger/canonical/cash-flow-inclusion.ts";
import type { CashFlowRow, CashFlowTransferSide } from "./model.ts";
import { linkEffect, manualPairRefusal, pairableRows, refusalOf, revokeEffect, transferReasons, transferRequest } from "./transfer-panel.ts";

const TRANSFER: CashFlowClass = { class: "not_counted", reason: "transfer" };
const OUTFLOW: CashFlowClass = { class: "outflow", categories: [{ category: null, group: null, amount: { coefficient: "500", scale: 0 } }] };
const INFLOW: CashFlowClass = { class: "inflow", group: "transfers_in" };

function row(id: string, direction: "inflow" | "outflow", overrides: Partial<CashFlowRow> = {}): CashFlowRow {
  return {
    transactionId: id,
    source: "canonical",
    accountId: direction === "outflow" ? "bank-a" : "bank-b",
    date: "2026-10-03",
    amount: { coefficient: "500", scale: 0, currency: "TWD" },
    direction,
    kind: { code: direction === "outflow" ? "purchase" : "receipt", basis: "fallback" },
    cashFlow: direction === "outflow" ? OUTFLOW : INFLOW,
    details: {
      description: null, counterparty: null, note: null, time: null,
      account: { id: "bank-a", source: "canonical", institutionKey: null, stream: null, mask: null, name: null },
    },
    transferLinkId: null,
    ...overrides,
  };
}

function side(base: CashFlowRow, cashFlow: CashFlowClass, ownCashFlow: CashFlowClass): CashFlowTransferSide {
  return { ...base, cashFlow, ownCashFlow, inPeriod: true };
}

const evidence = (code: string): CashFlowKind => ({ code, basis: "evidence" });

test("the reasons name only what the page holds, and evidence only when both sides carry the same transfer Kind", () => {
  const out = side(row("o", "outflow", { kind: evidence("transfer.internal") }), TRANSFER, TRANSFER);
  const into = side(row("i", "inflow", { kind: evidence("transfer.internal") }), TRANSFER, TRANSFER);
  assert.deepEqual(transferReasons({ outflow: out, inflow: into, dayGap: 0 }, "evidence"), [
    { kind: "amount", amount: { coefficient: "500", scale: 0, currency: "TWD" } },
    { kind: "days", days: 0, withinWindow: true },
    { kind: "accounts" },
    { kind: "evidence", code: "transfer.internal" },
  ]);
  const weak = side(row("i", "inflow", { kind: { code: "transfer.internal", basis: "weak" } }), TRANSFER, INFLOW);
  assert.ok(!transferReasons({ outflow: out, inflow: weak, dayGap: 1 }, "evidence").some((reason) => reason.kind === "evidence"));
  assert.deepEqual(transferReasons({ outflow: out, inflow: into, dayGap: 7 }, "manual").slice(1), [
    { kind: "days", days: 7, withinWindow: false },
    { kind: "accounts" },
    { kind: "decided", origin: "manual" },
  ], "a manual pair beyond the window says so, and never claims evidence");
  assert.equal(transferReasons({ outflow: out, inflow: into, dayGap: 2 }, null).length, 3, "a candidate has no decision yet");
});

test("revoking returns only the sides the link alone keeps out", () => {
  const fallbackOut = side(row("o", "outflow"), TRANSFER, OUTFLOW);
  const fallbackIn = side(row("i", "inflow"), TRANSFER, INFLOW);
  assert.deepEqual(revokeEffect({ outflow: fallbackOut, inflow: fallbackIn }), { outflow: true, inflow: true });
  const internalOut = side(row("o", "outflow", { kind: evidence("transfer.internal") }), TRANSFER, TRANSFER);
  assert.deepEqual(revokeEffect({ outflow: internalOut, inflow: fallbackIn }), { outflow: false, inflow: true },
    "an internal transfer stays out without its link");
  const internalIn = side(row("i", "inflow", { kind: evidence("transfer.internal") }), TRANSFER, TRANSFER);
  assert.deepEqual(revokeEffect({ outflow: internalOut, inflow: internalIn }), { outflow: false, inflow: false });
});

test("confirming takes a side out only where the link rule would", () => {
  const fallbackOut = side(row("o", "outflow"), OUTFLOW, OUTFLOW);
  const fallbackIn = side(row("i", "inflow"), INFLOW, INFLOW);
  assert.deepEqual(linkEffect({ outflow: fallbackOut, inflow: fallbackIn, ifLinked: { outflow: TRANSFER, inflow: TRANSFER } }), { outflow: true, inflow: true });
  assert.deepEqual(linkEffect({ outflow: fallbackOut, inflow: fallbackIn, ifLinked: { outflow: OUTFLOW, inflow: INFLOW } }), { outflow: false, inflow: false },
    "a link that leaves both classes alone changes no total");
  const internalOut = side(row("o", "outflow", { kind: evidence("transfer.internal") }), TRANSFER, TRANSFER);
  assert.deepEqual(linkEffect({ outflow: internalOut, inflow: fallbackIn, ifLinked: { outflow: TRANSFER, inflow: TRANSFER } }), { outflow: false, inflow: true },
    "a side already out is not taken out again");
});

test("a manual pair is checked with the worker's rule, links and denials included", () => {
  const out = row("o", "outflow");
  const into = row("i", "inflow");
  const panel = { links: [], deniedPairs: [] };
  assert.equal(manualPairRefusal(out, into, panel), null);
  assert.equal(manualPairRefusal(out, row("i", "inflow", { amount: { coefficient: "501", scale: 0, currency: "TWD" } }), panel), "amount");
  assert.equal(manualPairRefusal(out, row("i", "inflow", { amount: { coefficient: "500", scale: 0, currency: "USD" } }), panel), "currency");
  assert.equal(manualPairRefusal(out, row("i", "inflow", { accountId: "bank-a" }), panel), "same_account");
  assert.equal(manualPairRefusal(out, row("i", "inflow", { date: "2026-12-31" }), panel), null, "a manual pair has no day window");
  assert.equal(manualPairRefusal(out, into, { links: [], deniedPairs: ["o/i"] }), "denied");
  const other = side(row("x", "inflow"), TRANSFER, INFLOW);
  const elsewhere = { linkId: "o/x", origin: "confirmed", outflow: side(out, TRANSFER, OUTFLOW), inflow: other, dayGap: 0, paired: true } as const;
  assert.equal(manualPairRefusal(out, into, { links: [elsewhere], deniedPairs: [] }), "linked");
  assert.deepEqual(pairableRows([out, into, row("m", "outflow", { source: "manual" })], "outflow").map((entry) => entry.transactionId), ["o"],
    "a Manual Account row is never a side");
});

test("a refusal reads from the worker's error, and anything else is not one", () => {
  assert.equal(refusalOf(new Error("Cash-flow transfer pair refused: linked.")), "linked");
  assert.equal(refusalOf(new Error("Error invoking remote method: Error: Cash-flow transfer confirm refused: too_far.")), "too_far");
  assert.equal(refusalOf(new Error("Cash-flow transfer pair refused: nonsense.")), null);
  assert.equal(refusalOf(new Error("Spending action data version is stale; reload Spending.")), null);
});

test("a decision becomes the Financial page action of its kind", () => {
  assert.deepEqual(transferRequest("pair", { outflowTransactionId: "o", inflowTransactionId: "i" }, 42), {
    action: "pair", kind: "transfer_pair", outflowTransactionId: "o", inflowTransactionId: "i", dataVersion: 42,
  });
  assert.equal(transferRequest("revoke", { outflowTransactionId: "o", inflowTransactionId: "i" }, 1).kind, "transfer_revoke");
});
