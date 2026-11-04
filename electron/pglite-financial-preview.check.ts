import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
import { createLocalDateClock, createPGliteLiveViewDependencies } from "./pglite-financial-live-dependencies.ts";
import { createPGliteFinancialLiveViews, type PGliteFinancialLiveView } from "./pglite-financial-live-views.ts";
import { createPGliteFinancialRegistry } from "./pglite-financial-registry.ts";
import { readOverview } from "../src/lib/overview/overview-model.ts";
import type { LiabilitiesPageDto } from "../src/lib/liabilities/types.ts";
import type { OverviewPageDto } from "../src/lib/overview/types.ts";
import { applyPgliteBaseline } from "../src/ledger/pglite/baseline.ts";
import { createTestPGlite } from "../src/ledger/pglite/baseline-test-template.ts";
import {
  addUsdRate,
  commitVerifiedDeposit,
  HIDDEN,
  TODAY,
  twdSavings,
  usdSavings,
  VISIBLE,
  writePreviewDeposits,
} from "../src/ledger/pglite/financial-pages.fixtures.ts";
import { applyPgliteManualAssetsSchema } from "../src/ledger/pglite/manual-assets.ts";
import { applyPgliteOperationalBaseline } from "../src/ledger/pglite/operational.ts";
import {
  applyPglitePreviewFinancialDataSchema,
  createPGlitePreviewFinancialData,
  PREVIEW_FINANCIAL_DATA_TABLES,
  type PreviewAccount,
  type PreviewVisibility,
} from "../src/ledger/pglite/preview-financial-data.ts";
import { PGliteStore } from "../src/ledger/pglite/transaction.ts";

process.env.OCTOPUSBEAK_PREVIEW_SOURCE_FIXTURE = "1";
const { currentPreviewVisibility } = await import("../src/lib/automation/server/settings.ts");

async function withLedger(run: (input: {
  store: PGliteStore;
  registry: (visibility: () => PreviewVisibility) => ReturnType<typeof createPGliteFinancialRegistry>;
  writePreview: (...accounts: PreviewAccount[]) => Promise<void>;
  preview: ReturnType<typeof createPGlitePreviewFinancialData>;
  addUsdRate: () => Promise<void>;
}) => Promise<void>, database?: PGlite) {
  const store = new PGliteStore(database ?? await createTestPGlite("ledger+operational"));
  try {
    await applyPglitePreviewFinancialDataSchema(store);
    await applyPgliteManualAssetsSchema(store);
    await commitVerifiedDeposit(store);
    const preview = createPGlitePreviewFinancialData(store);
    await run({
      store,
      preview,
      registry: (visibility) => createPGliteFinancialRegistry(store, visibility),
      writePreview: (...accounts) => writePreviewDeposits(preview, ...accounts),
      addUsdRate: () => addUsdRate(store, "2026-10-01"),
    });
  } finally {
    await store.close();
  }
}

test("the Preview features setting decides visibility at each read", async () => {
  await withLedger(async ({ registry, writePreview }) => {
    await writePreview(twdSavings);
    let settings: Record<string, string> = { PREVIEW_FEATURES_ENABLED: "true" };
    const live = registry(() => currentPreviewVisibility(settings));
    assert.equal((await live["financial.overview.current"]([])).accounts.some((account) => account.preview), true);
    settings = { PREVIEW_FEATURES_ENABLED: "false" };
    const off = await live["financial.overview.current"]([]);
    assert.equal(off.accounts.some((account) => account.preview), false);
    assert.equal(off.dailyHistory.some((row) => row.provenance.preview), false);
    assert.equal(off.summary.net.provenance.preview, false);
    assert.equal(readOverview(off, { today: TODAY }).netWorth.chipsProvenance.preview, false);
    assert.equal((await live["financial.assets.current"]([])).accounts.some((account) => account.preview), false);
  });
});

async function canonicalSnapshot(store: PGliteStore): Promise<Record<string, string>> {
  const tables = await store.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND NOT (table_name = ANY($1::text[]))
      ORDER BY table_name`,
    [PREVIEW_FINANCIAL_DATA_TABLES],
  );
  const snapshot: Record<string, string> = {};
  for (const { table_name } of tables.rows) {
    const result = await store.query<{ digest: string | null }>(
      `SELECT md5(string_agg(row_text, '|' ORDER BY row_text)) AS digest
         FROM (SELECT t::text AS row_text FROM "${table_name}" t) rows`,
    );
    snapshot[table_name] = result.rows[0]?.digest ?? "empty";
  }
  return snapshot;
}

test("preview writes and reads leave every canonical table unchanged", async () => {
  await withLedger(async ({ store, registry, writePreview }) => {
    const shown = registry(() => VISIBLE);
    await shown["financial.overview.current"]([]);
    await shown["financial.assets.current"]([]);
    const before = await canonicalSnapshot(store);
    await writePreview(twdSavings, usdSavings);
    await shown["financial.overview.current"]([]);
    await shown["financial.assets.current"]([]);
    await shown["financial.liabilities.current"]([]);
    assert.deepEqual(await canonicalSnapshot(store), before);
  });
});

test("live overview republishes on a preview collection and on a visibility change", async () => {
  const database = await PGlite.create({ extensions: { live } }) as unknown as PGliteWithLive;
  await applyPgliteBaseline(database as unknown as PGlite);
  await applyPgliteOperationalBaseline(new PGliteStore(database as unknown as PGlite));
  await withLedger(async ({ registry, writePreview }) => {
    let visibility = VISIBLE;
    const shown = registry(() => visibility);
    const views = createPGliteFinancialLiveViews(shown, createPGliteLiveViewDependencies(database, shown, createLocalDateClock(() => TODAY)));
    const published: OverviewPageDto[] = [];
    const stop = await views.subscribe("financial.overview.current", {}, (value) => published.push(value as OverviewPageDto));
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("live overview did not republish");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await until(() => published.length >= 1);
      assert.equal(published.at(-1)!.accounts.some((account) => account.preview), false);
      await writePreview(twdSavings);
      await until(() => published.at(-1)!.accounts.some((account) => account.preview));
      visibility = HIDDEN;
      await shown["financial.preview.visibilityChanged"]([]);
      await until(() => !published.at(-1)!.accounts.some((account) => account.preview));
    } finally {
      await stop();
    }
  }, database as unknown as PGlite);
});

test("live liabilities republish on a preview credit collection and on a visibility change", async () => {
  const database = await PGlite.create({ extensions: { live } }) as unknown as PGliteWithLive;
  await applyPgliteBaseline(database as unknown as PGlite);
  await applyPgliteOperationalBaseline(new PGliteStore(database as unknown as PGlite));
  await withLedger(async ({ registry, preview }) => {
    let visibility: PreviewVisibility = { visible: [{ sourceId: "synthetic", product: "credit_card" }] };
    const shown = registry(() => visibility);
    const views = createPGliteFinancialLiveViews(shown, createPGliteLiveViewDependencies(database, shown, createLocalDateClock(() => TODAY)));
    const published: LiabilitiesPageDto[] = [];
    const stop = await views.subscribe("financial.liabilities.current", {}, (value) => published.push(value as LiabilitiesPageDto));
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("live liabilities did not republish");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await until(() => published.length >= 1);
      assert.equal(published.at(-1)!.accounts.some((account) => account.preview), false);
      await preview.write({
        sourceId: "synthetic",
        institution: "bank-017",
        product: "credit_card",
        collection: {
          collectedAt: "2026-10-05T03:00:00.000Z",
          accounts: [{
            sourceAccountKey: "known", displayLabel: "Known card", currency: "TWD", creditLimit: "50000",
            cards: [], purchases: [], statements: [],
            balances: [{
              amount: "300", currency: "TWD", observedAt: { at: "2026-10-05T02:00:00.000Z", source: "reported" },
              basis: { kind: "provider-used-credit", usedCredit: "300" },
            }],
          }],
        },
      });
      await until(() => published.at(-1)!.accounts.some((account) => account.preview));
      visibility = HIDDEN;
      await shown["financial.preview.visibilityChanged"]([]);
      await until(() => !published.at(-1)!.accounts.some((account) => account.preview));
    } finally {
      await stop();
    }
  }, database as unknown as PGlite);
});

test("live liabilities republish on a preview loan collection, including one that only closes a loan", async () => {
  const database = await PGlite.create({ extensions: { live } }) as unknown as PGliteWithLive;
  await applyPgliteBaseline(database as unknown as PGlite);
  await applyPgliteOperationalBaseline(new PGliteStore(database as unknown as PGlite));
  await withLedger(async ({ registry, preview }) => {
    const shown = registry(() => ({ visible: [{ sourceId: "synthetic", product: "loan" }] }));
    const views = createPGliteFinancialLiveViews(shown, createPGliteLiveViewDependencies(database, shown, createLocalDateClock(() => TODAY)));
    const published: LiabilitiesPageDto[] = [];
    const stop = await views.subscribe("financial.liabilities.current", {}, (value) => published.push(value as LiabilitiesPageDto));
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("live liabilities did not republish");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const loans = (collectedAt: string, held: boolean) => preview.write({
      sourceId: "synthetic",
      institution: "bank-017",
      product: "loan",
      collection: {
        collectedAt,
        completeness: "complete",
        loans: held ? [{
          sourceAccountKey: "home", displayLabel: "Home loan 4567", currency: "TWD", category: "housing",
          outstandingBalance: { amount: "6000000", observedAt: { at: collectedAt, source: "reported" } },
          originalAmount: "8000000", interestRate: null, paymentAmount: null, nextPaymentDate: null,
          installmentsPaid: null, installmentsTotal: null, openedOn: null, maturityDate: null,
        }] : [],
      },
    });
    const showsLoan = () => published.at(-1)!.accounts.some((account) => account.preview && account.amountLines.length > 0);
    try {
      await until(() => published.length >= 1);
      assert.equal(showsLoan(), false);
      await loans("2026-10-05T03:00:00.000Z", true);
      await until(showsLoan);
      await loans("2026-10-06T03:00:00.000Z", false);
      await until(() => !showsLoan());
    } finally {
      await stop();
    }
  }, database as unknown as PGlite);
});

test("each live view republishes on exactly the dependencies it reads", async () => {
  const database = await PGlite.create({ extensions: { live } }) as unknown as PGliteWithLive;
  await applyPgliteBaseline(database as unknown as PGlite);
  await applyPgliteOperationalBaseline(new PGliteStore(database as unknown as PGlite));
  await withLedger(async ({ registry, writePreview, addUsdRate }) => {
    const shown = registry(() => VISIBLE);
    const views = createPGliteFinancialLiveViews(shown, createPGliteLiveViewDependencies(database, shown, createLocalDateClock(() => TODAY)));
    const expected = {
      "financial.overview.current": { preview: true, exchangeRates: true },
      "financial.assets.current": { preview: true, exchangeRates: true },
      "financial.liabilities.current": { preview: true, exchangeRates: true },
      "financial.spending.current": { preview: false, exchangeRates: false },
    } satisfies Record<PGliteFinancialLiveView, { preview: boolean; exchangeRates: boolean }>;
    const counts = new Map<string, number>();
    const stops: Array<() => Promise<void>> = [];
    const settle = async (dependency: "preview" | "exchangeRates", change: () => Promise<unknown>) => {
      const before = new Map(counts);
      await change();
      const deadline = Date.now() + 5_000;
      const pending = () => Object.entries(expected)
        .filter(([view, reads]) => reads[dependency] && counts.get(view) === before.get(view));
      while (pending().length > 0) {
        if (Date.now() > deadline) throw new Error(`${pending().map(([view]) => view).join(", ")} did not republish on ${dependency}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Every subscriber hears the same live query round; give the others time to (wrongly) publish.
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (const [view, reads] of Object.entries(expected)) {
        if (!reads[dependency]) assert.equal(counts.get(view), before.get(view), `${view} republished on ${dependency}`);
      }
    };
    try {
      for (const view of Object.keys(expected)) {
        counts.set(view, 0);
        stops.push(await views.subscribe(view, {}, () => counts.set(view, counts.get(view)! + 1)));
      }
      await settle("preview", () => writePreview(twdSavings));
      await settle("preview", () => shown["financial.preview.visibilityChanged"]([]));
      await settle("exchangeRates", addUsdRate);
    } finally {
      await Promise.all(stops.map((stop) => stop()));
    }
  }, database as unknown as PGlite);
});
