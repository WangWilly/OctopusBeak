import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialPageActionRequest, FinancialPageActionResult } from "../../lib/financial/page-actions.ts";
import { createFinancialPageActions } from "./financial-page-actions.ts";

/** A pairing that removed one purchase. */
const removal = (baseKnowledgeAt = 6, knowledgeAt = 7): FinancialPageActionResult => ({
  status: "committed",
  action: "confirm",
  kind: "direct",
  baseKnowledgeAt,
  knowledgeAt,
  subject: { invoiceIds: ["invoice-1"], transactionIds: ["transaction-1"] },
  summaryDelta: { before: [{ date: "2026-01-01", amount: { currency: "TWD", coefficient: "100", scale: 0 }, category: { mode: "absent" } }], after: [] },
  affectedRecords: [],
}) as FinancialPageActionResult;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const REQUEST = { action: "confirm", kind: "direct" } as unknown as FinancialPageActionRequest;

test("overlapping actions settle once, with the newest result, after the last one ends", async () => {
  const replies = [deferred<FinancialPageActionResult>(), deferred<FinancialPageActionResult>()];
  let next = 0;
  const actions = createFinancialPageActions(() => replies[next++]!.promise);
  const heard: (FinancialPageActionResult | null)[] = [];
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
  const actions = createFinancialPageActions(async () => {
    if (fail) throw new Error("stale pairing");
    return removal();
  });
  const heard: (FinancialPageActionResult | null)[] = [];
  actions.onSettled((result) => heard.push(result));
  await assert.rejects(actions.run(REQUEST), /stale pairing/u);
  fail = false;
  await actions.run(REQUEST);
  assert.deepEqual(heard.map((result) => result?.knowledgeAt ?? null), [null, 7]);
});

test("a strong batch's conflict settles with no result, so the page reads nothing new from it", async () => {
  const actions = createFinancialPageActions(async () => ({
    status: "conflict",
    action: "confirm",
    kind: "strong",
    knowledgeAt: 9,
    conflicts: [],
    strongPairs: [],
  }));
  const heard: (FinancialPageActionResult | null)[] = [];
  actions.onSettled((result) => heard.push(result));
  assert.equal((await actions.run(REQUEST)).status, "conflict", "the caller still hears the conflict");
  assert.deepEqual(heard, [null]);
});

test("a listener that throws changes neither the action's result nor the other listeners", async () => {
  const actions = createFinancialPageActions(async () => removal());
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
