<script lang="ts">
  import { onMount } from "svelte";
  import AssetsDashboard from "$lib/assets/AssetsDashboard.svelte";
  import type { AssetsPageDto } from "$lib/assets/types.ts";
  import AutomationDashboard from "$lib/automation/AutomationDashboard.svelte";
  import type { AutomationDesktopModel } from "$lib/desktop/api.ts";
  import DataIssuesDashboard from "$lib/data-issues/DataIssuesDashboard.svelte";
  import { t } from "$lib/i18n/i18n.ts";
  import LiabilitiesDashboard from "$lib/liabilities/LiabilitiesDashboard.svelte";
  import type { LiabilitiesPageDto } from "$lib/liabilities/types.ts";
  import OnboardingCoach from "$lib/onboarding/OnboardingCoach.svelte";
  import {
    completedImportFinishedAt,
    createOnboardingState,
    readOnboardingState,
    writeOnboardingState,
    type OnboardingState,
  } from "$lib/onboarding/state.ts";
  import {
    hasExistingProductData,
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

  type RouteId = OnboardingRoute;
  type LoadState<T> =
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; data: T };

  let route: RouteId = "overview";
  let dataIssueId: string | null = null;
  let focusAccountId: string | null = null;
  let initialized = false;
  let overview: LoadState<OverviewPageDto> = { status: "loading" };
  let assets: LoadState<AssetsPageDto> = { status: "loading" };
  let liabilities: LoadState<LiabilitiesPageDto> = { status: "loading" };
  let spending: LoadState<SpendingPageDto> = { status: "loading" };
  let automation: LoadState<AutomationDesktopModel> = { status: "loading" };
  let onboardingState: OnboardingState | null = null;
  let onboardingEligibilityChecked = false;
  let overviewLoadedForImportFinishedAt: string | null = null;
  let overviewReloading = false;

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
          importGateLocked: automationData.automation.importGate.locked,
        }
        : null,
      overview: overviewData
        ? { accounts: overviewData.accounts, importedAt: overviewData.importedAt }
        : null,
      overviewLoadedForImportFinishedAt: overviewLoadedAt,
    };
  }

  $: onboardingFacts = factsForOnboarding(
    route,
    automation.status === "ready" ? automation.data : null,
    overview.status === "ready" ? overview.data : null,
    overviewLoadedForImportFinishedAt,
  );
  $: onboardingStep = resolveOnboardingStep(onboardingFacts, onboardingState);
  $: onboardingCompact = automation.status === "ready"
    && (onboardingStep === "collection" || onboardingStep === "import")
    && automation.data.automation.tasks.some((task) =>
      task.isActive
      && (onboardingStep === "import"
        ? task.id === "import-downloads-csv"
        : task.credentialGroupId === onboardingState?.selectedCredentialGroupId),
    );
  $: if (
    initialized
    && !onboardingEligibilityChecked
    && (route !== "overview" || overview.status !== "loading")
    && (route !== "automation" || automation.status !== "loading")
  ) {
    onboardingEligibilityChecked = true;
    void checkOnboardingEligibility();
  }
  $: if (
    route === "overview"
    && onboardingStep === "overview"
    && !overviewReloading
    && automation.status === "ready"
    && completedImportFinishedAt(automation.data.automation.tasks)
  ) {
    void loadRoute("overview");
  }

  function normalizeRoute() {
    const [next, encodedId, ...extraSegments] = location.hash.replace(/^#\/?/, "").split("/");
    route = ["overview", "assets", "liabilities", "spending", "automation", "data-issues", "settings"].includes(next) ? next as RouteId : "overview";
    const acceptsId = route === "assets" || route === "liabilities" || route === "data-issues";
    let id: string | null = null;
    try {
      id = acceptsId && encodedId ? decodeURIComponent(encodedId) : null;
    } catch {
      id = null;
    }
    dataIssueId = route === "data-issues" ? id : null;
    focusAccountId = route === "assets" || route === "liabilities" ? id : null;
    const canonicalHash = id ? `/${route}/${encodeURIComponent(id)}` : `/${route}`;
    if (!location.hash || next !== route || encodedId === "" || (!acceptsId && encodedId) || (encodedId && !id) || extraSegments.length > 0) location.hash = canonicalHash;
    void loadRoute(route);
  }

  function message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  function saveOnboarding(next: OnboardingState) {
    onboardingState = next;
    writeOnboardingState(localStorage, next);
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
    if (history.length > 1) history.back();
    else location.hash = route === "automation" ? "/overview" : "/automation";
  }

  async function checkOnboardingEligibility() {
    try {
      if (onboardingState && onboardingState.status !== "active") return;
      const [automationData, overviewData] = await Promise.all([
        automation.status === "ready"
          ? automation.data
          : window.octopusBeak.automation.load(),
        overview.status === "ready"
          ? overview.data
          : window.octopusBeak.overview.load(),
      ]);
      automation = { status: "ready", data: automationData };
      overview = { status: "ready", data: overviewData };
      if (!onboardingState && !hasExistingProductData(
        factsForOnboarding(route, automationData, overviewData, overviewLoadedForImportFinishedAt),
      )) {
        saveOnboarding(createOnboardingState());
      }
    } catch (error) {
      console.warn("onboarding-eligibility-load-failed", message(error));
    }
  }

  async function loadRoute(next: RouteId) {
    const importFinishedAt = next === "overview" && automation.status === "ready"
      ? completedImportFinishedAt(automation.data.automation.tasks)
      : null;
    if (next === "overview") overviewReloading = true;
    try {
      if (next === "overview") {
        overview = { status: "ready", data: await window.octopusBeak.overview.load() };
        overviewLoadedForImportFinishedAt = importFinishedAt;
      }
      if (next === "assets") assets = { status: "ready", data: await window.octopusBeak.assets.load() };
      if (next === "liabilities") liabilities = { status: "ready", data: await window.octopusBeak.liabilities.load() };
      if (next === "spending") spending = { status: "ready", data: await window.octopusBeak.spending.load() };
      if (next === "automation") automation = { status: "ready", data: await window.octopusBeak.automation.load() };
    } catch (error) {
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

  onMount(() => {
    void window.octopusBeak.settings.load().then((value) => {
      applySystemSettings(value);
    }).catch((error) => console.warn("system-settings-load-failed", error)).finally(() => {
      onboardingState = readOnboardingState(localStorage);
      initialized = true;
      normalizeRoute();
    });
    addEventListener("hashchange", normalizeRoute);
    return () => removeEventListener("hashchange", normalizeRoute);
  });
</script>

{#if !initialized}
  <div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>
{:else if route === "overview"}
  {#if overview.status === "ready"}<OverviewDashboard overview={overview.data} />{/if}
  {#if overview.status === "loading"}<div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>{/if}
  {#if overview.status === "error"}<p class="status">{overview.message}</p>{/if}
{:else if route === "assets"}
  {#if assets.status === "ready"}<AssetsDashboard assets={assets.data} {focusAccountId} />{/if}
  {#if assets.status === "loading"}<div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>{/if}
  {#if assets.status === "error"}<p class="status">{assets.message}</p>{/if}
{:else if route === "liabilities"}
  {#if liabilities.status === "ready"}<LiabilitiesDashboard liabilities={liabilities.data} {focusAccountId} />{/if}
  {#if liabilities.status === "loading"}<div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>{/if}
  {#if liabilities.status === "error"}<p class="status">{liabilities.message}</p>{/if}
{:else if route === "spending"}
  {#if spending.status === "ready"}<SpendingDashboard spending={spending.data} />{/if}
  {#if spending.status === "loading"}<div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>{/if}
  {#if spending.status === "error"}<p class="status">{spending.message}</p>{/if}
{:else if route === "automation"}
  {#if automation.status === "ready"}
    <AutomationDashboard
      automation={automation.data.automation}
      credentialGroups={automation.data.credentialGroups}
      reload={() => loadRoute("automation")}
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
{:else if route === "data-issues"}
  <DataIssuesDashboard issueId={dataIssueId} />
{:else}
  <SettingsPage
    onboardingStatus={onboardingState?.status ?? null}
    onResumeOnboarding={resumeOnboarding}
    onRestartOnboarding={restartOnboarding}
  />
{/if}

{#if onboardingState}
  <OnboardingCoach
    step={onboardingStep}
    state={onboardingState}
    {route}
    onPause={pauseOnboarding}
    onFinish={finishOnboarding}
    onAddSource={addOnboardingSource}
    onBack={backOnboarding}
    onRetryTarget={() => loadRoute(route)}
    compact={onboardingCompact}
  />
{/if}

<style>
  .status {
    margin: 32px;
    color: var(--muted);
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
