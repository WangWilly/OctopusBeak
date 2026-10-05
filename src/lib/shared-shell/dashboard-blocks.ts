import type {
  AutomationCoreSnapshot,
  AutomationDesktopModel,
} from "$lib/desktop/api.ts";
import type { AssetsPageDto } from "$lib/assets/types.ts";
import type { LiabilitiesPageDto } from "$lib/liabilities/types.ts";
import type { OverviewPageDto } from "$lib/overview/types.ts";
import type { SpendingPageDto } from "$lib/spending/model.ts";
import type { BlockState } from "./block-load-state.ts";

/** Ticker and net worth card. */
export const OVERVIEW_SUMMARY_FIELDS = [
  "availability", "coverage", "sourceGaps", "importedAt", "summary", "historyAvailability",
  "dailyHistory", "accounts", "exchangeRates", "holdingPrices",
] as const satisfies readonly (keyof OverviewPageDto)[];
/** Asset and liability allocation. */
export const OVERVIEW_CHART_FIELDS = [
  "dailyHistory", "accounts", "exchangeRates",
] as const satisfies readonly (keyof OverviewPageDto)[];
/** Daily change bars, today's change, and the daily detail table. */
export const OVERVIEW_LIST_FIELDS = [
  "dailyHistory", "dailyHistoryByAccount", "accounts", "exchangeRates", "holdingPrices",
] as const satisfies readonly (keyof OverviewPageDto)[];

type OverviewSummaryField = (typeof OVERVIEW_SUMMARY_FIELDS)[number];
type OverviewChartField = (typeof OVERVIEW_CHART_FIELDS)[number];
type OverviewListField = (typeof OVERVIEW_LIST_FIELDS)[number];

/** Routes with independently renderable dashboard sections. */
export type DashboardBlockRoute =
  | "overview"
  | "assets"
  | "liabilities"
  | "spending"
  | "automation";

/**
 * Payloads deliberately contain only the fields needed by one major section.
 * They are not aliases for the complete route DTO: a fast summary can render
 * while a slow chart projection is still pending.
 */
export type DashboardBlockValueMap = {
  overview: {
    summary: Pick<OverviewPageDto, OverviewSummaryField>;
    chart: Pick<OverviewPageDto, OverviewChartField>;
    list: Pick<OverviewPageDto, OverviewListField>;
  };
  assets: {
    summary: Pick<AssetsPageDto, "accounts">;
    chart: Pick<AssetsPageDto, "accounts" | "dailyHistory" | "dailyHistoryByAccount">;
    list: Pick<AssetsPageDto, "accounts" | "positionsByAccount" | "transactionsByAccount" | "dailyHistoryByAccount">;
  };
  liabilities: {
    summary: Pick<LiabilitiesPageDto, "accounts">;
    chart: Pick<LiabilitiesPageDto, "accounts" | "dailyHistory" | "dailyHistoryByAccount">;
    list: Pick<LiabilitiesPageDto, "accounts" | "transactionsByAccount" | "dailyHistoryByAccount">;
    details: Pick<LiabilitiesPageDto, "marginAccounts" | "transactionsByAccount">;
  };
  spending: {
    summary: Pick<SpendingPageDto, "canonical" | "purchaseReport">;
    chart: Pick<SpendingPageDto, "canonical" | "purchaseReport">;
    list: Pick<SpendingPageDto, "canonical" | "purchaseReport" | "invoices">;
    details: Pick<SpendingPageDto, "canonical" | "purchaseReport" | "invoices">;
  };
  automation: {
    summary: Pick<AutomationDesktopModel, "automation" | "verificationActorsByCredentialGroup" | "runtimeSessionId" | "runtimeRevision">;
    list: Pick<AutomationCoreSnapshot, "automation" | "verificationActorsByCredentialGroup" | "credentialGroups" | "runtimeSessionId" | "runtimeRevision">;
    details: Pick<AutomationDesktopModel, "automation" | "verificationActorsByCredentialGroup" | "credentialGroups" | "runtimeSessionId" | "runtimeRevision">;
  };
};

export type DashboardBlockKeyForRoute<R extends DashboardBlockRoute> = keyof DashboardBlockValueMap[R];

export type DashboardBlockValue<
  R extends DashboardBlockRoute,
  K extends DashboardBlockKeyForRoute<R>,
> = DashboardBlockValueMap[R][K];

export type DashboardBlockPayload = {
  [R in DashboardBlockRoute]: {
    [K in DashboardBlockKeyForRoute<R>]: {
      route: R;
      block: K;
      data: DashboardBlockValue<R, K>;
    };
  }[DashboardBlockKeyForRoute<R>];
}[DashboardBlockRoute];

export type DashboardBlockStateMap<R extends DashboardBlockRoute> = Partial<{
  [K in DashboardBlockKeyForRoute<R>]: BlockState<Extract<
    DashboardBlockPayload,
    { route: R; block: K }
  >>;
}>;

export function wrapDashboardBlock<
  R extends DashboardBlockRoute,
  K extends DashboardBlockKeyForRoute<R>,
>(
  route: R,
  block: K,
  data: DashboardBlockValue<R, K>,
): Extract<DashboardBlockPayload, { route: R; block: K }> {
  return { route, block, data } as unknown as Extract<DashboardBlockPayload, { route: R; block: K }>;
}

/** Extract the data payload without making loading/error states special cases. */
export function dashboardBlockData<
  R extends DashboardBlockRoute,
  K extends DashboardBlockKeyForRoute<R>,
>(
  state: BlockState<Extract<DashboardBlockPayload, { route: R; block: K }>> | undefined,
): DashboardBlockValue<R, K> | undefined {
  if (!state || !("data" in state) || state.data === undefined) return undefined;
  const payload = state.data as unknown as Extract<DashboardBlockPayload, { route: R; block: K }>;
  return payload.data as unknown as DashboardBlockValue<R, K>;
}
