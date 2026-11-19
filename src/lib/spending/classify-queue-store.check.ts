import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createClassifyQueueStore } from "./classify-queue-store.ts";
import type { SpendingClassifyQueueDto, SpendingClassifyQueueItem, SpendingClassifyQueueRequest, SpendingPageReadResult } from "./model.ts";

type Reply = SpendingPageReadResult<SpendingClassifyQueueDto>;

function item(purchaseId: string): SpendingClassifyQueueItem {
  return { purchaseId, basis: "bank-transaction", date: "2026-10-01", title: purchaseId, amount: null, payment: null, details: { time: null, bankDescription: null, items: [] } };
}

function queue(knowledgeAt: number, ids: readonly string[]): Reply {
  return { schemaVersion: 1, knowledgeAt, startDate: "2025-11-18", endDate: "2026-11-17", items: ids.map(item) };
}

function harness() {
  const requests: { request: SpendingClassifyQueueRequest; resolve: (reply: Reply) => void }[] = [];
  let refreshes = 0;
  const store = createClassifyQueueStore({
    load: (request) => new Promise((resolve) => requests.push({ request, resolve })),
    refreshSummary: async () => { refreshes += 1; },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { store, requests, settle, refreshes: () => refreshes, ids: () => get(store.state).items?.map((entry) => entry.purchaseId) ?? null };
}

test("reads the last twelve months at the page's version and ignores an older one", async () => {
  const { store, requests, settle, ids } = harness();
  store.sync(5, "2026-11-17");
  assert.deepEqual(requests[0]!.request, { knowledgeAt: 5, startDate: "2025-11-18", endDate: "2026-11-17" });
  store.sync(4, "2026-11-17");
  store.sync(5, "2026-11-17");
  assert.equal(requests.length, 1);
  requests[0]!.resolve(queue(5, ["a", "b"]));
  await settle();
  assert.deepEqual(ids(), ["a", "b"]);
});

test("a read overtaken by a newer version never lands", async () => {
  const { store, requests, settle, ids } = harness();
  store.sync(5, "2026-11-17");
  store.sync(6, "2026-11-17");
  requests[1]!.resolve(queue(6, ["b"]));
  await settle();
  requests[0]!.resolve(queue(5, ["a", "b"]));
  await settle();
  assert.deepEqual(ids(), ["b"]);
});

test("a stale read asks the page to catch up instead of showing anything", async () => {
  const { store, requests, settle, ids, refreshes } = harness();
  store.sync(5, "2026-11-17");
  requests[0]!.resolve({ stale: true, knowledgeAt: 7 });
  await settle();
  assert.equal(refreshes(), 1);
  assert.equal(ids(), null);
});

test("a committed apply drops its purchases at once and reads the post-commit version", async () => {
  const { store, requests, settle, ids } = harness();
  store.sync(5, "2026-11-17");
  requests[0]!.resolve(queue(5, ["a", "b", "c"]));
  await settle();
  store.committed(["a", "c"], 6);
  assert.deepEqual(ids(), ["b"]);
  assert.equal(requests[1]!.request.knowledgeAt, 6);
  requests[1]!.resolve(queue(6, ["b"]));
  await settle();
  store.committed([], 7);
  requests[2]!.resolve(queue(7, ["a", "b", "c"]));
  await settle();
  assert.deepEqual(ids(), ["a", "b", "c"], "an undo brings the purchases back with the next read");
});
