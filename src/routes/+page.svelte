<script lang="ts">
  import { onMount, setContext } from "svelte";
  import { writable } from "svelte/store";
  import AssetsDashboard from "$lib/assets/AssetsDashboard.svelte";
  import type { AssetsPageDto } from "$lib/assets/types.ts";
  import AutomationDashboard from "$lib/automation/AutomationDashboard.svelte";
  import type { AutomationDesktopModel } from "$lib/desktop/api.ts";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import LiabilitiesDashboard from "$lib/liabilities/LiabilitiesDashboard.svelte";
  import type { LiabilitiesPageDto } from "$lib/liabilities/types.ts";
  import OnboardingCoach from "$lib/onboarding/OnboardingCoach.svelte";
  import {
    completedSourceTaskFinishedAt,
    createOnboardingState,
    readOnboardingState,
    writeOnboardingState,
    type OnboardingState,
  } from "$lib/onboarding/state.ts";
  import {
    resolveOnboardingStep,
    shouldNarrowOnboardingSources,
    type CredentialSetupResult,
    type OnboardingFacts,
    type OnboardingRoute,
  } from "$lib/onboarding/progression.ts";
  import OverviewDashboard from "$lib/overview/OverviewDashboard.svelte";
  import type { OverviewPageDto } from "$lib/overview/types.ts";
  import SettingsPage from "$lib/settings/SettingsPage.svelte";
  import { applySystemSettings } from "$lib/settings/system-timezone-store.ts";
  import SpendingDashboard from "$lib/spending/SpendingDashboard.svelte";
  import type { SpendingPageDto } from "$lib/spending/model.ts";
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
  import {
    beginIndependentBlocks,
    loadIndependentBlocks,
    type DashboardBlockKey,
    type BlockState,
    type BlockStateMap,
  } from "$lib/shared-shell/block-load-state.ts";
  import {
    type DataReadOptions,
    type DataVersionSnapshot,
  } from "$lib/shared-shell/data-version.ts";
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
    overview: OverviewPageDto;
    assets: AssetsPageDto;
    liabilities: LiabilitiesPageDto;
    spending: SpendingPageDto;
    automation: AutomationDesktopModel;
  };
  type LoadState<T> = ViewLoadState<T>;

  let route: RouteId = "overview";
  let focusAccountId: string | null = null;
  let overview: LoadState<OverviewPageDto> = { status: "loading" };
  let assets: LoadState<AssetsPageDto> = { status: "loading" };
  let liabilities: LoadState<LiabilitiesPageDto> = { status: "loading" };
  let spending: LoadState<SpendingPageDto> = { status: "loading" };
  let automation: LoadState<AutomationDesktopModel> = { status: "loading" };
  let onboardingState: OnboardingState | null = null;
  let firstRunWelcomeState: FirstRunWelcomeState | null = null;
  let completingFirstRunWelcome = false;
  let overviewLoadedForTaskFinishedAt: string | null = null;
  let overviewReloading = false;
  const routeDataCache = createRouteLoadCache<RouteData>();
  const refreshUi = writable<RefreshUiState>(initialRefreshUiState);
  const blockKeys: Readonly<Record<DashboardRoute, readonly DashboardBlockKey[]>> = {
    overview: ["summary", "chart", "list", "details"],
    assets: ["summary", "chart", "list"],
    liabilities: ["summary", "chart", "list", "details"],
    spending: ["summary", "chart", "list", "details"],
    automation: ["summary", "list", "details"],
  };
  let routeBlocks: Partial<Record<DashboardRoute, BlockStateMap<unknown>>> = {};
  let routeBlockLoadIds: Partial<Record<DashboardRoute, number>> = {};

  setContext(REFRESH_CONTEXT_KEY, {
    state: refreshUi,
    refresh: refreshApp,
  });

  function factsForOnboarding(
    nextRoute: RouteId,
    automationData: AutomationDesktopModel | null,
    overviewData: OverviewPageDto | null,
    overviewLoadedAt: string | null,
  ): OnboardingFacts {
    return {
      route: nextRoute,
      automation: automationData
        ? {
          tasks: automationData.automation.tasks,
          credentialGroups: automationData.credentialGroups,
          credentials: automationData.automation.credentials,
        }
        : null,
      overview: overviewData
        ? { accounts: overviewData.accounts, importedAt: overviewData.importedAt }
        : null,
      overviewLoadedForTaskFinishedAt: overviewLoadedAt,
    };
  }

  $: onboardingFacts = factsForOnboarding(
    route,
    viewData(automation) ?? null,
    viewData(overview) ?? null,
    overviewLoadedForTaskFinishedAt,
  );
  $: overviewValue = viewData(overview);
  $: assetsValue = viewData(assets);
  $: liabilitiesValue = viewData(liabilities);
  $: spendingValue = viewData(spending);
  $: automationValue = viewData(automation);
  $: activeBlocks = route === "settings" ? {} : routeBlocks[route] ?? {};
  $: onboardingStep = resolveOnboardingStep(onboardingFacts, onboardingState);
  $: onboardingCompact = automationValue
    && onboardingStep === "collection"
    && automationValue.automation.tasks.some((task) =>
      task.isActive
      && task.credentialGroupId === onboardingState?.selectedCredentialGroupId,
    );
  $: if (
    route === "overview"
    && onboardingStep === "overview"
    && !overviewReloading
    && automation.status === "ready"
    && completedSourceTaskFinishedAt(
      automation.data.automation.tasks,
      onboardingState?.selectedCredentialGroupId ?? null,
    ) !== overviewLoadedForTaskFinishedAt
  ) {
    routeDataCache.clearAll();
    void loadRoute("overview", { force: true });
  }

  function normalizeRoute() {
    const [next, encodedId, ...extraSegments] = location.hash.replace(/^#\/?/, "").split("/");
    route = ["overview", "assets", "liabilities", "spending", "automation", "settings"].includes(next) ? next as RouteId : "overview";
    const acceptsId = route === "assets" || route === "liabilities";
    let id: string | null = null;
    try {
      id = acceptsId && encodedId ? decodeURIComponent(encodedId) : null;
    } catch {
      id = null;
    }
    focusAccountId = route === "assets" || route === "liabilities" ? id : null;
    const canonicalHash = id ? `/${route}/${encodeURIComponent(id)}` : `/${route}`;
    if (!location.hash || next !== route || encodedId === "" || (!acceptsId && encodedId) || (encodedId && !id) || extraSegments.length > 0) location.hash = canonicalHash;
    void loadRoute(route);
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
    states: BlockStateMap<unknown>,
  ) {
    routeBlocks = { ...routeBlocks, [nextRoute]: states };
  }

  function loadRouteBlock(
    nextRoute: DashboardRoute,
    key: DashboardBlockKey,
    options: DataReadOptions | undefined,
  ): Promise<unknown> {
    if (nextRoute === "overview") return window.octopusBeak.overview.loadBlock(key, options);
    if (nextRoute === "assets") return window.octopusBeak.assets.loadBlock(key, options);
    if (nextRoute === "liabilities") return window.octopusBeak.liabilities.loadBlock(key, options);
    if (nextRoute === "spending") return window.octopusBeak.spending.loadBlock(key, options);
    return window.octopusBeak.automation.loadBlock(key, options);
  }

  function startRouteBlockLoads(
    nextRoute: DashboardRoute,
    options: DataReadOptions | undefined,
    onlyKey?: DashboardBlockKey,
  ) {
    const loadId = (routeBlockLoadIds[nextRoute] ?? 0) + 1;
    routeBlockLoadIds = { ...routeBlockLoadIds, [nextRoute]: loadId };
    const keys = onlyKey ? [onlyKey] : blockKeys[nextRoute];
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
      () => loadRouteBlock(nextRoute, key, options),
    ])) as Record<string, () => Promise<unknown>>;
    void loadIndependentBlocks(loaders, (key, state) => {
      if (routeBlockLoadIds[nextRoute] !== loadId) return;
      setRouteBlocks(nextRoute, {
        ...(routeBlocks[nextRoute] ?? {}),
        [key]: state,
      });
    });
  }

  function retryRouteBlock(nextRoute: DashboardRoute, key: string) {
    const cached = routeDataCache.read(nextRoute);
    if (cached) {
      startRouteBlockLoads(nextRoute, undefined, key as DashboardBlockKey);
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
      overview: (snapshot) => loadRoute("overview", { force: true, rethrow: true, snapshot }),
      assets: (snapshot) => loadRoute("assets", { force: true, rethrow: true, snapshot }),
      liabilities: (snapshot) => loadRoute("liabilities", { force: true, rethrow: true, snapshot }),
      spending: (snapshot) => loadRoute("spending", { force: true, rethrow: true, snapshot }),
      automation: (snapshot) => loadRoute("automation", { force: true, rethrow: true, snapshot }),
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
    const destinationHash = `#/${nextRoute}`;
    if (location.hash !== destinationHash) history.pushState(history.state, "", destinationHash);
    normalizeRoute();
  }

  function completeFirstRunWelcome() {
    if (!firstRunWelcomeState) return;
    const destination = resolveCompletedFirstRunWelcome(firstRunWelcomeState);
    if (!destination) return;
    if (destination.onboardingState) saveOnboarding(destination.onboardingState);
    navigateToRoute(destination.route);
    completingFirstRunWelcome = false;
  }

  function pauseOnboarding() {
    if (onboardingState) saveOnboarding({ ...onboardingState, status: "paused" });
  }

  function resumeOnboarding() {
    saveOnboarding(onboardingState
      ? { ...onboardingState, status: "active" }
      : createOnboardingState());
    location.hash = "/automation";
  }

  function restartOnboarding() {
    saveOnboarding(createOnboardingState());
    location.hash = "/automation";
  }

  function finishOnboarding() {
    if (onboardingState) saveOnboarding({ ...onboardingState, status: "completed" });
  }

  function selectOnboardingSource({ selectedCredentialGroupId, sourceConfiguredAt }: CredentialSetupResult) {
    const current = onboardingState ?? createOnboardingState();
    saveOnboarding({
      ...current,
      selectedCredentialGroupId,
      sourceConfiguredAt,
      status: "active",
    });
  }

  function addOnboardingSource() {
    finishOnboarding();
    location.hash = "/automation";
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-onboarding="automation-credentials"]')?.click();
    });
  }

  function backOnboarding() {
    location.hash = route === "automation" ? "/overview" : "/automation";
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
    startRouteBlockLoads("automation", undefined);
    startRouteBlockLoads("overview", undefined);
    const settled = await settleIndependentLoads({
      automation: () => routeDataCache.load("automation", () => window.octopusBeak.automation.load()),
      overview: () => routeDataCache.load("overview", () => window.octopusBeak.overview.load()),
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
      overviewLoadedForTaskFinishedAt = null;
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
    options: { force?: boolean; rethrow?: boolean; snapshot?: DataVersionSnapshot } = {},
  ) {
    const readOptions: DataReadOptions | undefined = options.snapshot
      ? { expectedVersion: options.snapshot.version }
      : undefined;
    const taskFinishedAt = next === "overview" && automation.status === "ready"
      ? completedSourceTaskFinishedAt(
        automation.data.automation.tasks,
        onboardingState?.selectedCredentialGroupId ?? null,
      )
      : null;
    startRouteLoad(next);
    if (next !== "settings") {
      const hasCachedData = routeDataCache.read(next) !== undefined;
      const hasBlockRead = Object.values(routeBlocks[next] ?? {}).some((state) => state.status === "loading");
      if (options.force || !hasCachedData && !hasBlockRead) startRouteBlockLoads(next, readOptions);
    }
    if (next === "overview") overviewReloading = true;
    try {
      if (next === "overview") {
        const data = await routeDataCache.load(
          "overview",
          () => window.octopusBeak.overview.load(readOptions),
          options,
        );
        overview = finishViewLoad(data);
        overviewLoadedForTaskFinishedAt = taskFinishedAt;
      }
      if (next === "assets") {
        const data = await routeDataCache.load("assets", () => window.octopusBeak.assets.load(readOptions), options);
        assets = finishViewLoad(data);
      }
      if (next === "liabilities") {
        const data = await routeDataCache.load("liabilities", () => window.octopusBeak.liabilities.load(readOptions), options);
        liabilities = finishViewLoad(data);
      }
      if (next === "spending") {
        const data = await routeDataCache.load("spending", () => window.octopusBeak.spending.load(undefined, readOptions), options);
        spending = finishViewLoad(data);
      }
      if (next === "automation") {
        const data = await routeDataCache.load("automation", () => window.octopusBeak.automation.load(readOptions), options);
        automation = finishViewLoad(data);
      }
    } catch (error) {
      failRouteLoad(next, error);
      if (options.rethrow) throw error;
    } finally {
      if (next === "overview") overviewReloading = false;
    }
  }

  onMount(() => {
    onboardingState = readOnboardingState(localStorage);
    void window.octopusBeak.settings.load()
      .then((value) => applySystemSettings(value))
      .catch((error) => console.warn("system-settings-load-failed", error));
    void resolveFirstRunWelcome();
    normalizeRoute();
    void window.octopusBeak.data.getVersion()
      .then((snapshot) => refreshUi.set({
        status: snapshot.stale ? "stale" : "current",
        version: snapshot.version,
        changedAt: snapshot.changedAt,
        failed: [],
        staleDuringRefresh: false,
      }))
      .catch((error) => console.warn("data-version-query-failed", error));
    const unsubscribe = window.octopusBeak.data.onInvalidated((event) => {
      refreshUi.update((state) => markRefreshInvalidated(state, event));
    });
    addEventListener("hashchange", normalizeRoute);
    return () => {
      unsubscribe();
      removeEventListener("hashchange", normalizeRoute);
    };
  });
</script>

{#if firstRunWelcomeState?.status === "active" || completingFirstRunWelcome}
  {#if firstRunWelcomeState}
    <FirstRunWelcome
      state={firstRunWelcomeState}
      onStateChange={saveFirstRunWelcome}
      onComplete={completeFirstRunWelcome}
    />
  {/if}
{:else if route === "overview"}
  {#if overviewValue}
    <OverviewDashboard
      overview={overviewValue}
      blocks={activeBlocks}
      retryBlock={(key) => retryRouteBlock("overview", key)}
    />
    <RouteLoadNotice state={overview} retry={() => void loadRoute("overview", { force: true })} />
  {:else}
    <DashboardShell active="overview" eyebrow={routeLabel("overview").eyebrow} title={routeLabel("overview").title} sideLabel={$t.overview.sideLabel}>
      <RouteLoadFallback state={overview} retry={() => void loadRoute("overview", { force: true })} />
    </DashboardShell>
  {/if}
{:else if route === "assets"}
  {#if assetsValue}
    <AssetsDashboard
      assets={assetsValue}
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
  {#if liabilitiesValue}
    <LiabilitiesDashboard
      liabilities={liabilitiesValue}
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
  {#if spendingValue}
    <SpendingDashboard
      spending={spendingValue}
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
  {#if automationValue}
    <AutomationDashboard
      automation={automationValue.automation}
      credentialGroups={automationValue.credentialGroups}
      blocks={activeBlocks}
      retryBlock={(key) => retryRouteBlock("automation", key)}
      reload={() => loadRoute("automation", { force: true })}
      onboardingSourceSelection={onboardingStep === "credentials"}
      onboardingSingleSource={shouldNarrowOnboardingSources(
        onboardingFacts,
        onboardingState,
        onboardingStep,
      )}
      {onboardingStep}
      onboardingSelectedCredentialGroupId={onboardingState?.selectedCredentialGroupId ?? null}
      onOnboardingSourceSaved={selectOnboardingSource}
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
    onResumeOnboarding={resumeOnboarding}
    onRestartOnboarding={restartOnboarding}
  />
{/if}

{#if onboardingState && firstRunWelcomeState?.status !== "active" && !completingFirstRunWelcome}
  <OnboardingCoach
    step={onboardingStep}
    state={onboardingState}
    {route}
    onPause={pauseOnboarding}
    onFinish={finishOnboarding}
    onAddSource={addOnboardingSource}
    onBack={backOnboarding}
    onRetryTarget={() => loadRoute(route, { force: true })}
    compact={onboardingCompact}
  />
{/if}

<style>
</style>
