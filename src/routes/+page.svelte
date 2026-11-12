<script lang="ts">
  import { onMount, setContext, tick } from "svelte";
  import { get, writable } from "svelte/store";
  import AssetsDashboard from "$lib/assets/AssetsDashboard.svelte";
  import AutomationDashboard from "$lib/automation/AutomationDashboard.svelte";
  import UsageStatisticsPrompt from "$lib/settings/UsageStatisticsPrompt.svelte";
  import { createAutomationPageState } from "$lib/automation/automation-page-state.ts";
  import type { AutomationActionStart, AutomationStopRequested } from "$lib/automation/automation-actions.ts";
  import {
    type AutomationActionToken,
    type AutomationBlockRefreshReason,
  } from "$lib/automation/runtime-controller.ts";
  import { mergeAutomationRuntime } from "$lib/automation/runtime-sync.ts";
  import { isActiveAutomationRuntimeStatus } from "$lib/automation/task-row.ts";
  import type {
    AutomationDesktopModel,
    AutomationRuntimeSnapshot,
    SettingsFocus,
  } from "$lib/desktop/api.ts";
  import { t } from "$lib/i18n/i18n.ts";
  import type { AppUpdateView } from "$lib/settings/app-updates.ts";
  import { APP_UPDATE_CONTEXT_KEY, type AppUpdateUiContext } from "$lib/shared-shell/app-update-context.ts";
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
  import { applySystemSettings, taipeiDate, usageStatisticsEnabled } from "$lib/settings/system-timezone-store.ts";
  import PurchaseSpendingDashboard from "$lib/spending/components/PurchaseSpendingDashboard.svelte";
  import CashFlowDashboard from "$lib/cash-flow/components/CashFlowDashboard.svelte";
  import type { CashFlowPageRequest } from "$lib/cash-flow/model.ts";
  import { quickRange, rollRange } from "$lib/cash-flow/period.ts";
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
    type RefreshResult,
  } from "$lib/shared-shell/refresh-coordinator.ts";
  import type { DashboardBlockKey } from "$lib/shared-shell/block-load-state.ts";
  import type { DataVersionSnapshot } from "$lib/shared-shell/data-version.ts";
  import { installDataVersionLifecycle } from "$lib/shared-shell/data-version-lifecycle.ts";
  import {
    initialRefreshUiState,
    REFRESH_CONTEXT_KEY,
    type RefreshUiState,
  } from "$lib/shared-shell/refresh-context.ts";
  import type { ViewLoadState } from "$lib/shared-shell/view-load-state.ts";
  import {
    acceptVersionSnapshot,
    beginRefresh,
    failRefresh,
    markRefreshInvalidated,
    settleRefresh,
  } from "$lib/shared-shell/refresh-ui-state.ts";
  import { settleIndependentLoads } from "./route-loader.ts";
  import { automationBlockValue, automationRouteModel, createAutomationRouteLoader } from "./automation-route-loader.ts";

  type RouteId = OnboardingRoute;

  let route: RouteId = "overview";
  let focusAccountId: string | null = null;
  let cashFlowToday = get(taipeiDate);
  let cashFlowRequest: CashFlowPageRequest = quickRange("month", cashFlowToday);
  const financialPage = createFinancialPage({ dataViews: window.octopusBeak?.dataViews, params: { "cash-flow": cashFlowRequest } });
  const financialState = financialPage.state;
  $: overview = $financialState.routes.overview.load;
  $: assets = $financialState.routes.assets.load;
  $: liabilities = $financialState.routes.liabilities.load;
  $: spending = $financialState.routes.spending.load;
  $: cashFlow = $financialState.routes["cash-flow"].load;
  // Only the current route's live failure is announced.
  $: financialLiveError = isFinancialRoute(route) && $financialState.routes[route].liveError;
  const automationRoute = createAutomationRouteLoader({
    loadBlock: (key, options) => window.octopusBeak.automation.loadBlock(key, options),
    runtime: () => get(automationState).runtime,
  });
  const automationRouteState = automationRoute.state;
  $: automation = $automationRouteState.view;
  $: automationBlocks = $automationRouteState.blocks;
  // Runtime ownership lives at the app shell so route changes never drop
  // events or lose the latest state while Automation is off-screen.
  const automationState = createAutomationPageState({
    // Read the bridge per call: the shell starts before any Automation request is made.
    api: {
      run: (taskId) => window.octopusBeak.automation.run(taskId),
      runMany: (taskIds) => window.octopusBeak.automation.runMany(taskIds),
      cancel: (taskId, expectedRunId) => window.octopusBeak.automation.cancel(taskId, expectedRunId),
      forceTerminate: (taskId, expectedRunId) => window.octopusBeak.automation.forceTerminate(taskId, expectedRunId),
      runtimeSnapshot: () => window.octopusBeak.automation.runtimeSnapshot(),
      fatalRuntimeSnapshot: () => window.octopusBeak.automation.fatalRuntimeSnapshot(),
    },
    requestReload: (reason) => {
      if (reason === "poll" && route !== "automation") return;
      return loadRoute("automation", {
        force: true,
        ...(reason === "session-resync" ? { automationRefreshReason: "session-resync" } : {}),
      });
    },
  });
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
  let settingsFocus: SettingsFocus | null = null;
  let firstRunWelcomeState: FirstRunWelcomeState | null = null;
  let completingFirstRunWelcome = false;
  const refreshUi = writable<RefreshUiState>(initialRefreshUiState);

  setContext(REFRESH_CONTEXT_KEY, {
    state: refreshUi,
    refresh: refreshApp,
  });

  const appUpdateView = writable<AppUpdateView | null>(null);
  const automationRunActive = writable(false);
  $: automationRunActive.set(
    $automationState.runtime?.tasks.some((task) => isActiveAutomationRuntimeStatus(task.status)) ?? false,
  );
  setContext<AppUpdateUiContext>(APP_UPDATE_CONTEXT_KEY, {
    view: appUpdateView,
    runActive: automationRunActive,
    check: async () => appUpdateView.set(await window.octopusBeak.appUpdates.check()),
    download: async () => appUpdateView.set(await window.octopusBeak.appUpdates.download()),
    restart: () => window.octopusBeak.appUpdates.restart(),
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
    $automationState.runtime,
    $automationState.pendingActions,
  );
  $: overviewValue = viewData(overview);
  $: assetsValue = viewData(assets);
  $: liabilitiesValue = viewData(liabilities);
  $: spendingValue = viewData(spending);
  $: cashFlowValue = viewData(cashFlow);
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
    const requestedRoute = ["overview", "assets", "liabilities", "spending", "cash-flow", "automation", "settings"].includes(next)
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
    const hasAutomationData = automationRoute.hasData();
    if (isFinancialRoute(route) && $financialState.enabled) return;
    // Settings reports source and exchange-rate status from Automation's data.
    void loadRoute(
      route === "settings" ? "automation" : route,
      route === "automation" && previousRoute !== "automation" && hasAutomationData
        ? { automationRefreshReason: "route-entry" }
        : {},
    );
  }

  function changeCashFlowRequest(next: CashFlowPageRequest) {
    cashFlowRequest = next;
    financialPage.setParams("cash-flow", next);
  }

  // 本週, 本月 and 近 30 天 follow the Taipei date past midnight; a custom range stays put.
  $: rollCashFlowPeriod($taipeiDate);
  function rollCashFlowPeriod(today: string) {
    if (today === cashFlowToday) return;
    const next = rollRange(cashFlowRequest, cashFlowToday, today);
    cashFlowToday = today;
    if (next.startDate === cashFlowRequest.startDate && next.endDate === cashFlowRequest.endDate) return;
    changeCashFlowRequest({ ...next, ...(cashFlowRequest.query ? { query: cashFlowRequest.query } : {}) });
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
    if (nextRoute === "cash-flow") return { eyebrow: $t.cashFlow.eyebrow, title: $t.cashFlow.title };
    if (nextRoute === "automation") return { eyebrow: $t.automation.eyebrow, title: $t.automation.title };
    return { eyebrow: $t.settings.eyebrow, title: $t.settings.title };
  }


  $: overviewRenderValue = overviewValue;
  $: assetsRenderValue = assetsValue;
  $: liabilitiesRenderValue = liabilitiesValue;
  $: spendingRenderValue = spendingValue;
  $: automationRenderValue = automationRouteModel($automationRouteState);
  $: automationState.setModel(
    automationBlockValue(automationBlocks, "list")?.automation ?? automationRenderValue?.automation ?? null,
  );
  $: settingsAutomation = route === "settings" && automationRenderValue
    ? {
      linkedSources: linkedSourceCount(automationRenderValue.credentialGroups, automationRenderValue.automation.credentials),
      exchangeRateLastRun: latestExchangeRateRun(
        mergeAutomationRuntime(automationRenderValue.automation, $automationState.runtime, $automationState.pendingActions).tasks,
      ),
    }
    : null;

  function retryAutomationBlock(key: string) {
    automationRoute.retry(key as DashboardBlockKey);
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
      "cash-flow": (snapshot) => loadRoute("cash-flow", { force: true, rethrow: true, awaitBlocks: true, snapshot }),
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
        const latest = automationRouteModel(get(automationRouteState));
        if (!latest) throw new Error("Automation data unavailable.");
        return latest;
      },
      runtimeSnapshot: async () => {
        const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
        automationState.acceptSnapshot(snapshot);
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
      cancelTask: (taskId, expectedRunId) => settleOnboardingStop(automationState.cancel({
        id: taskId,
        status: $automationState.live?.tasks.find((task) => task.id === taskId)?.status ?? "running",
      }, expectedRunId)),
      forceTerminateTask: (taskId, expectedRunId) => settleOnboardingStop(automationState.forceTerminate(taskId, expectedRunId)),
    }));
    onboardingController.hydrate(onboardingState);
    return onboardingController;
  }

  async function settleOnboardingStop(
    stop: AutomationActionStart<AutomationStopRequested> | null,
  ) {
    const result = await stop?.settled;
    if (result?.error) throw new Error(result.error);
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

    const settled = await settleIndependentLoads({
      automation: async () => {
        const data = await automationRoute.load({ reason: "route-entry", rethrow: true });
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

    if (!automationData && automationResult?.status === "rejected") {
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
    if (next !== "automation") return;
    await automationRoute.load({
      ...(options.force ? { force: true } : {}),
      ...(options.rethrow ? { rethrow: true } : {}),
      ...(options.awaitBlocks ? { awaitBlocks: true } : {}),
      ...(options.refreshCredentials ? { refreshCredentials: true } : {}),
      ...(options.snapshot ? { snapshot: options.snapshot } : {}),
      ...(options.automationRefreshReason ? { reason: options.automationRefreshReason } : {}),
    });
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
        refreshUi.update((state) => acceptVersionSnapshot(state, snapshot));
      },
      onQueryError: (error) => console.warn("data-version-query-failed", error),
    });
    const automationApi = window.octopusBeak.automation;
    automationState.connect({
      runtimeChanged: (listener) => automationApi.onRuntimeChanged(listener),
      resync: (listener) => {
        const onVisibilityChange = () => {
          if (document.visibilityState === "visible") listener();
        };
        addEventListener("focus", listener);
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
          removeEventListener("focus", listener);
          document.removeEventListener("visibilitychange", onVisibilityChange);
        };
      },
    });
    const takeNotificationTarget = () => {
      void automationApi.takeNotificationTarget().then((target) => {
        if (!target) return;
        if (target.route === "automation" && target.credentialGroupId) {
          signInSettingsGroupId = target.credentialGroupId;
        }
        if (target.route === "settings") settingsFocus = target.focus;
        navigateToRoute(target.route);
      });
    };
    const unsubscribeNotificationTargets = automationApi.onNotificationTargetRequested(takeNotificationTarget);
    takeNotificationTarget();
    addEventListener("hashchange", normalizeRoute);
    addEventListener("popstate", normalizeRoute);
    const unsubscribeAppUpdates = window.octopusBeak.appUpdates.onChanged((view) => appUpdateView.set(view));
    void window.octopusBeak.appUpdates.view().then((view) => appUpdateView.set(view)).catch(() => undefined);
    return () => {
      unsubscribeAppUpdates();
      mounted = false;
      dataVersionLifecycle.dispose();
      financialPage.dispose();
      unsubscribeNotificationTargets();
      // Ends the runtime connection too.
      automationState.dispose();
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
      manualPurchases={spendingRenderValue.manual?.purchases ?? []}
      refreshSummary={() => route === "spending" ? financialPage.reload("spending") : Promise.resolve()}
    />
    <RouteLoadNotice state={spending} retry={() => void loadRoute("spending", { force: true })} />
  {:else}
    <DashboardShell active="spending" eyebrow={routeLabel("spending").eyebrow} title={routeLabel("spending").title} sideLabel={$t.overview.sideLabel}>
      <RouteLoadFallback state={spending} retry={() => void loadRoute("spending", { force: true })} />
    </DashboardShell>
  {/if}
{:else if route === "cash-flow"}
  {#if cashFlowValue}
    <CashFlowDashboard
      page={cashFlowValue}
      request={cashFlowRequest}
      today={$taipeiDate}
      loading={cashFlow.status === "loading"}
      changeRequest={changeCashFlowRequest}
    />
    <RouteLoadNotice state={cashFlow} retry={() => void loadRoute("cash-flow", { force: true })} />
  {:else}
    <DashboardShell active="cash-flow" eyebrow={routeLabel("cash-flow").eyebrow} title={routeLabel("cash-flow").title} sideLabel={$t.cashFlow.sideLabel}>
      <RouteLoadFallback state={cashFlow} retry={() => void loadRoute("cash-flow", { force: true })} />
    </DashboardShell>
  {/if}
{:else if route === "automation"}
  {#if automationRenderValue}
    <AutomationDashboard
      bind:this={automationDashboard}
      state={automationState}
      credentialGroups={automationRenderValue.credentialGroups}
      blocks={automationBlocks}
      retryBlock={retryAutomationBlock}
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
        settingsFocus = "financial-data-deletion";
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
    focus={settingsFocus}
    onFocused={() => (settingsFocus = null)}
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
