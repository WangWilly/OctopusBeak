import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
import {
  createPGliteFinancialLiveViews,
  createPGliteFinancialRegistry,
} from "./pglite-financial-registry.ts";
import { readAssetsSummary } from "../src/lib/assets/assets-summary.ts";
import { readOverview } from "../src/lib/overview/overview-model.ts";
import type { OverviewPageDto } from "../src/lib/overview/types.ts";
import { applyPgliteBaseline } from "../src/ledger/pglite/baseline.ts";
import { createTestPGlite } from "../src/ledger/pglite/baseline-test-template.ts";
import type { PGliteCanonicalBalanceCaptureRequest } from "../src/ledger/pglite/balance.ts";
import type { PGliteCanonicalFinancialCommitRequest } from "../src/ledger/pglite/canonical-source-store.ts";
import { applyPgliteOperationalBaseline, createPgliteOperationalProvider } from "../src/ledger/pglite/operational.ts";
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

const token = (value: string): string => `sha256:${value.padEnd(64, value.at(-1) ?? "x").slice(0, 64)}`;
const VISIBLE: PreviewVisibility = { visible: [{ sourceId: "synthetic", product: "deposit" }] };
const HIDDEN: PreviewVisibility = { visible: [] };
const TODAY = "2026-10-15";

function depositCommit(): PGliteCanonicalFinancialCommitRequest {
  const occurrenceKey = token("occurrence");
  return {
    capture: {
      captureId: "preview-check-deposit",
      integrationNamespace: "cathay",
      sourceConnectionKey: token("a"),
      identityEpoch: token("b"),
      stream: "domestic-deposit",
      recordKind: "source-record",
      routeKey: "cathay/domestic-deposit/v1",
      contractVersion: "v1",
      subjectDigest: token("c"),
      observedAt: "2026-10-01T00:00:00.000Z",
      accountNumber: { value: "123456", kind: "depository-account", evidenceVersion: "synthetic-v1", sourceField: "accountNumber" },
      scope: {
        startDate: "20261001", endDate: "20261001", kind: "point-in-time", completeness: "single-page",
        ruleVersion: "cathay/domestic-deposit/v1", sourceAccountKey: "123456",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: 1, terminal: true, metadata: { pageCount: 1 } }],
      records: [{
        occurrenceKey,
        collisionKey: token("collision"),
        providerKey: token("provider"),
        contentHash: token("content"),
        compact: { amount: { coefficient: "100", scale: 0 } },
      }],
    },
    account: { sourceAccountKey: "123456", accountNo: "123456", accountType: "depository", currency: "TWD" },
    transactions: [{
      sourceOccurrenceKey: occurrenceKey,
      sourceSequence: "sequence-1",
      amount: { coefficient: "100", scale: 0 },
      currency: "TWD",
      direction: "outflow",
      postingStatus: "posted",
      postingOrigin: "provider_booked_history",
      postingBasis: "query-status-success-with-accounting-date",
      postingRuleVersion: "cathay/domestic-deposit/v1",
      description: "canonical outflow",
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: "cathay/domestic-deposit/v1",
      effectiveOn: "2026-10-01",
      transactionDateTimeLocal: "2026-10-01T00:00:00+08:00",
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      timeOrigin: "source_reported",
      effectiveTimeBasis: "accounting",
      effectiveTimeRuleVersion: "cathay/domestic-deposit/v1",
      utcInstantUtcUs: 1,
    }],
  };
}

function canonicalBalanceOf100Point1Twd(): PGliteCanonicalBalanceCaptureRequest {
  const occurrenceKey = token("balance-occurrence");
  const effectiveAt = "2026-10-01T04:00:00.000Z";
  return {
    capture: {
      captureId: "preview-check-balance",
      integrationNamespace: "cathay",
      sourceConnectionKey: token("a"),
      identityEpoch: token("b"),
      stream: "domestic-deposit",
      recordKind: "synthetic-balance",
      routeKey: "cathay/domestic-deposit/current-balance-v1",
      contractVersion: "cathay/current-deposit-balance-v1",
      subjectDigest: token("balance-subject"),
      observedAt: effectiveAt,
      accountNumber: null,
      scope: {
        startDate: "2026-10-01", endDate: "2026-10-01", dateFormat: "YYYY-MM-DD", kind: "point-in-time",
        completeness: "single-page", ruleVersion: "cathay/current-deposit-balance-v1",
        sourceAccountKey: "123456", accountNo: "123456",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: 1, terminal: true, metadata: { provider: "synthetic" } }],
      records: [{
        occurrenceKey,
        collisionKey: token("balance-collision"),
        providerKey: token("balance-provider"),
        contentHash: token("balance-content"),
        compact: { balance: { coefficient: "1001", scale: 1 }, effectiveAt, currency: "TWD" },
      }],
    },
    account: { sourceAccountKey: "123456", accountType: "depository", currency: "TWD" },
    observations: [{
      observationKey: token("ledger-observation"),
      balanceKind: "ledger",
      balance: { coefficient: "1001", scale: 1 },
      currency: "TWD",
      effectiveAt,
      effectiveTimeBasis: "provider-system-time",
      effectiveTimeRuleVersion: "cathay/current-deposit-balance-v1",
      evidenceSourceRecordKey: occurrenceKey,
      evidenceSourceField: "balance",
      evidenceSourceValue: "100.1",
      evidenceContractVersion: "cathay/current-deposit-balance-v1",
      sourceOccurrenceKey: occurrenceKey,
    }],
  };
}

const twdSavings: PreviewAccount = {
  sourceAccountKey: "savings",
  displayLabel: "Preview savings",
  currency: "TWD",
  type: "depository",
  balances: [
    { kind: "current", amount: "1000.00", currency: "TWD", observedAt: { at: "2026-10-03T02:00:00.000Z", source: "reported" } },
    { kind: "current", amount: "1234.50", currency: "TWD", observedAt: { at: "2026-10-05T02:00:00.000Z", source: "reported" } },
  ],
  transactions: [
    { sourceRowKey: "row-1", amount: "250", currency: "TWD", direction: "unknown",
      postedAt: { precision: "day", value: "2026-10-04" }, description: "preview row" },
    { sourceRowKey: "row-2", amount: "-40", currency: "TWD", direction: "outflow",
      postedAt: { precision: "minute", value: "2026-10-05T09:30" }, description: "preview fee" },
  ],
};

const usdSavings: PreviewAccount = {
  sourceAccountKey: "usd",
  displayLabel: "Preview USD",
  currency: "USD",
  type: "depository",
  balances: [{ kind: "current", amount: "10.00", currency: "USD", observedAt: { at: "2026-10-05T02:00:00.000Z", source: "collection-time" } }],
  transactions: [],
};

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
    const operational = createPgliteOperationalProvider(store);
    const canonical = createPGliteFinancialRegistry(store, operational.exchangeRates);
    await canonical["financial.source.commit"]([depositCommit()]);
    await canonical["financial.balance.capture"]([canonicalBalanceOf100Point1Twd()]);
    const preview = createPGlitePreviewFinancialData(store);
    await run({
      store,
      preview,
      registry: (visibility) => createPGliteFinancialRegistry(store, operational.exchangeRates, visibility),
      writePreview: async (...accounts) => {
        await preview.write({
          sourceId: "synthetic",
          institution: "bank-017",
          product: "deposit",
          collection: { collectedAt: "2026-10-05T03:00:00.000Z", accounts },
        });
      },
      addUsdRate: () => operational.exchangeRates.upsertExchangeRates([{
        rateDate: "2026-10-01", currency: "USD", twdPerUnit: 32, source: "check", fetchedAt: "2026-10-01T00:00:00.000Z",
      }]),
    });
  } finally {
    await store.close();
  }
}

const net = (overview: OverviewPageDto) => overview.summary.find((metric) => metric.label === "Net position")!.amounts;

test("visible preview balances count in overview and assets totals with exact decimals and a flag", async () => {
  await withLedger(async ({ registry, writePreview }) => {
    await writePreview(twdSavings);
    const shown = registry(() => VISIBLE);
    const overview = await shown["financial.overview.current"]([]);
    assert.deepEqual(net(overview).map((amount) => [amount.currency, amount.exact]), [
      ["TWD", { coefficient: "133460", scale: 2 }],
    ], "100.1 canonical plus 1234.50 preview, exactly");
    const preview = overview.accounts.find((account) => account.preview)!;
    assert.match(preview.id, /^preview:[0-9a-f]{32}$/u);
    assert.equal(preview.canonicalAccountId, undefined);
    assert.deepEqual(preview.preview!.transactions.map((row) => row.direction), ["outflow", "unknown"]);
    assert.deepEqual(overview.dailyHistory.map((row) => [row.date, row.includesPreview === true]), [
      ["2026-10-01", false],
      ["2026-10-03", true],
      ["2026-10-05", true],
    ]);
    assert.deepEqual(overview.dailyHistory.at(-1)!.assets.map((amount) => amount.exact), [{ coefficient: "13346", scale: 1 }]);

    const assets = await shown["financial.assets.current"]([]);
    assert.ok(assets.accounts.some((account) => account.id === preview.id));
    assert.deepEqual(assets.dailyHistoryByAccount[preview.id]!.map((row) => row.date), ["2026-10-03", "2026-10-05"]);
    assert.deepEqual(assets.transactionsByAccount[preview.id], undefined, "preview rows never become canonical transactions");

    const model = readOverview(overview, { today: TODAY });
    assert.equal(model.netWorth.value, 1334.6);
    assert.equal(model.netWorth.includesPreview, true);
    assert.equal(model.assetAllocation.includesPreview, true);
    assert.equal(model.series.at(-1)!.includesPreview, true);
    const summary = readAssetsSummary(assets, { today: TODAY });
    assert.ok(summary.state === "ready" && summary.includesPreview && summary.total === 1334.6);
  });
});

test("hidden preview data adds no account, history row, total, or flag", async () => {
  await withLedger(async ({ registry, writePreview }) => {
    await writePreview(twdSavings);
    const hidden = registry(() => HIDDEN);
    const overview = await hidden["financial.overview.current"]([]);
    assert.deepEqual(net(overview).map((amount) => amount.exact), [{ coefficient: "1001", scale: 1 }]);
    assert.equal(overview.accounts.some((account) => account.preview), false);
    assert.deepEqual(overview.dailyHistory.map((row) => row.date), ["2026-10-01"]);
    assert.equal(overview.dailyHistory.some((row) => row.includesPreview), false);
    const assets = await hidden["financial.assets.current"]([]);
    assert.equal(assets.accounts.some((account) => account.preview), false);
    assert.equal(Object.keys(assets.dailyHistoryByAccount).some((id) => id.startsWith("preview:")), false);
    const model = readOverview(overview, { today: TODAY });
    assert.equal(model.netWorth.includesPreview, false);
    assert.equal(model.assetAllocation.includesPreview, false);
  });
});

test("the Preview features setting decides visibility at each read", async () => {
  await withLedger(async ({ registry, writePreview }) => {
    await writePreview(twdSavings);
    let settings: Record<string, string> = { PREVIEW_FEATURES_ENABLED: "true" };
    const live = registry(() => currentPreviewVisibility(settings));
    assert.equal((await live["financial.overview.current"]([])).accounts.some((account) => account.preview), true);
    settings = { PREVIEW_FEATURES_ENABLED: "false" };
    const off = await live["financial.overview.current"]([]);
    assert.equal(off.accounts.some((account) => account.preview), false);
    assert.equal(off.dailyHistory.some((row) => row.includesPreview), false);
    assert.equal(readOverview(off, { today: TODAY }).netWorth.includesPreview, false);
    assert.equal((await live["financial.assets.current"]([])).accounts.some((account) => account.preview), false);
  });
});

test("a USD preview balance converts with a rate and is left out, listed, and unflagged without one", async () => {
  await withLedger(async ({ registry, writePreview, addUsdRate }) => {
    await writePreview(usdSavings);
    const shown = registry(() => VISIBLE);
    const rateless = readOverview(await shown["financial.overview.current"]([]), { today: TODAY });
    assert.equal(rateless.netWorth.value, 100.1, "verified net worth stays when preview data has no rate");
    assert.deepEqual(rateless.netWorth.unconvertedPreviewCurrencies, ["USD"]);
    assert.equal(rateless.netWorth.includesPreview, false);
    assert.equal(rateless.assetAllocation.total, 100.1);
    assert.deepEqual(rateless.assetAllocation.unconvertedCurrencies, ["USD"]);
    assert.equal(rateless.assetAllocation.includesPreview, false);
    assert.equal(rateless.series.some((point) => point.includesPreview), false);
    const ratelessAssets = readAssetsSummary(await shown["financial.assets.current"]([]), { today: TODAY });
    assert.ok(ratelessAssets.state === "ready" && !ratelessAssets.includesPreview);

    await addUsdRate();
    const rated = readOverview(await shown["financial.overview.current"]([]), { today: TODAY });
    assert.equal(rated.netWorth.value, 100.1 + 320);
    assert.equal(rated.netWorth.includesPreview, true);
    assert.equal(rated.assetAllocation.includesPreview, true);
    assert.deepEqual(rated.assetAllocation.unconvertedCurrencies, []);
    assert.equal(rated.series.at(-1)!.includesPreview, true);
  });
});

test("preview credit accounts list on Liabilities only, and an unknown used credit counts as no amount", async () => {
  await withLedger(async ({ registry, preview }) => {
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
    const shown = registry(() => ({ visible: [{ sourceId: "synthetic", product: "credit_card" }] }));
    const liabilities = await shown["financial.liabilities.current"]([]);
    const rows = liabilities.accounts.filter((account) => account.preview);
    assert.deepEqual(rows.map((account) => [account.label, account.valueAvailability]), [
      ["Known card", "available"],
      ["Unknown card", "unavailable"],
    ]);
    assert.equal(liabilities.dailyHistory.at(-1)!.liabilities[0]!.value, 300);
    assert.equal((await shown["financial.assets.current"]([])).accounts.some((account) => account.preview), false);
  });
});

test("preview transactions stay out of Spending reads", async () => {
  await withLedger(async ({ registry, writePreview }) => {
    const shown = registry(() => VISIBLE);
    const readSpending = async () => {
      const knowledgeAt = await shown["financial.spending.version"]([]);
      return {
        summary: await shown["financial.spending.current"]([]),
        records: await shown["financial.spending.recordPage"]([{ knowledgeAt, month: "2026-10" }]),
      };
    };
    const before = await readSpending();
    await writePreview(twdSavings, usdSavings);
    assert.deepEqual(await readSpending(), before);
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
    const views = createPGliteFinancialLiveViews(database, shown);
    const published: OverviewPageDto[] = [];
    const stop = await views.subscribe("financial.overview.current", {}, (rows) => published.push(rows[0] as OverviewPageDto));
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
