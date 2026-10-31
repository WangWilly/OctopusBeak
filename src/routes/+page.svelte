<script lang="ts">
  import { onMount, setContext, tick } from "svelte";
  import { writable } from "svelte/store";
  import AssetsDashboard from "$lib/assets/AssetsDashboard.svelte";
  import AutomationDashboard from "$lib/automation/AutomationDashboard.svelte";
  import UsageStatisticsPrompt from "$lib/settings/UsageStatisticsPrompt.svelte";
  import {
    createAutomationRuntimeController,
    createAutomationBlockRefreshCoordinator,
    type AutomationActionToken,
    type AutomationBlockRefreshReason,
  } from "$lib/automation/runtime-controller.ts";
  import { isAutomationBlockStale, mergeAutomationRuntime } from "$lib/automation/runtime-sync.ts";
  import { isActiveAutomationRuntimeStatus } from "$lib/automation/task-row.ts";
  import type {
    AutomationDesktopModel,
    AutomationRuntimeSnapshot,
  } from "$lib/desktop/api.ts";
  import { t } from "$lib/i18n/i18n.ts";
  import LiabilitiesDashboard from "$lib/liabilities/LiabilitiesDashboard.svelte";
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
  import { latestExchangeRateRun, linkedSourceCount } from "$lib/settings/settings-status.ts";
  import { applySystemSettings, usageStatisticsEnabled } from "$lib/settings/system-timezone-store.ts";
  import PurchaseSpendingDashboard from "$lib/spending/components/PurchaseSpendingDashboard.svelte";
  import {
    createFinancialPage,
    FinancialPageSuperseded,
    isFinancialRoute,
  } from "$lib/financial/client/financial-page.ts";
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
    type DashboardBlockPayload,
    type DashboardBlockValueMap,
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
  type LoadState<T> = ViewLoadState<T>;

  let route: RouteId = "overview";
  let focusAccountId: string | null = null;
  const financialPage = createFinancialPage({ dataViews: window.octopusBeak?.dataViews });
  const financialState = financialPage.state;
  $: overview = $financialState.routes.overview.load;
  $: assets = $financialState.routes.assets.load;
  $: liabilities = $financialState.routes.liabilities.load;
  $: spending = $financialState.routes.spending.load;
  // Only the current route's live failure is announced.
  $: financialLiveError = isFinancialRoute(route) && $financialState.routes[route].liveError;
  let automation: LoadState<AutomationDesktopModel> = { status: "loading" };
  // Runtime ownership lives at the app shell so route changes never drop
  // events or lose the latest state while Automation is off-screen.
  let automationRuntimeSnapshot: AutomationRuntimeSnapshot | null = null;
  const automationRuntimeController = createAutomationRuntimeController();
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
  let signInSettingsGroupId: string | null = null;
  let focusFinancialDataDeletion = false;
  let firstRunWelcomeState: FirstRunWelcomeState | null = null;
  let completingFirstRunWelcome = false;
  const routeDataCache = createRouteLoadCache<RouteData>();
  const refreshUi = writable<RefreshUiState>(initialRefreshUiState);
  const automationBlockKeys: readonly DashboardBlockKey[] = ["summary", "list", "details"];
  let automationBlocks: BlockStateMap<DashboardBlockPayload> = {};
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
  /** ADR 0078: the one-time usage statistics question waits for the welcome and onboarding to finish. */
  let usageStatisticsAsk = false;
  let firstRunWelcomeResolved = false;
  let lastUsageStatisticsEnabled: boolean | null = null;
  // Changing the switch in Settings answers the question, even while the dialog is still waiting.
  $: {
    if (lastUsageStatisticsEnabled !== null && $usageStatisticsEnabled !== lastUsageStatisticsEnabled) {
      usageStatisticsAsk = false;
    }
    lastUsageStatisticsEnabled = $usageStatisticsEnabled;
  }
  $: showUsageStatisticsPrompt = usageStatisticsAsk
    && firstRunWelcomeResolved
    && firstRunWelcomeState?.status !== "active"
    && !completingFirstRunWelcome
    && onboardingState?.status !== "active";

  async function answerUsageStatistics(enabled: boolean) {
    usageStatisticsAsk = false;
    try {
      applySystemSettings(await window.octopusBeak.settings.answerUsageStatistics(enabled));
    } catch (error) {
      // Unrecorded, so the question comes back on the next launch.
      console.error("usage-statistics-answer-failed", error);
    }
  }

  $: onboardingStory = onboardingState
    ? onboardingController?.getStoryView(onboardingRestartPending) ?? null
    : null;
  $: if (
    onboardingController
    && $financialState.capabilityResolved
    && onboardingState?.status === "active"
    && (onboardingState.phase === "running"
      || onboardingState.phase === "preparing-overview"
      || onboardingState.phase === "overview")
  ) void onboardingController.reconcile(onboardingFacts);
  function normalizeRoute() {
    if (!$financialState.capabilityResolved) return;
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
    const preserveOnboardingOverviewRead = onboardingState?.status === "active"
      && onboardingState.phase === "preparing-overview"
      && $financialState.shown === "overview";
    if (!preserveOnboardingOverviewRead) {
      financialPage.show(isFinancialRoute(route) ? route : null);
    }
    const hasAutomationData = routeDataCache.read("automation") !== undefined
      || Object.values(automationBlocks).some((state) => "data" in state);
    if (isFinancialRoute(route) && $financialState.enabled) return;
    // Settings reports source and exchange-rate status from Automation's data.
    void loadRoute(
      route === "settings" ? "automation" : route,
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

  function routeLabel(nextRoute: RouteId) {
    if (nextRoute === "overview") return { eyebrow: $t.overview.eyebrow, title: $t.overview.title };
    if (nextRoute === "assets") return { eyebrow: $t.assets.eyebrow, title: $t.assets.title };
    if (nextRoute === "liabilities") return { eyebrow: $t.liabilities.eyebrow, title: $t.liabilities.title };
    if (nextRoute === "spending") {
      return { eyebrow: $t.spending.eyebrow, title: $t.spending.title };
    }
    if (nextRoute === "automation") return { eyebrow: $t.automation.eyebrow, title: $t.automation.title };
    return { eyebrow: $t.settings.eyebrow, title: $t.settings.title };
  }


  function progressiveAutomation(): AutomationDesktopModel | undefined {
    return automationFromBlockStates(automationBlocks);
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
    };
  }

  $: overviewRenderValue = overviewValue;
  $: assetsRenderValue = assetsValue;
  $: liabilitiesRenderValue = liabilitiesValue;
  $: spendingRenderValue = spendingValue;
  $: automationRenderValue = automationValue ?? progressiveAutomation();
  $: settingsAutomation = route === "settings" && automationRenderValue
    ? {
      linkedSources: linkedSourceCount(automationRenderValue.credentialGroups, automationRenderValue.automation.credentials),
      exchangeRateLastRun: latestExchangeRateRun(
        mergeAutomationRuntime(automationRenderValue.automation, automationRuntimeSnapshot, automationPendingActions).tasks,
      ),
    }
    : null;

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
    const current = automationBlocks;
    if (!onlyKey) {
      automationBlocks = beginIndependentBlocks(current, keys);
    } else {
      automationBlocks = {
        ...current,
        [onlyKey]: beginViewLoad(current[onlyKey] ?? { status: "loading" }),
      };
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
      automationBlocks = {
        ...automationBlocks,
        [key]: state,
      };
    });
    void settled.then((states) => {
      if (routeBlockLoadIds.automation !== loadId) return;
      // The per-block callbacks provide progressive rendering. The final
      // commit is a safety net for fast/parallel resolutions and guarantees
      // that a completed request cannot leave a block in loading state.
      automationBlocks = {
        ...automationBlocks,
        ...states,
      };
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

  function retryAutomationBlock(key: string) {
    if (!routeDataCache.read("automation")) {
      void loadRoute("automation", { force: true });
      return;
    }
    startRouteBlockLoads(
      "automation",
      key === "details" ? { refreshCredentials: true } : undefined,
      key as DashboardBlockKey,
    );
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
        // Keep the current route on Automation until this subscription has
        // delivered a fresh Overview read. The route transition itself then
        // reuses the ready live subscription instead of starting a stale read.
        await financialPage.reload("overview");
        const value = viewData($financialState.routes.overview.load);
        if (!value) throw new Error("Overview data unavailable.");
        return value;
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

    automation = beginViewLoad(automation);
    const automationBlocks = startRouteBlockLoads("automation", undefined, undefined, "route-entry");
    const settled = await settleIndependentLoads({
      automation: async () => {
        const states = await automationBlocks;
        const data = automationFromBlockStates(states);
        if (!data) throw new Error("Automation data unavailable.");
        return data;
      },
      overview: async () => {
        await financialPage.reload("overview");
        const value = viewData($financialState.routes.overview.load);
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
      automation = failViewLoad(automation, automationResult.error);
      console.warn("welcome-automation-load-failed", message(automationResult.error));
    }
    if (overviewResult?.status === "rejected") {
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
    if (isFinancialRoute(next)) {
      if (route !== next || ($financialState.enabled && !options.force)) return;
      try {
        await financialPage.reload(next);
      } catch (error) {
        // The page records its own failure; a superseded reload is a cancellation.
        if (options.rethrow && !(error instanceof FinancialPageSuperseded)) throw error;
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
    if (next === "automation") automation = beginViewLoad(automation);
    let blockLoads: Promise<Record<string, BlockState<DashboardBlockPayload>>> | null = null;
    if (next === "automation") {
      const hasCachedData = routeDataCache.read("automation") !== undefined;
      const hasBlockRead = Object.values(automationBlocks).some((state) => state.status === "loading");
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
      if (next === "automation") automation = failViewLoad(automation, error);
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
    void window.octopusBeak.settings.shouldAskUsageStatistics()
      .then((ask) => {
        if (mounted) usageStatisticsAsk = ask;
      })
      .catch((error) => console.warn("usage-statistics-ask-failed", error));
    // Financial routes are PGlite-live-only, so resolve the capability before
    // the first route load and never start legacy page/block reads.
    void financialPage.capability.then(() => {
      if (!mounted) return;
      void resolveFirstRunWelcome().finally(() => {
        if (!mounted) return;
        firstRunWelcomeResolved = true;
        normalizeRoute();
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
      automationPendingActions = automationRuntimeController.pendingActions();
    });
    const unsubscribeAutomationRuntime = typeof automationApi.onRuntimeChanged === "function"
      ? automationApi.onRuntimeChanged(acceptAutomationRuntimeSnapshot)
      : () => {};
    const takeNotificationTarget = () => {
      void automationApi.takeNotificationTarget?.().then((target) => {
        if (!target) return;
        if (target.route === "automation" && target.credentialGroupId) {
          signInSettingsGroupId = target.credentialGroupId;
        }
        // Settings is only a target for Delete all financial data.
        if (target.route === "settings") focusFinancialDataDeletion = true;
        navigateToRoute(target.route);
      });
    };
    const unsubscribeNotificationTargets = typeof automationApi.onNotificationTargetRequested === "function"
      ? automationApi.onNotificationTargetRequested(takeNotificationTarget)
      : () => {};
    takeNotificationTarget();
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
      financialPage.dispose();
      unsubscribeAutomationRuntime();
      unsubscribeNotificationTargets();
      unsubscribeAutomationController();
      removeEventListener("focus", onAutomationRuntimeResync);
      document.removeEventListener("visibilitychange", onAutomationRuntimeVisibilityChange);
      removeEventListener("hashchange", normalizeRoute);
      removeEventListener("popstate", normalizeRoute);
    };
  });
</script>

{#if financialLiveError}
  <p role="status" data-financial-live-error>
    {$t.common.financialLiveUnavailable}
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
      onboardingEmptyState={onboardingStory?.id === "overview-empty"}
      {onboardingTargets}
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
    />
    <RouteLoadNotice state={liabilities} retry={() => void loadRoute("liabilities", { force: true })} />
  {:else}
    <DashboardShell active="liabilities" eyebrow={routeLabel("liabilities").eyebrow} title={routeLabel("liabilities").title} sideLabel={$t.liabilities.sideLabel}>
      <RouteLoadFallback state={liabilities} retry={() => void loadRoute("liabilities", { force: true })} />
    </DashboardShell>
  {/if}
{:else if route === "spending"}
  {#if spendingRenderValue}
    <PurchaseSpendingDashboard
      purchaseReport={spendingRenderValue.purchaseReport}
      fallbackCanonical={spendingRenderValue.canonical}
      refreshSummary={() => route === "spending" ? financialPage.reload("spending") : Promise.resolve()}
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
      blocks={automationBlocks}
      runtimeSnapshot={automationRuntimeSnapshot}
      runtimeController={automationRuntimeController}
      retryBlock={retryAutomationBlock}
      reload={() => loadRoute("automation", { force: true })}
      overviewLive={$financialState.enabled ? financialPage.overviewStore() : null}
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
      {signInSettingsGroupId}
      onSignInSettingsOpened={() => (signInSettingsGroupId = null)}
      onOpenFinancialDataSettings={() => {
        focusFinancialDataDeletion = true;
        navigateToRoute("settings");
      }}
    />
    <RouteLoadNotice state={automation} retry={() => void loadRoute("automation", { force: true })} />
  {:else}
    <DashboardShell active="automation" eyebrow={routeLabel("automation").eyebrow} title={routeLabel("automation").title} sideLabel={$t.automation.sideLabel}>
      <RouteLoadFallback state={automation} retry={() => void loadRoute("automation", { force: true })} />
    </DashboardShell>
  {/if}
{:else}
  <SettingsPage
    {focusFinancialDataDeletion}
    onFinancialDataDeletionFocused={() => (focusFinancialDataDeletion = false)}
    automationRunActive={automationRuntimeSnapshot?.tasks.some((task) => isActiveAutomationRuntimeStatus(task.status)) ?? false}
    onboardingStatus={onboardingState?.status ?? null}
    onboardingEndedAt={onboardingState?.endedAt ?? null}
    onboardingLinkedSources={settingsAutomation?.linkedSources ?? 0}
    onboardingFirstSyncSucceeded={onboardingState?.overviewReadiness === "accounts"}
    exchangeRateLastRun={settingsAutomation?.exchangeRateLastRun ?? null}
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

{#if showUsageStatisticsPrompt}
  <UsageStatisticsPrompt onAnswer={answerUsageStatistics} />
{/if}

<style>
</style>
