import assert from "node:assert/strict";
import test from "node:test";
import { createTestPGlite } from "./baseline-test-template.ts";
import { readPGliteCashFlow, type CashFlowReport } from "./cash-flow.ts";
import { applyPgliteCashFlowTransferSchema } from "./cash-flow-transfer.ts";
import { commitCathay, commitTdccSettlement } from "./direct-source-precedence-fixture.ts";
import { readKnowledgePoint } from "./knowledge-point.ts";
import { applyPgliteManualAssetsSchema } from "./manual-assets.ts";
import { applyPGliteFinancialPageAction } from "./spending-command.ts";
import { createSpendingCategoryFixture, setKind, type FixtureTransactionInput, type SpendingCategoryFixture } from "./spending-test-fixture.ts";
import { PGliteStore } from "./transaction.ts";
import type { FinancialPageActionRequest } from "../../lib/financial/page-actions.ts";

const SEPTEMBER = { startDate: "2026-09-01", endDate: "2026-09-30" } as const;
const amount = (coefficient: string) => ({ coefficient, scale: 0 });

async function withFixture(run: (fixture: SpendingCategoryFixture) => Promise<void>) {
  const fixture = await createSpendingCategoryFixture();
  try {
    await applyPgliteManualAssetsSchema(fixture.store);
    await applyPgliteCashFlowTransferSchema(fixture.store);
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

/** Add every transaction, then set Kinds: each addition re-projects them all. */
async function addSides(
  fixture: SpendingCategoryFixture,
  entries: readonly (readonly [code: string, evidenceKind: string, input: FixtureTransactionInput])[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const [, , input] of entries) ids.push(await fixture.addTransaction(input));
  for (const [index, [code, evidenceKind]] of entries.entries()) await setKind(fixture.store, ids[index]!, code, evidenceKind);
  return ids;
}

const opaqueOut = (date = "2026-09-10", value = "5000") => ["purchase", "bank-rule", { amount: value, date, account: "bank-a" }] as const;
const opaqueIn = (date = "2026-09-11", value = "5000", account = "bank-b") => ["receipt", "bank-rule", { amount: value, date, direction: "inflow", account }] as const;

type TransferKind = "transfer_confirm" | "transfer_deny" | "transfer_revoke" | "transfer_pair";
const ACTION = { transfer_confirm: "confirm", transfer_deny: "deny", transfer_revoke: "revoke", transfer_pair: "pair" } as const;

async function act(store: PGliteStore, kind: TransferKind, outflowTransactionId: string, inflowTransactionId: string) {
  const request = {
    action: ACTION[kind], kind, outflowTransactionId, inflowTransactionId, dataVersion: await readKnowledgePoint(store),
  } as FinancialPageActionRequest;
  return applyPGliteFinancialPageAction(store, request as Exclude<FinancialPageActionRequest, Readonly<{ kind: "strong" }>>);
}

const classOf = (report: CashFlowReport, id: string) => report.transactions.find((row) => row.transactionId === id)?.cashFlow.class;
const pairsOf = (entries: CashFlowReport["transfers"]["candidates" | "links"]) =>
  entries.map((entry) => [entry.outflowTransactionId, entry.inflowTransactionId]);

test("an opaque transfer counts on both sides until confirmed, and revoking restores both", async () => {
  await withFixture(async (fixture) => {
    const [out, into] = await addSides(fixture, [opaqueOut(), opaqueIn()]);
    const before = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual([classOf(before, out!), classOf(before, into!)], ["outflow", "inflow"]);
    assert.deepEqual(pairsOf(before.transfers.candidates), [[out, into]]);
    assert.deepEqual(before.totals[0]?.outflow.amount, amount("5000"));

    const result = await act(fixture.store, "transfer_confirm", out!, into!);
    assert.equal(result.status, "committed");
    assert.deepEqual(result.status === "committed" && result.summaryDelta, { before: [], after: [] }, "Spending gets an empty delta");
    const confirmed = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual([classOf(confirmed, out!), classOf(confirmed, into!)], ["not_counted", "not_counted"]);
    assert.deepEqual(confirmed.transfers.candidates, []);
    assert.equal(confirmed.transfers.links[0]?.origin.kind, "confirmed");
    assert.ok(confirmed.transactions.every((row) => row.transferLinkId === `${out}/${into}`));
    assert.deepEqual(confirmed.totals[0]?.outflow.amount, amount("0"));
    assert.deepEqual(confirmed.totals[0]?.notCounted, [{ reason: "transfer", amount: amount("10000"), count: 2 }]);

    await act(fixture.store, "transfer_revoke", out!, into!);
    const revoked = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual([classOf(revoked, out!), classOf(revoked, into!)], ["outflow", "inflow"]);
    assert.deepEqual(revoked.transfers.links, []);
    assert.deepEqual(pairsOf(revoked.transfers.candidates), [[out, into]], "a revoked pair may be proposed again");
    const events = await fixture.store.query<{ event_kind: string }>("SELECT event_kind FROM cash_flow_transfer_decision_events ORDER BY evidence_knowledge_sequence");
    assert.deepEqual(events.rows.map((row) => row.event_kind), ["confirmed", "revoked"], "the history keeps both decisions");
  });
});

test("a link never excludes an evidence-backed purchase", async () => {
  await withFixture(async (fixture) => {
    const [out, into] = await addSides(fixture, [["purchase", "merchant-category", { amount: "5000", date: "2026-09-10", account: "bank-a" }], opaqueIn()]);
    await act(fixture.store, "transfer_confirm", out!, into!);
    const report = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual(pairsOf(report.transfers.links), [[out, into]]);
    assert.deepEqual([classOf(report, out!), classOf(report, into!)], ["outflow", "inflow"]);
  });
});

test("a denied pair is not proposed again and cannot be paired", async () => {
  await withFixture(async (fixture) => {
    const [out, into] = await addSides(fixture, [opaqueOut(), opaqueIn()]);
    await act(fixture.store, "transfer_deny", out!, into!);
    const report = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual(report.transfers, { links: [], suspended: [], candidates: [] });
    assert.deepEqual([classOf(report, out!), classOf(report, into!)], ["outflow", "inflow"]);
    await assert.rejects(act(fixture.store, "transfer_confirm", out!, into!), /denied/u);
    await assert.rejects(act(fixture.store, "transfer_pair", out!, into!), /denied/u);
  });
});

test("sides 4 days apart are no candidate but can be paired manually, and unequal amounts are refused", async () => {
  await withFixture(async (fixture) => {
    const [out, far, other] = await addSides(fixture, [opaqueOut("2026-09-10"), opaqueIn("2026-09-14"), opaqueIn("2026-09-10", "4999", "bank-c")]);
    assert.deepEqual((await readPGliteCashFlow(fixture.store, SEPTEMBER)).transfers.candidates, []);
    await assert.rejects(act(fixture.store, "transfer_confirm", out!, far!), /too_far/u);
    await assert.rejects(act(fixture.store, "transfer_pair", out!, other!), /amount/u);
    await act(fixture.store, "transfer_pair", out!, far!);
    const report = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual(report.transfers.links.map((link) => [link.linkId, link.origin.kind]), [[`${out}/${far}`, "manual"]]);
    assert.deepEqual([classOf(report, out!), classOf(report, far!)], ["not_counted", "not_counted"]);
  });
});

test("evidence links a unique internal transfer, and a one-to-many match links nothing", async () => {
  await withFixture(async (fixture) => {
    const internal = (direction: "outflow" | "inflow", date: string, account: string) =>
      ["transfer.internal", "bank-rule", { amount: "5000", date, direction, account }] as const;
    const [out, into] = await addSides(fixture, [internal("outflow", "2026-09-10", "bank-a"), internal("inflow", "2026-09-11", "bank-b")]);
    const unique = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual(unique.transfers.links.map((link) => [link.linkId, link.origin.kind]), [[`${out}/${into}`, "evidence"]]);

    const second = await fixture.addTransaction(internal("inflow", "2026-09-12", "bank-c")[2]);
    for (const id of [out!, into!, second]) await setKind(fixture.store, id, "transfer.internal");
    const ambiguous = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual(ambiguous.transfers.links, []);
    assert.deepEqual(pairsOf(ambiguous.transfers.candidates), [[out, into], [out, second]]);
  });
});

test("an automatic link can be revoked and does not come back", async () => {
  await withFixture(async (fixture) => {
    const [out, into] = await addSides(fixture, [
      ["transfer.internal", "bank-rule", { amount: "5000", date: "2026-09-10", account: "bank-a" }],
      ["transfer.internal", "bank-rule", { amount: "5000", date: "2026-09-10", direction: "inflow", account: "bank-b" }],
    ]);
    await act(fixture.store, "transfer_revoke", out!, into!);
    const report = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual(report.transfers.links, []);
    assert.deepEqual(pairsOf(report.transfers.candidates), [[out, into]]);
  });
});

test("a covered account is never a candidate and cannot be paired", async () => {
  const store = new PGliteStore(await createTestPGlite("full"));
  try {
    const august = { startDate: "2026-08-01", endDate: "2026-08-31" };
    await commitTdccSettlement(store, "013", { rows: [["20260803090000", "0.0", "5000.0", "10000.0", "轉出"]] });
    await commitTdccSettlement(store, "822", { rows: [["20260804090000", "5000.0", "0.0", "15000.0", "轉入"]] });
    const uncovered = await readPGliteCashFlow(store, august);
    assert.equal(uncovered.transfers.candidates.length, 1);
    const [candidate] = uncovered.transfers.candidates;

    await commitCathay(store);
    const covered = await readPGliteCashFlow(store, august);
    assert.deepEqual(covered.transfers.candidates, []);
    await assert.rejects(act(store, "transfer_pair", candidate!.outflowTransactionId, candidate!.inflowTransactionId), /Cash flow counts/u);
  } finally {
    await store.close();
  }
});

test("a covered side suspends its link, and the other side is free again and the link revocable", async () => {
  const store = new PGliteStore(await createTestPGlite("full"));
  try {
    const august = { startDate: "2026-08-01", endDate: "2026-08-31" };
    await commitTdccSettlement(store, "013", { rows: [["20260803090000", "0.0", "5000.0", "10000.0", "轉出"]] });
    await commitTdccSettlement(store, "822", { rows: [["20260804090000", "5000.0", "0.0", "15000.0", "轉入"]] });
    await commitTdccSettlement(store, "012", { rows: [["20260805090000", "0.0", "5000.0", "10000.0", "轉出"]] });
    const unlinked = await readPGliteCashFlow(store, august);
    const into = unlinked.transactions.find((row) => row.direction === "inflow")!;
    const [covered, other] = unlinked.transfers.candidates.map((candidate) => candidate.outflowTransactionId);
    assert.equal(unlinked.transfers.candidates.length, 2);
    await act(store, "transfer_confirm", covered!, into.transactionId);
    assert.deepEqual(pairsOf((await readPGliteCashFlow(store, august)).transfers.candidates), [], "a linked inflow is no candidate");

    await commitCathay(store);
    const report = await readPGliteCashFlow(store, august);
    assert.ok(!report.transactions.some((row) => row.transactionId === covered), "Direct source precedence covers the 013 account");
    assert.deepEqual(report.transfers.links, []);
    assert.deepEqual(report.transfers.suspended.map((link) => [link.linkId, link.suspension]),
      [[`${covered}/${into.transactionId}`, { reason: "not_counted", transactionIds: [covered] }]]);
    assert.deepEqual(pairsOf(report.transfers.candidates), [[other, into.transactionId]], "the counted side is a candidate again");
    const row = report.transactions.find((entry) => entry.transactionId === into.transactionId)!;
    assert.deepEqual([row.cashFlow, row.transferLinkId], [into.cashFlow, null]);

    await act(store, "transfer_revoke", covered!, into.transactionId);
    assert.deepEqual((await readPGliteCashFlow(store, august)).transfers.suspended, []);
    assert.equal((await store.query("SELECT 1 FROM current_cash_flow_transfer_links")).rows.length, 0);
  } finally {
    await store.close();
  }
});

test("a revised amount suspends a link and counts both sides, and the link applies again once the amounts match", async () => {
  await withFixture(async (fixture) => {
    const [out, into] = await addSides(fixture, [opaqueOut(), opaqueIn()]);
    await act(fixture.store, "transfer_confirm", out!, into!);
    const revise = async (value: string) => {
      await fixture.reviseTransaction(into!, { amount: value, date: "2026-09-11", direction: "inflow" });
      for (const id of [out!, into!]) await setKind(fixture.store, id, id === out ? "purchase" : "receipt");
      return readPGliteCashFlow(fixture.store, SEPTEMBER);
    };

    const suspended = await revise("4000");
    assert.deepEqual(suspended.transfers.links, []);
    assert.deepEqual(suspended.transfers.suspended.map((link) => [link.linkId, link.suspension]), [[`${out}/${into}`, { reason: "amount" }]]);
    assert.deepEqual([classOf(suspended, out!), classOf(suspended, into!)], ["outflow", "inflow"]);
    assert.ok(suspended.transactions.every((row) => row.transferLinkId === null));

    const restored = await revise("5000");
    assert.deepEqual(restored.transfers.links.map((link) => [link.linkId, link.origin.kind]), [[`${out}/${into}`, "confirmed"]]);
    assert.deepEqual(restored.transfers.suspended, []);
    assert.deepEqual([classOf(restored, out!), classOf(restored, into!)], ["not_counted", "not_counted"]);
  });
});

test("a suspended link can be revoked, and a new link on one of its sides replaces it", async () => {
  await withFixture(async (fixture) => {
    const [out, into, other] = await addSides(fixture, [opaqueOut(), opaqueIn(), opaqueIn("2026-09-12", "5000", "bank-c")]);
    const setKinds = async () => {
      for (const [id, code] of [[out!, "purchase"], [into!, "receipt"], [other!, "receipt"]] as const) await setKind(fixture.store, id, code);
    };
    await act(fixture.store, "transfer_confirm", out!, into!);
    await fixture.reviseTransaction(into!, { amount: "4000", date: "2026-09-11", direction: "inflow" });
    await setKinds();
    await act(fixture.store, "transfer_revoke", out!, into!);
    const revoked = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual([revoked.transfers.links, revoked.transfers.suspended], [[], []]);

    await fixture.reviseTransaction(into!, { amount: "5000", date: "2026-09-11", direction: "inflow" });
    await setKinds();
    await act(fixture.store, "transfer_confirm", out!, into!);
    await fixture.reviseTransaction(into!, { amount: "4000", date: "2026-09-11", direction: "inflow" });
    await setKinds();
    assert.deepEqual(pairsOf((await readPGliteCashFlow(fixture.store, SEPTEMBER)).transfers.candidates), [[out, other]]);
    await act(fixture.store, "transfer_confirm", out!, other!);
    const replaced = await readPGliteCashFlow(fixture.store, SEPTEMBER);
    assert.deepEqual(pairsOf(replaced.transfers.links), [[out, other]]);
    assert.deepEqual(replaced.transfers.suspended, []);
    const hex = (id: string) => id.replaceAll("-", "");
    const history = await fixture.store.query<{ event_kind: string; link_origin: string | null; inflow: string }>(
      `SELECT event_kind, link_origin, encode(inflow_transaction_id, 'hex') AS inflow
         FROM cash_flow_transfer_decision_events
        ORDER BY evidence_knowledge_sequence, event_kind DESC`);
    assert.deepEqual(history.rows.map((row) => [row.event_kind, row.link_origin, row.inflow]), [
      ["confirmed", "confirmed", hex(into!)],
      ["revoked", "confirmed", hex(into!)],
      ["confirmed", "confirmed", hex(into!)],
      ["revoked", "confirmed", hex(into!)],
      ["confirmed", "confirmed", hex(other!)],
    ], "replacing a suspended link records its revocation");
  });
});

test("a counterpart dated by its consume date, with a far effective date, is seen by the page and by every decision", async () => {
  await withFixture(async (fixture) => {
    const internal = (direction: "outflow" | "inflow", date: string, account: string, consumeDate?: string) =>
      ["transfer.internal", "bank-rule", { amount: "5000", date, direction, account, ...consumeDate ? { card: { consumeDate } } : {} }] as const;
    const [out, into, consumed] = await addSides(fixture, [
      internal("outflow", "2026-09-10", "bank-a"),
      internal("inflow", "2026-09-11", "bank-b"),
      // Effective 20 days later, beyond six days of either side's effective date.
      internal("inflow", "2026-09-30", "bank-c", "2026-09-09"),
    ]);
    const report = await readPGliteCashFlow(fixture.store, { startDate: "2026-09-01", endDate: "2026-09-12" });
    assert.deepEqual(report.transfers.links, [], "two counterparts make the evidence ambiguous");
    assert.deepEqual(pairsOf(report.transfers.candidates).sort(), [[out, consumed], [out, into]].sort());
    await act(fixture.store, "transfer_confirm", out!, into!);
    assert.deepEqual(pairsOf((await readPGliteCashFlow(fixture.store, SEPTEMBER)).transfers.links), [[out, into]]);
  });
});
