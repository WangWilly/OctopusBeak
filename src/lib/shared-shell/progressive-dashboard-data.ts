import type { AssetsPageDto } from "../assets/types.ts";
import type { AutomationPageModel } from "../automation/types.ts";
import type { LiabilitiesPageDto } from "../liabilities/types.ts";
import type { OverviewPageDto } from "../overview/types.ts";
import type { SpendingPurchaseReportView } from "../spending/purchase-matching.ts";
import type { SpendingPageDto } from "../spending/model.ts";
import type { DashboardBlockValueMap } from "./dashboard-blocks.ts";
import type { AutomationRuntimeSnapshot } from "../desktop/api.ts";
import { selectAutomationBlockModel } from "../automation/runtime-sync.ts";

export function resolveOverviewSummary(
  fallback: OverviewPageDto,
  block?: DashboardBlockValueMap["overview"]["summary"],
) {
  return block?.summary ?? fallback.summary;
}

export function resolveOverviewChart(
  fallback: OverviewPageDto,
  block?: DashboardBlockValueMap["overview"]["chart"],
): DashboardBlockValueMap["overview"]["chart"] {
  return {
    historyAvailability: block?.historyAvailability ?? fallback.historyAvailability,
    dailyHistory: block?.dailyHistory ?? fallback.dailyHistory,
    accounts: block?.accounts ?? fallback.accounts,
    exchangeRates: block?.exchangeRates ?? fallback.exchangeRates,
  };
}

export function resolveOverviewList(
  fallback: OverviewPageDto,
  block?: DashboardBlockValueMap["overview"]["list"],
): DashboardBlockValueMap["overview"]["list"] {
  return {
    historyAvailability: block?.historyAvailability ?? fallback.historyAvailability,
    dailyHistory: block?.dailyHistory ?? fallback.dailyHistory,
    exchangeRates: block?.exchangeRates ?? fallback.exchangeRates,
    latestExchangeRateDate: block?.latestExchangeRateDate ?? fallback.latestExchangeRateDate,
  };
}

export function resolveOverviewDetails(
  fallback: OverviewPageDto,
  block?: DashboardBlockValueMap["overview"]["details"],
): DashboardBlockValueMap["overview"]["details"] {
  return {
    sankey: block?.sankey ?? fallback.sankey,
    sankeyExchangeRates: block?.sankeyExchangeRates ?? fallback.sankeyExchangeRates,
    sankeyLatestExchangeRateDate: block?.sankeyLatestExchangeRateDate ?? fallback.sankeyLatestExchangeRateDate,
  };
}

export function resolveAssetsSummary(
  fallback: AssetsPageDto,
  block?: DashboardBlockValueMap["assets"]["summary"],
): DashboardBlockValueMap["assets"]["summary"] {
  return { accounts: block?.accounts ?? fallback.accounts };
}

export function resolveAssetsChart(
  fallback: AssetsPageDto,
  block?: DashboardBlockValueMap["assets"]["chart"],
): DashboardBlockValueMap["assets"]["chart"] {
  return {
    accounts: block?.accounts ?? fallback.accounts,
    dailyHistory: block?.dailyHistory ?? fallback.dailyHistory,
    dailyHistoryByAccount: block?.dailyHistoryByAccount ?? fallback.dailyHistoryByAccount,
  };
}

export function resolveAssetsList(
  fallback: AssetsPageDto,
  block?: DashboardBlockValueMap["assets"]["list"],
): DashboardBlockValueMap["assets"]["list"] {
  return {
    accounts: block?.accounts ?? fallback.accounts,
    positionsByAccount: block?.positionsByAccount ?? fallback.positionsByAccount,
    transactionsByAccount: block?.transactionsByAccount ?? fallback.transactionsByAccount,
    dailyHistoryByAccount: block?.dailyHistoryByAccount ?? fallback.dailyHistoryByAccount,
  };
}

export function resolveLiabilitiesSummary(
  fallback: LiabilitiesPageDto,
  block?: DashboardBlockValueMap["liabilities"]["summary"],
): DashboardBlockValueMap["liabilities"]["summary"] {
  return { accounts: block?.accounts ?? fallback.accounts };
}

export function resolveLiabilitiesChart(
  fallback: LiabilitiesPageDto,
  block?: DashboardBlockValueMap["liabilities"]["chart"],
): DashboardBlockValueMap["liabilities"]["chart"] {
  return {
    accounts: block?.accounts ?? fallback.accounts,
    dailyHistory: block?.dailyHistory ?? fallback.dailyHistory,
    dailyHistoryByAccount: block?.dailyHistoryByAccount ?? fallback.dailyHistoryByAccount,
  };
}

export function resolveLiabilitiesList(
  fallback: LiabilitiesPageDto,
  block?: DashboardBlockValueMap["liabilities"]["list"],
): DashboardBlockValueMap["liabilities"]["list"] {
  return {
    accounts: block?.accounts ?? fallback.accounts,
    transactionsByAccount: block?.transactionsByAccount ?? fallback.transactionsByAccount,
    dailyHistoryByAccount: block?.dailyHistoryByAccount ?? fallback.dailyHistoryByAccount,
  };
}

export function resolveLiabilitiesDetails(
  fallback: LiabilitiesPageDto,
  block?: DashboardBlockValueMap["liabilities"]["details"],
): DashboardBlockValueMap["liabilities"]["details"] {
  return {
    marginAccounts: block?.marginAccounts ?? fallback.marginAccounts,
    transactionsByAccount: block?.transactionsByAccount ?? fallback.transactionsByAccount,
  };
}

/**
 * Keep each purchase block bound to the payload that settled for that block.
 * An absent/failed block intentionally falls back to the last route snapshot
 * so a sibling can continue rendering while this block retries.
 */
export function resolveSpendingPurchaseReport(
  fallback: SpendingPurchaseReportView,
  block?:
    | DashboardBlockValueMap["spending"]["summary"]
    | DashboardBlockValueMap["spending"]["chart"]
    | DashboardBlockValueMap["spending"]["list"]
    | DashboardBlockValueMap["spending"]["details"],
): SpendingPurchaseReportView {
  // The desktop block projection is the canonical report shape while this
  // renderer consumes its browser-safe view shape.  The projection contract
  // is intentionally the same at runtime; keep this conversion at the seam
  // rather than weakening every dashboard block to `unknown`.
  return block?.purchaseReport
    ? block.purchaseReport as unknown as SpendingPurchaseReportView
    : fallback;
}

/** Resolve an automation section from its own settled block payload. */
export function resolveAutomationBlock(
  fallback: AutomationPageModel,
  block?:
    | DashboardBlockValueMap["automation"]["summary"]
    | DashboardBlockValueMap["automation"]["list"]
    | DashboardBlockValueMap["automation"]["details"],
  runtime?: AutomationRuntimeSnapshot | null,
): AutomationPageModel {
  return selectAutomationBlockModel(fallback, block?.automation, runtime);
}

/**
 * Empty is a real product state. A block may legitimately have zero totals;
 * do not turn that into a fabricated available purchase view while the full
 * route DTO is still loading.
 */
export function isEmptySpendingPage(page: SpendingPageDto): boolean {
  return page.canonical.availability === "empty"
    && (page.purchaseReport?.records.length ?? 0) === 0
    && (page.invoices?.length ?? 0) === 0;
}
