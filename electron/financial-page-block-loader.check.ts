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

test("assets and liabilities summaries carry what a converted total and its 30-day change need", async () => {
  const page = {
    accounts: [{ id: "a" }],
    dailyHistory: [{ date: "2026-10-05" }],
    dailyHistoryByAccount: { a: [] },
    exchangeRates: [{ rateDate: "2026-10-05", currency: "USD", twdPerUnit: 31 }],
    positionsByAccount: { a: [] },
    marginAccounts: [],
  };
  const loader = createFinancialPageBlockLoader(() => page);
  for (const target of ["assets", "liabilities"] as const) {
    assert.deepEqual((await loader.load(target, "summary")).data, {
      accounts: page.accounts,
      dailyHistory: page.dailyHistory,
      dailyHistoryByAccount: page.dailyHistoryByAccount,
      exchangeRates: page.exchangeRates,
    }, `${target} summary drops list-only fields and keeps rates`);
  }
});

test("the assets list block carries covered accounts and no total carries them", async () => {
  const page = {
    accounts: [{ id: "counted" }],
    coveredAccounts: [{ id: "covered", coveredBy: { namespace: "cathay", institutionKey: "cathay", product: "deposit" } }],
    dailyHistory: [],
    dailyHistoryByAccount: {},
    exchangeRates: [],
    positionsByAccount: {},
    transactionsByAccount: {},
  };
  const loader = createFinancialPageBlockLoader(() => page);
  assert.deepEqual((await loader.load("assets", "list")).data, {
    accounts: page.accounts,
    coveredAccounts: page.coveredAccounts,
    positionsByAccount: page.positionsByAccount,
    transactionsByAccount: page.transactionsByAccount,
    dailyHistoryByAccount: page.dailyHistoryByAccount,
  });
  for (const block of ["summary", "chart"] as const) {
    assert.equal("coveredAccounts" in (await loader.load("assets", block)).data, false, `${block} block leaves covered accounts out`);
  }
});

test("automation blocks receive only sanitized credential state and never encrypted data", async () => {
  const contexts: unknown[] = [];
  const loader = createFinancialPageBlockLoader((_target, _options, context) => {
    contexts.push(context);
    return {
      automation: { credentials: {} },
      credentialGroups: [],
    };
  });
  const credentialState = {
    revision: 3,
    status: { USER: true },
    fileNames: { CERT: "client.p12" },
    invalidFileKeys: [],
    invalidFileReasons: {},
  } as const;

  await Promise.all([
    loader.load("automation", "summary", { expectedVersion: 3 }, { automationCredentialState: credentialState }),
    loader.load("automation", "list", { expectedVersion: 3 }, { automationCredentialState: credentialState }),
    loader.load(
      "automation",
      "details",
      { expectedVersion: 3 },
      { automationCredentialState: credentialState },
    ),
  ]);

  // Concurrent blocks share one generation-bound raw read, so the worker
  // context is captured once for the shared snapshot.
  assert.equal(contexts.length, 1);
  assert.deepEqual(contexts[0], { automationCredentialState: credentialState });
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
