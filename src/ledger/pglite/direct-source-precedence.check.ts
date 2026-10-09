import assert from "node:assert/strict";
import test from "node:test";
import { createBaselinePGlite } from "./baseline-test-template.ts";
import { readPGliteDailyHistoryWithAccounts } from "./daily-history.ts";
import {
  commitCathay,
  commitTdccCathayFund,
  commitTdccSettlement,
  commitTdccYuantaBroker,
  commitYuantaTrade,
  observedAt,
  tdcc,
  token,
} from "./direct-source-precedence-fixture.ts";
import { commitPGliteCanonicalEInvoiceCapture } from "./einvoice.ts";
import { createPGliteCanonicalOverviewQuery, selectPGliteOverviewAssets } from "./overview.ts";
import { createPGliteSpendingQuery } from "./spending-query.ts";
import { fixtureInvoice } from "./spending-test-fixture.ts";
import { PGliteStore } from "./transaction.ts";
import { mapCanonicalProduct } from "../../lib/shared-ledger/server/canonical-product.ts";
import type { CanonicalOverviewProjection } from "../canonical/canonical-overview-query.ts";

async function withStore(run: (store: PGliteStore) => Promise<void>) {
  const database = await createBaselinePGlite();
  try {
    await run(new PGliteStore(database));
  } finally {
    await database.close();
  }
}

const knowledgePoint = async (store: PGliteStore) =>
  Number((await store.query<{ value: number }>("SELECT MAX(commit_sequence)::int AS value FROM canonical_commits")).rows[0]!.value);

const twd = (amounts: readonly Readonly<{ currency: string; exact?: Readonly<{ coefficient: string; scale: number }> }>[]) =>
  amounts.map(({ currency, exact }) => `${exact!.coefficient}e-${exact!.scale} ${currency}`);

/** The TWD sum of every counted account's amounts. */
function netWorth(projection: CanonicalOverviewProjection): string {
  let total = 0n;
  for (const account of projection.accounts)
    for (const amount of account.amounts) {
      assert.equal(`${amount.currency}/${amount.exact.scale}`, "TWD/0", "fixtures hold whole TWD");
      total += BigInt(amount.exact.coefficient);
    }
  return total.toString();
}

/** What the person sees summed at one knowledge point: net worth, its history, activity, holdings, and spending. */
async function seen(store: PGliteStore, knowledgeAt?: number) {
  const overview = createPGliteCanonicalOverviewQuery(store);
  const projection = knowledgeAt === undefined
    ? (await overview.current()).projection
    : (await overview.historical({ knowledgeAt })).projection;
  const history = await readPGliteDailyHistoryWithAccounts(store, projection.knowledgePoint, projection.accounts);
  // Only the current Spending query exposes its transaction-basis report.
  const spending = knowledgeAt === undefined ? (await createPGliteSpendingQuery(store).current()).spending : null;
  return {
    netWorth: netWorth(projection),
    history: twd(history.dailyHistory.at(-1)?.assets ?? []),
    historyPositions: history.dailyHistory.at(-1)?.positionCount ?? 0,
    activity: projection.transactions.map((transaction) => `${transaction.direction} ${transaction.amount.coefficient}`).sort(),
    positions: projection.positions.map((position) => position.symbol).sort(),
    spendingRows: spending?.transactions.length ?? null,
    spendingGap: spending === null ? null : twd(spending.reportEligibility.gapAmountByCurrency.map(({ currency, coefficient, scale }) => ({ currency, exact: { coefficient, scale } }))),
    covered: projection.coveredAccounts.map(({ integrationNamespace, stream, coveredBy }) => ({ account: `${integrationNamespace}/${stream}`, ...coveredBy })),
  };
}

const TDCC_CATHAY_COUNTED = {
  netWorth: "15200",
  history: ["15200e-0 TWD"],
  historyPositions: 0,
  activity: ["inflow 167000", "outflow 15000"],
  positions: [],
  spendingRows: 2,
  spendingGap: ["18200e-0 TWD"],
  covered: [],
};

test("a direct Cathay deposit account covers the TDCC Cathay settlement account in every total, which stays listed with its coveredBy", async () => {
  await withStore(async (store) => {
    await commitTdccSettlement(store, "013");
    await commitCathay(store);
    assert.deepEqual(await seen(store), {
      netWorth: "1000",
      history: ["1000e-0 TWD"],
      historyPositions: 0,
      activity: [],
      positions: [],
      spendingRows: 0,
      spendingGap: [],
      covered: [{ account: "tdcc/domestic-deposit", namespace: "cathay", institutionKey: "cathay", product: "deposit" }],
    });

    const projection = (await createPGliteCanonicalOverviewQuery(store).current()).projection;
    const [covered] = projection.coveredAccounts;
    assert.deepEqual(twd(covered!.amounts), ["15200e-0 TWD"], "the covered account keeps its own balance");
    assert.deepEqual(covered!.transactions.map((transaction) => transaction.amount.coefficient).sort(), ["15000", "167000"]);
    assert.deepEqual(projection.sourceGaps, []);

    const history = await readPGliteDailyHistoryWithAccounts(store, projection.knowledgePoint, projection.accounts);
    const assets = mapCanonicalProduct(selectPGliteOverviewAssets(projection), "assets", history);
    assert.deepEqual(assets.accounts.map((account) => [account.institutionKey, twd(account.amountLines)]), [["cathay", ["1000e-0 TWD"]]]);
    assert.deepEqual(assets.coveredAccounts.map((account) => [account.id, account.coveredBy, twd(account.amountLines)]), [
      [covered!.id, { namespace: "cathay", institutionKey: "cathay", product: "deposit" }, ["15200e-0 TWD"]],
    ]);
    assert.equal(assets.transactionsByAccount[covered!.id]?.length, 2, "the covered account's own view keeps its transactions");
    assert.equal(assets.dailyHistoryByAccount[covered!.id], undefined);
  });
});

test("a covered account still awaiting its balance leaves no gap in the totals", async () => {
  await withStore(async (store) => {
    await commitTdccSettlement(store, "013", false);
    const awaiting = (await createPGliteCanonicalOverviewQuery(store).current()).projection;
    assert.deepEqual([awaiting.availability, awaiting.sourceGaps.map((gap) => gap.reason)], ["awaiting", ["current-value-not-observed"]]);
    await commitCathay(store);
    const covered = (await createPGliteCanonicalOverviewQuery(store).current()).projection;
    assert.deepEqual([covered.availability, covered.sourceGaps], ["available", []]);
    assert.equal(covered.coveredAccounts[0]!.availability, "awaiting");
  });
});

test("a direct source with no account yet leaves TDCC counting", async () => {
  await withStore(async (store) => {
    await commitTdccSettlement(store, "013");
    assert.deepEqual(await seen(store), TDCC_CATHAY_COUNTED);
  });
});

test("before the direct account exists TDCC counts, and at every later knowledge point it is covered", async () => {
  await withStore(async (store) => {
    await commitTdccSettlement(store, "013");
    const beforeDirect = await knowledgePoint(store);
    await commitCathay(store);
    assert.deepEqual(await seen(store, beforeDirect), { ...TDCC_CATHAY_COUNTED, spendingRows: null, spendingGap: null });
    assert.equal((await seen(store, await knowledgePoint(store))).netWorth, "1000");
  });
});

test("a TDCC account at a bank with no direct source counts beside a direct account elsewhere", async () => {
  await withStore(async (store) => {
    await commitTdccSettlement(store, "812");
    await commitCathay(store);
    const view = await seen(store);
    assert.equal(view.netWorth, "16200");
    assert.deepEqual(view.history, ["16200e-0 TWD"]);
    assert.deepEqual(view.activity, TDCC_CATHAY_COUNTED.activity);
    assert.equal(view.spendingRows, 2);
    assert.deepEqual(view.covered, []);
  });
});

test("a Yuanta Trade account covers TDCC's Yuanta Securities broker holdings", async () => {
  await withStore(async (store) => {
    await commitTdccYuantaBroker(store);
    const tdccOnly = await seen(store);
    assert.equal(tdccOnly.netWorth, "500000");
    assert.deepEqual(tdccOnly.positions, ["tdcc:2330"]);

    await commitYuantaTrade(store);
    const view = await seen(store);
    assert.equal(view.netWorth, "7000");
    assert.deepEqual(view.history, ["7000e-0 TWD"]);
    assert.equal(view.historyPositions, 1);
    assert.deepEqual(view.positions, ["yuanta-trade:0050"]);
    assert.deepEqual(view.covered, [
      { account: "tdcc/investment", namespace: "yuanta-trade", institutionKey: "yuanta-securities", product: "securities" },
    ]);
    const projection = (await createPGliteCanonicalOverviewQuery(store).current()).projection;
    assert.deepEqual(projection.coveredAccounts[0]!.positions.map((position) => position.symbol), ["tdcc:2330"]);
    const assets = mapCanonicalProduct(selectPGliteOverviewAssets(projection), "assets");
    assert.deepEqual(assets.positionsByAccount[projection.coveredAccounts[0]!.id]?.map((position) => position.symbol), ["tdcc:2330"]);
  });
});

test("a direct deposit account does not cover a TDCC fund account sold by the same bank", async () => {
  await withStore(async (store) => {
    await commitCathay(store);
    await commitTdccCathayFund(store);
    const view = await seen(store);
    assert.equal(view.netWorth, "49230");
    assert.deepEqual(view.history, ["49230e-0 TWD"]);
    assert.deepEqual(view.positions, ["tdcc:F001"]);
    assert.deepEqual(view.covered, []);
  });
});

/**
 * TDCC deposits get no Kind today, so none reaches purchase-basis Spending or
 * pairing. Granting the outflow a purchase Kind, with constraint checks off
 * for the one row, shows that those readers would still leave a covered
 * account out if a Kind producer ever covered TDCC.
 */
async function grantPurchaseKind(store: PGliteStore): Promise<void> {
  await store.transaction(async (transaction) => {
    const [row] = (await transaction.query<{ transaction_id: Uint8Array }>(
      `SELECT current_row.transaction_id
         FROM current_transactions current_row
         JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
        WHERE revision.direction = 'outflow'`,
    )).rows;
    await transaction.query("SET LOCAL session_replication_role = replica");
    await transaction.query(
      `INSERT INTO current_transaction_enrichment(
         transaction_id, field_name, assertion_id, value_text, origin, producer_id, producer_version,
         route_id, taxonomy_id, taxonomy_version, taxonomy_dimension, taxonomy_code, projection_commit_id
       ) VALUES ($1, 'kind', $1, 'purchase', 'derived', 'test', 'v1', 'test', 'test', 'v1', 'kind', 'purchase', $1)`,
      [row!.transaction_id],
    );
    await transaction.query("SET LOCAL session_replication_role = origin");
    await transaction.query("SELECT refresh_current_spending_pairing_entry($1)", [row!.transaction_id]);
  });
}

async function purchaseSpending(store: PGliteStore) {
  const spending = createPGliteSpendingQuery(store);
  const summary = await spending.summary();
  const knowledgeAt = summary.knowledgeAt;
  return {
    totals: summary.purchaseReport.totalsByCurrency.map(({ currency, coefficient, scale, count }) => `${count} × ${coefficient}e-${scale} ${currency}`),
    pendingPairs: (await spending.pendingOverview({ knowledgeAt })).pendingCount,
  };
}

test("purchase-basis Spending and pairing leave out a covered account's purchase", async () => {
  await withStore(async (store) => {
    await commitTdccSettlement(store, "013");
    await grantPurchaseKind(store);
    await commitPGliteCanonicalEInvoiceCapture(store, {
      captureId: "invoice-capture",
      sourceConnectionKey: token("einvoice-connection"),
      identityEpoch: token("einvoice-epoch"),
      subjectDigest: token("einvoice-subject"),
      observedAt: "2026-08-03T00:00:00Z",
      scope: {
        startDate: "2026-08-01", endDate: "2026-08-31", kind: "bounded-range", completeness: "complete-range",
        invoiceCompleteness: "complete", itemCompleteness: "complete", absenceAuthority: "comparable-complete-range",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: 1, terminal: true, metadata: { fixture: "direct-source-precedence" } }],
      invoices: [fixtureInvoice({ stableKey: "AB12345678", date: "2026-08-02", items: [{ sequence: 1, name: "便當", amount: "1500" }] })],
    });
    assert.deepEqual(await purchaseSpending(store), {
      totals: ["2 × 3000e-0 TWD"],
      pendingPairs: 1,
    }, "an uncovered TDCC purchase counts and can pair with the invoice");

    await commitCathay(store);
    assert.deepEqual(await purchaseSpending(store), {
      totals: ["1 × 1500e-0 TWD"],
      pendingPairs: 0,
    });
  });
});
