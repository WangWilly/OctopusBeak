<script lang="ts">
  import { onMount } from "svelte";
  import AssetsDashboard from "$lib/assets/AssetsDashboard.svelte";
  import type {
    AssetsPageDto,
    AssetsPrimaryDto,
    AssetsSecondaryDto,
  } from "$lib/assets/types.ts";
  import AutomationDashboard from "$lib/automation/AutomationDashboard.svelte";
  import type { AutomationDesktopModel } from "$lib/desktop/api.ts";
  import { t } from "$lib/i18n/i18n.ts";
  import LiabilitiesDashboard from "$lib/liabilities/LiabilitiesDashboard.svelte";
  import type {
    LiabilitiesPageDto,
    LiabilitiesPrimaryDto,
    LiabilitiesSecondaryDto,
  } from "$lib/liabilities/types.ts";
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
  import type {
    OverviewPageDto,
    OverviewPrimaryDto,
    OverviewSecondaryDto,
  } from "$lib/overview/types.ts";
  import SettingsPage from "$lib/settings/SettingsPage.svelte";
  import { applySystemSettings } from "$lib/settings/system-timezone-store.ts";
  import SpendingDashboard from "$lib/spending/SpendingDashboard.svelte";
  import type {
    SpendingPageDto,
    SpendingPrimaryDto,
    SpendingSecondaryDto,
  } from "$lib/spending/model.ts";
  import FirstRunWelcome from "$lib/welcome/FirstRunWelcome.svelte";
  import { resolveCompletedFirstRunWelcome } from "$lib/welcome/integration.ts";
  import {
    readFirstRunWelcomeState,
    resolveFirstRunWelcomeBoot,
    writeFirstRunWelcomeState,
    type FirstRunWelcomeState,
  } from "$lib/welcome/state.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import FinancialSecondaryFallback from "./FinancialSecondaryFallback.svelte";
  import FinancialSectionError from "./FinancialSectionError.svelte";
  import {
    createFinancialRouteGenerationCoordinator,
    createRouteLoadCache,
    type FinancialRouteGenerationCutoff,
  } from "./route-loader.ts";
  import {
    stableFinancialErrorCode,
    type FinancialErrorCode,
  } from "$lib/shared-ledger/financial-error.ts";
  import { financialPerformanceTelemetry } from "$lib/performance/financial-performance-telemetry.ts";

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
    | { status: "ready"; data: T };
  type SectionState<T> =
    | { status: "loading"; knowledgePoint?: number; updating?: boolean }
    | { status: "error"; message: string; knowledgePoint?: number }
    | { status: "ready"; data: T; knowledgePoint: number };
  type FinancialRouteState<Primary, Secondary> = {
    primary: SectionState<Primary>;
    secondary: SectionState<Secondary>;
    knowledgePoint: number | null;
    stale: boolean;
    updating: boolean;
    refreshError?: string;
  };

  let route: RouteId = "overview";
  let focusAccountId: string | null = null;
  let initialized = false;
  let overview: FinancialRouteState<OverviewPrimaryDto, OverviewSecondaryDto> = createFinancialRouteState();
  let assets: FinancialRouteState<AssetsPrimaryDto, AssetsSecondaryDto> = createFinancialRouteState();
  let liabilities: FinancialRouteState<LiabilitiesPrimaryDto, LiabilitiesSecondaryDto> = createFinancialRouteState();
  let spending: FinancialRouteState<SpendingPrimaryDto, SpendingSecondaryDto> = createFinancialRouteState();
  let automation: LoadState<AutomationDesktopModel> = { status: "loading" };
  let onboardingState: OnboardingState | null = null;
  let firstRunWelcomeState: FirstRunWelcomeState | null = null;
  let completingFirstRunWelcome = false;
  let overviewLoadedForTaskFinishedAt: string | null = null;
  let overviewReloading = false;
  let settingsReady = false;
  const routeDataCache = createRouteLoadCache<RouteData>();
  const financialRoutes: readonly FinancialRoute[] = [
    "overview",
    "assets",
    "liabilities",
    "spending",
  ];
  let freshnessReconcileTimer: ReturnType<typeof setTimeout> | undefined;
  let financialLoadGeneration = 0;
  let activeFinancialReadRequestToken: string | null = null;
  let retryingFinancialRoute: FinancialRoute | null = null;
  let routeNavigationEpoch = 0;
  let suppressNormalizedHashChange = false;

  function createFinancialRouteState<Primary, Secondary>(): FinancialRouteState<Primary, Secondary> {
    return {
      primary: { status: "loading" },
      secondary: { status: "loading" },
      knowledgePoint: null,
      stale: false,
      updating: false,
    };
  }

  function isFinancialRoute(value: RouteId): value is FinancialRoute {
    return financialRoutes.includes(value as FinancialRoute);
  }

  function routeState(nextRoute: FinancialRoute): FinancialRouteState<unknown, unknown> {
    if (nextRoute === "overview") return overview;
    if (nextRoute === "assets") return assets;
    if (nextRoute === "liabilities") return liabilities;
    return spending;
  }

  function updateRouteState(
    nextRoute: FinancialRoute,
    update: (state: FinancialRouteState<unknown, unknown>) => FinancialRouteState<unknown, unknown>,
  ) {
    const current = routeState(nextRoute);
    const next = update(current);
    if (nextRoute === "overview") overview = next as FinancialRouteState<OverviewPrimaryDto, OverviewSecondaryDto>;
    if (nextRoute === "assets") assets = next as FinancialRouteState<AssetsPrimaryDto, AssetsSecondaryDto>;
    if (nextRoute === "liabilities") liabilities = next as FinancialRouteState<LiabilitiesPrimaryDto, LiabilitiesSecondaryDto>;
    if (nextRoute === "spending") spending = next as FinancialRouteState<SpendingPrimaryDto, SpendingSecondaryDto>;
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
      updateRouteState(nextRoute, (state) => ({
        ...state,
        stale: true,
        updating: true,
        refreshError: undefined,
      }));
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
        refreshError: sanitizedFinancialError(error, $t.financialErrors.refreshFailed),
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

  function matchingSecondary<Primary extends { knowledgePoint: number }, Secondary extends { knowledgePoint: number }>(
    state: FinancialRouteState<Primary, Secondary>,
  ): Secondary | null {
    return state.primary.status === "ready"
      && state.secondary.status === "ready"
      && state.secondary.knowledgePoint === state.primary.knowledgePoint
      ? state.secondary.data
      : null;
  }

  function overviewPage(state: FinancialRouteState<OverviewPrimaryDto, OverviewSecondaryDto>): OverviewPageDto | null {
    if (state.primary.status !== "ready") return null;
    const secondary = matchingSecondary(state);
    return {
      ...state.primary.data,
      historyAvailability: secondary?.historyAvailability ?? "unavailable",
      dailyHistory: secondary?.dailyHistory ?? [],
      sankey: secondary?.sankey ?? null,
      sankeyExchangeRates: secondary?.sankeyExchangeRates ?? [],
      sankeyLatestExchangeRateDate: secondary?.sankeyLatestExchangeRateDate ?? null,
      exchangeRates: secondary?.exchangeRates ?? [],
      latestExchangeRateDate: secondary?.latestExchangeRateDate ?? null,
      knowledgePoint: state.primary.knowledgePoint,
    };
  }

  function assetsPage(state: FinancialRouteState<AssetsPrimaryDto, AssetsSecondaryDto>): AssetsPageDto | null {
    if (state.primary.status !== "ready") return null;
    const secondary = matchingSecondary(state);
    return {
      ...state.primary.data,
      dailyHistoryByAccount: secondary?.dailyHistoryByAccount ?? {},
      dailyHistory: secondary?.dailyHistory ?? [],
      knowledgePoint: state.primary.knowledgePoint,
    };
  }

  function liabilitiesPage(state: FinancialRouteState<LiabilitiesPrimaryDto, LiabilitiesSecondaryDto>): LiabilitiesPageDto | null {
    if (state.primary.status !== "ready") return null;
    const secondary = matchingSecondary(state);
    return {
      ...state.primary.data,
      dailyHistoryByAccount: secondary?.dailyHistoryByAccount ?? {},
      dailyHistory: secondary?.dailyHistory ?? [],
      knowledgePoint: state.primary.knowledgePoint,
    };
  }

  function spendingPage(state: FinancialRouteState<SpendingPrimaryDto, SpendingSecondaryDto>): SpendingPageDto | null {
    if (state.primary.status !== "ready") return null;
    const secondary = matchingSecondary(state);
    return {
      ...state.primary.data,
      purchaseReport: secondary?.purchaseReport ?? state.primary.data.purchaseReport,
      invoices: secondary?.invoices ?? state.primary.data.invoices,
      knowledgePoint: state.primary.knowledgePoint,
    };
  }

  $: overviewData = overviewPage(overview);
  $: assetsData = assetsPage(assets);
  $: liabilitiesData = liabilitiesPage(liabilities);
  $: spendingData = spendingPage(spending);
  $: spendingSecondaryReady = matchingSecondary(spending) !== null;

  $: onboardingFacts = factsForOnboarding(
    route,
    automation.status === "ready" ? automation.data : null,
    overviewData,
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
    if (!location.hash || next !== route || encodedId === "" || (!acceptsId && encodedId) || (encodedId && !id) || extraSegments.length > 0) {
      suppressNormalizedHashChange = true;
      location.hash = canonicalHash;
    }
    generationCoordinator.setVisibleRoute(isFinancialRoute(route) ? route : null);
    if (!settingsReady) return;
    const load = loadRoute(route);
    if (isFinancialRoute(route)) {
      void load.then(() => generationCoordinator.reconcile()).catch((error) => {
        console.warn("financial-freshness-route-reconcile-failed", stableFinancialErrorCode(error));
      });
    }
  }

  function sanitizedFinancialError(error: unknown, fallback = $t.financialErrors.generic) {
    const code = stableFinancialErrorCode(error);
    const messages: Partial<Record<FinancialErrorCode, string>> = {
      "financial-section-knowledge-point-mismatch": $t.financialErrors.knowledgePointMismatch,
      "canonical-cutoff-unavailable": $t.financialErrors.cutoffUnavailable,
      "validation-failed": $t.financialErrors.validationFailed,
      "worker-closed": $t.financialErrors.workerClosed,
      "worker-exit": $t.financialErrors.workerExit,
      "worker-error": $t.financialErrors.workerError,
      contention: $t.financialErrors.contention,
      cancelled: $t.financialErrors.cancelled,
    };
    return messages[code] ?? fallback;
  }

  function refreshStatus(state: FinancialRouteState<unknown, unknown>): string | null {
    if (state.updating) return $t.financialErrors.refreshing;
    if (state.refreshError) return $t.financialErrors.refreshFailed;
    return state.stale ? $t.financialErrors.newerData : null;
  }

  function sectionError(state: SectionState<unknown>): string {
    return state.status === "error" ? state.message : $t.financialErrors.generic;
  }

  async function retryFinancialRoute(next: FinancialRoute) {
    // A retry is explicitly user initiated. The lock prevents double clicks
    // from starting overlapping generations or turning a persistent failure
    // into a tight retry loop.
    if (route !== next || retryingFinancialRoute !== null) return;
    const state = routeState(next);
    if (state.primary.status === "loading" || state.secondary.status === "loading") return;
    retryingFinancialRoute = next;
    try {
      // loadRoute obtains one latest cutoff for both sections, preserving the
      // same generation/knowledge-point boundary as normal route entry. A
      // secondary-only retry keeps the already usable primary view visible.
      await loadRoute(next, {
        force: true,
        background: state.primary.status === "ready",
      });
    } finally {
      if (retryingFinancialRoute === next) retryingFinancialRoute = null;
    }
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

  async function resolveFirstRunWelcome(startedAtNavigationEpoch: number) {
    if (startedAtNavigationEpoch !== routeNavigationEpoch) return;
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
      const [automationData, overviewSection] = await Promise.all([
        routeDataCache.load("automation", () => window.octopusBeak.automation.load()),
        window.octopusBeak.overview.loadSection("primary"),
      ]);
      // Eligibility is a background read, not a route load. A user may have
      // navigated while it was in flight; in that case keep the chosen route
      // and let its own generation query own the visible state.
      if (startedAtNavigationEpoch !== routeNavigationEpoch) return;
      firstRunWelcomeState = resolveFirstRunWelcomeBoot({
        welcomeState: null,
        onboardingState: null,
        overview: { accounts: overviewSection.value.accounts, importedAt: overviewSection.value.importedAt },
        automation: { tasks: automationData.automation.tasks },
      });
      writeFirstRunWelcomeState(localStorage, firstRunWelcomeState);
    } catch {
      console.warn("welcome-eligibility-load-failed");
    }
  }

  type FinancialSectionResultValue<T> = Readonly<{
    knowledgePoint: number;
    value: T;
  }>;

  function sectionInput(cutoff: FinancialRouteGenerationCutoff) {
    return { cutoff };
  }

  function financialReadRequestToken(generation: number): string {
    const randomUuid = globalThis.crypto?.randomUUID?.();
    return randomUuid
      ? `financial-generation-${generation}-${randomUuid}`
      : `financial-generation-${generation}`;
  }

  function isCurrentFinancialLoad(next: FinancialRoute, token: number, signal?: AbortSignal) {
    return token === financialLoadGeneration && route === next && !signal?.aborted;
  }

  async function loadFinancialRouteSections(
    next: FinancialRoute,
    options: {
      force?: boolean;
      background?: boolean;
      cutoff?: FinancialRouteGenerationCutoff;
      generation?: number;
      signal?: AbortSignal;
      waitForSecondary?: boolean;
      onRequestToken?: (token: number) => void;
    },
  ): Promise<void> {
    const currentState = routeState(next);
    const telemetry = financialPerformanceTelemetry.startOperation("financial-load");
    telemetry.startSpan("page-shell").finish();
    if (
      !options.force
      && !options.background
      && options.generation === undefined
      && currentState.primary.status === "ready"
      && (currentState.secondary.status === "ready" || currentState.stale)
    ) return;

    const cutoff = options.cutoff ?? {
      knowledgePoint: await window.octopusBeak.financialFreshness.latestKnowledgePoint(),
    };
    const token = ++financialLoadGeneration;
    options.onRequestToken?.(token);
    const requestToken = financialReadRequestToken(token);
    const previousRequestToken = activeFinancialReadRequestToken;
    activeFinancialReadRequestToken = requestToken;
    if (previousRequestToken) {
      void window.octopusBeak.financial.cancel(previousRequestToken).catch((error) => {
        console.warn("financial-read-cancel-failed", stableFinancialErrorCode(error));
      });
    }
    let cancellationRequested = false;
    const cancelRead = () => {
      if (cancellationRequested) return;
      cancellationRequested = true;
      void window.octopusBeak.financial.cancel(requestToken).catch((error) => {
        console.warn("financial-read-cancel-failed", stableFinancialErrorCode(error));
      });
    };
    if (options.signal?.aborted) cancelRead();
    else options.signal?.addEventListener("abort", cancelRead, { once: true });
    const cleanupRequest = () => {
      options.signal?.removeEventListener("abort", cancelRead);
      if (activeFinancialReadRequestToken === requestToken) {
        activeFinancialReadRequestToken = null;
      }
    };
    if (options.signal?.aborted) {
      cleanupRequest();
      return;
    }
    let keepCancellationUntilSecondary = false;
    try {
    const background = Boolean(options.background && currentState.primary.status === "ready");
    if (!background) {
      updateRouteState(next, (state) => ({
        ...state,
        primary: { status: "loading", knowledgePoint: cutoff.knowledgePoint },
        secondary: { status: "loading", knowledgePoint: cutoff.knowledgePoint },
        knowledgePoint: state.knowledgePoint,
        stale: false,
        updating: false,
        refreshError: undefined,
      }));
    }

    let secondaryResult: FinancialSectionResultValue<unknown> | undefined;
    let secondaryError: unknown;
    let primarySettled = false;
    const isCurrent = () => isCurrentFinancialLoad(next, token, options.signal);

    const applyPrimary = (result: FinancialSectionResultValue<unknown>) => {
      if (!isCurrent()) return;
      if (result.knowledgePoint !== cutoff.knowledgePoint) {
        throw new Error("financial-section-knowledge-point-mismatch");
      }
      primarySettled = true;
      updateRouteState(next, (state) => ({
        ...state,
        primary: {
          status: "ready",
          data: result.value,
          knowledgePoint: result.knowledgePoint,
        },
        // A new primary generation invalidates the old secondary. It cannot
        // remain visible while its query is still at the previous cutoff.
        secondary: { status: "loading", knowledgePoint: cutoff.knowledgePoint, updating: background },
        knowledgePoint: result.knowledgePoint,
        updating: background,
        refreshError: undefined,
      }));
      if (secondaryResult) applySecondary(secondaryResult);
      if (secondaryError) applySecondaryError(secondaryError);
    };

    const applySecondary = (result: FinancialSectionResultValue<unknown>) => {
      if (!isCurrent()) return;
      if (result.knowledgePoint !== cutoff.knowledgePoint) {
        const error = new Error("financial-section-knowledge-point-mismatch");
        secondaryError = error;
        applySecondaryError(error);
        return;
      }
      secondaryResult = result;
      // An initial primary failure must not hide a secondary section that
      // already completed. During a background refresh, however, the new
      // secondary cannot replace the old generation until its primary has
      // also completed.
      if (!primarySettled && background) return;
      updateRouteState(next, (state) => ({
        ...state,
        secondary: {
          status: "ready",
          data: result.value,
          knowledgePoint: result.knowledgePoint,
        },
      }));
    };

    const applySecondaryError = (error: unknown) => {
      if (!isCurrent() || (background && !primarySettled)) return;
      updateRouteState(next, (state) => ({
        ...state,
        secondary: {
          status: "error",
          message: sanitizedFinancialError(error, $t.financialErrors.generic),
          knowledgePoint: cutoff.knowledgePoint,
        },
      }));
    };

    const loaders = (() => {
      const input = sectionInput(cutoff);
      const requestOptions = { requestToken };
      if (next === "overview") {
        return {
          primary: () => window.octopusBeak.overview.loadSection("primary", input, requestOptions),
          secondary: () => window.octopusBeak.overview.loadSection("secondary", input, requestOptions),
        };
      }
      if (next === "assets") {
        return {
          primary: () => window.octopusBeak.assets.loadSection("primary", input, requestOptions),
          secondary: () => window.octopusBeak.assets.loadSection("secondary", input, requestOptions),
        };
      }
      if (next === "liabilities") {
        return {
          primary: () => window.octopusBeak.liabilities.loadSection("primary", input, requestOptions),
          secondary: () => window.octopusBeak.liabilities.loadSection("secondary", input, requestOptions),
        };
      }
      return {
        primary: () => window.octopusBeak.spending.loadSection("primary", input, requestOptions),
        secondary: () => window.octopusBeak.spending.loadSection("secondary", input, requestOptions),
      };
    })();

    const primarySpan = telemetry.startSpan("primary-load", {
      knowledgePointDistance: currentState.knowledgePoint === null
        ? null
        : Math.max(0, cutoff.knowledgePoint - currentState.knowledgePoint),
    });
    const secondarySpan = telemetry.startSpan("secondary-load", {
      knowledgePointDistance: currentState.knowledgePoint === null
        ? null
        : Math.max(0, cutoff.knowledgePoint - currentState.knowledgePoint),
    });
    const invokeLoader = (loader: () => Promise<FinancialSectionResultValue<unknown>>) =>
      Promise.resolve().then(() => loader());
    const primaryPromise = invokeLoader(loaders.primary as () => Promise<FinancialSectionResultValue<unknown>>).then((result) => {
      primarySpan.finish("success", {
        knowledgePointDistance: Math.abs(result.knowledgePoint - cutoff.knowledgePoint),
      });
      applyPrimary(result);
      return result;
    }, (error: unknown) => {
      primarySpan.finish("error", { error });
      if (isCurrent() && !background) {
        updateRouteState(next, (state) => ({
          ...state,
          primary: {
            status: "error",
            message: sanitizedFinancialError(error),
            knowledgePoint: cutoff.knowledgePoint,
          },
          updating: false,
        }));
      }
      throw error;
    });
    const secondaryPromise = invokeLoader(loaders.secondary as () => Promise<FinancialSectionResultValue<unknown>>).then((result) => {
      secondarySpan.finish("success", {
        knowledgePointDistance: Math.abs(result.knowledgePoint - cutoff.knowledgePoint),
      });
      applySecondary(result);
      return result;
    }, (error: unknown) => {
      secondarySpan.finish("error", { error });
      secondaryError = error;
      applySecondaryError(error);
      return undefined;
    });
    keepCancellationUntilSecondary = true;
    void secondaryPromise.then(cleanupRequest, cleanupRequest);

    await primaryPromise;
    if (options.waitForSecondary) {
      const completedSecondary = await secondaryPromise;
      if (secondaryError) throw secondaryError;
      const completedState = routeState(next);
      if (
        !completedSecondary
        || !isCurrent()
        || completedState.primary.status !== "ready"
        || completedState.secondary.status !== "ready"
        || completedState.primary.knowledgePoint !== cutoff.knowledgePoint
        || completedState.secondary.knowledgePoint !== cutoff.knowledgePoint
      ) {
        throw new Error("financial-secondary-generation-incomplete");
      }
    }
    if (options.generation === undefined && isCurrent()) {
      generationCoordinator.markRouteLoaded(next, cutoff.knowledgePoint);
      if (next === "overview") overviewLoadedForTaskFinishedAt = taskFinishedAtForOverview();
    }
    } finally {
      if (!keepCancellationUntilSecondary) cleanupRequest();
    }
  }

  function taskFinishedAtForOverview() {
    return automation.status === "ready"
      ? completedSourceTaskFinishedAt(
        automation.data.automation.tasks,
        onboardingState?.selectedCredentialGroupId ?? null,
      )
      : null;
  }

  async function loadRoute(
    next: RouteId,
    options: {
      force?: boolean;
      background?: boolean;
      cutoff?: FinancialRouteGenerationCutoff;
      generation?: number;
      signal?: AbortSignal;
      waitForSecondary?: boolean;
    } = {},
  ) {
    if (next === "overview") overviewReloading = true;
    let requestToken: number | undefined;
    try {
      if (isFinancialRoute(next)) {
        await loadFinancialRouteSections(next, {
          ...options,
          onRequestToken: (token) => {
            requestToken = token;
          },
        });
      }
      if (next === "automation") {
        automation = {
          status: "ready",
          data: await routeDataCache.load("automation", () => window.octopusBeak.automation.load(), options),
        };
      }
    } catch (error) {
      if (options.background && isFinancialRoute(next)) {
        const activeRequest = requestToken !== undefined
          && requestToken === financialLoadGeneration
          && route === next
          && !options.signal?.aborted;
        if (!activeRequest) return;
        updateRouteState(next, (state) => ({
          ...state,
          stale: true,
          updating: false,
          refreshError: sanitizedFinancialError(error, $t.financialErrors.refreshFailed),
        }));
        throw error;
      }
      if (isFinancialRoute(next)) {
        updateRouteState(next, (state) => ({
          ...state,
          primary: { status: "error", message: sanitizedFinancialError(error) },
          updating: false,
        }));
      }
      if (next === "automation") automation = { status: "error", message: $t.automation.loadFailed };
    } finally {
      if (next === "overview") overviewReloading = false;
    }
  }

  /**
   * Spending commands use a sparse response on their fast path. If that
   * response is stale or its transport outcome is uncertain, the command
   * component asks the page coordinator for one complete, cutoff-pinned
   * Spending generation before declaring the outcome known.
   */
  async function reconcileSpendingAction() {
    while (route === "spending") {
      const knowledgePoint = await window.octopusBeak.financialFreshness.latestKnowledgePoint();
      await loadRoute("spending", {
        force: true,
        background: true,
        cutoff: { knowledgePoint },
        waitForSecondary: true,
      });
      const secondary = matchingSecondary(spending);
      if (
        secondary
        && spending.primary.status === "ready"
        && spending.primary.knowledgePoint === knowledgePoint
        && secondary.knowledgePoint === knowledgePoint
      ) return;

      // A newer commit may have cancelled this exact-cutoff read. Reconcile
      // directly to the newest point without ever exposing the old response as
      // a confirmed action outcome.
      const latestKnowledgePoint = await window.octopusBeak.financialFreshness.latestKnowledgePoint();
      if (latestKnowledgePoint === knowledgePoint) {
        throw new Error("spending-action-reconciliation-incomplete");
      }
    }
    throw new Error("spending-action-reconciliation-cancelled");
  }

  function scheduleFreshnessReconciliation() {
    if (freshnessReconcileTimer) clearTimeout(freshnessReconcileTimer);
    freshnessReconcileTimer = setTimeout(() => {
      freshnessReconcileTimer = undefined;
      if (!settingsReady || !isFinancialRoute(route)) return;
      void generationCoordinator.reconcile().catch((error) => {
        console.warn("financial-freshness-reconcile-failed", stableFinancialErrorCode(error));
      });
    }, 50);
  }

  onMount(() => {
    const onWindowFocus = () => scheduleFreshnessReconciliation();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleFreshnessReconciliation();
    };
    const onPageShow = () => scheduleFreshnessReconciliation();
    const onHashChange = () => {
      if (suppressNormalizedHashChange) {
        suppressNormalizedHashChange = false;
        normalizeRoute();
        return;
      }
      routeNavigationEpoch += 1;
      normalizeRoute();
    };
    addEventListener("focus", onWindowFocus);
    addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    addEventListener("hashchange", onHashChange);
    const unsubscribeFreshnessRecovery = window.octopusBeak?.financialFreshness
      ?.subscribeRecovery(scheduleFreshnessReconciliation);
    scheduleFreshnessReconciliation();
    onboardingState = readOnboardingState(localStorage);
    // Parse the route before any asynchronous bootstrap. This mounts the
    // shell and its navigation controls without waiting for settings,
    // Automation, or financial queries.
    normalizeRoute();
    initialized = true;
    const welcomeStartedAtNavigationEpoch = routeNavigationEpoch;
    void window.octopusBeak.settings.load()
      .then((value) => applySystemSettings(value))
      .catch((error) => console.warn("system-settings-load-failed", stableFinancialErrorCode(error)))
      .then(() => {
        settingsReady = true;
        generationCoordinator.start();
        normalizeRoute();
        void resolveFirstRunWelcome(welcomeStartedAtNavigationEpoch);
    });
    return () => {
      removeEventListener("hashchange", onHashChange);
      removeEventListener("focus", onWindowFocus);
      removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unsubscribeFreshnessRecovery?.();
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
  {#if overviewData}<OverviewDashboard overview={overviewData} />{:else}
    <DashboardShell active="overview" eyebrow={$t.overview.eyebrow} title={$t.overview.title} sideLabel={$t.overview.sideLabel}>
      {#if overview.primary.status === "loading"}
        <div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>
      {:else}
        <FinancialSectionError
          route="overview"
          section="primary"
          message={sectionError(overview.primary)}
          role="alert"
          retrying={retryingFinancialRoute === "overview"}
          onRetry={() => void retryFinancialRoute("overview")}
        />
      {/if}
    </DashboardShell>
  {/if}
  {#if refreshStatus(overview)}<p class="route-freshness" role="status">{refreshStatus(overview)}</p>{/if}
  {#if overview.primary.status !== "ready" && overview.secondary.status === "ready"}
    <FinancialSecondaryFallback kind="overview" data={overview.secondary.data} />
  {/if}
  {#if overview.secondary.status === "loading"}<p class="route-freshness" role="status">{$t.common.loading}</p>{/if}
  {#if overview.secondary.status === "error"}
    <FinancialSectionError
      route="overview"
      section="secondary"
      message={$t.financialErrors.secondaryUnavailable}
      retrying={retryingFinancialRoute === "overview"}
      onRetry={() => void retryFinancialRoute("overview")}
    />
  {/if}
{:else if route === "assets"}
  {#if assetsData}<AssetsDashboard assets={assetsData} {focusAccountId} />{:else}
    <DashboardShell active="assets" eyebrow={$t.assets.eyebrow} title={$t.assets.title} sideLabel={$t.assets.sideLabel} searchPlaceholder={$t.assets.searchPlaceholder}>
      {#if assets.primary.status === "loading"}
        <div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>
      {:else}
        <FinancialSectionError
          route="assets"
          section="primary"
          message={sectionError(assets.primary)}
          role="alert"
          retrying={retryingFinancialRoute === "assets"}
          onRetry={() => void retryFinancialRoute("assets")}
        />
      {/if}
    </DashboardShell>
  {/if}
  {#if refreshStatus(assets)}<p class="route-freshness" role="status">{refreshStatus(assets)}</p>{/if}
  {#if assets.primary.status !== "ready" && assets.secondary.status === "ready"}
    <FinancialSecondaryFallback kind="assets" data={assets.secondary.data} />
  {/if}
  {#if assets.secondary.status === "loading"}<p class="route-freshness" role="status">{$t.common.loading}</p>{/if}
  {#if assets.secondary.status === "error"}
    <FinancialSectionError
      route="assets"
      section="secondary"
      message={$t.financialErrors.secondaryUnavailable}
      retrying={retryingFinancialRoute === "assets"}
      onRetry={() => void retryFinancialRoute("assets")}
    />
  {/if}
{:else if route === "liabilities"}
  {#if liabilitiesData}<LiabilitiesDashboard liabilities={liabilitiesData} {focusAccountId} />{:else}
    <DashboardShell active="liabilities" eyebrow={$t.liabilities.eyebrow} title={$t.liabilities.title} sideLabel={$t.liabilities.sideLabel} searchPlaceholder={$t.liabilities.searchPlaceholder}>
      {#if liabilities.primary.status === "loading"}
        <div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>
      {:else}
        <FinancialSectionError
          route="liabilities"
          section="primary"
          message={sectionError(liabilities.primary)}
          role="alert"
          retrying={retryingFinancialRoute === "liabilities"}
          onRetry={() => void retryFinancialRoute("liabilities")}
        />
      {/if}
    </DashboardShell>
  {/if}
  {#if refreshStatus(liabilities)}<p class="route-freshness" role="status">{refreshStatus(liabilities)}</p>{/if}
  {#if liabilities.primary.status !== "ready" && liabilities.secondary.status === "ready"}
    <FinancialSecondaryFallback kind="liabilities" data={liabilities.secondary.data} />
  {/if}
  {#if liabilities.secondary.status === "loading"}<p class="route-freshness" role="status">{$t.common.loading}</p>{/if}
  {#if liabilities.secondary.status === "error"}
    <FinancialSectionError
      route="liabilities"
      section="secondary"
      message={$t.financialErrors.secondaryUnavailable}
      retrying={retryingFinancialRoute === "liabilities"}
      onRetry={() => void retryFinancialRoute("liabilities")}
    />
  {/if}
{:else if route === "spending"}
  {#if spendingData}
    <SpendingDashboard
      spending={spendingData}
      purchaseReportReady={spendingSecondaryReady}
      onActionReconciliation={reconcileSpendingAction}
    />
  {:else}
    <DashboardShell active="spending" eyebrow={$t.spending.eyebrow} title={$t.spending.title} sideLabel={$t.spending.sideLabel}>
      {#if spending.primary.status === "loading"}
        <div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>
      {:else}
        <FinancialSectionError
          route="spending"
          section="primary"
          message={sectionError(spending.primary)}
          role="alert"
          retrying={retryingFinancialRoute === "spending"}
          onRetry={() => void retryFinancialRoute("spending")}
        />
      {/if}
    </DashboardShell>
  {/if}
  {#if spendingData && !spendingSecondaryReady && spending.secondary.status === "loading"}
    <p class="route-freshness" data-spending-secondary-state="loading" role="status">{$t.financialErrors.spendingSecondaryLoading}</p>
  {/if}
  {#if refreshStatus(spending)}<p class="route-freshness" role="status">{refreshStatus(spending)}</p>{/if}
  {#if spending.primary.status !== "ready" && spending.secondary.status === "ready"}
    <FinancialSecondaryFallback kind="spending" data={spending.secondary.data} />
  {/if}
  {#if spending.secondary.status === "loading" && !spendingData}
    <p class="route-freshness" role="status">{$t.common.loading}</p>
  {/if}
  {#if spendingData && !spendingSecondaryReady && spending.secondary.status === "error"}
    <FinancialSectionError
      route="spending"
      section="secondary"
      stateMarker="error"
      message={$t.financialErrors.secondaryUnavailable}
      retrying={retryingFinancialRoute === "spending"}
      onRetry={() => void retryFinancialRoute("spending")}
    />
  {:else if spending.secondary.status === "error"}
    <FinancialSectionError
      route="spending"
      section="secondary"
      message={$t.financialErrors.secondaryUnavailable}
      retrying={retryingFinancialRoute === "spending"}
      onRetry={() => void retryFinancialRoute("spending")}
    />
  {/if}
{:else if route === "automation"}
  {#if automation.status === "ready"}
    <AutomationDashboard
      automation={automation.data.automation}
      credentialGroups={automation.data.credentialGroups}
      reload={() => loadRoute("automation", { force: true })}
      onAutomationRunSettled={scheduleFreshnessReconciliation}
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
