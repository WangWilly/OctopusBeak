import type {
  AutomationCoreSnapshot,
  AutomationDesktopModel,
} from "$lib/desktop/api.ts";

/**
 * Automation is the one route whose sections load independently; financial
 * routes render one live page snapshot.
 */
export type DashboardBlockRoute = "automation";

/** Each payload carries only the fields one Automation section renders. */
export type DashboardBlockValueMap = {
  automation: {
    summary: Pick<AutomationDesktopModel, "automation" | "runtimeSessionId" | "runtimeRevision">;
    list: Pick<AutomationCoreSnapshot, "automation" | "credentialGroups" | "runtimeSessionId" | "runtimeRevision">;
    details: Pick<AutomationDesktopModel, "automation" | "credentialGroups" | "runtimeSessionId" | "runtimeRevision">;
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
