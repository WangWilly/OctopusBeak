<script lang="ts">
  import { onMount } from "svelte";
  import AssetsDashboard from "$lib/assets/AssetsDashboard.svelte";
  import type { AssetsPageDto } from "$lib/assets/types.ts";
  import AutomationDashboard from "$lib/automation/AutomationDashboard.svelte";
  import type { AutomationDesktopModel } from "$lib/desktop/api.ts";
  import { t } from "$lib/i18n/i18n.ts";
  import LiabilitiesDashboard from "$lib/liabilities/LiabilitiesDashboard.svelte";
  import type { LiabilitiesPageDto } from "$lib/liabilities/types.ts";
  import OverviewDashboard from "$lib/overview/OverviewDashboard.svelte";
  import type { OverviewPageDto } from "$lib/overview/types.ts";
  import SettingsPage from "$lib/settings/SettingsPage.svelte";

  type RouteId = "overview" | "assets" | "liabilities" | "automation" | "settings";
  type LoadState<T> =
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; data: T };

  let route: RouteId = "overview";
  let overview: LoadState<OverviewPageDto> = { status: "loading" };
  let assets: LoadState<AssetsPageDto> = { status: "loading" };
  let liabilities: LoadState<LiabilitiesPageDto> = { status: "loading" };
  let automation: LoadState<AutomationDesktopModel> = { status: "loading" };

  function normalizeRoute() {
    const next = location.hash.replace(/^#\/?/, "") as RouteId;
    route = ["overview", "assets", "liabilities", "automation", "settings"].includes(next) ? next : "overview";
    if (!location.hash || next !== route) location.hash = `/${route}`;
    void loadRoute(route);
  }

  function message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  async function loadRoute(next: RouteId) {
    try {
      if (next === "overview") overview = { status: "ready", data: await window.octopusBeak.overview.load() };
      if (next === "assets") assets = { status: "ready", data: await window.octopusBeak.assets.load() };
      if (next === "liabilities") liabilities = { status: "ready", data: await window.octopusBeak.liabilities.load() };
      if (next === "automation") automation = { status: "ready", data: await window.octopusBeak.automation.load() };
    } catch (error) {
      const failed = { status: "error" as const, message: message(error) };
      if (next === "overview") overview = failed;
      if (next === "assets") assets = failed;
      if (next === "liabilities") liabilities = failed;
      if (next === "automation") automation = failed;
    }
  }

  onMount(() => {
    normalizeRoute();
    addEventListener("hashchange", normalizeRoute);
    return () => removeEventListener("hashchange", normalizeRoute);
  });
</script>

{#if route === "overview"}
  {#if overview.status === "ready"}<OverviewDashboard overview={overview.data} />{/if}
  {#if overview.status === "loading"}<p class="status">{$t.common.loading}</p>{/if}
  {#if overview.status === "error"}<p class="status">{overview.message}</p>{/if}
{:else if route === "assets"}
  {#if assets.status === "ready"}<AssetsDashboard assets={assets.data} />{/if}
  {#if assets.status === "loading"}<p class="status">{$t.common.loading}</p>{/if}
  {#if assets.status === "error"}<p class="status">{assets.message}</p>{/if}
{:else if route === "liabilities"}
  {#if liabilities.status === "ready"}<LiabilitiesDashboard liabilities={liabilities.data} />{/if}
  {#if liabilities.status === "loading"}<p class="status">{$t.common.loading}</p>{/if}
  {#if liabilities.status === "error"}<p class="status">{liabilities.message}</p>{/if}
{:else if route === "automation"}
  {#if automation.status === "ready"}
    <AutomationDashboard
      automation={automation.data.automation}
      credentialGroups={automation.data.credentialGroups}
      reload={() => loadRoute("automation")}
    />
  {/if}
  {#if automation.status === "loading"}<p class="status">{$t.common.loading}</p>{/if}
  {#if automation.status === "error"}<p class="status">{automation.message}</p>{/if}
{:else}
  <SettingsPage />
{/if}

<style>
  .status {
    margin: 32px;
    color: var(--muted);
  }
</style>
