import assert from "node:assert/strict";
import test from "node:test";
import type {
  CanonicalSpendingView,
  SpendingPageActionRequest,
  SpendingPageActionResult,
  SpendingPageDto,
  SpendingPurchaseReportSummaryDto,
} from "../../lib/spending/model.ts";
import {
  createSpendingPageActions,
  spendingPageAfterAction,
  spendingPageNeedsRecompute,
} from "./spending-page-actions.ts";

const TWD = (coefficient: string) => ({ currency: "TWD", coefficient, scale: 0 });

/** One TWD 100 purchase on 2026-01-01. */
const SUMMARY: SpendingPurchaseReportSummaryDto = {
  recordCount: 1,
  candidateCount: null,
  pendingCandidateCount: null,
  candidateState: "unloaded",
  currencies: ["TWD"],
  totalsByCurrency: [{ ...TWD("100"), count: 1 }],
  monthTotals: [{ month: "2026-01", recordCount: 1, activeDayCount: 1, pendingCandidateCount: null, totalsByCurrency: [{ ...TWD("100"), count: 1 }] }],
  dayTotals: [{ month: "2026-01", date: "2026-01-01", recordCount: 1, totalsByCurrency: [{ ...TWD("100"), count: 1 }] }],
  categoryTotalsByMonth: [{ month: "2026-01", currency: "TWD", categoryCode: null, coefficient: "100", scale: 0, count: 1 }],
};

const page = (knowledgeAt: number, summary: SpendingPurchaseReportSummaryDto | null = SUMMARY): SpendingPageDto => ({
  canonical: { availability: "available", knowledgePoint: knowledgeAt, totalStatus: "complete", totalsByCurrency: [] } as unknown as CanonicalSpendingView,
  purchaseReport: { knowledgeAt, totalsByCurrency: summary?.totalsByCurrency ?? [], summary } as unknown as SpendingPageDto["purchaseReport"],
  invoices: [],
  manual: { revision: 2, purchases: [] },
});

/** A pairing that removed the TWD 100 purchase: version 6 to 7. */
const removal = (baseKnowledgeAt = 6, knowledgeAt = 7): SpendingPageActionResult => ({
  action: "confirm",
  kind: "direct",
  baseKnowledgeAt,
  knowledgeAt,
  subject: { invoiceIds: ["invoice-1"], transactionIds: ["transaction-1"] },
  summaryDelta: { before: [{ date: "2026-01-01", amount: TWD("100"), category: { mode: "absent" } }], after: [] },
  affectedRecords: [],
}) as SpendingPageActionResult;

const at = (knowledgeAt: number, manualRevision = 2) => ({ knowledgeAt, manualRevision });

test("a page at the action's base version takes its delta and moves to the action's version", () => {
  const { page: next, published } = spendingPageAfterAction(page(6), removal());
  assert.equal(published, true);
  assert.ok(next);
  assert.equal(next.purchaseReport.knowledgeAt, 7);
  assert.equal(next.purchaseReport.summary!.recordCount, 0);
  assert.deepEqual(next.purchaseReport.totalsByCurrency, next.purchaseReport.summary!.totalsByCurrency);
  assert.equal(next.canonical.knowledgePoint, 7);
  assert.equal(next.canonical.availability, "empty", "the canonical view follows the record count");
  assert.deepEqual(next.manual, page(6).manual, "the rest of the page is kept");
  assert.equal(spendingPageNeedsRecompute(next, at(7), { result: removal(), published }), false);
});

test("a page already at the action's version publishes nothing and needs no recompute", () => {
  const { page: next, published } = spendingPageAfterAction(page(7), removal());
  assert.equal(next, null);
  assert.equal(published, true);
  assert.equal(spendingPageNeedsRecompute(page(7), at(7), { result: removal(), published }), false);
});

test("a page newer than the action keeps itself and is read again for the action", () => {
  const { page: next, published } = spendingPageAfterAction(page(8), removal());
  assert.equal(next, null, "a delayed action result never overwrites a newer page");
  assert.equal(published, false);
  assert.equal(spendingPageNeedsRecompute(page(8), at(8), { result: removal(), published }), true,
    "the page is read once more rather than assumed to contain the action");
});

test("a page at neither side of the action cannot take its delta and is read again", () => {
  const { page: next, published } = spendingPageAfterAction(page(5), removal());
  assert.equal(next, null);
  assert.equal(published, false);
  assert.equal(spendingPageNeedsRecompute(page(5), at(7), { result: removal(), published }), true);
});

test("a page without a summary counts as showing the action only at its version", () => {
  assert.deepEqual(spendingPageAfterAction(page(7, null), removal()), { page: null, published: true });
  assert.deepEqual(spendingPageAfterAction(page(6, null), removal()), { page: null, published: false });
  assert.deepEqual(spendingPageAfterAction(undefined, removal()), { page: null, published: false });
});

test("a commit or a manual write during the action is read again even after the delta is published", () => {
  const { page: next, published } = spendingPageAfterAction(page(6), removal());
  assert.equal(spendingPageNeedsRecompute(next!, at(8), { result: removal(), published }), true, "a canonical commit");
  assert.equal(spendingPageNeedsRecompute(next!, at(7, 3), { result: removal(), published }), true, "a manual write");
  assert.equal(spendingPageNeedsRecompute(page(6), at(6), null), false, "no action succeeded and nothing moved");
  assert.equal(spendingPageNeedsRecompute(page(6), at(7), null), true, "no action succeeded but the store moved");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const REQUEST = { action: "confirm", kind: "direct" } as unknown as SpendingPageActionRequest;

test("overlapping actions settle once, with the newest result, after the last one ends", async () => {
  const replies = [deferred<SpendingPageActionResult>(), deferred<SpendingPageActionResult>()];
  let next = 0;
  const actions = createSpendingPageActions(() => replies[next++]!.promise);
  const heard: (SpendingPageActionResult | null)[] = [];
  actions.onSettled((result) => heard.push(result));

  const first = actions.run(REQUEST);
  const second = actions.run(REQUEST);
  assert.equal(actions.inFlight(), true);
  replies[1]!.resolve(removal(7, 9));
  await second;
  assert.equal(heard.length, 0, "nothing settles while an action still runs");
  assert.equal(actions.inFlight(), true);
  replies[0]!.resolve(removal(6, 8));
  await first;
  assert.equal(actions.inFlight(), false);
  assert.deepEqual(heard.map((result) => result?.knowledgeAt), [9], "the newer result wins though it finished first");
});

test("a burst where every action fails settles with no result, and the next burst starts clean", async () => {
  let fail = true;
  const actions = createSpendingPageActions(async () => {
    if (fail) throw new Error("stale pairing");
    return removal();
  });
  const heard: (SpendingPageActionResult | null)[] = [];
  actions.onSettled((result) => heard.push(result));
  await assert.rejects(actions.run(REQUEST), /stale pairing/u);
  fail = false;
  await actions.run(REQUEST);
  assert.deepEqual(heard.map((result) => result?.knowledgeAt ?? null), [null, 7]);
});

test("a listener that throws changes neither the action's result nor the other listeners", async () => {
  const actions = createSpendingPageActions(async () => removal());
  const heard: number[] = [];
  actions.onSettled(() => {
    throw new Error("broken listener");
  });
  const stop = actions.onSettled((result) => heard.push(result!.knowledgeAt));
  assert.equal((await actions.run(REQUEST)).knowledgeAt, 7);
  assert.deepEqual(heard, [7]);
  stop();
  await actions.run(REQUEST);
  assert.deepEqual(heard, [7], "a stopped listener hears nothing more");
});
