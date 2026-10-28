import assert from "node:assert/strict";
import test from "node:test";
import type { TdccProductCollection } from "../../workflows/tdcc-epassbook-collection.ts";
import type { CollectionProductOutcome, ProductCollectionRunSummary } from "./product-collection.ts";
import { productRunResult } from "./workflow-run-result.ts";
import {
  aggregateTdccExclusionCounts,
  createTdccRunSummary,
  TDCC_MAX_SUMMARY_COUNT,
  TdccCollectionSummaryInvariantError,
  type RecordValidatedTdccExclusions,
  type TdccProductId,
  type TdccValidatedExclusion,
} from "./tdcc-collection-summary.ts";

const tdccResult = (summary: ProductCollectionRunSummary) => productRunResult(summary, {
  counts: aggregateTdccExclusionCounts(summary.products.flatMap((product) =>
    product.collection ? [product.collection.exclusionCounts] : [])),
});

const empty: TdccProductCollection = { items: [], sourceCaptureCount: 1, rowCount: 0 };
// The summary must treat commit items as opaque; only the product runner validates them.
const collected: TdccProductCollection = { ...empty, items: [{} as TdccProductCollection["items"][number]] };
const hidden: TdccValidatedExclusion = {
  reason: "hidden-account", bankId: "fixture-bank", currency: "TWD", accountNoSuffix: "fixture-suffix",
};
const problematic: TdccValidatedExclusion = { reason: "bank-not-updated", bankId: "fixture-bank" };

function base(products: readonly CollectionProductOutcome[]): ProductCollectionRunSummary {
  const committedCount = products.reduce((n, product) => n + product.committedCount, 0);
  return {
    products,
    sourceCaptureCount: 1,
    rowCount: 0,
    itemCount: products.reduce((n, product) => n + product.itemCount, 0),
    committedCount,
    status: products.some((product) => product.status === "failed")
      ? committedCount > 0 ? "partial" : "failed" : "completed",
  };
}

const success: CollectionProductOutcome = { typeId: "settlement", status: "success", itemCount: 1, committedCount: 1 };
const failure: CollectionProductOutcome = {
  typeId: "settlement", status: "failed", itemCount: 0, committedCount: 0, errorCode: "source-unavailable",
};

test("normal collection returns items without retaining them and produces stable private evidence", async () => {
  const run = createTdccRunSummary();
  const decision = await run.collect("settlement", async (record) => {
    record([hidden]);
    record([hidden]);
    return collected;
  });
  assert.equal(decision.kind, "items");
  assert.equal(decision.collection, collected);
  const first = run.summarize(base([success]));
  assert.deepEqual(first.products[0]?.collection, {
    status: "complete_with_exclusions", exclusionCounts: { hiddenAccountCount: 2 },
  });
  assert.deepEqual(run.summarize(base([success])), first);
  assert.equal(tdccResult(first).status, "financial-admitted");
  assert.equal(tdccResult(first).counts.hiddenAccountCount, 2);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.products)
    && Object.isFrozen(first.products[0]) && Object.isFrozen(first.products[0]?.collection?.exclusionCounts));
  assert.doesNotMatch(JSON.stringify(first), /fixture-bank|fixture-suffix|"items"/u);
});

test("zero items distinguish proven absence, intentional exclusions, and incomplete evidence", async () => {
  const scenarios = [
    { exclusions: [], collection: { ...empty, absence: "not_held" as const }, kind: "absent", status: "complete" },
    { exclusions: [], collection: empty, kind: "incomplete", status: "incomplete" },
    { exclusions: [hidden], collection: empty, kind: "complete-with-exclusions", status: "complete_with_exclusions" },
    { exclusions: [problematic], collection: { ...empty, absence: "not_held" as const }, kind: "incomplete", status: "incomplete" },
  ];
  for (const scenario of scenarios) {
    const run = createTdccRunSummary();
    const decision = await run.collect("settlement", async (record) => {
      record(scenario.exclusions);
      return scenario.collection;
    });
    assert.equal(decision.kind, scenario.kind);
    const product: CollectionProductOutcome = scenario.kind === "absent"
      ? { typeId: "settlement", status: "not_held", itemCount: 0, committedCount: 0 }
      : scenario.kind === "complete-with-exclusions"
      ? { typeId: "settlement", status: "success", itemCount: 0, committedCount: 0 }
      : failure;
    const summary = run.summarize(base([product]));
    assert.equal(summary.products[0]?.collection?.status, scenario.status);
    assert.equal(tdccResult(summary).status, scenario.kind === "absent" ? "no-data"
      : scenario.kind === "complete-with-exclusions" ? "completed" : "failed");
  }
});

test("failure and cancellation retain early observations, prior receipts, and unattempted products", async () => {
  for (const error of [new Error("provider failure"), new DOMException("cancelled", "AbortError")]) {
    const run = createTdccRunSummary();
    await run.collect("securities", async () => collected);
    await assert.rejects(run.collect("settlement", async (record) => {
      record([hidden]);
      throw error;
    }), (actual) => actual === error);
    const summary = run.summarize(base([
      { ...success, typeId: "securities" }, failure,
      { typeId: "fund", status: "skipped", skipReason: "not_attempted", itemCount: 0, committedCount: 0 },
    ]));
    assert.equal(summary.status, "partial");
    assert.equal(summary.committedCount, 1);
    assert.deepEqual(summary.products[1]?.collection, {
      status: "incomplete", exclusionCounts: { hiddenAccountCount: 1 },
    });
    assert.equal(summary.products[2]?.collection, undefined);
    assert.equal(tdccResult(summary).counts.hiddenAccountCount, 1);
  }
});

test("a failed collector with no observations still has incomplete coverage", async () => {
  const run = createTdccRunSummary();
  await assert.rejects(run.collect("settlement", async () => { throw new Error("first request failed"); }));
  const summary = run.summarize(base([failure]));
  assert.equal(summary.status, "failed");
  assert.deepEqual(summary.products[0]?.collection, { status: "incomplete", exclusionCounts: {} });
});

test("recorders expire on both return and throw, and a product cannot be collected twice", async () => {
  for (const fail of [false, true]) {
    const run = createTdccRunSummary();
    let recorder: RecordValidatedTdccExclusions | undefined;
    const work = run.collect("settlement", async (record) => {
      recorder = record;
      record([hidden]);
      if (fail) throw new Error("failed");
      return collected;
    });
    if (fail) await assert.rejects(work);
    else await work;
    const before = run.summarize(base([fail ? failure : success]));
    assert.throws(() => recorder!([problematic]), TdccCollectionSummaryInvariantError);
    await assert.rejects(run.collect("settlement", async () => collected), TdccCollectionSummaryInvariantError);
    await assert.rejects(run.collect("deposit" as TdccProductId, async () => collected), TdccCollectionSummaryInvariantError);
    assert.deepEqual(run.summarize(base([fail ? failure : success])), before);
  }
});

test("in-flight collection excludes concurrent collection and premature snapshots", async () => {
  const run = createTdccRunSummary();
  let finish!: (value: TdccProductCollection) => void;
  const pending = run.collect("settlement", () => new Promise((resolve) => { finish = resolve; }));
  try {
    assert.throws(() => run.summarize(base([])), TdccCollectionSummaryInvariantError);
    await assert.rejects(run.collect("fund", async () => empty), TdccCollectionSummaryInvariantError);
  } finally {
    finish(collected);
  }
  await pending;
  await run.collect("fund", async () => ({ ...empty, absence: "not_held" }));
});

test("run-wide overflow rejects only the new observation and preserves earlier evidence", async () => {
  const run = createTdccRunSummary();
  await run.collect("settlement", async (record) => {
    record([{ reason: "time-deposits-not-admitted", bankId: "fixture-bank", count: TDCC_MAX_SUMMARY_COUNT }]);
    return empty;
  });
  await assert.rejects(run.collect("fund", async (record) => {
    record([hidden]);
    record([{ reason: "time-deposits-not-admitted", bankId: "fixture-bank", count: 1 }]);
    return empty;
  }), TdccCollectionSummaryInvariantError);
  const summary = run.summarize(base([
    { ...success, itemCount: 0, committedCount: 0 },
    { ...failure, typeId: "fund", errorCode: "workflow-failed" },
  ]));
  assert.equal(summary.status, "failed");
  assert.equal(tdccResult(summary).counts.excludedTimeDepositCount, TDCC_MAX_SUMMARY_COUNT);
  assert.deepEqual(summary.products[1]?.collection, { status: "incomplete", exclusionCounts: { hiddenAccountCount: 1 } });
});
