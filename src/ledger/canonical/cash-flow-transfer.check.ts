import assert from "node:assert/strict";
import test from "node:test";
import type { CashFlowClass, CashFlowKind } from "./cash-flow-inclusion.ts";
import { linkedCashFlow, pairCashFlowTransfers, type CashFlowTransferPairingSide } from "./cash-flow-transfer.ts";
import {
  cashFlowTransferContext,
  cashFlowTransferRefusal,
  type CashFlowTransferPairHistory,
  type CashFlowTransferSide,
} from "./cash-flow-transfer-rules.ts";

const evidence = (code: string): CashFlowKind => ({ code, basis: "evidence" });
const fallback = (code: string): CashFlowKind => ({ code, basis: "fallback" });
const weak = (code: string): CashFlowKind => ({ code, basis: "weak" });

function side(transactionId: string, direction: "outflow" | "inflow", overrides: Partial<CashFlowTransferPairingSide> = {}): CashFlowTransferPairingSide {
  return {
    exchangeLabel: false,
    institutionKey: "bank",
    transactionId,
    source: "canonical",
    accountId: direction === "outflow" ? "bank-a" : "bank-b",
    date: "2026-09-10",
    amount: { coefficient: "5000", scale: 0, currency: "TWD" },
    direction,
    kind: direction === "outflow" ? fallback("purchase") : fallback("receipt"),
    cashFlow: direction === "outflow" ? { class: "outflow", categories: [] } : { class: "inflow", group: "other" },
    ...overrides,
  };
}

const none = cashFlowTransferContext([], new Map());

test("a loan's interest, booked in on the loan account and counted out, is neither side of a pair", () => {
  const interest = side("interest", "inflow", { kind: evidence("interest.charged"), cashFlow: { class: "outflow", categories: [] } });
  assert.equal(cashFlowTransferRefusal(side("out", "outflow"), interest, "manual", none), "direction");
  const pairing = pairCashFlowTransfers([side("out", "outflow"), interest], [], new Map());
  assert.deepEqual(pairing.candidates, [], "an equal deposit outflow is no candidate for it");
});

test("a pair needs equal amounts in one currency, opposite directions and two accounts", () => {
  const out = side("out", "outflow");
  assert.equal(cashFlowTransferRefusal(out, side("in", "inflow"), "candidate", none), null);
  assert.equal(cashFlowTransferRefusal(out, side("in", "inflow", { amount: { coefficient: "4999", scale: 0, currency: "TWD" } }), "manual", none), "amount");
  assert.equal(cashFlowTransferRefusal(out, side("in", "inflow", { amount: { coefficient: "50000", scale: 1, currency: "TWD" } }), "candidate", none), null,
    "an equal amount at another scale is still equal");
  const usd = side("in", "inflow", { amount: { coefficient: "5000", scale: 0, currency: "USD" } });
  assert.equal(cashFlowTransferRefusal(out, usd, "manual", none), null, "two currencies pair by hand as an exchange, whatever the amounts");
  assert.equal(cashFlowTransferRefusal(out, usd, "candidate", none), "exchange_label", "but are proposed only with an exchange label");
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

test("evidence never links a fallback side, a decided pair, or a card bill payment whose credit names nothing", () => {
  const out = side("out", "outflow", { kind: evidence("transfer.internal") });
  const opaque = side("in", "inflow");
  assert.deepEqual(pairCashFlowTransfers([out, opaque], [], new Map()).links, []);
  const internal = side("in", "inflow", { kind: evidence("transfer.internal") });
  assert.deepEqual(pairCashFlowTransfers([out, internal], [], new Map([["out/in", "decided" as const]])).links, [],
    "a revoked automatic link stays revoked");
  const billPayment = side("out", "outflow", { kind: evidence("payment.credit_card") });
  assert.deepEqual(pairCashFlowTransfers([billPayment, side("in", "inflow", { kind: fallback("refund") })], [], new Map()).links, []);
});

test("a card bill payment links by evidence when the card's credit names itself", () => {
  const billPayment = side("out", "outflow", { kind: evidence("payment.credit_card") });
  const paymentCredit = side("in", "inflow", { kind: evidence("payment.credit_card") });
  assert.deepEqual(pairCashFlowTransfers([billPayment, paymentCredit], [], new Map()).links.map((link) => [link.outflowTransactionId, link.inflowTransactionId, link.origin.kind]),
    [["out", "in", "evidence"]]);
  const internal = side("in", "inflow", { kind: evidence("transfer.internal") });
  assert.deepEqual(pairCashFlowTransfers([billPayment, internal], [], new Map()).links, [], "both sides must prove the same move");
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

test("a link excludes a weak or fallback side when the other side is weak, fallback or an internal transfer", () => {
  const outflow = { class: "outflow" as const, categories: [] };
  const inflow = { class: "inflow" as const, group: "transfers_in" as const };
  const internal = { class: "not_counted" as const, reason: "transfer" as const };
  const cardPayment = { class: "not_counted" as const, reason: "card_payment" as const };
  const salary = { class: "inflow" as const, group: "income.employment.salary" as const };
  const linked = (sideKind: CashFlowKind | null, sideClass: CashFlowClass, otherKind: CashFlowKind | null, otherClass: CashFlowClass) =>
    linkedCashFlow({ kind: sideKind, cashFlow: sideClass }, { kind: otherKind, cashFlow: otherClass });
  const pair = { cashFlow: internal, paired: true };
  assert.deepEqual(linked(weak("transfer.external"), outflow, weak("transfer.external"), inflow), pair);
  assert.deepEqual(linked(weak("transfer"), outflow, fallback("receipt"), inflow), pair);
  assert.deepEqual(linked(fallback("purchase"), outflow, weak("transfer.external"), inflow), pair);
  // An evidence-backed internal transfer proves the move for its counterpart too.
  assert.deepEqual(linked(weak("transfer.external"), inflow, evidence("transfer.internal"), internal), pair);
  assert.deepEqual(linked(fallback("receipt"), inflow, evidence("transfer.internal"), internal), pair);
  assert.deepEqual(linked(evidence("transfer.internal"), internal, weak("transfer.external"), inflow), pair);
  // Any other evidence-backed Kind decides its own side and keeps the other side counted: no pair.
  assert.deepEqual(linked(evidence("payment.credit_card"), cardPayment, weak("transfer.external"), inflow), { cashFlow: cardPayment, paired: false });
  assert.deepEqual(linked(weak("transfer.external"), inflow, evidence("payment.credit_card"), cardPayment), { cashFlow: inflow, paired: false });
  // Two card bill payment sides are both out already: a pair, though not a transfer one.
  assert.deepEqual(linked(evidence("payment.credit_card"), cardPayment, evidence("payment.credit_card"), cardPayment), { cashFlow: cardPayment, paired: true });
  assert.deepEqual(linked(evidence("purchase"), outflow, fallback("receipt"), inflow), { cashFlow: outflow, paired: false });
  assert.deepEqual(linked(fallback("purchase"), outflow, evidence("income.employment.salary"), salary), { cashFlow: outflow, paired: false });
  assert.deepEqual(linked(evidence("transfer.internal"), internal, evidence("income.employment.salary"), salary), { cashFlow: internal, paired: false });
  assert.deepEqual(linked(null, { class: "unresolved" }, fallback("receipt"), inflow), { cashFlow: { class: "unresolved" }, paired: false });
});

const twd = (coefficient: string) => ({ coefficient, scale: 0, currency: "TWD" });
const usdAmount = (coefficient: string, scale = 0) => ({ coefficient, scale, currency: "USD" });

/** A bank's exchange: a TWD outflow and a USD inflow at one Institution, both labelled and internal transfers by evidence. */
function exchange(overrides: Readonly<{ out?: Partial<CashFlowTransferPairingSide>; into?: Partial<CashFlowTransferPairingSide> }> = {}) {
  return [
    side("twd-out", "outflow", { amount: twd("32703"), kind: evidence("transfer.internal"), cashFlow: { class: "not_counted", reason: "transfer" }, exchangeLabel: true, ...overrides.out }),
    side("usd-in", "inflow", {
      accountId: "bank-a-usd", amount: usdAmount("100000", 2), kind: evidence("transfer.internal"), cashFlow: { class: "not_counted", reason: "transfer" }, exchangeLabel: true, ...overrides.into,
    }),
  ] as const;
}

const linksOf = (pairing: ReturnType<typeof pairCashFlowTransfers>) => pairing.links.map((link) => [link.linkId, link.origin.kind]);
const candidatesOf = (pairing: ReturnType<typeof pairCashFlowTransfers>) => pairing.candidates.map((candidate) => `${candidate.outflowTransactionId}/${candidate.inflowTransactionId}`);

test("evidence links a currency exchange at one Institution on one date, labelled on both sides", () => {
  assert.deepEqual(linksOf(pairCashFlowTransfers(exchange(), [], new Map())), [["twd-out/usd-in", "evidence"]]);
});

test("an exchange links by evidence beside an unrelated purchase, which is no longer its candidate", () => {
  const [out, into] = exchange();
  const groceries = side("groceries", "outflow", { accountId: "bank-b", amount: twd("486") });
  const pairing = pairCashFlowTransfers([out, into, groceries], [], new Map());
  assert.deepEqual(linksOf(pairing), [["twd-out/usd-in", "evidence"]]);
  assert.deepEqual(candidatesOf(pairing), []);
  const alone = pairCashFlowTransfers([into, groceries], [], new Map());
  assert.deepEqual(candidatesOf(alone), ["groceries/usd-in"], "an unpaired labelled side proposes any opposite row in another currency nearby");
});

test("an exchange across Institutions, a day apart, or ambiguous is only a candidate", () => {
  const otherBank = pairCashFlowTransfers(exchange({ into: { institutionKey: "other-bank" } }), [], new Map());
  assert.deepEqual([linksOf(otherBank), candidatesOf(otherBank)], [[], ["twd-out/usd-in"]]);
  const nextDay = pairCashFlowTransfers(exchange({ into: { date: "2026-09-11" } }), [], new Map());
  assert.deepEqual([linksOf(nextDay), candidatesOf(nextDay)], [[], ["twd-out/usd-in"]]);
  const [out, into] = exchange();
  const second = side("usd-in-2", "inflow", { ...into, transactionId: "usd-in-2", accountId: "bank-a-usd-2" });
  const ambiguous = pairCashFlowTransfers([out, into, second], [], new Map());
  assert.deepEqual([linksOf(ambiguous), candidatesOf(ambiguous).sort()], [[], ["twd-out/usd-in", "twd-out/usd-in-2"]]);
  const unlabelled = pairCashFlowTransfers(exchange({ into: { exchangeLabel: false } }), [], new Map());
  assert.deepEqual([linksOf(unlabelled), candidatesOf(unlabelled)], [[], ["twd-out/usd-in"]], "one label proposes, but evidence needs both");
  const decided = pairCashFlowTransfers(exchange(), [], new Map([["twd-out/usd-in", "decided" as const]]));
  assert.deepEqual(linksOf(decided), [], "a revoked automatic exchange stays revoked");
});

test("a pair across currencies is proposed only with an exchange label, within 3 days", () => {
  const out = side("twd-out", "outflow", { amount: twd("32703") });
  const into = side("usd-in", "inflow", { amount: usdAmount("1000") });
  assert.deepEqual(candidatesOf(pairCashFlowTransfers([out, into], [], new Map())), [], "a card purchase and an unrelated inflow are no exchange");
  const labelled = { ...into, exchangeLabel: true };
  assert.deepEqual(candidatesOf(pairCashFlowTransfers([out, labelled], [], new Map())), ["twd-out/usd-in"]);
  assert.deepEqual(candidatesOf(pairCashFlowTransfers([out, { ...labelled, date: "2026-09-14" }], [], new Map())), [], "4 days apart is too far");
  assert.equal(cashFlowTransferRefusal(out, { ...labelled, date: "2026-09-30" }, "manual", none), null, "but the person may pair it");
});

test("a same-currency evidence link survives an exchange's side nearby", () => {
  const out = side("out", "outflow", { kind: evidence("transfer.internal") });
  const into = side("in", "inflow", { kind: evidence("transfer.internal") });
  const usdIn = side("usd-in", "inflow", { accountId: "bank-d", amount: usdAmount("150"), exchangeLabel: true, kind: evidence("transfer.internal") });
  const pairing = pairCashFlowTransfers([out, into, usdIn], [], new Map());
  assert.deepEqual(linksOf(pairing), [["out/in", "evidence"]]);
  assert.deepEqual(candidatesOf(pairing), [], "a linked side is no candidate");
});

test("a manual exchange keeps ADR 0137's exclusion rules: an income side stays counted", () => {
  const out = side("twd-out", "outflow", { amount: twd("30000"), kind: evidence("transfer.internal"), cashFlow: { class: "not_counted", reason: "transfer" } });
  const salary = side("usd-in", "inflow", { amount: usdAmount("1000"), kind: evidence("income.employment.salary"), cashFlow: { class: "inflow", group: "income.employment.salary" } });
  const manual = { outflowTransactionId: "twd-out", inflowTransactionId: "usd-in", origin: { kind: "manual" as const, eventId: "event", decidedAtKnowledge: 4 } };
  assert.deepEqual(linksOf(pairCashFlowTransfers([out, salary], [manual], new Map())), [["twd-out/usd-in", "manual"]]);
  assert.deepEqual(linkedCashFlow(salary, out), { cashFlow: salary.cashFlow, paired: false });
  const receipt = side("usd-in", "inflow", { amount: usdAmount("1000") });
  assert.deepEqual(linkedCashFlow(receipt, out), { cashFlow: { class: "not_counted", reason: "transfer" }, paired: true }, "a fallback side is excluded");
});

test("a denied exchange is never proposed or linked again", () => {
  const history = new Map<string, CashFlowTransferPairHistory>([["twd-out/usd-in", "denied"]]);
  assert.deepEqual(pairCashFlowTransfers(exchange(), [], history), { links: [], suspended: [], candidates: [] });
  const [out, into] = exchange();
  assert.equal(cashFlowTransferRefusal(out, into, "manual", cashFlowTransferContext([], history)), "denied");
});
