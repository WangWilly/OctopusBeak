<script lang="ts">
  import { onMount, setContext, tick } from "svelte";
  import { writable } from "svelte/store";
  import AssetsDashboard from "$lib/assets/AssetsDashboard.svelte";
  import type { AssetsPageDto } from "$lib/assets/types.ts";
  import AutomationDashboard from "$lib/automation/AutomationDashboard.svelte";
  import {
    createAutomationRuntimeController,
    createAutomationBlockRefreshCoordinator,
    type AutomationActionToken,
    type AutomationBlockRefreshReason,
  } from "$lib/automation/runtime-controller.ts";
  import { isAutomationBlockStale, mergeAutomationRuntime } from "$lib/automation/runtime-sync.ts";
  import type {
    AutomationDesktopModel,
    AutomationRuntimeSnapshot,
  } from "$lib/desktop/api.ts";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import LiabilitiesDashboard from "$lib/liabilities/LiabilitiesDashboard.svelte";
  import type { LiabilitiesPageDto } from "$lib/liabilities/types.ts";
  import OnboardingCoach from "$lib/onboarding/OnboardingCoach.svelte";
  import {
    createOnboardingApplicationPort,
  } from "$lib/onboarding/application-port.ts";
  import {
    createOnboardingController,
    requiredOnboardingRoute,
    type OnboardingWorkflowToken,
  } from "$lib/onboarding/controller.ts";
  import type { OnboardingPresentation, OnboardingStoryEvent } from "$lib/onboarding/story.ts";
  import {
    readOnboardingState,
    writeOnboardingState,
    type OnboardingState,
  } from "$lib/onboarding/state.ts";
  import {
    shouldNarrowOnboardingSources,
    type OnboardingFacts,
    type OnboardingRoute,
  } from "$lib/onboarding/progression.ts";
  import { createOnboardingTargetRegistry } from "$lib/onboarding/target-observer.ts";
  import OverviewDashboard from "$lib/overview/OverviewDashboard.svelte";
  import type { OverviewPageDto } from "$lib/overview/types.ts";
  import SettingsPage from "$lib/settings/SettingsPage.svelte";
  import { applySystemSettings } from "$lib/settings/system-timezone-store.ts";
  import SpendingDashboard from "$lib/spending/SpendingDashboard.svelte";
  import type { SpendingPageDto } from "$lib/spending/model.ts";
  import {
    createFinancialPageLiveStores,
    type FinancialPageLiveStores,
  } from "$lib/financial/client/page-live-stores.ts";
  import FirstRunWelcome from "$lib/welcome/FirstRunWelcome.svelte";
  import { resolveCompletedFirstRunWelcome } from "$lib/welcome/integration.ts";
  import {
    readFirstRunWelcomeState,
    resolveFirstRunWelcomeBoot,
    writeFirstRunWelcomeState,
    type FirstRunWelcomeState,
  } from "$lib/welcome/state.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import RouteLoadFallback from "$lib/shared-shell/components/RouteLoadFallback.svelte";
  import RouteLoadNotice from "$lib/shared-shell/components/RouteLoadNotice.svelte";
  import {
    createRefreshCoordinator,
    RefreshLoadError,
    type RefreshResult,
  } from "$lib/shared-shell/refresh-coordinator.ts";
  import {
    beginIndependentBlocks,
    loadIndependentBlocks,
    type DashboardBlockKey,
    type BlockState,
    type BlockStateMap,
  } from "$lib/shared-shell/block-load-state.ts";
  import {
    wrapDashboardBlock,
    type DashboardBlockPayload,
    type DashboardBlockRoute,
    type DashboardBlockValueMap,
    type DashboardBlockValue,
    type DashboardBlockKeyForRoute,
  } from "$lib/shared-shell/dashboard-blocks.ts";
  import {
    type DataReadOptions,
    type DataVersionSnapshot,
  } from "$lib/shared-shell/data-version.ts";
  import { installDataVersionLifecycle } from "$lib/shared-shell/data-version-lifecycle.ts";
  import {
    initialRefreshUiState,
    REFRESH_CONTEXT_KEY,
    type RefreshUiState,
  } from "$lib/shared-shell/refresh-context.ts";
  import {
    beginViewLoad,
    failViewLoad,
    finishViewLoad,
    type ViewLoadState,
  } from "$lib/shared-shell/view-load-state.ts";
  import {
    beginRefresh,
    failRefresh,
    markRefreshInvalidated,
    settleRefresh,
  } from "$lib/shared-shell/refresh-ui-state.ts";
  import { createRouteLoadCache, settleIndependentLoads } from "./route-loader.ts";

  type RouteId = OnboardingRoute;
  type DashboardRoute = Exclude<RouteId, "settings">;
  type RouteData = {
    automation: AutomationDesktopModel;
  };
  type FinancialRoute = Exclude<DashboardRoute, "automation">;
  type LoadState<T> = ViewLoadState<T>;

  let route: RouteId = "overview";
  let focusAccountId: string | null = null;
  let overview: LoadState<OverviewPageDto> = { status: "loading" };
  let assets: LoadState<AssetsPageDto> = { status: "loading" };
  let liabilities: LoadState<LiabilitiesPageDto> = { status: "loading" };
  let spending: LoadState<SpendingPageDto> = { status: "loading" };
  let automation: LoadState<AutomationDesktopModel> = { status: "loading" };
  // Runtime ownership lives at the app shell so route changes never drop
  // events or lose the latest state while Automation is off-screen.
  let automationRuntimeSnapshot: AutomationRuntimeSnapshot | null = null;
  const automationRuntimeController = createAutomationRuntimeController();
  let automationPendingTaskIds = new Set<string>();
  let automationPendingActions: readonly AutomationActionToken[] = [];
  let onboardingState: OnboardingState | null = null;
  let onboardingController: ReturnType<typeof createOnboardingController> | null = null;
  const onboardingTargets = createOnboardingTargetRegistry();
  let onboardingRestartPending = false;
  let onboardingRestartError: string | null = null;
  let automationDashboard: {
    retryOnboardingWorkflow(): Promise<void>;
    openCredentialsForOnboarding(): void;
    applyOnboardingCredentialPresentation(
      presentation: OnboardingPresentation,
      credentialGroupId: string | null,
    ): Promise<void>;
  } | undefined;
  let firstRunWelcomeState: FirstRunWelcomeState | null = null;
  let completingFirstRunWelcome = false;
  let overviewReloading = false;
  let financialLiveStores: FinancialPageLiveStores | null = null;
  let financialLiveEnabled = false;
  let routeCapabilityResolved = false;
  let financialLiveError = false;
  let financialLiveRoute: DashboardRoute | null = null;
  let stopFinancialLive: (() => void) | null = null;
  let financialLiveWaiter: {
    route: DashboardRoute;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  const routeDataCache = createRouteLoadCache<RouteData>();
  const refreshUi = writable<RefreshUiState>(initialRefreshUiState);
  const automationBlockKeys: readonly DashboardBlockKey[] = ["summary", "list", "details"];
  let routeBlocks: Partial<Record<DashboardRoute, BlockStateMap<DashboardBlockPayload>>> = {};
  let routeBlockLoadIds: Partial<Record<DashboardRoute, number>> = {};
  let routeBlockPromises: Partial<Record<DashboardRoute, Promise<Record<string, BlockState<DashboardBlockPayload>>>>> = {};
  type AutomationBlockRefreshPhase = "direct" | "primary" | "trailing";
  const automationBlockRefreshCoordinator = createAutomationBlockRefreshCoordinator(
    () => startRouteBlockLoadsUncoordinated("automation", undefined, undefined, "primary"),
  );

  setContext(REFRESH_CONTEXT_KEY, {
    state: refreshUi,
    refresh: refreshApp,
  });

  function factsForOnboarding(
    nextRoute: RouteId,
    automationData: AutomationDesktopModel | null,
    overviewData: OverviewPageDto | null,
    runtimeSnapshot: AutomationRuntimeSnapshot | null,
    pendingActions: readonly AutomationActionToken[],
  ): OnboardingFacts {
    const liveAutomation = automationData
      ? mergeAutomationRuntime(automationData.automation, runtimeSnapshot, pendingActions)
      : null;
    return {
      route: nextRoute,
      automation: liveAutomation && automationData
        ? {
          tasks: liveAutomation.tasks,
          credentialGroups: automationData.credentialGroups,
          credentials: liveAutomation.credentials,
        }
        : null,
      overview: overviewData
        ? {
          accounts: overviewData.accounts,
          importedAt: overviewData.importedAt,
          availability: overviewData.availability,
        }
        : null,
    };
  }

  $: onboardingFacts = factsForOnboarding(
    route,
    viewData(automation) ?? null,
    viewData(overview) ?? null,
    automationRuntimeSnapshot,
    automationPendingActions,
  );
  $: overviewValue = viewData(overview);
  $: assetsValue = viewData(assets);
  $: liabilitiesValue = viewData(liabilities);
  $: spendingValue = viewData(spending);
  $: automationValue = viewData(automation);
  $: activeBlocks = route === "settings" ? {} : routeBlocks[route] ?? {};
  $: onboardingStory = onboardingState
    ? onboardingController?.getStoryView(onboardingRestartPending) ?? null
    : null;
  $: if (
    onboardingController
    && routeCapabilityResolved
    && onboardingState?.status === "active"
    && (onboardingState.phase === "running"
      || onboardingState.phase === "preparing-overview"
      || onboardingState.phase === "overview")
  ) void onboardingController.reconcile(onboardingFacts);
  function normalizeRoute() {
    if (!routeCapabilityResolved) return;
    const previousRoute = route;
    const [next, encodedId, ...extraSegments] = location.hash.replace(/^#\/?/, "").split("/");
    const requestedRoute = ["overview", "assets", "liabilities", "spending", "automation", "settings"].includes(next)
      ? next as RouteId
      : "overview";
    const requiredRoute = requiredOnboardingRoute(onboardingState);
    route = requiredRoute ?? requestedRoute;
    const acceptsId = route === "assets" || route === "liabilities";
    let id: string | null = null;
    try {
      id = acceptsId && encodedId ? decodeURIComponent(encodedId) : null;
    } catch {
      id = null;
    }
    focusAccountId = route === "assets" || route === "liabilities" ? id : null;
    const canonicalHash = id ? `/${route}/${encodeURIComponent(id)}` : `/${route}`;
    if (
      !location.hash
      || requestedRoute !== route
      || next !== route
      || encodedId === ""
      || (!acceptsId && encodedId)
      || (encodedId && !id)
      || extraSegments.length > 0
    ) history.replaceState(history.state, "", `#${canonicalHash}`);
    if (route !== "automation" && route !== "settings" && previousRoute !== route) {
      startRouteLoad(route);
    }
    const preserveOnboardingOverviewRead = onboardingState?.status === "active"
      && onboardingState.phase === "preparing-overview"
      && financialLiveRoute === "overview"
      && Boolean(stopFinancialLive);
    if (!preserveOnboardingOverviewRead) {
      startFinancialLive(route === "settings" ? "automation" : route);
    }
    const hasAutomationData = routeDataCache.read("automation") !== undefined
      || Object.values(routeBlocks.automation ?? {}).some((state) => "data" in state);
    if (route !== "automation" && route !== "settings" && financialLiveEnabled) return;
    void loadRoute(
      route,
      route === "automation" && previousRoute !== "automation" && hasAutomationData
        ? { automationRefreshReason: "route-entry" }
        : {},
    );
  }

  function message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  function viewData<T>(state: ViewLoadState<T>): T | undefined {
    return "data" in state ? state.data : undefined;
  }

  function stopActiveFinancialLive() {
    financialLiveWaiter?.reject(new Error("Financial page subscription was replaced."));
    financialLiveWaiter = null;
    stopFinancialLive?.();
    stopFinancialLive = null;
    financialLiveRoute = null;
  }

  function applyLivePage<Value>(
    nextRoute: FinancialRoute,
    state: { status: "loading" } | { status: "error"; code: "subscription-failed" } | { status: "ready"; data: Value },
    setValue: (value: Value) => BlockStateMap<DashboardBlockPayload>,
  ) {
    if (state.status === "error") {
      financialLiveError = true;
      failRouteLoad(nextRoute, new Error("Financial page subscription failed."));
      if (financialLiveWaiter?.route === nextRoute) {
        financialLiveWaiter.reject(new Error("Financial page subscription failed."));
        financialLiveWaiter = null;
      }
      return;
    }
    if (state.status !== "ready") return;
    financialLiveError = false;
    setRouteBlocks(nextRoute, setValue(state.data));
    if (financialLiveWaiter?.route === nextRoute) {
      financialLiveWaiter.resolve();
      financialLiveWaiter = null;
    }
  }

  function startFinancialLive(nextRoute: DashboardRoute, alreadyStopped = false) {
    if (nextRoute === "automation" || !financialLiveEnabled || !financialLiveStores) {
      stopActiveFinancialLive();
      return;
    }
    if (financialLiveRoute === nextRoute && stopFinancialLive) return;
    if (!alreadyStopped) stopActiveFinancialLive();
    financialLiveError = false;
    financialLiveRoute = nextRoute;
    if (nextRoute === "overview") {
      stopFinancialLive = financialLiveStores.overview().subscribe((state) => {
        applyLivePage("overview", state, (value: OverviewPageDto) => {
          overview = finishViewLoad(value);
          return overviewBlocks(value);
        });
      });
    } else if (nextRoute === "assets") {
      stopFinancialLive = financialLiveStores.assets().subscribe((state) => {
        applyLivePage("assets", state, (value: AssetsPageDto) => {
          assets = finishViewLoad(value);
          return assetsBlocks(value);
        });
      });
    } else if (nextRoute === "liabilities") {
      stopFinancialLive = financialLiveStores.liabilities().subscribe((state) => {
        applyLivePage("liabilities", state, (value: LiabilitiesPageDto) => {
          liabilities = finishViewLoad(value);
          return liabilitiesBlocks(value);
        });
      });
    } else {
      stopFinancialLive = financialLiveStores.spending().subscribe((state) => {
        applyLivePage("spending", state, (value: SpendingPageDto) => {
          spending = finishViewLoad(value);
          return spendingBlocks(value);
        });
      });
    }
  }

  function reloadFinancialLive(nextRoute: DashboardRoute): Promise<void> {
    stopActiveFinancialLive();
    startRouteLoad(nextRoute);
    financialLiveError = false;
    if (!financialLiveEnabled || !financialLiveStores || nextRoute === "automation") {
      const error = new Error("PGlite financial page views are unavailable.");
      financialLiveError = true;
      failRouteLoad(nextRoute, error);
      return Promise.reject(error);
    }
    return new Promise<void>((resolve, reject) => {
      financialLiveWaiter = { route: nextRoute, resolve, reject };
      startFinancialLive(nextRoute, true);
    });
  }

  function readyDashboardBlock<Route extends DashboardBlockRoute, Key extends DashboardBlockKeyForRoute<Route>>(
    nextRoute: Route,
    key: Key,
    data: DashboardBlockValue<Route, Key>,
  ): BlockState<DashboardBlockPayload> {
    return finishViewLoad(wrapDashboardBlock(nextRoute, key, data));
  }

  function overviewBlocks(value: OverviewPageDto): BlockStateMap<DashboardBlockPayload> {
    return {
      summary: readyDashboardBlock("overview", "summary", {
        availability: value.availability,
        coverage: value.coverage,
        sourceGaps: value.sourceGaps,
        importedAt: value.importedAt,
        summary: value.summary,
      }),
      chart: readyDashboardBlock("overview", "chart", {
        historyAvailability: value.historyAvailability,
        dailyHistory: value.dailyHistory,
        accounts: value.accounts,
        exchangeRates: value.exchangeRates,
      }),
      list: readyDashboardBlock("overview", "list", {
        historyAvailability: value.historyAvailability,
        dailyHistory: value.dailyHistory,
        exchangeRates: value.exchangeRates,
        latestExchangeRateDate: value.latestExchangeRateDate,
      }),
      details: readyDashboardBlock("overview", "details", {
        sankey: value.sankey,
        sankeyExchangeRates: value.sankeyExchangeRates,
        sankeyLatestExchangeRateDate: value.sankeyLatestExchangeRateDate,
      }),
    };
  }

  function assetsBlocks(value: AssetsPageDto): BlockStateMap<DashboardBlockPayload> {
    return {
      summary: readyDashboardBlock("assets", "summary", { accounts: value.accounts }),
      chart: readyDashboardBlock("assets", "chart", {
        accounts: value.accounts,
        dailyHistory: value.dailyHistory,
        dailyHistoryByAccount: value.dailyHistoryByAccount,
      }),
      list: readyDashboardBlock("assets", "list", {
        accounts: value.accounts,
        positionsByAccount: value.positionsByAccount,
        transactionsByAccount: value.transactionsByAccount,
        dailyHistoryByAccount: value.dailyHistoryByAccount,
      }),
    };
  }

  function liabilitiesBlocks(value: LiabilitiesPageDto): BlockStateMap<DashboardBlockPayload> {
    return {
      summary: readyDashboardBlock("liabilities", "summary", { accounts: value.accounts }),
      chart: readyDashboardBlock("liabilities", "chart", {
        accounts: value.accounts,
        dailyHistory: value.dailyHistory,
        dailyHistoryByAccount: value.dailyHistoryByAccount,
      }),
      list: readyDashboardBlock("liabilities", "list", {
        accounts: value.accounts,
        transactionsByAccount: value.transactionsByAccount,
        dailyHistoryByAccount: value.dailyHistoryByAccount,
      }),
      details: readyDashboardBlock("liabilities", "details", {
        marginAccounts: value.marginAccounts,
        transactionsByAccount: value.transactionsByAccount,
      }),
    };
  }

  function spendingBlocks(value: SpendingPageDto): BlockStateMap<DashboardBlockPayload> {
    return {
      summary: readyDashboardBlock("spending", "summary", {
        canonical: value.canonical,
        purchaseReport: value.purchaseReport,
      }),
      chart: readyDashboardBlock("spending", "chart", {
        canonical: value.canonical,
        purchaseReport: value.purchaseReport,
      }),
      list: readyDashboardBlock("spending", "list", {
        canonical: value.canonical,
        purchaseReport: value.purchaseReport,
        invoices: value.invoices,
      }),
      details: readyDashboardBlock("spending", "details", {
        canonical: value.canonical,
        purchaseReport: value.purchaseReport,
        invoices: value.invoices,
      }),
    };
  }

  function routeLabel(nextRoute: RouteId) {
    if (nextRoute === "overview") return { eyebrow: $t.overview.eyebrow, title: $t.overview.title };
    if (nextRoute === "assets") return { eyebrow: $t.assets.eyebrow, title: $t.assets.title };
    if (nextRoute === "liabilities") return { eyebrow: $t.liabilities.eyebrow, title: $t.liabilities.title };
    if (nextRoute === "spending") {
      return {
        eyebrow: $locale === "zh-TW" ? "消費" : "Spending",
        title: $locale === "zh-TW" ? "個人消費" : "Personal spending",
      };
    }
    if (nextRoute === "automation") return { eyebrow: $t.automation.eyebrow, title: $t.automation.title };
    return { eyebrow: $t.settings.eyebrow, title: $t.settings.title };
  }

  function setRouteBlocks(
    nextRoute: DashboardRoute,
    states: BlockStateMap<DashboardBlockPayload>,
  ) {
    routeBlocks = { ...routeBlocks, [nextRoute]: states };
  }

  function progressiveAutomation(): AutomationDesktopModel | undefined {
    return automationFromBlockStates(routeBlocks.automation ?? {});
  }

  function automationFromBlockStates(
    states: Readonly<Record<string, BlockState<DashboardBlockPayload>>>,
  ): AutomationDesktopModel | undefined {
    const read = <Key extends "summary" | "list" | "details">(key: Key) => {
      const state = states[key];
      if (!state || !("data" in state) || state.data === undefined) return undefined;
      const payload = state.data;
      return payload.route === "automation" && payload.block === key
        ? payload.data as DashboardBlockValueMap["automation"][Key]
        : undefined;
    };
    const summary = read("summary");
    const list = read("list");
    const details = read("details");
    const source = details ?? list ?? summary;
    if (!source) return undefined;
    return {
      automation: details?.automation ?? source.automation,
      credentialGroups: details?.credentialGroups ?? list?.credentialGroups ?? [],
      verificationActorsByCredentialGroup:
        details?.verificationActorsByCredentialGroup
        ?? list?.verificationActorsByCredentialGroup
        ?? summary?.verificationActorsByCredentialGroup
        ?? {},
    };
  }

  $: overviewRenderValue = overviewValue;
  $: assetsRenderValue = assetsValue;
  $: liabilitiesRenderValue = liabilitiesValue;
  $: spendingRenderValue = spendingValue;
  $: automationRenderValue = automationValue ?? progressiveAutomation();

  function loadRouteBlock(
    key: DashboardBlockKey,
    options: DataReadOptions | undefined,
  ): Promise<DashboardBlockPayload> {
    return window.octopusBeak.automation.loadBlock(key, options);
  }

  function startRouteBlockLoadsUncoordinated(
    nextRoute: "automation",
    options: DataReadOptions | undefined,
    onlyKey?: DashboardBlockKey,
    refreshPhase: AutomationBlockRefreshPhase = "direct",
  ): Promise<Record<string, BlockState<DashboardBlockPayload>>> {
    const loadId = (routeBlockLoadIds.automation ?? 0) + 1;
    routeBlockLoadIds = { ...routeBlockLoadIds, automation: loadId };
    const keys = onlyKey ? [onlyKey] : automationBlockKeys;
    const current = routeBlocks[nextRoute] ?? {};
    if (!onlyKey) {
      setRouteBlocks(nextRoute, beginIndependentBlocks(current, keys));
    } else {
      setRouteBlocks(nextRoute, {
        ...current,
        [onlyKey]: beginViewLoad(current[onlyKey] ?? { status: "loading" }),
      });
    }
    const loaders = Object.fromEntries(keys.map((key) => [
      key,
      () => loadRouteBlock(key, options),
    ])) as Record<string, () => Promise<DashboardBlockPayload>>;
    let staleBlockDetected = false;
    const settled = loadIndependentBlocks(loaders, (key, state) => {
      if (routeBlockLoadIds.automation !== loadId) return;
      const payload = "data" in state ? state.data : undefined;
      if (
        payload?.route === "automation"
        && isAutomationBlockStale(payload.data, automationRuntimeSnapshot)
        && refreshPhase !== "trailing"
      ) {
        // Commit the block first. Starting a refresh from inside this
        // callback increments the route load id and can otherwise invalidate
        // the current callback before its ready state reaches the renderer.
        staleBlockDetected = true;
      }
      setRouteBlocks(nextRoute, {
        ...(routeBlocks[nextRoute] ?? {}),
        [key]: state,
      });
    });
    void settled.then((states) => {
      if (routeBlockLoadIds.automation !== loadId) return;
      // The per-block callbacks provide progressive rendering. The final
      // commit is a safety net for fast/parallel resolutions and guarantees
      // that a completed request cannot leave a block in loading state.
      setRouteBlocks(nextRoute, {
        ...(routeBlocks[nextRoute] ?? {}),
        ...states,
      });
      if (
        staleBlockDetected
        && refreshPhase !== "trailing"
      ) {
        void automationBlockRefreshCoordinator.refresh(
          "overtaken",
          (isTrailing) => startRouteBlockLoadsUncoordinated(
            "automation",
            options,
            onlyKey,
            isTrailing ? "trailing" : "primary",
          ),
        );
      }
    });
    routeBlockPromises = { ...routeBlockPromises, [nextRoute]: settled };
    void settled.finally(() => {
      if (routeBlockPromises.automation === settled) {
        const remaining = { ...routeBlockPromises };
        delete remaining.automation;
        routeBlockPromises = remaining;
      }
    });
    return settled;
  }

  function startRouteBlockLoads(
    nextRoute: "automation",
    options: DataReadOptions | undefined,
    onlyKey?: DashboardBlockKey,
    refreshReason?: AutomationBlockRefreshReason,
  ): Promise<Record<string, BlockState<DashboardBlockPayload>>> {
    if (!refreshReason) {
      return startRouteBlockLoadsUncoordinated(nextRoute, options, onlyKey);
    }
    return automationBlockRefreshCoordinator.refresh(
      refreshReason,
      (isTrailing) => startRouteBlockLoadsUncoordinated(
        nextRoute,
        options,
        onlyKey,
        isTrailing ? "trailing" : "primary",
      ),
    );
  }

  function retryRouteBlock(nextRoute: DashboardRoute, key: string) {
    if (nextRoute !== "automation") {
      void loadRoute(nextRoute, { force: true });
      return;
    }
    const cached = routeDataCache.read("automation");
    if (cached) {
      startRouteBlockLoads(
        nextRoute,
        nextRoute === "automation" && key === "details"
          ? { refreshCredentials: true }
          : undefined,
        key as DashboardBlockKey,
      );
      return;
    }
    void loadRoute(nextRoute, { force: true });
  }

  function startRouteLoad(nextRoute: RouteId) {
    if (nextRoute === "overview") overview = beginViewLoad(overview);
    if (nextRoute === "assets") assets = beginViewLoad(assets);
    if (nextRoute === "liabilities") liabilities = beginViewLoad(liabilities);
    if (nextRoute === "spending") spending = beginViewLoad(spending);
    if (nextRoute === "automation") automation = beginViewLoad(automation);
  }

  function failRouteLoad(nextRoute: RouteId, error: unknown) {
    if (nextRoute === "overview") overview = failViewLoad(overview, error);
    if (nextRoute === "assets") assets = failViewLoad(assets, error);
    if (nextRoute === "liabilities") liabilities = failViewLoad(liabilities, error);
    if (nextRoute === "spending") spending = failViewLoad(spending, error);
    if (nextRoute === "automation") automation = failViewLoad(automation, error);
  }

  const refreshCoordinator = createRefreshCoordinator({
    readSnapshot: () => window.octopusBeak.data.getVersion(),
    acknowledgeSnapshot: async (version) => {
      const snapshot = await window.octopusBeak.data.acknowledgeVersion(version);
      return snapshot.version === version && !snapshot.stale;
    },
    loaders: {
      overview: (snapshot) => loadRoute("overview", { force: true, rethrow: true, awaitBlocks: true, snapshot }),
      assets: (snapshot) => loadRoute("assets", { force: true, rethrow: true, awaitBlocks: true, snapshot }),
      liabilities: (snapshot) => loadRoute("liabilities", { force: true, rethrow: true, awaitBlocks: true, snapshot }),
      spending: (snapshot) => loadRoute("spending", { force: true, rethrow: true, awaitBlocks: true, snapshot }),
      automation: (snapshot) => loadRoute("automation", {
        force: true,
        rethrow: true,
        awaitBlocks: true,
        refreshCredentials: true,
        snapshot,
        automationRefreshReason: "manual",
      }),
    },
  });

  let refreshInFlight: Promise<void> | null = null;

  function applyRefreshResult(result: RefreshResult) {
    refreshUi.update((state) => settleRefresh(state, result));
  }

  function refreshApp(): Promise<void> {
    if (refreshInFlight) return refreshInFlight;
    refreshUi.update(beginRefresh);
    const work = refreshCoordinator.refresh(route)
      .then(applyRefreshResult)
      .catch((error: unknown) => {
        refreshUi.update((state) => failRefresh(state, ["refresh"]));
        console.warn("data-refresh-failed", message(error));
      });
    refreshInFlight = work.finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  function saveOnboarding(next: OnboardingState) {
    onboardingState = next;
    writeOnboardingState(localStorage, next);
  }

  function acceptAutomationRuntimeSnapshot(snapshot: AutomationRuntimeSnapshot) {
    const result = automationRuntimeController.acceptSnapshot(snapshot);
    if (!result.accepted) return;
    automationRuntimeSnapshot = result.snapshot;
    automationPendingTaskIds = automationRuntimeController.pendingTaskIds();
    automationPendingActions = automationRuntimeController.pendingActions();
    if (result.hadGap || result.sessionChanged) {
      void loadRoute("automation", {
        force: true,
        automationRefreshReason: "session-resync",
      });
    }
  }

  function saveFirstRunWelcome(next: FirstRunWelcomeState) {
    firstRunWelcomeState = next;
    writeFirstRunWelcomeState(localStorage, next);
    if (next.status === "completed") completingFirstRunWelcome = true;
  }

  function navigateToRoute(nextRoute: RouteId) {
    const allowedRoute = requiredOnboardingRoute(onboardingState) ?? nextRoute;
    const destinationHash = `#/${allowedRoute}`;
    if (location.hash !== destinationHash) history.pushState(history.state, "", destinationHash);
    normalizeRoute();
  }

  function ensureOnboardingController() {
    if (onboardingController) return onboardingController;
    onboardingController = createOnboardingController(createOnboardingApplicationPort({
      persist: saveOnboarding,
      now: () => new Date().toISOString(),
      navigate: navigateToRoute,
      loadAutomation: async () => {
        await loadRoute("automation", {
          force: true,
          rethrow: true,
          awaitBlocks: true,
          automationRefreshReason: "session-resync",
        });
        const latest = viewData(automation) ?? progressiveAutomation();
        if (!latest) throw new Error("Automation data unavailable.");
        return latest;
      },
      runtimeSnapshot: async () => {
        const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
        acceptAutomationRuntimeSnapshot(snapshot);
        return snapshot;
      },
      loadOverview: async () => {
        overviewReloading = true;
        try {
          // Keep the current route on Automation until this subscription has
          // delivered a fresh Overview read. The route transition itself then
          // reuses the ready live subscription instead of starting a stale read.
          await reloadFinancialLive("overview");
          const value = viewData(overview);
          if (!value) throw new Error("Overview data unavailable.");
          return value;
        } finally {
          overviewReloading = false;
        }
      },
      cancelTask: (taskId, expectedRunId) => window.octopusBeak.automation.cancel(taskId, expectedRunId),
      forceTerminateTask: (taskId, expectedRunId) => window.octopusBeak.automation.forceTerminate(taskId, expectedRunId),
    }));
    onboardingController.hydrate(onboardingState);
    return onboardingController;
  }

  function completeFirstRunWelcome() {
    if (!firstRunWelcomeState) return;
    const destination = resolveCompletedFirstRunWelcome(firstRunWelcomeState);
    if (!destination) return;
    if (destination.onboardingState) {
      saveOnboarding(destination.onboardingState);
      ensureOnboardingController().hydrate(destination.onboardingState);
    }
    navigateToRoute(destination.route);
    completingFirstRunWelcome = false;
  }

  async function restartOnboarding() {
    if (onboardingRestartPending) return;
    onboardingRestartPending = true;
    onboardingRestartError = null;
    try {
      const restarted = await ensureOnboardingController().restart();
      if (!restarted) {
        onboardingRestartError = onboardingController?.state?.error
          ?? "The previous workflow could not be cancelled.";
      }
    } catch (error) {
      onboardingRestartError = message(error);
    } finally {
      onboardingRestartPending = false;
    }
  }

  function finishOnboarding() {
    onboardingController?.finish();
  }

  function handleOnboardingStoryEvent(event: OnboardingStoryEvent) {
    const controller = ensureOnboardingController();
    if (event.type === "open-picker") controller.openSourcePicker();
    else if (event.type === "choose-source") controller.chooseSource(event.credentialGroupId);
    else controller.sourceSaved({
      selectedCredentialGroupId: event.credentialGroupId,
      sourceConfiguredAt: event.configuredAt,
    });
  }

  async function previousOnboardingNode() {
    const transition = onboardingController?.previous(onboardingRestartPending);
    if (!transition) return;
    await tick();
    await automationDashboard?.applyOnboardingCredentialPresentation(
      transition.presentation,
      transition.credentialGroupId,
    );
  }

  function returnToOnboardingOverview() {
    return onboardingController?.returnToOverview() ?? Promise.resolve(false);
  }

  async function addOnboardingSource() {
    onboardingController?.addSource();
  }

  function workflowStarting(taskId: string, credentialGroupId: string | null): OnboardingWorkflowToken | null {
    return ensureOnboardingController().workflowStarting(taskId, credentialGroupId);
  }

  function workflowStarted(
    token: OnboardingWorkflowToken | null,
    run: { taskId: string; runId: string | null },
  ) {
    onboardingController?.workflowStarted(token, run);
  }

  function workflowStartFailed(token: OnboardingWorkflowToken | null, error: string) {
    onboardingController?.workflowStartFailed(token, error);
  }

  async function retryOnboardingWorkflow() {
    await automationDashboard?.retryOnboardingWorkflow();
  }

  async function cancelOnboardingWorkflow() {
    await onboardingController?.cancelWorkflow();
  }

  async function resolveFirstRunWelcome() {
    const storedWelcome = readFirstRunWelcomeState(localStorage);
    if (storedWelcome || onboardingState) {
      firstRunWelcomeState = resolveFirstRunWelcomeBoot({
        welcomeState: storedWelcome,
        onboardingState,
        overview: null,
        automation: null,
      });
      if (!storedWelcome) writeFirstRunWelcomeState(localStorage, firstRunWelcomeState);
      return;
    }

    startRouteLoad("automation");
    startRouteLoad("overview");
    const automationBlocks = startRouteBlockLoads("automation", undefined, undefined, "route-entry");
    const settled = await settleIndependentLoads({
      automation: async () => {
        const states = await automationBlocks;
        const data = automationFromBlockStates(states);
        if (!data) throw new Error("Automation data unavailable.");
        return data;
      },
      overview: async () => {
        await reloadFinancialLive("overview");
        const value = viewData(overview);
        if (!value) throw new Error("Welcome overview data unavailable.");
        return value;
      },
    });
    const automationResult = settled.automation;
    const overviewResult = settled.overview;
    const automationData = automationResult?.status === "fulfilled"
      ? automationResult.value as AutomationDesktopModel
      : null;
    const overviewData = overviewResult?.status === "fulfilled"
      ? overviewResult.value as OverviewPageDto
      : null;

    if (automationData) {
      automation = finishViewLoad(automationData);
    } else if (automationResult?.status === "rejected") {
      failRouteLoad("automation", automationResult.error);
      console.warn("welcome-automation-load-failed", message(automationResult.error));
    }
    if (overviewData) {
      overview = finishViewLoad(overviewData);
    } else if (overviewResult?.status === "rejected") {
      failRouteLoad("overview", overviewResult.error);
      console.warn("welcome-overview-load-failed", message(overviewResult.error));
    }

    if (automationData && overviewData) {
      firstRunWelcomeState = resolveFirstRunWelcomeBoot({
        welcomeState: null,
        onboardingState: null,
        overview: { accounts: overviewData.accounts, importedAt: overviewData.importedAt },
        automation: { tasks: automationData.automation.tasks },
      });
      writeFirstRunWelcomeState(localStorage, firstRunWelcomeState);
    }
  }

  async function loadRoute(
    next: RouteId,
    options: {
      force?: boolean;
      rethrow?: boolean;
      awaitBlocks?: boolean;
      refreshCredentials?: boolean;
      snapshot?: DataVersionSnapshot;
      automationRefreshReason?: AutomationBlockRefreshReason;
    } = {},
  ) {
    if (next !== "automation" && next !== "settings") {
      if (route !== next || (financialLiveEnabled && !options.force)) return;
      if (next === "overview") overviewReloading = true;
      try {
        await reloadFinancialLive(next);
      } catch (error) {
        if (route === next) failRouteLoad(next, error);
        if (options.rethrow) throw error;
      } finally {
        if (next === "overview") overviewReloading = false;
      }
      return;
    }
    const readOptions: DataReadOptions | undefined = options.snapshot
      ? {
        expectedVersion: options.snapshot.version,
        ...(options.refreshCredentials ? { refreshCredentials: true } : {}),
      }
      : options.refreshCredentials
        ? { refreshCredentials: true }
      : undefined;
    const automationRefreshReason = next === "automation"
      ? options.automationRefreshReason ?? (options.force ? "manual" : undefined)
      : undefined;
    startRouteLoad(next);
    let blockLoads: Promise<Record<string, BlockState<DashboardBlockPayload>>> | null = null;
    if (next === "automation") {
      const hasCachedData = routeDataCache.read("automation") !== undefined;
      const hasBlockRead = Object.values(routeBlocks.automation ?? {}).some((state) => state.status === "loading");
      const automationRefreshRequested = automationRefreshReason !== undefined;
      if (options.force || automationRefreshRequested || !hasCachedData && !hasBlockRead) {
        blockLoads = startRouteBlockLoads(
          "automation",
          readOptions,
          undefined,
          automationRefreshReason,
        );
      } else if (!hasCachedData) {
        blockLoads = routeBlockPromises.automation ?? null;
      }
    }
    try {
      if (next === "automation") {
        const data = await routeDataCache.load("automation", async () => {
          const states = blockLoads
            ? await blockLoads
            : await startRouteBlockLoads("automation", readOptions);
          const value = automationFromBlockStates(states);
          if (!value) throw new Error("Automation data unavailable.");
          return value;
        }, {
          ...options,
          force: options.force || automationRefreshReason !== undefined,
        });
        automation = finishViewLoad(data);
      }
      if (options.awaitBlocks && blockLoads) {
        const states = await blockLoads;
        const failedBlocks = Object.entries(states)
          .filter(([, state]) => state.status === "error")
          .map(([key]) => `${next}:${key}`);
        if (failedBlocks.length > 0) {
          throw new RefreshLoadError(
            `${next} block refresh failed`,
            failedBlocks,
          );
        }
      }
    } catch (error) {
      if (options.awaitBlocks && blockLoads) await blockLoads;
      failRouteLoad(next, error);
      if (options.rethrow) throw error;
    }
  }

  onMount(() => {
    let mounted = true;
    onboardingState = readOnboardingState(localStorage);
    ensureOnboardingController();
    void window.octopusBeak.settings.load()
      .then((value) => applySystemSettings(value))
      .catch((error) => console.warn("system-settings-load-failed", error));
    // Financial routes are PGlite-live-only, so resolve the capability before
    // the first route load and never start legacy page/block reads.
    void Promise.resolve(window.octopusBeak?.dataViews?.enabled?.() ?? false)
      .catch(() => false)
      .then((enabled) => {
        if (!mounted) return;
        if (enabled) {
          financialLiveEnabled = true;
          financialLiveStores = createFinancialPageLiveStores(window.octopusBeak.dataViews);
        }
        routeCapabilityResolved = true;
        void resolveFirstRunWelcome().finally(() => {
          if (mounted) normalizeRoute();
        });
      });
    const dataVersionLifecycle = installDataVersionLifecycle({
      data: window.octopusBeak.data,
      resumeTarget: window,
      visibilityTarget: document,
      isVisible: () => document.visibilityState === "visible",
      onInvalidated: (event) => {
        refreshUi.update((state) => markRefreshInvalidated(state, event));
      },
      onSnapshot: (snapshot) => {
        refreshUi.update((state) => {
          // A reconnect response can have been captured before an event that
          // is already visible to the renderer.  Never let that older/current
          // response hide the newer stale marker.
          if (snapshot.version < state.version) return state;
          if (state.status === "stale" && snapshot.version === state.version && !snapshot.stale) {
            return state;
          }
          // A reconnect query must not make an in-flight refresh look settled.
          // An observed stale snapshot is still latched until that round ends.
          if (state.status === "refreshing") {
            return snapshot.stale
              ? {
                ...state,
                version: Math.max(state.version, snapshot.version),
                changedAt: snapshot.changedAt,
                staleDuringRefresh: true,
              }
              : state;
          }
          return {
            status: snapshot.stale ? "stale" : "current",
            version: snapshot.version,
            changedAt: snapshot.changedAt,
            failed: [],
            staleDuringRefresh: false,
          };
        });
      },
      onQueryError: (error) => console.warn("data-version-query-failed", error),
    });
    const automationApi = window.octopusBeak.automation;
    const unsubscribeAutomationController = automationRuntimeController.subscribe(() => {
      const current = automationRuntimeController.snapshot();
      if (current) automationRuntimeSnapshot = current;
      automationPendingTaskIds = automationRuntimeController.pendingTaskIds();
      automationPendingActions = automationRuntimeController.pendingActions();
    });
    const unsubscribeAutomationRuntime = typeof automationApi.onRuntimeChanged === "function"
      ? automationApi.onRuntimeChanged(acceptAutomationRuntimeSnapshot)
      : () => {};
    if (typeof automationApi.runtimeSnapshot === "function") {
      void automationApi.runtimeSnapshot()
        .then(acceptAutomationRuntimeSnapshot)
        .catch((error) => {
          console.error("automation-runtime-snapshot-failed", error);
          if (typeof automationApi.fatalRuntimeSnapshot === "function") {
            void automationApi.fatalRuntimeSnapshot();
          }
        });
    }
    const onAutomationRuntimeResync = () => {
      if (typeof automationApi.runtimeSnapshot !== "function") return;
      void automationApi.runtimeSnapshot()
        .then(acceptAutomationRuntimeSnapshot)
        .catch((error) => {
          console.error("automation-runtime-resync-failed", error);
          if (typeof automationApi.fatalRuntimeSnapshot === "function") {
            void automationApi.fatalRuntimeSnapshot();
          }
        });
    };
    addEventListener("focus", onAutomationRuntimeResync);
    const onAutomationRuntimeVisibilityChange = () => {
      if (document.visibilityState === "visible") onAutomationRuntimeResync();
    };
    document.addEventListener("visibilitychange", onAutomationRuntimeVisibilityChange);
    addEventListener("hashchange", normalizeRoute);
    addEventListener("popstate", normalizeRoute);
    return () => {
      mounted = false;
      dataVersionLifecycle.dispose();
      stopActiveFinancialLive();
      financialLiveStores = null;
      unsubscribeAutomationRuntime();
      unsubscribeAutomationController();
      removeEventListener("focus", onAutomationRuntimeResync);
      document.removeEventListener("visibilitychange", onAutomationRuntimeVisibilityChange);
      removeEventListener("hashchange", normalizeRoute);
      removeEventListener("popstate", normalizeRoute);
    };
  });
</script>

{#if financialLiveEnabled && financialLiveError}
  <p role="status" data-financial-live-error>
    {$locale === "zh-TW" ? "即時財務資料暫時無法更新，正在顯示最近可用資料。" : "Live financial data is temporarily unavailable; showing the latest available data."}
  </p>
{/if}

{#if firstRunWelcomeState?.status === "active" || completingFirstRunWelcome}
  {#if firstRunWelcomeState}
    <FirstRunWelcome
      state={firstRunWelcomeState}
      onStateChange={saveFirstRunWelcome}
      onComplete={completeFirstRunWelcome}
    />
  {/if}
{:else if route === "overview"}
  {#if overviewRenderValue}
    <OverviewDashboard
      overview={overviewRenderValue}
      blocks={activeBlocks}
      onboardingEmptyState={onboardingStory?.id === "overview-empty"}
      {onboardingTargets}
      retryBlock={(key) => retryRouteBlock("overview", key)}
    />
    <RouteLoadNotice state={overview} retry={() => void loadRoute("overview", { force: true })} />
  {:else}
    <DashboardShell active="overview" eyebrow={routeLabel("overview").eyebrow} title={routeLabel("overview").title} sideLabel={$t.overview.sideLabel}>
      <RouteLoadFallback state={overview} retry={() => void loadRoute("overview", { force: true })} />
    </DashboardShell>
  {/if}
{:else if route === "assets"}
  {#if assetsRenderValue}
    <AssetsDashboard
      assets={assetsRenderValue}
      {focusAccountId}
      blocks={activeBlocks}
      retryBlock={(key) => retryRouteBlock("assets", key)}
    />
    <RouteLoadNotice state={assets} retry={() => void loadRoute("assets", { force: true })} />
  {:else}
    <DashboardShell active="assets" eyebrow={routeLabel("assets").eyebrow} title={routeLabel("assets").title} sideLabel={$t.assets.sideLabel}>
      <RouteLoadFallback state={assets} retry={() => void loadRoute("assets", { force: true })} />
    </DashboardShell>
  {/if}
{:else if route === "liabilities"}
  {#if liabilitiesRenderValue}
    <LiabilitiesDashboard
      liabilities={liabilitiesRenderValue}
      {focusAccountId}
      blocks={activeBlocks}
      retryBlock={(key) => retryRouteBlock("liabilities", key)}
    />
    <RouteLoadNotice state={liabilities} retry={() => void loadRoute("liabilities", { force: true })} />
  {:else}
    <DashboardShell active="liabilities" eyebrow={routeLabel("liabilities").eyebrow} title={routeLabel("liabilities").title} sideLabel={$t.liabilities.sideLabel}>
      <RouteLoadFallback state={liabilities} retry={() => void loadRoute("liabilities", { force: true })} />
    </DashboardShell>
  {/if}
{:else if route === "spending"}
  {#if spendingRenderValue}
    <SpendingDashboard
      spending={spendingRenderValue}
      refreshSummary={() => route === "spending" ? reloadFinancialLive("spending") : Promise.resolve()}
      blocks={activeBlocks}
      retryBlock={(key) => retryRouteBlock("spending", key)}
    />
    <RouteLoadNotice state={spending} retry={() => void loadRoute("spending", { force: true })} />
  {:else}
    <DashboardShell active="spending" eyebrow={routeLabel("spending").eyebrow} title={routeLabel("spending").title} sideLabel={$t.overview.sideLabel}>
      <RouteLoadFallback state={spending} retry={() => void loadRoute("spending", { force: true })} />
    </DashboardShell>
  {/if}
{:else if route === "automation"}
  {#if automationRenderValue}
    <AutomationDashboard
      bind:this={automationDashboard}
      automation={automationRenderValue.automation}
      credentialGroups={automationRenderValue.credentialGroups}
      verificationActorsByCredentialGroup={automationRenderValue.verificationActorsByCredentialGroup}
      blocks={activeBlocks}
      runtimeSnapshot={automationRuntimeSnapshot}
      runtimeController={automationRuntimeController}
      appPendingTaskIds={automationPendingTaskIds}
      appPendingActions={automationPendingActions}
      retryBlock={(key) => retryRouteBlock("automation", key)}
      reload={() => loadRoute("automation", { force: true })}
      onboardingSourceSelection={[
        "source-entry",
        "source-selection",
        "credentials",
      ].includes(onboardingStory?.id ?? "")}
      onboardingSingleSource={shouldNarrowOnboardingSources(
        onboardingFacts,
        onboardingState,
        onboardingStory?.id ?? "source-entry",
      )}
      onboardingNodeId={onboardingStory?.id ?? null}
      onboardingSelectedCredentialGroupId={onboardingState?.selectedCredentialGroupId ?? null}
      onboardingTrackedTaskId={onboardingState?.trackedRun?.taskId ?? null}
      {onboardingTargets}
      onOnboardingStoryEvent={handleOnboardingStoryEvent}
      onOnboardingWorkflowStarting={workflowStarting}
      onOnboardingWorkflowStarted={workflowStarted}
      onOnboardingWorkflowStartFailed={workflowStartFailed}
    />
    <RouteLoadNotice state={automation} retry={() => void loadRoute("automation", { force: true })} />
  {:else}
    <DashboardShell active="automation" eyebrow={routeLabel("automation").eyebrow} title={routeLabel("automation").title} sideLabel={$t.automation.sideLabel}>
      <RouteLoadFallback state={automation} retry={() => void loadRoute("automation", { force: true })} />
    </DashboardShell>
  {/if}
{:else}
  <SettingsPage
    onboardingStatus={onboardingState?.status ?? null}
    onRestartOnboarding={restartOnboarding}
    {onboardingRestartPending}
    {onboardingRestartError}
  />
{/if}

{#if onboardingStory && onboardingState && firstRunWelcomeState?.status !== "active" && !completingFirstRunWelcome}
  <OnboardingCoach
    story={onboardingStory}
    state={onboardingState}
    targets={onboardingTargets}
    onExit={() => onboardingController?.exit()}
    onPrevious={previousOnboardingNode}
    onReturnToOverview={returnToOnboardingOverview}
    onFinish={finishOnboarding}
    onAddSource={addOnboardingSource}
    onRetryWorkflow={retryOnboardingWorkflow}
    onRetryOverview={() => onboardingController?.retryOverview() ?? Promise.resolve()}
    onCancelWorkflow={cancelOnboardingWorkflow}
  />
{/if}

<style>
</style>
