import assert from "node:assert/strict";
import test from "node:test";
import type { CashFlowKind } from "./cash-flow-inclusion.ts";
import {
  cashFlowTransferContext,
  cashFlowTransferRefusal,
  linkedCashFlowClass,
  pairCashFlowTransfers,
  type CashFlowTransferPairHistory,
  type CashFlowTransferSide,
} from "./cash-flow-transfer.ts";

const evidence = (code: string): CashFlowKind => ({ code, basis: "evidence" });
const fallback = (code: string): CashFlowKind => ({ code, basis: "fallback" });

function side(transactionId: string, direction: "outflow" | "inflow", overrides: Partial<CashFlowTransferSide> = {}): CashFlowTransferSide {
  return {
    transactionId,
    source: "canonical",
    accountId: direction === "outflow" ? "bank-a" : "bank-b",
    date: "2026-09-10",
    amount: { coefficient: "5000", scale: 0, currency: "TWD" },
    direction,
    kind: direction === "outflow" ? fallback("purchase") : fallback("receipt"),
    ...overrides,
  };
}

const none = cashFlowTransferContext([], new Map());

test("a pair needs equal amounts in one currency, opposite directions and two accounts", () => {
  const out = side("out", "outflow");
  assert.equal(cashFlowTransferRefusal(out, side("in", "inflow"), "candidate", none), null);
  assert.equal(cashFlowTransferRefusal(out, side("in", "inflow", { amount: { coefficient: "4999", scale: 0, currency: "TWD" } }), "manual", none), "amount");
  assert.equal(cashFlowTransferRefusal(out, side("in", "inflow", { amount: { coefficient: "50000", scale: 1, currency: "TWD" } }), "candidate", none), null,
    "an equal amount at another scale is still equal");
  assert.equal(cashFlowTransferRefusal(out, side("in", "inflow", { amount: { coefficient: "5000", scale: 0, currency: "USD" } }), "manual", none), "currency");
  assert.equal(cashFlowTransferRefusal(out, side("in", "inflow", { accountId: "bank-a" }), "manual", none), "same_account");
  assert.equal(cashFlowTransferRefusal(out, side("in", "outflow"), "manual", none), "direction");
  assert.equal(cashFlowTransferRefusal(out, side("in", "inflow", { source: "manual" }), "manual", none), "manual_account");
});

test("sides 4 days apart are no candidate, but the person may pair them", () => {
  const out = side("out", "outflow", { date: "2026-09-10" });
  assert.equal(cashFlowTransferRefusal(out, side("in", "inflow", { date: "2026-09-13" }), "candidate", none), null);
  const far = side("in", "inflow", { date: "2026-09-14" });
  assert.equal(cashFlowTransferRefusal(out, far, "candidate", none), "too_far");
  assert.equal(cashFlowTransferRefusal(out, far, "manual", none), null);
  assert.deepEqual(pairCashFlowTransfers([out, far], [], new Map()), { links: [], suspended: [], candidates: [] });
});

test("a denied pair is never proposed or paired again", () => {
  const sides = [side("out", "outflow"), side("in", "inflow")];
  assert.equal(pairCashFlowTransfers(sides, [], new Map()).candidates.length, 1);
  const history = new Map<string, CashFlowTransferPairHistory>([["out/in", "denied"]]);
  assert.deepEqual(pairCashFlowTransfers(sides, [], history), { links: [], suspended: [], candidates: [] });
  assert.equal(cashFlowTransferRefusal(sides[0]!, sides[1]!, "manual", cashFlowTransferContext([], history)), "denied");
});

test("evidence links a unique pair of internal transfers, and an ambiguous match links nothing", () => {
  const out = side("out", "outflow", { kind: evidence("transfer.internal") });
  const first = side("in-1", "inflow", { kind: evidence("transfer.internal"), date: "2026-09-11" });
  const unique = pairCashFlowTransfers([out, first], [], new Map());
  assert.deepEqual(unique, {
    links: [{ linkId: "out/in-1", outflowTransactionId: "out", inflowTransactionId: "in-1", origin: { kind: "evidence" } }], suspended: [], candidates: [],
  });

  const second = side("in-2", "inflow", { kind: evidence("transfer.internal"), accountId: "bank-c", date: "2026-09-10" });
  const ambiguous = pairCashFlowTransfers([out, first, second], [], new Map());
  assert.deepEqual(ambiguous.links, []);
  assert.deepEqual(ambiguous.candidates.map((candidate) => [candidate.inflowTransactionId, candidate.dayGap]), [["in-2", 0], ["in-1", 1]],
    "every counterpart is shown, the closest first");
});

test("evidence never links a fallback side, a decided pair, or a card bill payment", () => {
  const out = side("out", "outflow", { kind: evidence("transfer.internal") });
  const opaque = side("in", "inflow");
  assert.deepEqual(pairCashFlowTransfers([out, opaque], [], new Map()).links, []);
  const internal = side("in", "inflow", { kind: evidence("transfer.internal") });
  assert.deepEqual(pairCashFlowTransfers([out, internal], [], new Map([["out/in", "decided" as const]])).links, [],
    "a revoked automatic link stays revoked");
  const billPayment = side("out", "outflow", { kind: evidence("payment.credit_card") });
  assert.deepEqual(pairCashFlowTransfers([billPayment, side("in", "inflow", { kind: fallback("refund") })], [], new Map()).links, []);
});

test("5000 and 5000.00 are one amount when pairing", () => {
  const out = side("out", "outflow");
  const into = side("in", "inflow", { amount: { coefficient: "500000", scale: 2, currency: "TWD" } });
  assert.deepEqual(pairCashFlowTransfers([out, into], [], new Map()).candidates.map((candidate) => [candidate.outflowTransactionId, candidate.inflowTransactionId]),
    [["out", "in"]]);
  const stored = { outflowTransactionId: "out", inflowTransactionId: "in", origin: { kind: "confirmed" as const, eventId: "event", decidedAtKnowledge: 4 } };
  assert.deepEqual(pairCashFlowTransfers([out, into], [stored], new Map()).suspended, [], "a stored link at another scale still applies");
});

const confirmed = (outflowTransactionId: string, inflowTransactionId: string) =>
  ({ outflowTransactionId, inflowTransactionId, origin: { kind: "confirmed" as const, eventId: "event", decidedAtKnowledge: 4 } });

test("a stored link whose side is no longer counted is suspended and blocks nothing", () => {
  const into = side("in", "inflow");
  const other = side("out-2", "outflow", { accountId: "bank-c" });
  const pairing = pairCashFlowTransfers([into, other], [confirmed("out", "in")], new Map());
  assert.deepEqual(pairing.links, []);
  assert.deepEqual(pairing.suspended.map((link) => [link.linkId, link.suspension]), [["out/in", { reason: "not_counted", transactionIds: ["out"] }]]);
  assert.deepEqual(pairing.candidates.map((candidate) => [candidate.outflowTransactionId, candidate.inflowTransactionId]), [["out-2", "in"]],
    "the counted side may pair again");
});

test("a stored link suspends while its sides break a rule, and applies again once they do not", () => {
  const out = side("out", "outflow");
  const revised = side("in", "inflow", { amount: { coefficient: "4000", scale: 0, currency: "TWD" } });
  const suspended = pairCashFlowTransfers([out, revised], [confirmed("out", "in")], new Map());
  assert.deepEqual(suspended.links, []);
  assert.deepEqual(suspended.suspended.map((link) => link.suspension), [{ reason: "amount" }]);
  for (const [overrides, reason] of [
    [{ amount: { coefficient: "5000", scale: 0, currency: "USD" } }, "currency"],
    [{ direction: "outflow" }, "direction"],
    [{ accountId: "bank-a" }, "same_account"],
  ] as const)
    assert.deepEqual(pairCashFlowTransfers([out, side("in", "inflow", overrides)], [confirmed("out", "in")], new Map()).suspended.map((link) => link.suspension),
      [{ reason }]);
  const restored = pairCashFlowTransfers([out, side("in", "inflow")], [confirmed("out", "in")], new Map());
  assert.deepEqual(restored.links.map((link) => link.linkId), ["out/in"]);
  assert.deepEqual(restored.suspended, []);
});

test("a stored link takes both sides out of every candidate", () => {
  const sides = [side("out", "outflow"), side("in", "inflow"), side("in-2", "inflow", { accountId: "bank-c" })];
  const pairing = pairCashFlowTransfers(sides, [{
    outflowTransactionId: "out", inflowTransactionId: "in", origin: { kind: "confirmed", eventId: "event", decidedAtKnowledge: 4 },
  }], new Map());
  assert.deepEqual(pairing.links.map((link) => link.linkId), ["out/in"]);
  assert.deepEqual(pairing.candidates, []);
});

test("a link excludes a side only when both sides carry nothing but fallback Kinds", () => {
  const outflow = { class: "outflow" as const, categories: [] };
  assert.deepEqual(linkedCashFlowClass({ kind: fallback("purchase"), cashFlow: outflow }, { kind: fallback("receipt") }), { class: "not_counted", reason: "transfer" });
  assert.deepEqual(linkedCashFlowClass({ kind: evidence("purchase"), cashFlow: outflow }, { kind: fallback("receipt") }), outflow);
  assert.deepEqual(linkedCashFlowClass({ kind: fallback("purchase"), cashFlow: outflow }, { kind: evidence("income.employment.salary") }), outflow);
  assert.deepEqual(linkedCashFlowClass({ kind: null, cashFlow: { class: "unresolved" } }, { kind: fallback("receipt") }), { class: "unresolved" });
});
