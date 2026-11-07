import assert from "node:assert/strict";
import test from "node:test";
import {
  createSpendingReviewStore,
  type SpendingReviewSnapshot,
  type SpendingReviewTransport,
} from "./spending-review-store.ts";

const pairRef = (index: number) => ({ candidateId: `candidate-${index}`, invoiceIdentityId: `invoice-${index}`, transactionIdentityId: `payment-${index}` });

function overview(knowledgeAt: number, strong: readonly number[]) {
  return {
    schemaVersion: 1,
    knowledgeAt,
    pendingCount: strong.length + 1,
    strongCount: strong.length,
    affectedByCurrency: [{ currency: "TWD", coefficient: "4658", scale: 0, count: 3 }],
    strongPairs: strong.map(pairRef),
  } as const;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function harness(
  overrides: Partial<Record<keyof SpendingReviewTransport, (...args: any[]) => unknown>> = {},
  monthSettleMs = 0,
  /** The page's answer to the store's page actions, as `PurchaseSpendingSession.applyPageAction` gives it. */
  applyPageAction: (intent: any) => Promise<any> = async (intent) =>
    ({ status: "committed", baseKnowledgeAt: intent.shownKnowledgeAt ?? 3, knowledgeAt: (intent.shownKnowledgeAt ?? 3) + 1 }),
) {
  const calls: Record<string, any[]> = { overview: [], insight: [], candidates: [], records: [], strong: [], category: [], cancels: [] };
  let refreshes = 0;
  const transport = {
    loadPendingOverview: async (input: any) => { calls.overview!.push(input); return overview(input.knowledgeAt, [1, 2]); },
    loadMonthInsight: async (input: any) => { calls.insight!.push(input); return { schemaVersion: 1, knowledgeAt: input.knowledgeAt, month: input.month, largestByCurrency: [] }; },
    loadMerchantStats: async (input: any) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, purchaseId: input.purchaseId, month: "2026-10", merchant: null, merchantLabel: null, count: 1, totalsByCurrency: [] }),
    loadMergeLog: async (input: any) => ({ schemaVersion: 1, knowledgeAt: input.knowledgeAt, entries: [], nextCursor: null }),
    loadCandidatePage: async (input: any) => {
      calls.candidates!.push(input);
      const offset = input.offset ?? 0;
      const items = Array.from({ length: offset === 0 ? 50 : 10 }, (_, index) => ({ candidate: { candidateId: `c-${offset + index}` }, invoiceRecord: null, paymentRecord: null }));
      return { schemaVersion: 1, knowledgeAt: input.knowledgeAt, month: null, items, totalCandidateCount: 60, strongCandidateCount: 2, nextOffset: offset === 0 ? 50 : null };
    },
    cancelCandidatePage: async (requestId: string) => { calls.cancels!.push(requestId); return true; },
    loadRecordPage: async (input: any) => { calls.records!.push(input); return { schemaVersion: 1, knowledgeAt: input.knowledgeAt, month: null, day: null, categoryCodes: null, query: null, basis: "linked", records: [], nextCursor: null }; },
    ...overrides,
  } as unknown as SpendingReviewTransport;
  const store = createSpendingReviewStore({
    transport,
    refreshSummary: async () => { refreshes += 1; },
    applyPageAction: async (intent) => {
      const { kind, ...request } = intent;
      calls[kind]!.push(request);
      return applyPageAction(intent);
    },
    monthSettleMs,
  });
  let snapshot!: SpendingReviewSnapshot;
  store.state.subscribe((next) => { snapshot = next; });
  return { store, calls, current: () => snapshot, refreshes: () => refreshes };
}

test("the month overview and month insight follow the page version and month", async () => {
  const { store, calls, current } = harness();
  store.sync(1, "2026-10");
  await settle();
  assert.equal(current().overview?.pendingCount, 3);
  assert.equal(current().monthInsight?.month, "2026-10");
  store.sync(1, "2026-10");
  await settle();
  assert.equal(calls.overview!.length, 1, "an unchanged version and month do not reread");
  store.sync(1, "2026-09");
  await settle();
  assert.deepEqual(calls.overview!.map((input) => input.month), ["2026-10", "2026-09"], "the pending count follows the selected month");
  assert.deepEqual(calls.insight!.map((input) => input.month), ["2026-10", "2026-09"]);
  store.sync(2, "2026-09");
  await settle();
  assert.deepEqual(calls.overview!.map((input) => input.knowledgeAt), [1, 1, 2]);
});

test("stepping through months reads only the month that stays chosen", async () => {
  const { store, calls, current } = harness({}, 20);
  store.sync(1, "2026-10");
  await settle();
  assert.deepEqual(calls.insight!.map((input) => input.month), ["2026-10"], "a new version reads at once");
  store.sync(1, "2026-09");
  store.sync(1, "2026-08");
  store.sync(1, "2026-07");
  await new Promise((resolve) => setTimeout(resolve, 40));
  await settle();
  assert.deepEqual(calls.insight!.map((input) => input.month), ["2026-10", "2026-07"]);
  assert.deepEqual(calls.overview!.map((input) => input.month), ["2026-10", "2026-07"]);
  assert.equal(current().monthInsight?.month, "2026-07");
  store.dispose();
});

test("a reply for an older version never replaces the newer overview", async () => {
  const first = deferred<any>();
  let call = 0;
  const { store, current } = harness({
    loadPendingOverview: async (input: any) => (++call === 1 ? first.promise : overview(input.knowledgeAt, [7])),
  });
  store.sync(1, null);
  store.sync(2, null);
  await settle();
  first.resolve(overview(1, [1, 2, 3]));
  await settle();
  assert.equal(current().overview?.knowledgeAt, 2);
  assert.deepEqual(current().overview?.strongPairs.map((pair) => pair.candidateId), ["candidate-7"]);
});

test("merge lists load only while shown, page by page, and reload on a new version", async () => {
  const { store, calls, current } = harness();
  store.sync(1, "2026-10");
  await settle();
  assert.equal(calls.candidates!.length, 0);
  store.showMergeLists();
  await settle();
  assert.equal(current().pending.items.length, 50);
  assert.deepEqual(current().pending.meta, { total: 60, strong: 2 });
  assert.equal(calls.candidates![0].month, "2026-10", "the merge modal lists the selected month");
  assert.equal(calls.records![0].basis, "linked");
  assert.equal(calls.records![0].month, "2026-10", "merged purchases follow the selected month");
  await store.morePending();
  assert.equal(current().pending.items.length, 60);
  assert.equal(current().pending.hasMore, false);
  store.sync(2, "2026-10");
  await settle();
  assert.equal(current().pending.knowledgeAt, 2);
  assert.equal(current().pending.items.length, 50, "a new version restarts from the first page");
  store.hideMergeLists();
  store.sync(3, "2026-10");
  await settle();
  assert.equal(calls.candidates!.filter((input) => input.knowledgeAt === 3).length, 0);
  assert.equal(current().pending.status, "idle");
});

test("bulk merge confirms the shown strong set as a page action and re-offers the recomputed set on conflict", async () => {
  let conflict = true;
  const { store, calls, current, refreshes } = harness({}, 0, async () => {
    if (conflict) {
      conflict = false;
      return { status: "conflict", action: "confirm", kind: "strong", knowledgeAt: 5, conflicts: [pairRef(2)], strongPairs: [pairRef(1)] };
    }
    return { status: "committed", action: "confirm", kind: "strong", baseKnowledgeAt: 4, knowledgeAt: 6 };
  });
  store.sync(4, "2026-10");
  await settle();
  await store.confirmStrong();
  assert.deepEqual(calls.strong![0], { shownKnowledgeAt: 4, month: "2026-10", pairs: [pairRef(1), pairRef(2)] });
  assert.deepEqual(current().strongBatch, { kind: "conflict", offered: 1 });
  assert.equal(current().overview?.strongCount, 1);
  assert.equal(refreshes(), 0, "a rejected batch wrote nothing");
  await store.confirmStrong();
  assert.deepEqual(calls.strong![1].pairs, [pairRef(1)], "the second press confirms exactly the re-offered set");
  assert.deepEqual(current().strongBatch, { kind: "idle" });
  assert.equal(refreshes(), 0, "the committed batch publishes its own delta");
});

test("a strong batch the page refuses for now leaves the button ready", async () => {
  const { store, current } = harness({}, 0, async () => ({ status: "refused" }));
  store.sync(4, "2026-10");
  await settle();
  await store.confirmStrong();
  assert.deepEqual(current().strongBatch, { kind: "idle" });
});

test("changing a category runs its page action without reading the page again, and a failure stays visible", async () => {
  let fail = false;
  const { store, calls, current, refreshes } = harness({}, 0, async () => fail
    ? { status: "failed", message: "Synthetic category failure" }
    : { status: "committed", baseKnowledgeAt: 3, knowledgeAt: 4 });
  store.sync(3, "2026-10");
  await settle();
  assert.equal(await store.setPurchaseCategory("invoice:1", "dining"), true);
  assert.deepEqual(calls.category![0], { purchaseId: "invoice:1", categoryCode: "dining" });
  assert.equal(refreshes(), 0, "the page action publishes its own delta");
  fail = true;
  assert.equal(await store.setPurchaseCategory("invoice:1", null), false);
  assert.equal(current().categoryError, "Synthetic category failure");
  assert.equal(current().categorySaving, null);
});
