import assert from "node:assert/strict";
import test from "node:test";
import { readAssetsSummary } from "../../lib/assets/assets-summary.ts";
import { readOverview } from "../../lib/overview/overview-model.ts";
import { accountLedger } from "../../lib/shared-ledger/twd-valuation.ts";
import { indexExchangeRates } from "../../lib/shared-money/exchange-rates.ts";
import { createTestPGlite } from "./baseline-test-template.ts";
import { commitCathay, commitTdccSettlement } from "./direct-source-precedence-fixture.ts";
import {
  addUsdRate,
  applyManual,
  commitVerifiedDeposit,
  convertedNet,
  createManualAsset as create,
  HIDDEN,
  MANUAL_CLOCK,
  TODAY,
  twdSavings,
  usdSavings,
  VISIBLE,
  writePreviewDeposits,
} from "./financial-pages.fixtures.ts";
import { readAssetsPage, readLiabilitiesPage, readOverviewPage, type FinancialPageScope } from "./financial-pages.ts";
import { applyManualAssetCommand } from "./manual-assets.ts";
import { createPGlitePreviewFinancialData, type PreviewVisibility } from "./preview-financial-data.ts";
import { PGliteStore } from "./transaction.ts";

const SCOPE: FinancialPageScope = { expectedSources: [], previewVisibility: { visible: [] }, today: "2026-11-03" };

async function withStore(run: (store: PGliteStore) => Promise<void>) {
  const store = new PGliteStore(await createTestPGlite("full"));
  try {
    await run(store);
  } finally {
    await store.close();
  }
}

async function readPages(store: PGliteStore) {
  return {
    overview: await store.transaction((reader) => readOverviewPage(reader, SCOPE)),
    assets: await store.transaction((reader) => readAssetsPage(reader, SCOPE)),
    liabilities: await store.transaction((reader) => readLiabilitiesPage(reader, SCOPE)),
  };
}

test("every Financial page is valued at the newest history date, not the person's date", async () => {
  await withStore(async (store) => {
    await commitCathay(store);
    const { overview, assets, liabilities } = await readPages(store);
    const newest = overview.dailyHistory.map((row) => row.date).sort().at(-1);
    assert.ok(newest && newest < SCOPE.today, "the fixture's history ends before the person's date");
    assert.equal(overview.valuationDate, newest);
    assert.equal(assets.valuationDate, newest);
    assert.equal(liabilities.valuationDate, newest);
  });
});

test("without history or rates, the pages are valued at the person's date", async () => {
  await withStore(async (store) => {
    const { overview, assets, liabilities } = await readPages(store);
    assert.deepEqual(overview.dailyHistory, []);
    assert.deepEqual(
      [overview.valuationDate, assets.valuationDate, liabilities.valuationDate],
      [SCOPE.today, SCOPE.today, SCOPE.today],
    );
  });
});

function pageScope({ visibility = HIDDEN, today = TODAY }: { visibility?: PreviewVisibility; today?: string } = {}): FinancialPageScope {
  return { expectedSources: [], previewVisibility: visibility, today };
}

/** A store holding the verified 100.1 TWD deposit, ready for preview collections. */
async function withPreviewLedger(run: (input: {
  store: PGliteStore;
  preview: ReturnType<typeof createPGlitePreviewFinancialData>;
}) => Promise<void>) {
  await withStore(async (store) => {
    await commitVerifiedDeposit(store);
    await run({ store, preview: createPGlitePreviewFinancialData(store) });
  });
}

test("visible preview balances count in overview and assets totals with exact decimals and a flag", async () => {
  await withPreviewLedger(async ({ store, preview: port }) => {
    await writePreviewDeposits(port, twdSavings);
    const shown = pageScope({ visibility: VISIBLE });
    const overview = await readOverviewPage(store, shown);
    assert.deepEqual(overview.summary.assets.amounts.map((amount) => [amount.currency, amount.exact]), [
      ["TWD", { coefficient: "133460", scale: 2 }],
    ], "100.1 canonical plus 1234.50 preview, exactly");
    assert.equal(overview.summary.assets.provenance.preview, true);
    const preview = overview.accounts.find((account) => account.preview)!;
    assert.match(preview.id, /^preview:[0-9a-f]{32}$/u);
    assert.equal(preview.canonicalAccountId, undefined);
    assert.deepEqual(preview.preview!.transactions.map((row) => row.direction), ["outflow", "unknown"]);
    assert.deepEqual(overview.dailyHistory.map((row) => [row.date, row.provenance.preview]), [
      ["2026-10-01", false],
      ["2026-10-03", true],
      ["2026-10-05", true],
    ]);
    assert.deepEqual(overview.dailyHistory.at(-1)!.assets.map((amount) => amount.exact), [{ coefficient: "13346", scale: 1 }]);

    const assets = await readAssetsPage(store, shown);
    assert.ok(assets.accounts.some((account) => account.id === preview.id));
    assert.deepEqual(assets.dailyHistoryByAccount[preview.id]!.map((row) => row.date), ["2026-10-03", "2026-10-05"]);
    assert.deepEqual(assets.transactionsByAccount[preview.id], undefined, "preview rows never become canonical transactions");

    const model = readOverview(overview, { today: TODAY });
    const net = convertedNet(overview);
    assert.equal(net.twd, 1334.6);
    assert.equal(net.provenance.preview, true);
    assert.equal(model.assetAllocation.provenance.preview, true);
    assert.equal(model.series.at(-1)!.provenance.preview, true);
    const summary = readAssetsSummary(assets);
    assert.ok(summary.state === "ready" && summary.provenance.preview && summary.total === 1334.6);
  });
});

test("hidden preview data adds no account, history row, total, or flag", async () => {
  await withPreviewLedger(async ({ store, preview }) => {
    await writePreviewDeposits(preview, twdSavings);
    const hidden = pageScope({ visibility: HIDDEN });
    const overview = await readOverviewPage(store, hidden);
    assert.deepEqual(overview.summary.assets.amounts.map((amount) => amount.exact), [{ coefficient: "1001", scale: 1 }]);
    assert.equal(convertedNet(overview).twd, 100.1);
    assert.equal(overview.accounts.some((account) => account.preview), false);
    assert.deepEqual(overview.dailyHistory.map((row) => row.date), ["2026-10-01"]);
    assert.equal(overview.dailyHistory.some((row) => row.provenance.preview), false);
    const assets = await readAssetsPage(store, hidden);
    assert.equal(assets.accounts.some((account) => account.preview), false);
    assert.equal(Object.keys(assets.dailyHistoryByAccount).some((id) => id.startsWith("preview:")), false);
    const model = readOverview(overview, { today: TODAY });
    assert.equal(overview.summary.net.provenance.preview, false);
    assert.equal(model.netWorth.chipsProvenance.preview, false);
    assert.equal(model.assetAllocation.provenance.preview, false);
  });
});

test("a USD preview balance converts with a rate and is left out, listed, and unflagged without one", async () => {
  await withPreviewLedger(async ({ store, preview }) => {
    await writePreviewDeposits(preview, usdSavings);
    const shown = pageScope({ visibility: VISIBLE });
    const ratelessPage = await readOverviewPage(store, shown);
    const rateless = readOverview(ratelessPage, { today: TODAY });
    const ratelessNet = convertedNet(ratelessPage);
    assert.equal(ratelessNet.twd, 100.1, "verified net worth stays when preview data has no rate");
    assert.deepEqual(ratelessNet.unconvertedCurrencies, ["USD"]);
    assert.equal(ratelessNet.provenance.preview, false);
    assert.equal(rateless.assetAllocation.total, 100.1);
    assert.deepEqual(rateless.assetAllocation.unconvertedCurrencies, ["USD"]);
    assert.equal(rateless.assetAllocation.provenance.preview, false);
    assert.equal(rateless.series.some((point) => point.provenance.preview), false);
    const ratelessAssets = readAssetsSummary(await readAssetsPage(store, shown));
    assert.ok(ratelessAssets.state === "ready" && !ratelessAssets.provenance.preview);

    await addUsdRate(store, "2026-10-01");
    const ratedPage = await readOverviewPage(store, shown);
    const rated = readOverview(ratedPage, { today: TODAY });
    const ratedNet = convertedNet(ratedPage);
    assert.equal(ratedNet.twd, 100.1 + 320);
    assert.equal(ratedNet.provenance.preview, true);
    assert.equal(rated.assetAllocation.provenance.preview, true);
    assert.deepEqual(rated.assetAllocation.unconvertedCurrencies, []);
    assert.equal(rated.series.at(-1)!.provenance.preview, true);
  });
});

test("the published Net position converts verified TWD beside a USD preview, naming the rateless currency until a rate arrives", async () => {
  await withPreviewLedger(async ({ store, preview }) => {
    await writePreviewDeposits(preview, usdSavings);
    const shown = pageScope({ visibility: VISIBLE });
    assert.deepEqual((await readOverviewPage(store, shown)).summary.net, {
      display: "converted",
      twd: 100.1,
      unconvertedCurrencies: ["USD"],
      provenance: { preview: false, manual: false },
      incomplete: false,
    }, "the rateless USD preview is named, not shown as a native line, and does not mark the figure");

    await addUsdRate(store, "2026-10-01");
    assert.deepEqual((await readOverviewPage(store, shown)).summary.net, {
      display: "converted",
      twd: 100.1 + 320,
      unconvertedCurrencies: [],
      provenance: { preview: true, manual: false },
      incomplete: false,
    }, "with a rate the USD preview counts in the TWD figure and marks it");
  });
});

test("a native Net position carries the preview and manual markers its per-currency amounts include", async () => {
  await withPreviewLedger(async ({ store, preview }) => {
    await writePreviewDeposits(preview, twdSavings);
    await commitTdccSettlement(store, "013", { currency: "USD" });
    const clock = { now: () => "2026-10-15T02:00:00.000Z", today: () => TODAY };
    const created = await applyManualAssetCommand(store, {
      kind: "createAsset", category: "house", name: "Apartment", currency: "TWD",
      firstValuation: { valuedOn: "2026-10-05", amount: "5000000", source: "appraisal_report", note: null },
    }, clock);
    assert.ok(created.ok);
    const overview = await readOverviewPage(store, pageScope({ visibility: VISIBLE, today: TODAY }));
    const net = overview.summary.net;
    assert.equal(net.display, "native", "a verified USD balance without a rate withholds the TWD figure");
    assert.deepEqual(net.provenance, { preview: true, manual: true });
    assert.deepEqual(overview.summary.assets.provenance, { preview: true, manual: true });
    assert.deepEqual(overview.summary.liabilities.provenance, { preview: false, manual: false });
  });
});

test("preview credit accounts list on Liabilities only, and an unknown used credit counts as no amount", async () => {
  await withPreviewLedger(async ({ store, preview }) => {
    await preview.write({
      sourceId: "synthetic",
      institution: "bank-017",
      product: "credit_card",
      collection: {
        collectedAt: "2026-10-05T03:00:00.000Z",
        accounts: [
          {
            sourceAccountKey: "known", displayLabel: "Known card", currency: "TWD", creditLimit: "50000",
            cards: [{ sourceCardKey: "c1", cardMask: "****-1111", displayLabel: null }],
            balances: [{
              amount: "300", currency: "TWD", observedAt: { at: "2026-10-05T02:00:00.000Z", source: "reported" },
              basis: { kind: "provider-used-credit", usedCredit: "300" },
            }],
            purchases: [], statements: [],
          },
          {
            sourceAccountKey: "unknown", displayLabel: "Unknown card", currency: "TWD", creditLimit: null,
            cards: [], balances: [], purchases: [], statements: [],
          },
        ],
      },
    });
    const shown = pageScope({ visibility: { visible: [{ sourceId: "synthetic", product: "credit_card" }] } });
    const liabilities = await readLiabilitiesPage(store, shown);
    const rows = liabilities.accounts.filter((account) => account.preview);
    assert.deepEqual(rows.map((account) => [account.label, account.valueAvailability]), [
      ["Known card", "available"],
      ["Unknown card", "unavailable"],
    ]);
    assert.equal(liabilities.dailyHistory.at(-1)!.liabilities[0]!.value, 300);
    assert.equal((await readAssetsPage(store, shown)).accounts.some((account) => account.preview), false);
  });
});

test("preview loans list on Liabilities only, count against the Net position with a marker, and close out of every total", async () => {
  await withPreviewLedger(async ({ store, preview }) => {
    const loan = (key: string, amount: string) => ({
      sourceAccountKey: key, displayLabel: `Loan ****${key}`, currency: "TWD", category: "housing" as const,
      outstandingBalance: { amount, observedAt: { at: "2026-10-05T02:00:00.000Z", source: "reported" as const } },
      originalAmount: "1000", interestRate: null, paymentAmount: null, nextPaymentDate: null,
      installmentsPaid: null, installmentsTotal: null, openedOn: null, maturityDate: null,
    });
    const write = (collectedAt: string, loans: ReturnType<typeof loan>[]) => preview.write({
      sourceId: "synthetic", institution: "bank-017", product: "loan",
      collection: { collectedAt, completeness: "complete", loans },
    });
    await write("2026-10-05T03:00:00.000Z", [loan("1111", "40.10"), loan("2222", "20")]);
    const shown = pageScope({ visibility: { visible: [{ sourceId: "synthetic", product: "loan" }] } });
    const liabilities = await readLiabilitiesPage(store, shown);
    assert.deepEqual(liabilities.accounts.filter((account) => account.preview).map((account) => [account.label, account.kind]), [
      ["Loan ****1111", "loan"],
      ["Loan ****2222", "loan"],
    ]);
    assert.equal((await readAssetsPage(store, shown)).accounts.some((account) => account.preview), false);
    assert.deepEqual(convertedNet(await readOverviewPage(store, shown)), {
      display: "converted", twd: 100.1 - 60.1, unconvertedCurrencies: [], provenance: { preview: true, manual: false }, incomplete: false,
    });
    assert.equal(convertedNet(await readOverviewPage(store, pageScope({ visibility: HIDDEN }))).twd, 100.1, "hidden loans count toward nothing");

    await write("2026-10-06T03:00:00.000Z", [loan("1111", "40.10")]);
    assert.equal(convertedNet(await readOverviewPage(store, shown)).twd, 100.1 - 40.1, "the closed loan leaves the total");
  });
});

/** A store holding the 1000 TWD Cathay account, read at `MANUAL_CLOCK`'s date. */
async function withManualLedger(run: (input: {
  store: PGliteStore;
  apply: (command: unknown) => ReturnType<typeof applyManual>;
}) => Promise<void>) {
  await withStore(async (store) => {
    await commitCathay(store);
    await run({ store, apply: (command) => applyManual(store, command) });
  });
}

const manualScope = pageScope({ today: MANUAL_CLOCK.today() });

test("a manual asset counts toward assets and the Net position with a manual marker, never a preview one", async () => {
  await withManualLedger(async ({ store, apply }) => {
    const before = convertedNet(await readOverviewPage(store, manualScope));
    assert.equal(before.provenance.manual, false);
    await apply(create("house", "Apartment", "TWD", "2026-10-05", "5000000.5", "appraisal_report"));
    const overview = await readOverviewPage(store, manualScope);
    const net = convertedNet(overview);
    assert.equal(net.twd, before.twd + 5000000.5);
    assert.deepEqual(net.provenance, { preview: false, manual: true });
    assert.equal(overview.summary.assets.provenance.manual, true);
    const row = overview.accounts.find((account) => account.manual);
    assert.equal(row?.kind, "manual");
    assert.equal(row?.preview, undefined);
    assert.deepEqual(row?.amountLines, [{ currency: "TWD", value: 5000000.5, exact: { coefficient: "50000005", scale: 1 } }]);
    const assets = await readAssetsPage(store, manualScope);
    assert.ok(assets.accounts.some((account) => account.id === row!.id), "the Assets page lists it");
    assert.ok(!(await readLiabilitiesPage(store, manualScope)).accounts.some((account) => account.manual));
    const summary = readAssetsSummary(assets);
    assert.ok(summary.state === "ready" && summary.slices.some((slice) => slice.category === "manual"));
  });
});

test("a manual currency without a rate leaves the asset out of the TWD figure and names the currency", async () => {
  await withManualLedger(async ({ store, apply }) => {
    const before = convertedNet(await readOverviewPage(store, manualScope));
    await apply(create("insurance", "Policy cash value", "USD", "2026-10-05", "1000", "insurer_statement"));
    const rateless = convertedNet(await readOverviewPage(store, manualScope));
    assert.equal(rateless.twd, before.twd, "the total stays a figure");
    assert.deepEqual(rateless.unconvertedCurrencies, ["USD"]);
    assert.equal(rateless.provenance.manual, false, "the marker describes only the figure shown");
    await addUsdRate(store, "2026-01-01");
    const withRate = convertedNet(await readOverviewPage(store, manualScope));
    assert.equal(withRate.twd, before.twd + 32000);
    assert.deepEqual(withRate.unconvertedCurrencies, []);
    assert.equal(withRate.provenance.manual, true);
  });
});

test("an asset counts through its end date, sale price included, and drops to zero the day after", async () => {
  await withManualLedger(async ({ store, apply }) => {
    const { assetId } = await apply(create("vehicle", "Car", "TWD", "2026-09-01", "600000", "purchase_price"));
    await apply({ kind: "upsertValuation", assetId, valuation: { valuedOn: "2026-10-20", amount: "550000", source: "used_vehicle_quote", note: null } });
    await apply({ kind: "endAsset", assetId, endedOn: "2026-10-25" });
    await apply({ kind: "upsertValuation", assetId, valuation: { valuedOn: "2026-10-25", amount: "520000", source: "used_vehicle_quote", note: "sold" } });
    const overview = await readOverviewPage(store, manualScope);
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
    const assets = readAssetsSummary(await readAssetsPage(store, manualScope));
    assert.deepEqual(assets.state === "ready" && assets.trailing?.provenance, { preview: false, manual: true }, "the ended car marks the Assets 30-day change");
    assert.deepEqual(assets.state === "ready" && assets.provenance, { preview: false, manual: true });
  });
});

test("an asset ended today still counts today", async () => {
  await withManualLedger(async ({ store, apply }) => {
    const before = convertedNet(await readOverviewPage(store, manualScope));
    const { assetId } = await apply(create("other", "Watch", "TWD", "2026-10-01", "50000", "market_quote"));
    await apply({ kind: "endAsset", assetId, endedOn: MANUAL_CLOCK.today() });
    const overview = await readOverviewPage(store, manualScope);
    assert.equal(convertedNet(overview).twd, before.twd + 50000);
    assert.equal(overview.accounts.find((account) => account.manual)?.amountLines.length, 1);
  });
});

test("a Manual Account counts its latest count plus the transactions after it", async () => {
  await withManualLedger(async ({ store, apply }) => {
    const { assetId } = await apply(create("cash", "Wallet", "TWD", "2026-10-01", "3000", "counted"));
    const add = (transaction: object) => apply({ kind: "addTransaction", accountId: assetId, transaction });
    await add({ kind: "purchase", personalCategory: "dining", occurredOn: "2026-10-01", amount: "100", note: null });
    await add({ kind: "purchase", personalCategory: "dining", occurredOn: "2026-10-03", amount: "250", note: null });
    await add({ kind: "receipt", occurredOn: "2026-10-04", amount: "50", note: null });
    const row = (await readAssetsPage(store, manualScope)).accounts.find((account) => account.manual)!;
    assert.deepEqual(row.amountLines.map((line) => line.exact), [{ coefficient: "2800", scale: 0 }]);
    assert.equal(row.manual?.balance?.asOf, "2026-10-04");
    assert.equal(row.manual?.transactions.length, 3);
  });
});

test("a store holding only manual assets fills the Assets page and its history, with no empty-state banner", async () => {
  await withStore(async (store) => {
    const result = await applyManualAssetCommand(store, create("house", "Home", "TWD", "2025-03-01", "12000000", "actual_price_registration"), MANUAL_CLOCK);
    assert.equal(result.ok, true);
    const assets = await readAssetsPage(store, manualScope);
    assert.equal(assets.availability, "available");
    assert.notEqual(assets.coverage, "awaiting", "the 尚無可用的財務帳戶 banner shows only for awaiting or unavailable coverage");
    const row = assets.accounts.find((account) => account.manual)!;
    assert.deepEqual(assets.dailyHistoryByAccount[row.id]?.map((entry) => entry.date), ["2025-03-01"]);
    assert.deepEqual(assets.dailyHistory.map((entry) => [entry.date, entry.assets[0]?.value]), [["2025-03-01", 12000000]]);
    const overview = await readOverviewPage(store, manualScope);
    assert.deepEqual(overview.dailyHistory.map((entry) => entry.date), ["2025-03-01"]);
    assert.equal(overview.historyAvailability, "available");
  });
});
