import assert from "node:assert/strict";
import test from "node:test";
import {
  createFinancialPageBlockLoader,
  projectFinancialBlock,
} from "./financial-page-block-loader.ts";

test("concurrent blocks share one generation-bound raw snapshot", async () => {
  let reads = 0;
  let release!: () => void;
  const rawSnapshot = new Promise((resolve) => {
    release = () => resolve({ summary: "summary", chart: "chart" });
  });
  const loader = createFinancialPageBlockLoader(async () => {
    reads += 1;
    return rawSnapshot;
  });

  const summary = loader.load("overview", "summary", { expectedVersion: 11 });
  const chart = loader.load("overview", "chart", { expectedVersion: 11 });
  assert.equal(reads, 1);
  release();
  assert.equal(await summary, "summary");
  assert.equal(await chart, "chart");
});

test("synchronous raw reads remain shared for the current message turn", async () => {
  let reads = 0;
  const loader = createFinancialPageBlockLoader(() => {
    reads += 1;
    return { summary: "summary", chart: "chart" };
  });
  const summary = loader.load("automation", "summary", { expectedVersion: 12 });
  const chart = loader.load("automation", "chart", { expectedVersion: 12 });
  assert.equal(reads, 1);
  assert.equal(await summary, "summary");
  assert.equal(await chart, "chart");
});

test("different generations never share a raw snapshot", async () => {
  const generations: number[] = [];
  const loader = createFinancialPageBlockLoader((_, options) => {
    const version = options?.expectedVersion ?? 0;
    generations.push(version);
    return { summary: version };
  });

  assert.equal(await loader.load("assets", "summary", { expectedVersion: 3 }), 3);
  assert.equal(await loader.load("assets", "summary", { expectedVersion: 4 }), 4);
  assert.deepEqual(generations, [3, 4]);
});

test("block projection selects a section without waiting on route DTO mapping", () => {
  const raw = {
    accounts: [{ id: "account" }],
    transactions: [{ id: "transaction" }],
    positionsByAccount: { account: [{ symbol: "FUND" }] },
  };
  assert.deepEqual(projectFinancialBlock(raw, "list"), raw.accounts);
  assert.deepEqual(projectFinancialBlock(raw, "chart"), raw.transactions);
  assert.deepEqual(projectFinancialBlock(raw, "details"), raw.positionsByAccount);
});
