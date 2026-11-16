import assert from "node:assert/strict";
import test from "node:test";
import type { CashFlowClass, CashFlowKind } from "../../ledger/canonical/cash-flow-inclusion.ts";
import { translations } from "../i18n/i18n.ts";
import type { CashFlowRow, CashFlowTransferSide } from "./model.ts";
import type { CashFlowSuspendedTransferView, CashFlowTransferCandidateView, CashFlowTransferLinkView, CashFlowTransferSummary } from "./model.ts";
import {
  linkEffect,
  pairableRows,
  revokeEffect,
  transferErrorKey,
  transferNote,
  transferReasons,
  transferRefusal,
  transferRequest,
  unpairedTransfers,
  type CashFlowTransferPageData,
} from "./transfer-panel.ts";

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
      edit: null,
    },
    transferLinkId: null,
    exchangeLabel: false,
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
    { kind: "days", days: 0, withinWindow: true, origin: "evidence" },
    { kind: "accounts" },
    { kind: "evidence", code: "transfer.internal" },
  ]);
  const weak = side(row("i", "inflow", { kind: { code: "transfer.internal", basis: "weak" } }), TRANSFER, INFLOW);
  assert.ok(!transferReasons({ outflow: out, inflow: weak, dayGap: 1 }, "evidence").some((reason) => reason.kind === "evidence"));
  assert.deepEqual(transferReasons({ outflow: out, inflow: into, dayGap: 7 }, "manual").slice(1), [
    { kind: "days", days: 7, withinWindow: false, origin: "manual" },
    { kind: "accounts" },
    { kind: "decided", origin: "manual" },
  ], "a manual pair beyond the window says so, and never claims evidence");
  assert.equal(transferReasons({ outflow: out, inflow: into, dayGap: 2 }, null).length, 3, "a candidate has no decision yet");
  // A confirmed link stays applied when a side is later revised beyond the window: suspension has no date rule.
  assert.deepEqual(transferReasons({ outflow: out, inflow: into, dayGap: 5 }, "confirmed")[1], { kind: "days", days: 5, withinWindow: false, origin: "confirmed" });
  const note = translations["zh-TW"].cashFlow.transferPanel.windowNote;
  assert.equal(note(false, true), "（手動配對不限天數）");
  assert.equal(note(false, false), "（相隔超過 3 天，你確認過）", "a confirmed link beyond the window is not called a manual pair");
  assert.equal(note(true, false), "（自動比對容許 3 天內）");
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

const link = (out: CashFlowRow, into: CashFlowRow): CashFlowTransferLinkView => ({
  linkId: `${out.transactionId}/${into.transactionId}`, origin: "confirmed",
  outflow: side(out, TRANSFER, OUTFLOW), inflow: side(into, TRANSFER, INFLOW), dayGap: 0, paired: true,
});
const candidate = (out: CashFlowRow, into: CashFlowRow): CashFlowTransferCandidateView => ({
  pairId: `${out.transactionId}/${into.transactionId}`,
  outflow: side(out, OUTFLOW, OUTFLOW), inflow: side(into, INFLOW, INFLOW), dayGap: 0,
  ifLinked: { outflow: TRANSFER, inflow: TRANSFER },
});
const pageData = (rows: readonly CashFlowRow[], panel: Partial<CashFlowTransferPageData["panel"]> = {}): CashFlowTransferPageData =>
  ({ rows, panel: { links: [], candidates: [], suspended: [], deniedPairs: [], ...panel } });
const pairOf = (out: CashFlowRow, into: CashFlowRow) => ({ outflowTransactionId: out.transactionId, inflowTransactionId: into.transactionId });

test("a manual pair is checked with the worker's rule, links and denials included", () => {
  const out = row("o", "outflow");
  const into = row("i", "inflow");
  const refusal = (inflow: CashFlowRow, panel: Partial<CashFlowTransferPageData["panel"]> = {}) =>
    transferRefusal("pair", pairOf(out, inflow), pageData([out, inflow], panel));
  assert.equal(refusal(into), null);
  assert.equal(refusal(row("i", "inflow", { amount: { coefficient: "501", scale: 0, currency: "TWD" } })), "amount");
  const usd = row("i", "inflow", { amount: { coefficient: "15", scale: 0, currency: "USD" } });
  assert.equal(refusal(usd), null, "two currencies pair by hand as an exchange");
  assert.equal(transferRefusal("confirm", pairOf(out, usd), pageData([out, usd])), "exchange_label",
    "a confirm is checked as a candidate: across currencies it needs an exchange label");
  assert.equal(transferRefusal("confirm", pairOf(out, { ...usd, exchangeLabel: true }), pageData([out, { ...usd, exchangeLabel: true }])), null);
  assert.equal(translations["zh-TW"].cashFlow.transferPanel.refusals.exchange_label, "兩筆都沒有銀行的換匯標記，不會列為換匯配對。");
  assert.equal(refusal(row("i", "inflow", { accountId: "bank-a" })), "same_account");
  assert.equal(refusal(row("i", "inflow", { date: "2026-12-31" })), null, "a manual pair has no day window");
  assert.equal(refusal(into, { deniedPairs: ["o/i"] }), "denied");
  assert.equal(refusal(into, { links: [link(out, row("x", "inflow"))] }), "linked");
  assert.deepEqual(pairableRows([out, into, row("m", "outflow", { source: "manual" })], "outflow").map((entry) => entry.transactionId), ["o"],
    "a Manual Account row is never a side");
});

test("after a failed action, the refusal is named from the page read again, not from an error message", () => {
  const out = row("o", "outflow");
  const into = row("i", "inflow");
  const later = row("l", "inflow", { date: "2026-10-09" });
  const other = row("x", "inflow");
  // The confirm failed because, by the time it ran, `out` had been paired with `other` elsewhere.
  const reread = pageData([out, into, other], { links: [link(out, other)] });
  assert.equal(transferRefusal("confirm", pairOf(out, into), reread), "linked");
  assert.equal(transferRefusal("deny", pairOf(out, into), reread), "linked", "a deny is checked as a candidate too");
  assert.equal(transferRefusal("confirm", pairOf(out, later), pageData([out, later])), "too_far", "a confirm keeps the candidate window");
  assert.equal(transferRefusal("pair", pairOf(out, later), pageData([out, later])), null, "a manual pair does not");
  // A side the page reads only through the panel, such as one dated outside the period, still counts.
  const far = row("f", "inflow", { date: "2026-09-30" });
  assert.equal(transferRefusal("confirm", pairOf(out, far), pageData([out], { candidates: [candidate(out, far)], deniedPairs: ["o/f"] })), "denied");
  assert.equal(transferRefusal("confirm", pairOf(out, into), pageData([out])), null, "a side the page no longer holds leaves only the generic failure");
  assert.equal(transferRefusal("revoke", pairOf(out, into), reread), null, "a revoke has no refusal to name");
});

const summary = (pairs: number, unpaired: number, exchanges = 0): CashFlowTransferSummary => ({
  pairs: { amount: { coefficient: "0", scale: 0 }, count: pairs, origins: { evidence: 0, confirmed: pairs, manual: 0 } },
  unpaired: { amount: { coefficient: "0", scale: 0 }, count: unpaired },
  exchanges: { amount: { coefficient: "0", scale: 0 }, count: exchanges },
});

test("the transfer note counts only its own currency, and never shows a zero to review", () => {
  const twdOut = row("o", "outflow");
  const twdIn = row("i", "inflow");
  const usdOut = row("uo", "outflow", { amount: { coefficient: "5", scale: 0, currency: "USD" } });
  const usdIn = row("ui", "inflow", { amount: { coefficient: "5", scale: 0, currency: "USD" } });
  const empty = { links: [], candidates: [], suspended: [] };
  assert.equal(transferNote("TWD", null, empty), null);
  assert.deepEqual(transferNote("TWD", summary(1, 0), { ...empty, candidates: [candidate(usdOut, usdIn)] }), { kind: "summary", pending: 0 },
    "a USD candidate is not pending under TWD");
  assert.deepEqual(transferNote("TWD", summary(0, 1), { ...empty, candidates: [candidate(twdOut, twdIn)] }), { kind: "summary", pending: 1 });
  assert.deepEqual(transferNote("TWD", summary(0, 0), { ...empty, candidates: [candidate(twdOut, twdIn)] }), { kind: "pending", pending: 1 });
  // A card bill payment link is not a pair the summary counts, so it gets its own entry, not 「0 組待確認」.
  const cardLink = link(twdOut, twdIn);
  assert.deepEqual(transferNote("TWD", summary(0, 0), { ...empty, links: [cardLink] }), { kind: "links", count: 1 });
  assert.deepEqual(transferNote("TWD", null, { ...empty, links: [cardLink], candidates: [candidate(usdOut, usdIn)] }), { kind: "links", count: 1 });
  assert.equal(transferNote("USD", null, { ...empty, links: [cardLink] }), null, "a TWD link opens nothing under USD");
  const suspended = { linkId: "o/i", origin: "confirmed", outflowTransactionId: "o", inflowTransactionId: "i", outflow: null,
    inflow: side(twdIn, INFLOW, INFLOW), suspension: { reason: "not_counted", transactionIds: ["o"] } } as const;
  assert.deepEqual(transferNote("TWD", null, { ...empty, suspended: [suspended] }), { kind: "links", count: 1 });
});

test("a decision becomes the Financial page action of its kind", () => {
  assert.deepEqual(transferRequest("pair", { outflowTransactionId: "o", inflowTransactionId: "i" }, 42), {
    action: "pair", kind: "transfer_pair", outflowTransactionId: "o", inflowTransactionId: "i", dataVersion: 42,
  });
  assert.equal(transferRequest("revoke", { outflowTransactionId: "o", inflowTransactionId: "i" }, 1).kind, "transfer_revoke");
});

test("a failed decision whose row left the reloaded page shows its message at the top of its section", () => {
  const out = row("o", "outflow");
  const into = row("i", "inflow");
  const other = row("x", "inflow");
  const panel = (entries: Partial<CashFlowTransferPageData["panel"]>) => pageData([], entries).panel;
  assert.equal(transferErrorKey("o/i", "confirm", pairOf(out, into), panel({ candidates: [candidate(out, into)] })), "o/i",
    "a candidate still listed shows the message on its own row");
  assert.equal(transferErrorKey("o/i", "confirm", pairOf(out, into), panel({ links: [link(out, other)] })), "candidates");
  assert.equal(transferErrorKey("o/i:deny", "deny", pairOf(out, into), panel({})), "candidates");
  assert.equal(transferErrorKey("o/i", "revoke", pairOf(out, into), panel({ links: [link(out, into)] })), "o/i");
  assert.equal(transferErrorKey("o/i", "revoke", pairOf(out, into), panel({})), "links");
  assert.equal(transferErrorKey("manual", "pair", pairOf(out, into), panel({})), "manual");
  const suspended: CashFlowSuspendedTransferView = {
    linkId: "o/i", origin: "confirmed", outflowTransactionId: "o", inflowTransactionId: "i", outflow: null, inflow: null,
    suspension: { reason: "not_counted", transactionIds: ["o", "i"] },
  };
  assert.equal(transferErrorKey("o/i", "revoke", pairOf(out, into), panel({ suspended: [suspended] })), "o/i",
    "a suspended link that lost its sides is still matched by its ids");
});

test("an exchange states both amounts and the rate they imply, and evidence as the labels it rests on", () => {
  const account = (institutionKey: string) => ({ id: institutionKey, source: "canonical", institutionKey, stream: null, mask: null, name: null } as const);
  const exchangeRow = (id: string, direction: "outflow" | "inflow", amount: CashFlowRow["amount"], institutionKey = "bank", exchangeLabel = true) =>
    row(id, direction, {
      amount, exchangeLabel, kind: evidence("transfer.internal"), cashFlow: TRANSFER,
      details: { description: null, counterparty: null, note: null, time: null, account: account(institutionKey), edit: null },
    });
  const twd = { coefficient: "3270360", scale: 2, currency: "TWD" };
  const usd = { coefficient: "1000", scale: 0, currency: "USD" };
  const out = side(exchangeRow("o", "outflow", twd), TRANSFER, TRANSFER);
  const into = side(exchangeRow("i", "inflow", usd), TRANSFER, TRANSFER);
  assert.deepEqual(transferReasons({ outflow: out, inflow: into, dayGap: 0 }, "evidence"), [
    { kind: "exchange", outflow: twd, inflow: usd, rate: { base: "USD", quote: "TWD", rate: "32.7036" } },
    { kind: "days", days: 0, withinWindow: true, origin: "evidence" },
    { kind: "accounts" },
    { kind: "exchange_label", both: true, sameInstitution: true },
  ], "an exchange never claims an equal amount");
  const elsewhere = side(exchangeRow("i", "inflow", usd, "other-bank", false), INFLOW, INFLOW);
  assert.deepEqual(transferReasons({ outflow: out, inflow: elsewhere, dayGap: 1 }, null).at(-1), { kind: "exchange_label", both: false, sameInstitution: false });
  const copy = translations["zh-TW"].cashFlow.transferPanel;
  assert.equal(copy.reasonExchange("TWD 32,703.60", "USD 1,000", "1 USD = 32.7036 TWD"), "TWD 32,703.60 換成 USD 1,000（1 USD = 32.7036 TWD）");
  assert.equal(copy.reasonExchangeLabel(true, true), "兩邊都是同一家銀行的換匯紀錄");
});

test("an exchange shows in the transfer note of both its currencies", () => {
  const twdOut = row("o", "outflow");
  const usdIn = row("ui", "inflow", { amount: { coefficient: "15", scale: 0, currency: "USD" }, exchangeLabel: true });
  const empty = { links: [], candidates: [], suspended: [] };
  for (const currency of ["TWD", "USD"])
    assert.deepEqual(transferNote(currency, summary(0, 0), { ...empty, candidates: [candidate(twdOut, usdIn)] }), { kind: "pending", pending: 1 }, currency);
  assert.deepEqual(transferNote("USD", summary(0, 0, 1), empty), { kind: "summary", pending: 0 }, "an exchange pair alone is a summary");
  assert.equal(transferNote("JPY", null, { ...empty, candidates: [candidate(twdOut, usdIn)] }), null);
});

test("the unpaired list keeps to the chosen currency", () => {
  const twd = row("t", "outflow", { cashFlow: TRANSFER });
  const usd = row("u", "inflow", { cashFlow: TRANSFER, amount: { coefficient: "15", scale: 0, currency: "USD" } });
  const panel = { unpaired: [{ row: twd, reason: "no_counterpart" as const }, { row: usd, reason: "exchange" as const }] };
  assert.deepEqual(unpairedTransfers(panel, "USD").map((entry) => entry.row.transactionId), ["u"]);
  assert.deepEqual(unpairedTransfers(panel, "twd").map((entry) => entry.row.transactionId), ["t"]);
});
