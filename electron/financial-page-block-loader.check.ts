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
    release = () => resolve({
      summary: [{ label: "Net position", amounts: [], breakdown: [] }],
      dailyHistory: [{ date: "2026-09-19" }],
      accounts: [{ id: "account" }],
    });
  });
  const loader = createFinancialPageBlockLoader(async () => {
    reads += 1;
    return rawSnapshot;
  });

  const summary = loader.load("overview", "summary", { expectedVersion: 11 });
  const chart = loader.load("overview", "chart", { expectedVersion: 11 });
  assert.equal(reads, 1);
  release();
  const summaryPayload = await summary;
  const chartPayload = await chart;
  assert.equal(summaryPayload.route, "overview");
  assert.equal(summaryPayload.block, "summary");
  assert.equal(chartPayload.route, "overview");
  assert.equal(chartPayload.block, "chart");
  if (summaryPayload.block !== "summary" || chartPayload.block !== "chart") throw new Error("wrong block payload");
  assert.deepEqual(summaryPayload.data.summary, [{ label: "Net position", amounts: [], breakdown: [] }]);
  assert.deepEqual(chartPayload.data.dailyHistory, [{ date: "2026-09-19" }]);
});

test("synchronous raw reads remain shared for the current message turn", async () => {
  let reads = 0;
  const loader = createFinancialPageBlockLoader(() => {
    reads += 1;
    return { automation: { active: false } };
  });
  const summary = loader.load("automation", "summary", { expectedVersion: 12 });
  const chart = loader.load("automation", "chart", { expectedVersion: 12 });
  assert.equal(reads, 1);
  assert.deepEqual((await summary).data, { automation: { active: false } });
  assert.deepEqual((await chart).data, { automation: { active: false } });
});

test("different generations never share a raw snapshot", async () => {
  const generations: number[] = [];
  const loader = createFinancialPageBlockLoader((_, options) => {
    const version = options?.expectedVersion ?? 0;
    generations.push(version);
    return { accounts: [{ id: String(version) }] };
  });

  assert.deepEqual((await loader.load("assets", "summary", { expectedVersion: 3 })).data, {
    accounts: [{ id: "3" }],
  });
  assert.deepEqual((await loader.load("assets", "summary", { expectedVersion: 4 })).data, {
    accounts: [{ id: "4" }],
  });
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
