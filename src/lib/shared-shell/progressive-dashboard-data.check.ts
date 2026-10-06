import assert from "node:assert/strict";
import test from "node:test";
import type { AccountRowDto, SummaryMetricDto } from "$lib/shared-ledger/types.ts";
import type { AssetsPageDto } from "$lib/assets/types.ts";
import type { LiabilitiesPageDto } from "$lib/liabilities/types.ts";
import type { OverviewPageDto } from "$lib/overview/types.ts";
import type { SpendingPageDto } from "$lib/spending/model.ts";
import type { SpendingPurchaseReportView } from "$lib/spending/purchase-matching.ts";
import type { DashboardBlockValueMap } from "./dashboard-blocks.ts";
import {
  resolveAutomationBlock,
  resolveSpendingPurchaseReport,
  resolveAssetsList,
  resolveLiabilitiesDetails,
  resolveOverview,
} from "./progressive-dashboard-data.ts";
import type { AutomationPageModel } from "$lib/automation/types.ts";

const account = (id: string): AccountRowDto => ({
  id,
  label: id,
  institution: id,
  product: id,
  group: "asset",
  kind: "bank",
  typeLabel: id,
  amountLines: [],
  transactionCount: 0,
  assetPositionCount: 0,
  lastUpdated: null,
  valueAvailability: "available",
});

const overview = (summary: SummaryMetricDto[]): OverviewPageDto => ({
  availability: "available",
  coverage: "complete",
  historyAvailability: "unavailable",
  sourceGaps: [],
  importedAt: null,
  summary,
  dailyHistory: [],
  dailyHistoryByAccount: {},
  accounts: [],
  holdingPrices: [],
  exchangeRates: [],
});

const emptySpending = (): SpendingPageDto => ({
  canonical: {
    availability: "empty",
    policy: { id: "gross-posted-outflow", version: "v1", name: "Gross posted outflow" },
    knowledgePoint: 1,
    selectedMonth: null,
    selectedCategory: null,
    transactions: [],
    includedTransactions: [],
    totalsByCurrency: [],
    categoryTotalsByCurrency: [],
    unclassifiedByCurrency: [],
    classificationCoverage: {
      includedCount: 0,
      classifiedCount: 0,
      unclassifiedCount: 0,
      includedAmountByCurrency: [],
      classifiedAmountByCurrency: [],
      unclassifiedAmountByCurrency: [],
    },
    reportEligibility: { status: "complete", gapCount: 0, gapAmountByCurrency: [] },
    totalStatus: "complete",
  },
  purchaseReport: {
    status: "ok",
    kind: "current",
    knowledgeAt: 1,
    financialAt: null,
    records: [],
    totalsByCurrency: [],
    totalStatus: "complete",
    candidates: [],
  },
  invoices: [],
});

test("progressive dashboard adapters prefer a settled block and fall back to the route DTO", () => {
  const fallbackOverview = overview([{ label: "fallback", amounts: [], breakdown: [] }]);
  const blockSummary: DashboardBlockValueMap["overview"]["summary"] = {
    ...fallbackOverview,
    summary: [{ label: "block", amounts: [], breakdown: [] }],
  };
  const blockList: DashboardBlockValueMap["overview"]["list"] = {
    ...fallbackOverview,
    dailyHistoryByAccount: { account: [] },
  };
  assert.equal(resolveOverview(fallbackOverview, { summary: blockSummary }).summary[0]?.label, "block");
  assert.deepEqual(resolveOverview(fallbackOverview, { list: blockList }).dailyHistoryByAccount, { account: [] });
  assert.equal(resolveOverview(fallbackOverview, {}).summary[0]?.label, "fallback");

  const fallbackAssets = {
    availability: "available",
    coverage: "complete",
    sourceGaps: [],
    importedAt: null,
    accounts: [account("fallback")],
    positionsByAccount: {},
    transactionsByAccount: {},
    dailyHistoryByAccount: {},
    dailyHistory: [],
    exchangeRates: [],
  } as AssetsPageDto;
  const blockAssets: DashboardBlockValueMap["assets"]["list"] = {
    accounts: [account("block")],
    positionsByAccount: {},
    transactionsByAccount: {},
    dailyHistoryByAccount: {},
  };
  assert.equal(resolveAssetsList(fallbackAssets, blockAssets).accounts[0]?.id, "block");
  assert.equal(resolveAssetsList(fallbackAssets).accounts[0]?.id, "fallback");

  const fallbackLiabilities = {
    availability: "available",
    coverage: "complete",
    sourceGaps: [],
    importedAt: null,
    marginAccounts: [account("fallback")],
    transactionsByAccount: {},
    accounts: [],
    dailyHistoryByAccount: {},
    dailyHistory: [],
    exchangeRates: [],
  } as LiabilitiesPageDto;
  const blockLiabilities: DashboardBlockValueMap["liabilities"]["details"] = {
    marginAccounts: [account("block")],
    transactionsByAccount: {},
  };
  assert.equal(resolveLiabilitiesDetails(fallbackLiabilities, blockLiabilities).marginAccounts[0]?.id, "block");
  assert.equal(resolveLiabilitiesDetails(fallbackLiabilities).marginAccounts[0]?.id, "fallback");
});

test("settled spending and automation blocks provide their own content without replacing siblings", () => {
  const fallbackSpending = emptySpending().purchaseReport as unknown as SpendingPurchaseReportView;
  const chartSpending = { ...fallbackSpending, knowledgeAt: 2 };
  const listSpending = { ...fallbackSpending, knowledgeAt: 3 };

  assert.equal(
    resolveSpendingPurchaseReport(
      fallbackSpending,
      { canonical: emptySpending().canonical, purchaseReport: chartSpending } as unknown as DashboardBlockValueMap["spending"]["chart"],
    ),
    chartSpending,
  );
  assert.equal(
    resolveSpendingPurchaseReport(
      fallbackSpending,
      { canonical: emptySpending().canonical, purchaseReport: listSpending, invoices: [] } as unknown as DashboardBlockValueMap["spending"]["list"],
    ),
    listSpending,
  );
  assert.equal(resolveSpendingPurchaseReport(fallbackSpending), fallbackSpending);

  const fallbackAutomation = {
    tasks: [{ id: "fallback-task" }],
  } as unknown as AutomationPageModel;
  const listAutomation = {
    ...fallbackAutomation,
    tasks: [{ id: "list-task" }],
  } as unknown as AutomationPageModel;
  const detailsAutomation = {
    ...fallbackAutomation,
    tasks: [{ id: "details-task" }],
  } as unknown as AutomationPageModel;

  assert.equal(
    resolveAutomationBlock(fallbackAutomation, {
      automation: listAutomation,
      credentialGroups: [],
    }).tasks[0]?.id,
    "list-task",
  );
  assert.equal(
    resolveAutomationBlock(fallbackAutomation, {
      automation: detailsAutomation,
      credentialGroups: [],
    }).tasks[0]?.id,
    "details-task",
  );
  assert.equal(resolveAutomationBlock(fallbackAutomation)?.tasks[0]?.id, "fallback-task");
});
