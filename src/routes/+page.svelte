<script lang="ts">
  import { onMount } from "svelte";
  import AssetsDashboard from "$lib/assets/AssetsDashboard.svelte";
  import type { AssetsPageDto } from "$lib/assets/types.ts";
  import AutomationDashboard from "$lib/automation/AutomationDashboard.svelte";
  import type { AutomationDesktopModel } from "$lib/desktop/api.ts";
  import { t } from "$lib/i18n/i18n.ts";
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
  import {
    createFinancialRouteGenerationCoordinator,
    createRouteLoadCache,
    type FinancialRouteGenerationCutoff,
  } from "./route-loader.ts";

  type RouteId = OnboardingRoute;
  type FinancialRoute = "overview" | "assets" | "liabilities" | "spending";
  type RouteData = {
    overview: OverviewPageDto;
    assets: AssetsPageDto;
    liabilities: LiabilitiesPageDto;
    spending: SpendingPageDto;
    automation: AutomationDesktopModel;
  };
  type LoadState<T> =
    | { status: "loading" }
    | { status: "error"; message: string }
    | {
      status: "ready";
      data: T;
      knowledgePoint?: number | null;
      stale?: boolean;
      updating?: boolean;
      refreshError?: string;
    };

  let route: RouteId = "overview";
  let focusAccountId: string | null = null;
  let initialized = false;
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
  const financialRoutes: readonly FinancialRoute[] = [
    "overview",
    "assets",
    "liabilities",
    "spending",
  ];
  let freshnessReconcileTimer: ReturnType<typeof setTimeout> | undefined;

  function isFinancialRoute(value: RouteId): value is FinancialRoute {
    return financialRoutes.includes(value as FinancialRoute);
  }

  function routeState(nextRoute: FinancialRoute): LoadState<unknown> {
    if (nextRoute === "overview") return overview;
    if (nextRoute === "assets") return assets;
    if (nextRoute === "liabilities") return liabilities;
    return spending;
  }

  function updateRouteState(
    nextRoute: FinancialRoute,
    update: (state: Extract<LoadState<unknown>, { status: "ready" }>) => Extract<LoadState<unknown>, { status: "ready" }>,
  ) {
    const current = routeState(nextRoute);
    if (current.status !== "ready") return;
    const next = update(current);
    if (nextRoute === "overview") overview = next as LoadState<OverviewPageDto>;
    if (nextRoute === "assets") assets = next as LoadState<AssetsPageDto>;
    if (nextRoute === "liabilities") liabilities = next as LoadState<LiabilitiesPageDto>;
    if (nextRoute === "spending") spending = next as LoadState<SpendingPageDto>;
  }

  const generationCoordinator = createFinancialRouteGenerationCoordinator<FinancialRoute>({
    routes: financialRoutes,
    subscribe: (listener) => {
      const freshness = window.octopusBeak?.financialFreshness;
      return freshness?.subscribe(listener) ?? (() => {});
    },
    latestKnowledgePoint: () => {
      const freshness = window.octopusBeak?.financialFreshness;
      return freshness?.latestKnowledgePoint() ?? Promise.resolve(0);
    },
    load: ({ route: nextRoute, cutoff, generation, signal }) => loadRoute(nextRoute, {
      force: true,
      background: true,
      cutoff,
      generation,
      signal,
    }),
    onRouteStale: (nextRoute, knowledgePoint) => {
      routeDataCache.markStale(nextRoute, knowledgePoint);
      updateRouteState(nextRoute, (state) => ({
        ...state,
        stale: true,
        refreshError: undefined,
      }));
    },
    onRouteRefreshStart: (nextRoute) => {
      updateRouteState(nextRoute, (state) => ({ ...state, stale: true, updating: true }));
    },
    onRouteFresh: (nextRoute, knowledgePoint) => {
      routeDataCache.markFresh(nextRoute, knowledgePoint);
      updateRouteState(nextRoute, (state) => ({
        ...state,
        knowledgePoint,
        stale: false,
        updating: false,
        refreshError: undefined,
      }));
    },
    onRouteRefreshError: (nextRoute, error) => {
      updateRouteState(nextRoute, (state) => ({
        ...state,
        stale: true,
        updating: false,
        refreshError: error,
      }));
    },
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
    automation.status === "ready" ? automation.data : null,
    overview.status === "ready" ? overview.data : null,
    overviewLoadedForTaskFinishedAt,
  );
  $: onboardingStep = resolveOnboardingStep(onboardingFacts, onboardingState);
  $: onboardingCompact = automation.status === "ready"
    && onboardingStep === "collection"
    && automation.data.automation.tasks.some((task) =>
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
    generationCoordinator.setVisibleRoute(isFinancialRoute(route) ? route : null);
    const load = loadRoute(route);
    if (isFinancialRoute(route)) {
      void load.then(() => generationCoordinator.reconcile()).catch((error) => {
        console.warn("financial-freshness-route-reconcile-failed", error);
      });
    }
  }

  function message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  function knowledgePointFrom(value: unknown, fallback: number | null = null): number | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
    const knowledgePoint = (value as { knowledgePoint?: unknown }).knowledgePoint;
    return typeof knowledgePoint === "number"
      && Number.isSafeInteger(knowledgePoint)
      && knowledgePoint >= 0
      ? knowledgePoint
      : fallback;
  }

  function shouldDiscardOlderRouteResult(
    nextRoute: FinancialRoute,
    data: unknown,
    options: { generation?: number; cutoff?: FinancialRouteGenerationCutoff },
  ) {
    if (options.generation !== undefined) return false;
    const loaded = knowledgePointFrom(data, options.cutoff?.knowledgePoint ?? null);
    const cached = routeDataCache.knowledgePoint(nextRoute);
    return loaded !== null && cached !== null && cached > loaded;
  }

  function refreshStatus<T>(state: LoadState<T>): string | null {
    if (state.status !== "ready") return null;
    if (state.updating) return "更新中…";
    if (state.refreshError) return "更新失敗，暫時顯示舊資料";
    return state.stale ? "有較新的資料可用" : null;
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

    try {
      const [automationData, overviewData] = await Promise.all([
        routeDataCache.load("automation", () => window.octopusBeak.automation.load()),
        routeDataCache.load("overview", () => window.octopusBeak.overview.load()),
      ]);
      automation = { status: "ready", data: automationData };
      const knowledgePoint = knowledgePointFrom(overviewData);
      overview = {
        status: "ready",
        data: overviewData,
        knowledgePoint,
        stale: false,
        updating: false,
      };
      generationCoordinator.markRouteLoaded("overview", knowledgePoint);
      overviewLoadedForTaskFinishedAt = null;
      firstRunWelcomeState = resolveFirstRunWelcomeBoot({
        welcomeState: null,
        onboardingState: null,
        overview: { accounts: overviewData.accounts, importedAt: overviewData.importedAt },
        automation: { tasks: automationData.automation.tasks },
      });
      writeFirstRunWelcomeState(localStorage, firstRunWelcomeState);
    } catch (error) {
      console.warn("welcome-eligibility-load-failed", message(error));
    }
  }

  async function loadRoute(
    next: RouteId,
    options: {
      force?: boolean;
      background?: boolean;
      cutoff?: FinancialRouteGenerationCutoff;
      generation?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    const taskFinishedAt = next === "overview" && automation.status === "ready"
      ? completedSourceTaskFinishedAt(
        automation.data.automation.tasks,
        onboardingState?.selectedCredentialGroupId ?? null,
      )
      : null;
    if (next === "overview") overviewReloading = true;
    try {
      if (next === "overview") {
        const data = await routeDataCache.load(
          "overview",
          () => window.octopusBeak.overview.load(options.cutoff ? { cutoff: options.cutoff } : undefined),
          options,
        );
        if (options.generation !== undefined && (options.signal?.aborted || route !== next)) return;
        if (shouldDiscardOlderRouteResult(next, data, options)) return;
        const knowledgePoint = knowledgePointFrom(data, options.cutoff?.knowledgePoint ?? null);
        overview = {
          status: "ready",
          data,
          knowledgePoint,
          stale: routeDataCache.isStale(next),
          updating: Boolean(options.background),
        };
        if (options.generation === undefined) {
          routeDataCache.markFresh(next, knowledgePoint);
          generationCoordinator.markRouteLoaded(next, knowledgePoint);
        }
        overviewLoadedForTaskFinishedAt = taskFinishedAt;
      }
      if (next === "assets") {
        const data = await routeDataCache.load(
          "assets",
          () => window.octopusBeak.assets.load(options.cutoff ? { cutoff: options.cutoff } : undefined),
          options,
        );
        if (options.generation !== undefined && (options.signal?.aborted || route !== next)) return;
        if (shouldDiscardOlderRouteResult(next, data, options)) return;
        const knowledgePoint = knowledgePointFrom(data, options.cutoff?.knowledgePoint ?? null);
        assets = {
          status: "ready",
          data,
          knowledgePoint,
          stale: routeDataCache.isStale(next),
          updating: Boolean(options.background),
        };
        if (options.generation === undefined) {
          routeDataCache.markFresh(next, knowledgePoint);
          generationCoordinator.markRouteLoaded(next, knowledgePoint);
        }
      }
      if (next === "liabilities") {
        const data = await routeDataCache.load(
          "liabilities",
          () => window.octopusBeak.liabilities.load(options.cutoff ? { cutoff: options.cutoff } : undefined),
          options,
        );
        if (options.generation !== undefined && (options.signal?.aborted || route !== next)) return;
        if (shouldDiscardOlderRouteResult(next, data, options)) return;
        const knowledgePoint = knowledgePointFrom(data, options.cutoff?.knowledgePoint ?? null);
        liabilities = {
          status: "ready",
          data,
          knowledgePoint,
          stale: routeDataCache.isStale(next),
          updating: Boolean(options.background),
        };
        if (options.generation === undefined) {
          routeDataCache.markFresh(next, knowledgePoint);
          generationCoordinator.markRouteLoaded(next, knowledgePoint);
        }
      }
      if (next === "spending") {
        const data = await routeDataCache.load(
          "spending",
          () => window.octopusBeak.spending.load(options.cutoff ? { cutoff: options.cutoff } : undefined),
          options,
        );
        if (options.generation !== undefined && (options.signal?.aborted || route !== next)) return;
        if (shouldDiscardOlderRouteResult(next, data, options)) return;
        const knowledgePoint = knowledgePointFrom(data, options.cutoff?.knowledgePoint ?? null);
        spending = {
          status: "ready",
          data,
          knowledgePoint,
          stale: routeDataCache.isStale(next),
          updating: Boolean(options.background),
        };
        if (options.generation === undefined) {
          routeDataCache.markFresh(next, knowledgePoint);
          generationCoordinator.markRouteLoaded(next, knowledgePoint);
        }
      }
      if (next === "automation") {
        automation = {
          status: "ready",
          data: await routeDataCache.load("automation", () => window.octopusBeak.automation.load(), options),
        };
      }
    } catch (error) {
      if (options.background && isFinancialRoute(next)) {
        updateRouteState(next, (state) => ({
          ...state,
          stale: true,
          updating: false,
          refreshError: message(error),
        }));
        throw error;
      }
      const failed = { status: "error" as const, message: message(error) };
      if (next === "overview") overview = failed;
      if (next === "assets") assets = failed;
      if (next === "liabilities") liabilities = failed;
      if (next === "spending") spending = failed;
      if (next === "automation") automation = failed;
    } finally {
      if (next === "overview") overviewReloading = false;
    }
  }

  function scheduleFreshnessReconciliation() {
    if (freshnessReconcileTimer) clearTimeout(freshnessReconcileTimer);
    freshnessReconcileTimer = setTimeout(() => {
      freshnessReconcileTimer = undefined;
      if (!isFinancialRoute(route)) return;
      void generationCoordinator.reconcile().catch((error) => {
        console.warn("financial-freshness-reconcile-failed", error);
      });
    }, 50);
  }

  onMount(() => {
    generationCoordinator.start();
    const onWindowFocus = () => scheduleFreshnessReconciliation();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleFreshnessReconciliation();
    };
    const onPageShow = () => scheduleFreshnessReconciliation();
    addEventListener("focus", onWindowFocus);
    addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    scheduleFreshnessReconciliation();
    void window.octopusBeak.settings.load()
      .then((value) => applySystemSettings(value))
      .catch((error) => console.warn("system-settings-load-failed", error))
      .then(async () => {
        onboardingState = readOnboardingState(localStorage);
        await resolveFirstRunWelcome();
        initialized = true;
        normalizeRoute();
    });
    addEventListener("hashchange", normalizeRoute);
    return () => {
      removeEventListener("hashchange", normalizeRoute);
      removeEventListener("focus", onWindowFocus);
      removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (freshnessReconcileTimer) clearTimeout(freshnessReconcileTimer);
      freshnessReconcileTimer = undefined;
      generationCoordinator.stop();
    };
  });
</script>

{#if !initialized}
  <div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>
{:else if firstRunWelcomeState?.status === "active" || completingFirstRunWelcome}
  {#if firstRunWelcomeState}
    <FirstRunWelcome
      state={firstRunWelcomeState}
      onStateChange={saveFirstRunWelcome}
      onComplete={completeFirstRunWelcome}
    />
  {/if}
{:else if route === "overview"}
  {#if overview.status === "ready"}<OverviewDashboard overview={overview.data} />{/if}
  {#if refreshStatus(overview)}<p class="route-freshness" role="status">{refreshStatus(overview)}</p>{/if}
  {#if overview.status === "loading"}<div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>{/if}
  {#if overview.status === "error"}<p class="status">{overview.message}</p>{/if}
{:else if route === "assets"}
  {#if assets.status === "ready"}<AssetsDashboard assets={assets.data} {focusAccountId} />{/if}
  {#if refreshStatus(assets)}<p class="route-freshness" role="status">{refreshStatus(assets)}</p>{/if}
  {#if assets.status === "loading"}<div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>{/if}
  {#if assets.status === "error"}<p class="status">{assets.message}</p>{/if}
{:else if route === "liabilities"}
  {#if liabilities.status === "ready"}<LiabilitiesDashboard liabilities={liabilities.data} {focusAccountId} />{/if}
  {#if refreshStatus(liabilities)}<p class="route-freshness" role="status">{refreshStatus(liabilities)}</p>{/if}
  {#if liabilities.status === "loading"}<div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>{/if}
  {#if liabilities.status === "error"}<p class="status">{liabilities.message}</p>{/if}
{:else if route === "spending"}
  {#if spending.status === "ready"}<SpendingDashboard spending={spending.data} />{/if}
  {#if refreshStatus(spending)}<p class="route-freshness" role="status">{refreshStatus(spending)}</p>{/if}
  {#if spending.status === "loading"}<div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>{/if}
  {#if spending.status === "error"}<p class="status">{spending.message}</p>{/if}
{:else if route === "automation"}
  {#if automation.status === "ready"}
    <AutomationDashboard
      automation={automation.data.automation}
      credentialGroups={automation.data.credentialGroups}
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
  {/if}
  {#if automation.status === "loading"}<div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>{/if}
  {#if automation.status === "error"}<p class="status">{automation.message}</p>{/if}
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
  .status {
    margin: 32px;
    color: var(--muted);
  }

  .route-freshness {
    margin: 0 var(--space-4) var(--space-4);
    color: var(--muted);
    font-size: 0.875rem;
  }

  .loading-status {
    min-height: calc(100vh - var(--topbar-height, 0px));
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
  }

  .loading-spinner {
    width: 18px;
    height: 18px;
    flex: 0 0 auto;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: loading-spin 700ms linear infinite;
  }

  @keyframes loading-spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .loading-spinner { animation: none; }
  }
</style>
