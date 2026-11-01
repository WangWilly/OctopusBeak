import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
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

async function withManualLedger(run: (input: {
  store: PGliteStore;
  registry: ReturnType<typeof createPGliteFinancialRegistry>;
  apply: (command: unknown) => ReturnType<typeof applyManualAssetCommand>;
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
      registry: createPGliteFinancialRegistry(store, undefined, { manualAssets: true }),
      apply: (command) => applyManualAssetCommand(store, parseManualAssetCommand(command)),
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
    assert.equal(before.includesManual, false);
    await apply(create("house", "Apartment", "TWD", "2026-10-05", "5000000.5", "appraisal_report"));
    const overview = await registry["financial.overview.current"]([]);
    const net = converted(overview);
    assert.equal(net.twd, before.twd + 5000000.5);
    assert.equal(net.includesManual, true);
    assert.equal(net.includesPreview, false);
    assert.equal(overview.summary.assets.includesManual, true);
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
    assert.equal(rateless.includesManual, false, "the marker describes only the figure shown");
    await addUsdRate();
    const withRate = converted(await registry["financial.overview.current"]([]));
    assert.equal(withRate.twd, before.twd + 32000);
    assert.deepEqual(withRate.unconvertedCurrencies, []);
    assert.equal(withRate.includesManual, true);
  });
});

test("valuation dates become history dates, carried forward until the asset ends, with its history kept", async () => {
  await withManualLedger(async ({ registry, apply }) => {
    const { assetId } = await apply(create("vehicle", "Car", "TWD", "2026-09-01", "600000", "purchase_price"));
    await apply({ kind: "upsertValuation", assetId, valuation: { valuedOn: "2026-10-20", amount: "550000", source: "used_vehicle_quote", note: null } });
    await apply({ kind: "endAsset", assetId, endedOn: "2026-10-25" });
    const overview = await registry["financial.overview.current"]([]);
    const assetsOn = (date: string) => overview.dailyHistory.find((row) => row.date === date);
    assert.deepEqual(assetsOn("2026-09-01")?.assets, [{ currency: "TWD", value: 600000, exact: { coefficient: "600000", scale: 0 } }]);
    assert.equal(assetsOn("2026-09-01")?.includesManual, true);
    const october20 = assetsOn("2026-10-20")!.assets[0]!;
    assert.equal(october20.value, 550000 + 1000, "the car beside the 1000 TWD Cathay account");
    assert.equal(assetsOn("2026-10-25")?.assets[0]?.value, 1000, "from its end date the car counts toward nothing");
    assert.equal(assetsOn("2026-10-25")?.includesManual, undefined);
    const row = overview.accounts.find((account) => account.manual)!;
    assert.deepEqual(row.amountLines, [], "an ended asset shows no amount");
    assert.equal(row.manual?.endedOn, "2026-10-25");
    assert.equal(row.manual?.valuations.length, 2);
    assert.equal(overview.dailyHistoryByAccount[row.id]?.length, 2, "its own history stays");
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
    assert.deepEqual(page.manual?.purchases.map((row) => [row.amount, row.personalCategory]), [["30", null], ["120.5", "dining"]]);
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
    const views = createPGliteFinancialLiveViews(database, registry, () => [], undefined, { manualAssets: true });
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
