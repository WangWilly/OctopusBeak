import assert from "node:assert/strict";
import test from "node:test";
import type { DailyHistoryRowDto } from "../../lib/shared-ledger/types.ts";
import type { PGliteDailyHistory } from "./daily-history.ts";
import {
  applyPglitePreviewFinancialDataSchema,
  createPGlitePreviewFinancialData,
  type PreviewCreditAccountView,
  type PreviewLoanAccountView,
} from "./preview-financial-data.ts";
import { PGliteStore } from "./transaction.ts";
import { previewRowValue, totalIncomplete } from "../../lib/shared-ledger/preview-account.ts";
import { createTestPGlite } from "./baseline-test-template.ts";
import { countableWithRates, previewSummaryMarkers, withBalanceSeriesHistory } from "./outside-counting.ts";
import { readOutsideFinancialData } from "./outside-financial-data.ts";
import { previewAccountRow, previewBalanceSeries } from "./outside-preview-deposit.ts";
import { previewCreditAccountRow, previewCreditSeries } from "./outside-preview-credit.ts";
import { previewLoanAccountRow, previewLoanSeries } from "./outside-preview-loan.ts";
import { exactFromDecimal, type BalanceSeries } from "./outside-row.ts";

const twd = (coefficient: string, scale = 0) => ({
  currency: "TWD",
  value: Number(coefficient) / 10 ** scale,
  exact: { coefficient, scale },
});

function canonicalRow(date: string, assets: string, liabilities: string, label: string): DailyHistoryRowDto {
  return {
    date,
    netAssets: [twd(String(Number(assets) - Number(liabilities)))],
    dailyChange: [],
    assets: [twd(assets)],
    liabilities: [twd(liabilities)],
    accountChanges: [label],
    positionCount: 2,
  };
}

const canonical: PGliteDailyHistory = {
  dailyHistory: [
    canonicalRow("2026-10-01", "1000", "200", "Cathay"),
    canonicalRow("2026-10-05", "1500", "200", "Cathay"),
  ],
  dailyHistoryByAccount: { cathay: [canonicalRow("2026-10-01", "1000", "0", "Cathay")] },
};

const savings: BalanceSeries = {
  accountId: "preview:a",
  label: "Preview savings",
  side: "asset",
  marker: "preview",
  closedOn: null,
  points: [
    { date: "2026-10-03", currency: "TWD", exact: { coefficient: "12345", scale: 1 } },
    { date: "2026-10-05", currency: "TWD", exact: { coefficient: "500", scale: 0 } },
  ],
};

const always = () => true;

test("without preview accounts the canonical history is returned unchanged", () => {
  assert.equal(withBalanceSeriesHistory(canonical, [], always), canonical);
});

test("preview dates join the canonical dates and carry the newest canonical total forward", () => {
  const merged = withBalanceSeriesHistory(canonical, [savings], always);
  assert.deepEqual(merged.dailyHistory.map((row) => row.date), ["2026-10-01", "2026-10-03", "2026-10-05"]);
  const [first, carried, both] = merged.dailyHistory;
  assert.deepEqual(first!.assets, [twd("1000")]);
  assert.equal(first!.includesPreview, undefined);
  assert.deepEqual(carried!.assets, [twd("22345", 1)], "1000 carried from 10-01 plus 1234.5");
  assert.deepEqual(carried!.netAssets, [twd("20345", 1)]);
  assert.deepEqual(carried!.liabilities, [twd("200")]);
  assert.equal(carried!.positionCount, 2);
  assert.deepEqual(carried!.accountChanges, ["Preview savings"]);
  assert.equal(carried!.includesPreview, true);
  assert.deepEqual(both!.assets, [twd("2000")]);
  assert.deepEqual(both!.accountChanges, ["Cathay", "Preview savings"]);
});

test("daily change is the difference from the previous merged row, exactly", () => {
  const merged = withBalanceSeriesHistory(canonical, [savings], always);
  assert.deepEqual(merged.dailyHistory.map((row) => row.dailyChange), [
    [],
    [twd("12345", 1)],
    [twd("-2345", 1)],
  ]);
});

test("a preview balance before any canonical row stands alone", () => {
  const merged = withBalanceSeriesHistory({ dailyHistory: [], dailyHistoryByAccount: {} }, [savings], always);
  assert.deepEqual(merged.dailyHistory[0]!.assets, [twd("12345", 1)]);
  assert.deepEqual(merged.dailyHistory[0]!.liabilities, []);
  assert.equal(merged.dailyHistory[0]!.positionCount, 0);
});

test("a preview balance without a rate is left out instead of dropping the date", () => {
  const usd: BalanceSeries = {
    accountId: "preview:u",
    label: "Preview USD",
    side: "asset",
    marker: "preview",
    closedOn: null,
    points: [{ date: "2026-10-03", currency: "USD", exact: { coefficient: "100", scale: 0 } }],
  };
  const merged = withBalanceSeriesHistory(canonical, [usd], countableWithRates([
    { rateDate: "2026-10-04", currency: "USD", twdPerUnit: 32, source: "test", fetchedAt: "2026-10-04T00:00:00Z" },
  ]));
  const byDate = new Map(merged.dailyHistory.map((row) => [row.date, row]));
  assert.deepEqual(byDate.get("2026-10-03")!.assets, [twd("1000")]);
  assert.equal(byDate.get("2026-10-03")!.includesPreview, undefined);
  assert.deepEqual(byDate.get("2026-10-05")!.assets.map((line) => line.currency), ["TWD", "USD"]);
  assert.equal(byDate.get("2026-10-05")!.includesPreview, true);
});

test("each preview account gets its own rows on its observation dates", () => {
  const merged = withBalanceSeriesHistory(canonical, [savings], always);
  assert.deepEqual(merged.dailyHistoryByAccount.cathay, canonical.dailyHistoryByAccount.cathay);
  assert.deepEqual(merged.dailyHistoryByAccount["preview:a"]!.map((row) => [row.date, row.netAssets, row.includesPreview]), [
    ["2026-10-03", [twd("12345", 1)], true],
    ["2026-10-05", [twd("500")], true],
  ]);
});

test("the series prefers current balances and keeps each date's newest observation", () => {
  const [series] = previewBalanceSeries([{
    previewAccountId: "a",
    displayLabel: "Preview savings",
    closedAt: null,
    observations: [
      { kind: "available", amount: "9", currency: "TWD", observedAt: { at: "2026-10-03T09:00:00Z", source: "reported" } },
      { kind: "current", amount: "1", currency: "TWD", observedAt: { at: "2026-10-03T01:00:00Z", source: "reported" } },
      { kind: "current", amount: "2", currency: "TWD", observedAt: { at: "2026-10-03T05:00:00Z", source: "reported" } },
    ],
  }]);
  assert.deepEqual(series!.points, [{ date: "2026-10-03", currency: "TWD", exact: { coefficient: "2", scale: 0 } }]);
  assert.deepEqual([series!.side, series!.closedOn], ["asset", null]);
});

test("a preview account row keeps the source amount exact and is namespaced away from canonical ids", () => {
  assert.deepEqual(exactFromDecimal("-0.50"), { coefficient: "-50", scale: 2 });
  const row = previewAccountRow({
    previewAccountId: "abc",
    sourceId: "synthetic",
    institution: "bank-017",
    product: "deposit",
    displayLabel: "Preview USD",
    currency: "USD",
    type: "depository",
    lastCollectedAt: "2026-10-15T01:00:00Z",
    latestBalance: { kind: "current", amount: "1234.50", currency: "USD", observedAt: { at: "2026-10-14T23:00:00Z", source: "collection-time" } },
    timeDeposit: null,
  }, []);
  assert.equal(row.id, "preview:abc");
  assert.equal(row.canonicalAccountId, undefined);
  assert.deepEqual([row.group, row.kind], ["asset", "foreign"]);
  assert.deepEqual(row.amountLines, [{ currency: "USD", value: 1234.5, exact: { coefficient: "123450", scale: 2 } }]);
  assert.equal(row.lastUpdated, "2026-10-14");
  assert.deepEqual(row.preview?.balanceTime, { at: "2026-10-14T23:00:00Z", source: "collection-time" });
});


const creditView = (latestBalance: PreviewCreditAccountView["latestBalance"]): PreviewCreditAccountView => ({
  previewAccountId: "c",
  sourceId: "cathay",
  institution: "cathay",
  product: "credit_card",
  displayLabel: "Cathay cards",
  currency: "TWD",
  creditLimit: "100000",
  cards: [{ sourceCardKey: "k", cardMask: "1234", displayLabel: null }],
  lastCollectedAt: "2026-10-15T01:00:00Z",
  latestBalance,
});

test("a preview credit account is a liability whose unknown balance makes the liability and net totals incomplete", () => {
  const known = previewCreditAccountRow(creditView({
    amount: "-250.5", currency: "TWD", observedAt: { at: "2026-10-14T23:00:00Z", source: "reported" },
    basis: { kind: "provider-used-credit", usedCredit: "-250.5" },
  }), [], []);
  assert.deepEqual([known.group, known.kind, known.valueAvailability], ["liability", "credit-card", "available"]);
  assert.deepEqual(known.amountLines, [{ currency: "TWD", value: -250.5, exact: { coefficient: "-2505", scale: 1 } }], "an overpaid card stays negative");
  assert.deepEqual(known.preview?.credit?.usedCredit?.basis, { kind: "provider-used-credit", usedCredit: "-250.5" });

  const unknown = previewCreditAccountRow(creditView(null), [], []);
  assert.deepEqual(unknown.amountLines, [], "an unknown used credit is never a zero line");
  assert.equal(unknown.valueAvailability, "unavailable");
  assert.equal(unknown.preview?.credit?.usedCredit, null);

  const savingsRow = previewAccountRow({
    previewAccountId: "s", sourceId: "synthetic", institution: "bank-017", product: "deposit", displayLabel: "Savings",
    currency: "TWD", type: "depository", lastCollectedAt: "2026-10-15T01:00:00Z", timeDeposit: null,
    latestBalance: { kind: "current", amount: "10", currency: "TWD", observedAt: { at: "2026-10-14T23:00:00Z", source: "reported" } },
  }, []);
  assert.deepEqual(previewSummaryMarkers([savingsRow, known]), {
    assets: { includesPreview: true },
    liabilities: { includesPreview: true },
    net: { includesPreview: true },
  });
  assert.deepEqual(previewSummaryMarkers([savingsRow, unknown]), {
    assets: { includesPreview: true },
    liabilities: { incomplete: true },
    net: { includesPreview: true, incomplete: true },
  }, "a total that would include the unknown balance is incomplete rather than zero");
  assert.deepEqual(previewSummaryMarkers([]), { assets: {}, liabilities: {}, net: {} });
});

test("a closed time deposit shows as closed with no amount and leaves the history from its closure date on", () => {
  const closed = previewAccountRow({
    previewAccountId: "t", sourceId: "synthetic", institution: "bank-017", product: "time_deposit", displayLabel: "Term",
    currency: "TWD", type: "depository", lastCollectedAt: "2026-10-05T01:00:00Z",
    latestBalance: { kind: "current", amount: "500", currency: "TWD", observedAt: { at: "2026-10-03T01:00:00Z", source: "reported" } },
    timeDeposit: { principal: "500", interestRate: null, maturityDate: null, closedAt: "2026-10-05T01:00:00Z" },
  }, []);
  assert.deepEqual(closed.amountLines, []);
  assert.equal(closed.product, "Time deposit");
  assert.equal(closed.preview?.timeDeposit?.closedAt, "2026-10-05T01:00:00Z");

  const [series] = previewBalanceSeries([{
    previewAccountId: "t", displayLabel: "Term", closedAt: "2026-10-05T01:00:00Z",
    observations: [{ kind: "current", amount: "500", currency: "TWD", observedAt: { at: "2026-10-03T01:00:00Z", source: "reported" } }],
  }]);
  assert.equal(series!.closedOn, "2026-10-05");
  const merged = withBalanceSeriesHistory(canonical, [series!], always);
  const byDate = new Map(merged.dailyHistory.map((row) => [row.date, row]));
  assert.deepEqual(byDate.get("2026-10-03")!.assets, [twd("1500")], "counted while open");
  assert.deepEqual(byDate.get("2026-10-05")!.assets, [twd("1500")], "gone from the closure date on, canonical 1500 remains");
  assert.equal(byDate.get("2026-10-05")!.includesPreview, undefined);
});

test("a preview credit series adds to liabilities and subtracts from net assets", () => {
  const [series] = previewCreditSeries([{
    previewAccountId: "c", displayLabel: "Cards",
    observations: [{
      amount: "300", currency: "TWD", observedAt: { at: "2026-10-03T01:00:00Z", source: "reported" },
      basis: { kind: "provider-used-credit", usedCredit: "300" },
    }],
  }]);
  assert.equal(series!.side, "liability");
  const merged = withBalanceSeriesHistory(canonical, [series!], always);
  const byDate = new Map(merged.dailyHistory.map((row) => [row.date, row]));
  assert.deepEqual(byDate.get("2026-10-03")!.liabilities, [twd("500")], "canonical 200 plus preview 300");
  assert.deepEqual(byDate.get("2026-10-03")!.netAssets, [twd("500")], "canonical 800 minus 300");
  assert.deepEqual(byDate.get("2026-10-03")!.assets, [twd("1000")]);
  assert.deepEqual(byDate.get("2026-10-05")!.netAssets, [twd("1000")], "carried forward: 1300 minus 300");
  assert.deepEqual(merged.dailyHistoryByAccount["preview:c"]![0]!.netAssets, [twd("-300")]);
});

const loanView = (closedAt: string | null): PreviewLoanAccountView => ({
  previewAccountId: "l", sourceId: "synthetic", institution: "bank-017", product: "loan", displayLabel: "Home loan ****5678",
  currency: "TWD", lastCollectedAt: "2026-10-05T01:00:00Z",
  latestBalance: { amount: "6000000.50", currency: "TWD", observedAt: { at: "2026-10-03T01:00:00Z", source: "reported" } },
  loan: {
    category: "housing", originalAmount: "8000000", interestRate: "2.185", paymentAmount: null, nextPaymentDate: null,
    installmentsPaid: null, installmentsTotal: null, openedOn: null, maturityDate: null, closedAt,
  },
});

test("a preview loan is a liability that counts its amount owed toward the liability and net totals", () => {
  const row = previewLoanAccountRow(loanView(null));
  assert.deepEqual([row.group, row.kind, row.product, row.valueAvailability], ["liability", "loan", "Loan", "available"]);
  assert.deepEqual(row.amountLines, [twd("600000050", 2)]);
  assert.equal(row.preview?.loan?.originalAmount, "8000000");
  assert.deepEqual(previewSummaryMarkers([row]), {
    assets: {}, liabilities: { includesPreview: true }, net: { includesPreview: true },
  });
});

test("a closed preview loan owes nothing, shows as closed, and leaves no total incomplete", () => {
  const row = previewLoanAccountRow(loanView("2026-10-05T01:00:00Z"));
  assert.deepEqual(row.amountLines, []);
  assert.deepEqual(previewRowValue(row), { kind: "closed", closedOn: "2026-10-05" });
  assert.equal(totalIncomplete([row]), false);
  assert.deepEqual(previewSummaryMarkers([row]), { assets: {}, liabilities: {}, net: {} });

  const [series] = previewLoanSeries([{
    previewAccountId: "l", displayLabel: "Home loan", closedAt: "2026-10-05T01:00:00Z",
    observations: [{ amount: "300", currency: "TWD", observedAt: { at: "2026-10-03T01:00:00Z", source: "reported" } }],
  }]);
  assert.equal(series!.side, "liability");
  const byDate = new Map(withBalanceSeriesHistory(canonical, [series!], always).dailyHistory.map((entry) => [entry.date, entry]));
  assert.deepEqual(byDate.get("2026-10-03")!.liabilities, [twd("500")], "canonical 200 plus the loan's 300 while open");
  assert.deepEqual(byDate.get("2026-10-05")!.liabilities, [twd("200")], "gone from the closure date on");
});

test("rows read for many preview accounts at once land on their own account, newest first", async () => {
  const store = new PGliteStore(await createTestPGlite("ledger+operational"));
  try {
    await applyPglitePreviewFinancialDataSchema(store);
    const preview = createPGlitePreviewFinancialData(store);
    const observedAt = { at: "2026-10-15T01:00:00.000Z", source: "collection-time" } as const;
    const deposit = (key: string, rows: readonly [string, string][]) => ({
      sourceAccountKey: key, displayLabel: key, currency: "TWD", type: "depository" as const,
      balances: [{ kind: "current" as const, amount: "100", currency: "TWD", observedAt }],
      transactions: rows.map(([sourceRowKey, day]) => ({
        sourceRowKey, amount: "-1", currency: "TWD", direction: "outflow" as const,
        postedAt: { precision: "day" as const, value: day }, description: null,
      })),
    });
    await preview.write({
      sourceId: "deposits", institution: "bank-017", product: "deposit",
      collection: { collectedAt: observedAt.at, accounts: [
        deposit("first", [["first-old", "2026-10-01"], ["first-new", "2026-10-03"]]),
        deposit("second", [["second-mid", "2026-10-02"]]),
        deposit("quiet", []),
      ] },
    });
    const card = (key: string, purchaseDays: readonly [string, string][], statementKeys: readonly string[]) => ({
      sourceAccountKey: key, displayLabel: key, currency: "TWD", creditLimit: "100000", cards: [],
      balances: [{ amount: "10", currency: "TWD", observedAt, basis: { kind: "provider-used-credit" as const, usedCredit: "10" } }],
      purchases: purchaseDays.map(([sourceRowKey, day]) => ({
        sourceRowKey, amount: "10", currency: "TWD", direction: "outflow" as const,
        posting: { status: "posted" as const, billing: "unbilled" as const, postingDate: day },
        consumedAt: { precision: "day" as const, value: day }, sourceCardKey: null, statementKey: null,
        bankReference: null, description: null,
      })),
      statements: statementKeys.map((statementKey) => ({
        statementKey, cycleStart: null, cycleEnd: null, closingDate: `${statementKey}-15`, dueDate: `${statementKey}-28`,
        amount: "10", currency: "TWD", minimumPayment: null, billingPeriod: statementKey,
        paidAmount: null, paid: null, noPaymentNeeded: null,
      })),
    });
    await preview.write({
      sourceId: "cards", institution: "bank-017", product: "credit_card",
      collection: { collectedAt: observedAt.at, accounts: [
        card("travel", [["travel-old", "2026-10-01"], ["travel-new", "2026-10-04"]], ["2026-08", "2026-09"]),
        card("daily", [["daily-mid", "2026-10-02"]], ["2026-09"]),
      ] },
    });

    const { accounts } = await readOutsideFinancialData(store, {
      previewVisibility: { visible: [{ sourceId: "deposits", product: "deposit" }, { sourceId: "cards", product: "credit_card" }] },
      manualAssets: false,
      today: "2026-10-15",
    });
    const byLabel = new Map(accounts.map((account) => [account.label, account.preview!]));
    assert.deepEqual(byLabel.get("first")!.transactions.map((row) => row.postedAt.value), ["2026-10-03", "2026-10-01"]);
    assert.deepEqual(byLabel.get("second")!.transactions.map((row) => row.postedAt.value), ["2026-10-02"]);
    assert.deepEqual(byLabel.get("quiet")!.transactions, []);
    assert.deepEqual(byLabel.get("travel")!.credit!.purchases.map((row) => row.sourceRowKey), ["travel-new", "travel-old"]);
    assert.deepEqual(byLabel.get("travel")!.credit!.statements.map((row) => row.statementKey), ["2026-09", "2026-08"]);
    assert.deepEqual(byLabel.get("daily")!.credit!.purchases.map((row) => row.sourceRowKey), ["daily-mid"]);
    assert.deepEqual(byLabel.get("daily")!.credit!.statements.map((row) => row.statementKey), ["2026-09"]);
  } finally {
    await store.close();
  }
});
