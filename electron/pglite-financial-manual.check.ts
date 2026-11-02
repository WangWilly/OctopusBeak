import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
import {
  createLocalDateClock,
  createPGliteLiveViewDependencies,
  type LocalDateClock,
} from "./pglite-financial-live-dependencies.ts";
import { createPGliteFinancialLiveViews, type PGliteFinancialLiveView } from "./pglite-financial-live-views.ts";
import { createPGliteFinancialRegistry } from "./pglite-financial-registry.ts";
import { readAssetsSummary } from "../src/lib/assets/assets-summary.ts";
import { parseManualAssetCommand } from "../src/lib/manual-assets/manual-assets.ts";
import type { OverviewPageDto } from "../src/lib/overview/types.ts";
import type { SpendingPageDto } from "../src/lib/spending/model.ts";
import { applyPgliteBaseline } from "../src/ledger/pglite/baseline.ts";
import { createTestPGlite } from "../src/ledger/pglite/baseline-test-template.ts";
import { commitCathay } from "../src/ledger/pglite/direct-source-precedence-fixture.ts";
import { applyManualAssetCommand, applyPgliteManualAssetsSchema } from "../src/ledger/pglite/manual-assets.ts";
import { applyPgliteOperationalBaseline, createPgliteOperationalProvider } from "../src/ledger/pglite/operational.ts";
import { applyPglitePreviewFinancialDataSchema } from "../src/ledger/pglite/preview-financial-data.ts";
import { PGliteStore } from "../src/ledger/pglite/transaction.ts";
import { accountLedger } from "../src/lib/shared-ledger/twd-valuation.ts";
import { indexExchangeRates } from "../src/lib/shared-money/exchange-rates.ts";

const CLOCK = { now: () => "2026-11-01T02:00:00.000Z", today: () => "2026-11-01" };

async function withManualLedger(run: (input: {
  store: PGliteStore;
  registry: ReturnType<typeof createPGliteFinancialRegistry>;
  apply: (command: unknown) => Promise<Readonly<{ revision: number; assetId?: string; transactionId?: string }>>;
  addUsdRate: () => Promise<void>;
}) => Promise<void>, database?: PGlite) {
  const store = new PGliteStore(database ?? await createTestPGlite("ledger+operational"));
  try {
    await applyPglitePreviewFinancialDataSchema(store);
    await applyPgliteManualAssetsSchema(store);
    await commitCathay(store);
    const operational = createPgliteOperationalProvider(store);
    await run({
      store,
      registry: createPGliteFinancialRegistry(store, undefined, { manualAssets: true, today: CLOCK.today }),
      apply: async (command) => {
        const result = await applyManualAssetCommand(store, command, CLOCK);
        if (!result.ok) assert.fail(`refused: ${result.code}`);
        return result;
      },
      addUsdRate: () => operational.exchangeRates.upsertExchangeRates([{
        rateDate: "2026-01-01", currency: "USD", twdPerUnit: 32, source: "check", fetchedAt: "2026-01-01T00:00:00.000Z",
      }]),
    });
  } finally {
    await store.close();
  }
}

const create = (category: string, name: string, currency: string, valuedOn: string, amount: string, source: string) => ({
  kind: "createAsset", category, name, currency, firstValuation: { valuedOn, amount, source, note: null },
});

function converted(overview: OverviewPageDto) {
  const net = overview.summary.net;
  if (net.display !== "converted") assert.fail(`expected a converted Net position, got ${net.display}`);
  return net;
}

test("a manual asset counts toward assets and the Net position with a manual marker, never a preview one", async () => {
  await withManualLedger(async ({ registry, apply }) => {
    const before = converted(await registry["financial.overview.current"]([]));
    assert.equal(before.provenance.manual, false);
    await apply(create("house", "Apartment", "TWD", "2026-10-05", "5000000.5", "appraisal_report"));
    const overview = await registry["financial.overview.current"]([]);
    const net = converted(overview);
    assert.equal(net.twd, before.twd + 5000000.5);
    assert.deepEqual(net.provenance, { preview: false, manual: true });
    assert.equal(overview.summary.assets.provenance.manual, true);
    const row = overview.accounts.find((account) => account.manual);
    assert.equal(row?.kind, "manual");
    assert.equal(row?.preview, undefined);
    assert.deepEqual(row?.amountLines, [{ currency: "TWD", value: 5000000.5, exact: { coefficient: "50000005", scale: 1 } }]);
    const assets = await registry["financial.assets.current"]([]);
    assert.ok(assets.accounts.some((account) => account.id === row!.id), "the Assets page lists it");
    assert.ok(!(await registry["financial.liabilities.current"]([])).accounts.some((account) => account.manual));
    const summary = readAssetsSummary(assets, { today: "2026-10-31" });
    assert.ok(summary.state === "ready" && summary.slices.some((slice) => slice.category === "manual"));
  });
});

test("a manual currency without a rate leaves the asset out of the TWD figure and names the currency", async () => {
  await withManualLedger(async ({ registry, apply, addUsdRate }) => {
    const before = converted(await registry["financial.overview.current"]([]));
    await apply(create("insurance", "Policy cash value", "USD", "2026-10-05", "1000", "insurer_statement"));
    const rateless = converted(await registry["financial.overview.current"]([]));
    assert.equal(rateless.twd, before.twd, "the total stays a figure");
    assert.deepEqual(rateless.unconvertedCurrencies, ["USD"]);
    assert.equal(rateless.provenance.manual, false, "the marker describes only the figure shown");
    await addUsdRate();
    const withRate = converted(await registry["financial.overview.current"]([]));
    assert.equal(withRate.twd, before.twd + 32000);
    assert.deepEqual(withRate.unconvertedCurrencies, []);
    assert.equal(withRate.provenance.manual, true);
  });
});

test("an asset counts through its end date, sale price included, and drops to zero the day after", async () => {
  await withManualLedger(async ({ registry, apply }) => {
    const { assetId } = await apply(create("vehicle", "Car", "TWD", "2026-09-01", "600000", "purchase_price"));
    await apply({ kind: "upsertValuation", assetId, valuation: { valuedOn: "2026-10-20", amount: "550000", source: "used_vehicle_quote", note: null } });
    await apply({ kind: "endAsset", assetId, endedOn: "2026-10-25" });
    await apply({ kind: "upsertValuation", assetId, valuation: { valuedOn: "2026-10-25", amount: "520000", source: "used_vehicle_quote", note: "sold" } });
    const overview = await registry["financial.overview.current"]([]);
    const assetsOn = (date: string) => overview.dailyHistory.find((row) => row.date === date);
    assert.deepEqual(assetsOn("2026-09-01")?.assets, [{ currency: "TWD", value: 600000, exact: { coefficient: "600000", scale: 0 } }]);
    assert.equal(assetsOn("2026-09-01")?.provenance.manual, true);
    assert.equal(assetsOn("2026-10-20")!.assets[0]!.value, 550000 + 1000, "the car beside the 1000 TWD Cathay account");
    assert.equal(assetsOn("2026-10-25")?.assets[0]?.value, 520000 + 1000, "on its end date the sale price counts");
    assert.equal(assetsOn("2026-10-26")?.assets[0]?.value, 1000, "from the next day the car counts toward nothing");
    assert.equal(assetsOn("2026-10-26")?.provenance.manual, false);
    const row = overview.accounts.find((account) => account.manual)!;
    assert.deepEqual(row.amountLines, [], "after its end date an ended asset shows no amount");
    assert.equal(row.manual?.endedOn, "2026-10-25");
    assert.equal(row.manual?.valuations.length, 3);
    assert.deepEqual(overview.dailyHistoryByAccount[row.id]?.map((entry) => [entry.date, entry.netAssets[0]?.value]), [
      ["2026-09-01", 600000], ["2026-10-20", 550000], ["2026-10-25", 520000], ["2026-10-26", 0],
    ], "its own history stays and records the drop to zero");
    const ledger = accountLedger(overview.dailyHistoryByAccount, indexExchangeRates(overview.exchangeRates));
    assert.equal(ledger.change("2026-10-25", "2026-10-31").change, -520000, "a change across the sale sees the car leave");
    assert.deepEqual(ledger.change("2026-10-25", "2026-10-31").provenance, { preview: false, manual: true }, "and is marked manual");
    const assets = readAssetsSummary(await registry["financial.assets.current"]([]), { today: "2026-10-31" });
    assert.deepEqual(assets.state === "ready" && assets.trailing?.provenance, { preview: false, manual: true }, "the ended car marks the Assets 30-day change");
    assert.deepEqual(assets.state === "ready" && assets.provenance, { preview: false, manual: true });
  });
});

test("an asset ended today still counts today", async () => {
  await withManualLedger(async ({ registry, apply }) => {
    const before = converted(await registry["financial.overview.current"]([]));
    const { assetId } = await apply(create("other", "Watch", "TWD", "2026-10-01", "50000", "market_quote"));
    await apply({ kind: "endAsset", assetId, endedOn: CLOCK.today() });
    const overview = await registry["financial.overview.current"]([]);
    assert.equal(converted(overview).twd, before.twd + 50000);
    assert.equal(overview.accounts.find((account) => account.manual)?.amountLines.length, 1);
  });
});

test("a Manual Account counts its latest count plus the transactions after it", async () => {
  await withManualLedger(async ({ registry, apply }) => {
    const { assetId } = await apply(create("cash", "Wallet", "TWD", "2026-10-01", "3000", "counted"));
    const add = (transaction: object) => apply({ kind: "addTransaction", accountId: assetId, transaction });
    await add({ kind: "purchase", personalCategory: "dining", occurredOn: "2026-10-01", amount: "100", note: null });
    await add({ kind: "purchase", personalCategory: "dining", occurredOn: "2026-10-03", amount: "250", note: null });
    await add({ kind: "receipt", occurredOn: "2026-10-04", amount: "50", note: null });
    const row = (await registry["financial.assets.current"]([])).accounts.find((account) => account.manual)!;
    assert.deepEqual(row.amountLines.map((line) => line.exact), [{ coefficient: "2800", scale: 0 }]);
    assert.equal(row.manual?.balance?.asOf, "2026-10-04");
    assert.equal(row.manual?.transactions.length, 3);
  });
});

test("a store without the manual tables reads its pages as before", async () => {
  const store = new PGliteStore(await createTestPGlite("ledger+operational"));
  try {
    await commitCathay(store);
    const overview = await createPGliteFinancialRegistry(store)["financial.overview.current"]([]);
    assert.equal(overview.accounts.some((account) => account.manual), false);
  } finally {
    await store.close();
  }
});

test("Spending counts manual purchases in their month, day, and Personal Category, and never a receipt or transfer", async () => {
  await withManualLedger(async ({ registry, apply }) => {
    const before = await registry["financial.spending.current"]([{}]);
    const { assetId: wallet } = await apply(create("cash", "Wallet", "TWD", "2026-10-01", "3000", "counted"));
    const { assetId: jar } = await apply(create("cash", "Jar", "TWD", "2026-10-01", "0", "counted"));
    const add = (transaction: object) => apply({ kind: "addTransaction", accountId: wallet, transaction });
    await add({ kind: "purchase", personalCategory: "dining", occurredOn: "2026-10-03", amount: "120.5", note: "Noodles" });
    await add({ kind: "purchase", personalCategory: null, occurredOn: "2026-10-03", amount: "30", note: null });
    await add({ kind: "receipt", occurredOn: "2026-10-04", amount: "500", note: null });
    await add({ kind: "transfer", direction: "out", counterpartAccountId: jar, occurredOn: "2026-10-05", amount: "100", note: null });
    const page = await registry["financial.spending.current"]([{}]);
    const summary = page.purchaseReport.summary!;
    assert.equal(summary.recordCount, before.purchaseReport.summary!.recordCount + 2);
    assert.deepEqual(page.manual?.purchases.map((row) => [row.amount, row.personalCategory]).sort(), [["120.5", "dining"], ["30", null]]);
    assert.deepEqual(summary.dayTotals.find((day) => day.date === "2026-10-03"), {
      month: "2026-10", date: "2026-10-03", recordCount: 2,
      totalsByCurrency: [{ currency: "TWD", coefficient: "1505", scale: 1, count: 2 }],
    });
    assert.equal(summary.dayTotals.some((day) => day.date === "2026-10-04" || day.date === "2026-10-05"), false);
    assert.deepEqual(summary.categoryTotalsByMonth.filter((entry) => entry.month === "2026-10").map((entry) => [entry.categoryCode, entry.coefficient, entry.scale])
      .sort(([left], [right]) => String(left).localeCompare(String(right))), [
      ["dining", "1205", 1],
      [null, "30", 0],
    ]);
    assert.equal(page.purchaseReport.knowledgeAt, before.purchaseReport.knowledgeAt, "manual purchases leave the canonical version alone");
  });
});

test("every live page republishes on each kind of manual write", async () => {
  const database = await PGlite.create({ extensions: { live } }) as unknown as PGliteWithLive;
  await applyPgliteBaseline(database as unknown as PGlite);
  await applyPgliteOperationalBaseline(new PGliteStore(database as unknown as PGlite));
  await withManualLedger(async ({ registry, apply }) => {
    const views = createPGliteFinancialLiveViews(registry, createPGliteLiveViewDependencies(database, registry, createLocalDateClock(CLOCK.today)));
    const latest = new Map<string, unknown>();
    const counts = new Map<string, number>();
    const stops: Array<() => Promise<void>> = [];
    const live = [
      "financial.overview.current",
      "financial.assets.current",
      "financial.liabilities.current",
      "financial.spending.current",
    ] as const satisfies readonly PGliteFinancialLiveView[];
    const settle = async (label: string, write: () => Promise<unknown>) => {
      const before = new Map(counts);
      await write();
      const deadline = Date.now() + 5_000;
      const pending = () => live.filter((view) => counts.get(view) === before.get(view));
      while (pending().length > 0) {
        if (Date.now() > deadline) throw new Error(`${pending().join(", ")} did not republish on ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      for (const view of live) {
        counts.set(view, 0);
        stops.push(await views.subscribe(view, {}, (rows) => {
          latest.set(view, rows[0]);
          counts.set(view, counts.get(view)! + 1);
        }));
      }
      let houseId = "";
      await settle("create", async () => {
        houseId = (await apply(create("house", "Flat", "TWD", "2026-10-05", "100", "own_estimate"))).assetId!;
      });
      await settle("valuation", () => apply({ kind: "upsertValuation", assetId: houseId, valuation: { valuedOn: "2026-10-06", amount: "120", source: "own_estimate", note: null } }));
      await settle("valuation replace", () => apply({ kind: "upsertValuation", assetId: houseId, valuation: { valuedOn: "2026-10-06", amount: "130", source: "own_estimate", note: null } }));
      await settle("valuation delete", () => apply({ kind: "deleteValuation", assetId: houseId, valuedOn: "2026-10-06" }));
      await settle("rename", () => apply({ kind: "renameAsset", assetId: houseId, name: "Home" }));
      await settle("end", () => apply({ kind: "endAsset", assetId: houseId, endedOn: "2026-10-07" }));
      let walletId = "";
      await settle("cash", async () => {
        walletId = (await apply(create("cash", "Wallet", "TWD", "2026-10-01", "500", "counted"))).assetId!;
      });
      let purchaseId = "";
      await settle("purchase", async () => {
        purchaseId = (await apply({ kind: "addTransaction", accountId: walletId, transaction: { kind: "purchase", personalCategory: "dining", occurredOn: "2026-10-02", amount: "40", note: null } })).transactionId!;
      });
      const spendingWith = () => (latest.get("financial.spending.current") as SpendingPageDto).manual?.purchases.length;
      assert.equal(spendingWith(), 1, "the published Spending page holds the purchase");
      await settle("purchase edit", () => apply({ kind: "updateTransaction", transactionId: purchaseId, transaction: { kind: "purchase", personalCategory: null, occurredOn: "2026-10-02", amount: "45", note: null } }));
      await settle("purchase delete", () => apply({ kind: "deleteTransaction", transactionId: purchaseId }));
      assert.equal(spendingWith(), 0);
      await settle("asset delete", () => apply({ kind: "deleteAsset", assetId: houseId }));
      await settle("delete all", () => apply({ kind: "deleteAllManualAssets" }));
      assert.equal((latest.get("financial.overview.current") as OverviewPageDto).accounts.some((account) => account.manual), false);
    } finally {
      await Promise.all(stops.map((stop) => stop()));
    }
  }, database as unknown as PGlite);
});

test("a live page republishes when the date moves past an asset's end date, with no write", async () => {
  const database = await PGlite.create({ extensions: { live } }) as unknown as PGliteWithLive;
  await applyPgliteBaseline(database as unknown as PGlite);
  await applyPgliteOperationalBaseline(new PGliteStore(database as unknown as PGlite));
  await withManualLedger(async ({ store, apply }) => {
    let date = CLOCK.today();
    let midnight = () => {};
    const clock: LocalDateClock = {
      today: () => date,
      async watch({ changed }) {
        midnight = changed;
        return async () => {};
      },
    };
    const registry = createPGliteFinancialRegistry(store, undefined, { manualAssets: true, today: clock.today });
    const { assetId } = await apply(create("other", "Watch", "TWD", "2026-10-01", "50000", "market_quote"));
    await apply({ kind: "endAsset", assetId, endedOn: CLOCK.today() });
    const views = createPGliteFinancialLiveViews(registry, createPGliteLiveViewDependencies(database, registry, clock));
    const published: OverviewPageDto[] = [];
    const stop = await views.subscribe("financial.overview.current", {}, (rows) => published.push(rows[0] as OverviewPageDto));
    const watchLines = () => published.at(-1)!.accounts.find((account) => account.manual)!.amountLines.length;
    try {
      assert.equal(watchLines(), 1, "on its end date the watch counts");
      const before = published.length;
      date = "2026-11-02";
      midnight();
      const deadline = Date.now() + 5_000;
      while (published.length === before) {
        if (Date.now() > deadline) throw new Error("the overview did not republish after midnight");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(watchLines(), 0, "the day after its end date the watch counts toward nothing");
    } finally {
      await stop();
    }
  }, database as unknown as PGlite);
});

test("a manual write during a Spending page action is published once the action settles", async () => {
  const database = await PGlite.create({ extensions: { live } }) as unknown as PGliteWithLive;
  await applyPgliteBaseline(database as unknown as PGlite);
  await applyPgliteOperationalBaseline(new PGliteStore(database as unknown as PGlite));
  await withManualLedger(async ({ registry, apply }) => {
    let inFlight = false;
    let settle: ((result: null) => void) | null = null;
    const racing = {
      ...registry,
      isSpendingPageActionInFlight: () => inFlight,
      onSpendingPageActionSettled: (listener: (result: null) => void) => {
        settle = listener;
        return () => {};
      },
    } as typeof registry;
    const views = createPGliteFinancialLiveViews(racing, createPGliteLiveViewDependencies(database, racing, createLocalDateClock(CLOCK.today)));
    const pages: SpendingPageDto[] = [];
    const stop = await views.subscribe("financial.spending.current", {}, (rows) => pages.push(rows[0] as SpendingPageDto));
    const purchases = () => pages.at(-1)?.manual?.purchases.length ?? 0;
    try {
      const { assetId } = await apply(create("cash", "Wallet", "TWD", "2026-10-01", "500", "counted"));
      const deadline = Date.now() + 5_000;
      while ((pages.at(-1)?.manual?.revision ?? 0) < 1) {
        if (Date.now() > deadline) throw new Error("Spending did not publish the first manual write");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      inFlight = true;
      await apply({ kind: "addTransaction", accountId: assetId, transaction: { kind: "purchase", personalCategory: null, occurredOn: "2026-10-02", amount: "40", note: null } });
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(purchases(), 0, "the trigger is held while the action runs");
      inFlight = false;
      settle!(null);
      const settled = Date.now() + 5_000;
      while (purchases() === 0) {
        if (Date.now() > settled) throw new Error("the manual purchase was never published after the action settled");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await stop();
    }
  }, database as unknown as PGlite);
});

test("a store holding only manual assets fills the Assets page and its history, with no empty-state banner", async () => {
  const store = new PGliteStore(await createTestPGlite("ledger+operational"));
  try {
    await applyPgliteManualAssetsSchema(store);
    const result = await applyManualAssetCommand(store, create("house", "Home", "TWD", "2025-03-01", "12000000", "actual_price_registration"), CLOCK);
    assert.equal(result.ok, true);
    const registry = createPGliteFinancialRegistry(store, undefined, { manualAssets: true, today: CLOCK.today });
    const assets = await registry["financial.assets.current"]([]);
    assert.equal(assets.availability, "available");
    assert.notEqual(assets.coverage, "awaiting", "the 尚無可用的財務帳戶 banner shows only for awaiting or unavailable coverage");
    const row = assets.accounts.find((account) => account.manual)!;
    assert.deepEqual(assets.dailyHistoryByAccount[row.id]?.map((entry) => entry.date), ["2025-03-01"]);
    assert.deepEqual(assets.dailyHistory.map((entry) => [entry.date, entry.assets[0]?.value]), [["2025-03-01", 12000000]]);
    const overview = await registry["financial.overview.current"]([]);
    assert.deepEqual(overview.dailyHistory.map((entry) => entry.date), ["2025-03-01"]);
    assert.equal(overview.historyAvailability, "available");
  } finally {
    await store.close();
  }
});
