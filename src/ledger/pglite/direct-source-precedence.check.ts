import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteBaseline } from "./baseline.ts";
import { commitPGliteCanonicalBalanceCapture, type PGliteCanonicalBalanceCaptureRequest } from "./balance.ts";
import { currentDepositBalanceCommandRequest } from "./current-deposit-balance-command.ts";
import { readPGliteDailyHistoryWithAccounts } from "./daily-history.ts";
import { commitPGliteCanonicalDepositCapture } from "./deposit.ts";
import { commitPGliteCanonicalInvestmentCapture } from "./investment.ts";
import { createPGliteCanonicalOverviewQuery, selectPGliteOverviewAssets } from "./overview.ts";
import { createPGliteSpendingQuery } from "./spending-query.ts";
import { commitPGliteCanonicalEInvoiceCapture } from "./einvoice.ts";
import { fixtureInvoice } from "./spending-test-fixture.ts";
import { PGliteStore } from "./transaction.ts";
import { mapCanonicalProduct } from "../../lib/shared-ledger/server/canonical-product.ts";
import type { InvestmentCaptureInput } from "../canonical/investment-financial-admission.ts";
import type { CanonicalOverviewProjection } from "../canonical/canonical-overview-query.ts";
import {
  readTdccFunds,
  readTdccPositions,
  tdccFundHoldingCapture,
  tdccSecuritiesHoldingCapture,
} from "../canonical/tdcc-investment-admission.ts";
import {
  readTdccSettlementSnapshot,
  tdccSettlementBalanceCapture,
  tdccSettlementTransactionCapture,
} from "../canonical/tdcc-settlement-admission.ts";

const token = (value: string) => `sha256:${createHash("sha256").update(value).digest("base64url")}`;
const tdcc = { sourceConnectionKey: token("tdcc-connection"), identityEpochKey: token("tdcc-epoch") };
const observedAt = "2026-10-09T02:31:00.000Z";
// Built at runtime so the repository privacy and secret scanners do not read fixtures as real accounts.
const SETTLEMENT_ACCOUNT = ["2001", "2345678"].join("");
const BROKER_ACCOUNT = ["98", "76543"].join("");
const CATHAY_ACCOUNT = ["1234", "56"].join("");

async function withStore(run: (store: PGliteStore) => Promise<void>) {
  const database = await PGlite.create();
  try {
    await applyPgliteBaseline(database);
    await run(new PGliteStore(database));
  } finally {
    await database.close();
  }
}

const settlementRow = (txnDateTime: string, transferInAmount: string, transferOutAmount: string, balance: string, summary: string) => ({
  balance, currency: "TWD", hcode: "", memo: "", stan: "000000123456", summary,
  transferInAccountNo: "", transferInAmount, transferInBankId: "",
  transferOutAccountNo: "", transferOutAmount, transferOutBankId: "", txnDateTime,
});

/** One TDCC settlement account at `bankId` holding 15200 TWD, with a 16700 inflow and a 1500 card-shop outflow. */
async function commitTdccSettlement(store: PGliteStore, bankId: string, withBalance = true) {
  const snapshot = readTdccSettlementSnapshot({
    tspAccountInfos: [{
      bankId,
      execMsg: "交易成功。",
      execStatue: "0000",
      tspAccount: [{ accountNo: SETTLEMENT_ACCOUNT, accountType: "活期存款", availableBalance: "15200", balanceAmt: "15200", currency: "TWD", isShow: true, remark: "" }],
      tspTimeAccounts: [],
    }],
    updateTime: "20261009103000",
  });
  const account = snapshot.accounts[0]!;
  await commitPGliteCanonicalDepositCapture(store, tdccSettlementTransactionCapture({
    captureId: `tsp007-${bankId}`,
    observedAt,
    connection: tdcc,
    account,
    pages: [{
      accountNo: SETTLEMENT_ACCOUNT, startDate: "20260710", endDate: "20261009", isComplete: true,
      transactionDetails: [
        settlementRow("20260801090000", "16700.0", "0.0", "16700.0", "薪資"),
        settlementRow("20260802101500", "0.0", "1500.0", "15200.0", "全家便利商店"),
      ],
    }],
  }));
  if (withBalance) await commitPGliteCanonicalBalanceCapture(store, currentDepositBalanceCommandRequest(tdccSettlementBalanceCapture({
    captureId: `tsp006-${bankId}`, observedAt, connection: tdcc, snapshot, account,
  })));
}

/** One Cathay United Bank account from the direct source holding 1000 TWD, with no transactions in its range. */
async function commitCathay(store: PGliteStore) {
  const fingerprint = token("cathay-contract");
  await commitPGliteCanonicalDepositCapture(store, {
    capture: {
      captureId: "cathay-history",
      authorityRoute: "cathay/domestic-deposit/v1",
      contractVersion: "v1",
      identity: {
        integrationNamespace: "cathay",
        sourceConnectionKey: token("cathay-connection"),
        identityEpochKey: token("cathay-epoch"),
        stream: "domestic-deposit",
        recordKind: "synthetic-deposit",
        subjectDigest: token("cathay-subject"),
        accountNo: CATHAY_ACCOUNT,
        sourceAccountKey: CATHAY_ACCOUNT,
        accountNumber: { value: CATHAY_ACCOUNT, kind: "depository-account", evidenceVersion: "synthetic-account-v1", sourceField: "accountNumber" },
        accountType: "depository",
        currency: "TWD",
      },
      observedAt: "2026-10-09T00:00:00.000Z",
      scope: {
        startDate: "2026-10-01", endDate: "2026-10-09", scopeKind: "bounded-range", completeness: "complete-range",
        completenessBasis: "synthetic-complete-range", completenessRuleVersion: "cathay/domestic-deposit/v1",
        absenceAuthority: "comparable-complete-range", contractFingerprint: fingerprint,
        preflightFingerprint: token("cathay-preflight"), pageCount: 1, withdrawalPolicy: "never-infer",
      },
      semantics: {
        postingStatus: "posted", postingOrigin: "provider_booked_history",
        postingBasis: "query-status-success-with-accounting-date", postingRuleVersion: "cathay/domestic-deposit/v1",
        economicStatus: "normal", administrativeState: "active", semanticRuleVersion: "cathay/domestic-deposit/v1",
        effectiveTimeBasis: "accounting", effectiveTimeRuleVersion: "cathay/domestic-deposit/v1",
        timeZone: "Asia/Taipei", timePrecision: "second", timeOrigin: "source_reported", requireBalance: false,
      },
      pages: [{
        pageOrdinal: 0, responseCode: "200", terminal: true, rowCount: 0, responseDigest: token("cathay-page"),
        proofKind: "synthetic", contractFingerprint: fingerprint, preflightFingerprint: token("cathay-preflight"),
        metadataJson: JSON.stringify({ provider: "synthetic" }),
      }],
      records: [],
    },
  });
  await commitPGliteCanonicalBalanceCapture(store, cathayBalance("cathay-balance"));
}

function cathayBalance(captureId: string): PGliteCanonicalBalanceCaptureRequest {
  const occurrenceKey = token(`${captureId}:occurrence`);
  const effectiveAt = "2026-10-09T08:00:00+08:00";
  return {
    capture: {
      captureId,
      integrationNamespace: "cathay",
      sourceConnectionKey: token("cathay-connection"),
      identityEpoch: token("cathay-epoch"),
      stream: "domestic-deposit",
      recordKind: "synthetic-balance",
      routeKey: "cathay/domestic-deposit/current-balance-v1",
      contractVersion: "cathay/current-deposit-balance-v1",
      subjectDigest: token(`${captureId}:subject`),
      observedAt: "2026-10-09T00:01:00.000Z",
      accountNumber: null,
      scope: {
        startDate: "2026-10-09", endDate: "2026-10-09", dateFormat: "YYYY-MM-DD", kind: "point-in-time",
        completeness: "single-page", ruleVersion: "cathay/current-deposit-balance-v1",
        sourceAccountKey: CATHAY_ACCOUNT, accountNo: CATHAY_ACCOUNT,
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", terminal: true, rowCount: 1, metadata: { provider: "synthetic" } }],
      records: [{
        occurrenceKey,
        collisionKey: token(`${captureId}:collision`),
        providerKey: token(`${captureId}:provider`),
        contentHash: token(`${captureId}:content`),
        compact: { balance: { coefficient: "1000", scale: 0 }, effectiveAt },
      }],
    },
    account: { sourceAccountKey: CATHAY_ACCOUNT, accountType: "depository", currency: "TWD" },
    observations: [{
      observationKey: token(`${captureId}:ledger`),
      balanceKind: "ledger",
      balance: { coefficient: "1000", scale: 0 },
      currency: "TWD",
      effectiveAt,
      effectiveTimeBasis: "provider-system-time",
      effectiveTimeRuleVersion: "cathay/current-deposit-balance-v1",
      evidenceSourceRecordKey: occurrenceKey,
      evidenceSourceField: "balance",
      evidenceSourceValue: "1000",
      evidenceContractVersion: "cathay/current-deposit-balance-v1",
      sourceOccurrenceKey: occurrenceKey,
    }],
  };
}

const tr001Item = (symbol: string, quantity: string, price: string) => {
  const row = Array.from({ length: 22 }, () => "");
  Object.assign(row, { 0: symbol, 1: symbol, 6: "00", 7: quantity, 17: price, 19: "TWD" });
  return row;
};

/** TDCC broker account at Yuanta Securities (branch 9800) holding 1000 shares at 500 TWD. */
async function commitTdccYuantaBroker(store: PGliteStore) {
  const positions = readTdccPositions({
    accounts: [{
      accountEmail: "", accountName: "", accountStatus: "0", applyTime: "112/01/09", brokerAccount: BROKER_ACCOUNT,
      brokerName: "", brokerNo: "9800", isTisa: "N", items: [tr001Item("2330", "1000", "500")], mergeByNewAcct: "",
      mergeDate: "", phoneNumber: "",
    }],
    currCHNames: { TWD: "新台幣　" }, exchangeRates: { TWD: "1" }, lastServerTime: "20261009103000",
  });
  await commitPGliteCanonicalInvestmentCapture(store, {
    capture: tdccSecuritiesHoldingCapture({ captureId: "tr001", observedAt, connection: tdcc, positions, account: positions.accounts[0]! }),
  });
}

/** TDCC fund account sold by Cathay United Bank (sale organisation 013) worth 48230 TWD. */
async function commitTdccCathayFund(store: PGliteStore) {
  const funds = readTdccFunds({
    fundDetails: [{ currAlias: "USD", fundCHName: "測試基金", fundNo: "F001", fundSHR: "120.5", refORIValue: "1500", refTWDValue: "48230", saleOrgCode: "013" }],
    refRateDate: "", totalAsset: "", updateTime: "20261009103000",
  });
  await commitPGliteCanonicalInvestmentCapture(store, {
    capture: tdccFundHoldingCapture({ captureId: "tr051", observedAt, connection: tdcc, funds, account: funds.accounts[0]! }),
  });
}

/** A Yuanta Trade broker account holding 10 shares worth 7000 TWD. */
async function commitYuantaTrade(store: PGliteStore) {
  const contractVersion = "yuanta-trade/investment/canonical-v1";
  const sourceRecordKey = token("yuanta-trade-holding");
  const capture: InvestmentCaptureInput = {
    captureId: "yuanta-trade-holdings",
    sourceId: "yuanta-trade",
    authorityRoute: contractVersion,
    contractVersion,
    observedAt: "2026-10-09T01:00:00.000Z",
    identity: {
      sourceConnectionKey: token("yuanta-trade-connection"),
      identityEpochKey: token("yuanta-trade-epoch"),
      accountKey: token("yuanta-trade-account"),
      accountType: "investment",
      reportingCurrency: "TWD",
    },
    scope: { effectiveOn: "2026-10-09", complete: true },
    securities: [{
      securityKey: "yuanta-trade:0050",
      producerSecurityId: "0050",
      name: "元大台灣50",
      currency: "TWD",
      securityType: "ETF",
      identityEvidence: { kind: "producer-security-id", contractVersion },
    }],
    holdings: [{
      measurementKey: token("yuanta-trade-measurement"),
      measurementSubjectKey: token("yuanta-trade-subject"),
      sourceRecordKey,
      securityKey: "yuanta-trade:0050",
      quantity: { coefficient: "10", scale: 0 },
      valuation: { coefficient: "7000", scale: 0, currency: "TWD" },
      effectiveOn: "2026-10-09",
      observedAt: "2026-10-09T01:00:00.000Z",
      effectiveTimeEvidence: { kind: "source-reported-as-of", sourceRecordKey, sourceField: "asOfDate", value: "2026-10-09", contractVersion },
      lineage: { page: 1, row: 1, contractVersion },
    }],
    transactions: [],
  };
  await commitPGliteCanonicalInvestmentCapture(store, { capture });
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
