import type { AssetsPageDto } from "../assets/types.ts";
import type { AutomationPageModel } from "../automation/types.ts";
import type { LiabilitiesPageDto } from "../liabilities/types.ts";
import type { OverviewPageDto } from "../overview/types.ts";
import type { SpendingPurchaseReportView } from "../spending/purchase-matching.ts";
import type { DashboardBlockValueMap } from "./dashboard-blocks.ts";
import type { AutomationRuntimeSnapshot } from "../desktop/api.ts";
import { selectAutomationBlockModel } from "../automation/runtime-sync.ts";
import type { AutomationActionToken } from "../automation/runtime-controller.ts";

/** A loaded block's fields win over the route DTO it was projected from. */
export function resolveOverview(
  fallback: OverviewPageDto,
  blocks: Partial<{ [Key in keyof DashboardBlockValueMap["overview"]]: DashboardBlockValueMap["overview"][Key] }>,
): OverviewPageDto {
  return { ...fallback, ...blocks.chart, ...blocks.list, ...blocks.summary };
}

export function resolveAssetsSummary(
  fallback: AssetsPageDto,
  block?: DashboardBlockValueMap["assets"]["summary"],
): DashboardBlockValueMap["assets"]["summary"] {
  return {
    accounts: block?.accounts ?? fallback.accounts,
    dailyHistory: block?.dailyHistory ?? fallback.dailyHistory,
    dailyHistoryByAccount: block?.dailyHistoryByAccount ?? fallback.dailyHistoryByAccount,
    exchangeRates: block?.exchangeRates ?? fallback.exchangeRates,
  };
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
    coveredAccounts: block?.coveredAccounts ?? fallback.coveredAccounts,
    positionsByAccount: block?.positionsByAccount ?? fallback.positionsByAccount,
    transactionsByAccount: block?.transactionsByAccount ?? fallback.transactionsByAccount,
    dailyHistoryByAccount: block?.dailyHistoryByAccount ?? fallback.dailyHistoryByAccount,
  };
}

export function resolveLiabilitiesSummary(
  fallback: LiabilitiesPageDto,
  block?: DashboardBlockValueMap["liabilities"]["summary"],
): DashboardBlockValueMap["liabilities"]["summary"] {
  return {
    accounts: block?.accounts ?? fallback.accounts,
    dailyHistory: block?.dailyHistory ?? fallback.dailyHistory,
    dailyHistoryByAccount: block?.dailyHistoryByAccount ?? fallback.dailyHistoryByAccount,
    exchangeRates: block?.exchangeRates ?? fallback.exchangeRates,
  };
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
  pendingActions?: readonly AutomationActionToken[],
): AutomationPageModel {
  return selectAutomationBlockModel(fallback, block?.automation, runtime, pendingActions);
}
