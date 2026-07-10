<script lang="ts">
  import { t } from "$lib/i18n/i18n.ts";
  import projectIcon from "../assets/project-icon.webp";
  import ValueVisibilityToggle from "./ValueVisibilityToggle.svelte";
  import { readStoredValuesVisible, writeStoredValuesVisible } from "./value-visibility.ts";

  export let active: "overview" | "assets" | "liabilities" | "spending" | "automation" | "settings" = "overview";
  export let eyebrow = "Overview";
  export let title = "Portfolio";
  export let sideLabel = "Net position";
  export let sideValue = "--";
  export let sideSub = "";
  export let sideSubSensitive = false;
  export let search = "";
  export let searchPlaceholder: string | null = null;
  export let syncLabel: string | null = null;

  const sidebarStorageKey = "octopusbeak-sidebar-collapsed";
  let sidebarCollapsed = readStoredSidebarCollapsed();
  let valuesVisible = readStoredValuesVisible();

  $: writeStoredValuesVisible(valuesVisible);

  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    localStorage.setItem(sidebarStorageKey, sidebarCollapsed ? "1" : "0");
  }

  function readStoredSidebarCollapsed() {
    return typeof localStorage !== "undefined" && localStorage.getItem(sidebarStorageKey) === "1";
  }

  $: nav = [
    {
      id: "overview",
      label: $t.nav.overview,
      href: "#/overview",
      path: "M3 13h8V3H3v10Zm2-8h4v6H5V5Zm-2 16h8v-6H3v6Zm2-4h4v2H5v-2Zm8 4h8V11h-8v10Zm2-8h4v6h-4v-6Zm-2-10v6h8V3h-8Zm2 2h4v2h-4V5Z",
    },
    {
      id: "assets",
      label: $t.nav.assets,
      href: "#/assets",
      path: "M21 7h-2V5c0-1.1-.9-2-2-2H5C3.34 3 2 4.34 2 6v12c0 1.1.9 2 2 2h17c.55 0 1-.45 1-1V8c0-.55-.45-1-1-1ZM5 5h12v2H5c-.55 0-1-.45-1-1s.45-1 1-1Zm15 10h-4c-1.1 0-2-.9-2-2s.9-2 2-2h4v4Zm-4-1.5c.28 0 .5-.22.5-.5s-.22-.5-.5-.5-.5.22-.5.5.22.5.5.5Z",
    },
    {
      id: "liabilities",
      label: $t.nav.liabilities,
      href: "#/liabilities",
      path: "M3 6h18c.55 0 1 .45 1 1v10c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1V7c0-.55.45-1 1-1Zm3 2c0 1.1-.9 2-2 2v4c1.1 0 2 .9 2 2h12c0-1.1.9-2 2-2v-4c-1.1 0-2-.9-2-2H6Zm6 7a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z",
    },
    {
      id: "spending",
      label: $t.nav.spending,
      href: "#/spending",
      path: "M19 3H5a2 2 0 0 0-2 2v16l3-2 2 2 2-2 2 2 2-2 2 2 2-2 3 2V5a2 2 0 0 0-2-2Zm-2 14.17-1-1-2 2-2-2-2 2-2-2-1 1V5h12v12.17ZM7 7h10v2H7V7Zm0 4h10v2H7v-2Z",
    },
    {
      id: "automation",
      label: $t.nav.automation,
      href: "#/automation",
      path: "M5 4h14v2H5V4Zm2 4h10v2H7V8Zm-2 4h14v8H5v-8Zm2 2v4h10v-4H7Z",
    },
    {
      id: "settings",
      label: $t.nav.settings,
      href: "#/settings",
      path: "M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.28 7.28 0 0 0-1.69-.98L14.5 2.42A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42L9.13 5.07c-.61.24-1.18.56-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.07.65-.07.98s.02.66.07.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.13.22.39.31.61.22l2.49-1c.51.4 1.08.73 1.69.98l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.61-.24 1.18-.56 1.69-.98l2.49 1c.23.08.48 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z",
    },
  ] as const;
</script>

<div class:values-hidden={!valuesVisible} class:sidebar-collapsed={sidebarCollapsed} class="shell-page">
  <aside class="sidebar">
    <div>
      <div class="brand-row">
        <a class="brand" href="#/overview" aria-label={$t.nav.homeAria}>
          <span class="brand-mark">
            <img class="brand-icon" src={projectIcon} alt="" width="32" height="32" aria-hidden="true" />
          </span>
          <span class="brand-copy">
            <strong class="brand-title">OB</strong>
            <span class="brand-subtitle">{$t.nav.personalPortfolio}</span>
          </span>
        </a>
        <button
          class="sidebar-toggle"
          type="button"
          aria-label={sidebarCollapsed ? $t.nav.expandSidebar : $t.nav.collapseSidebar}
          aria-expanded={!sidebarCollapsed}
          title={sidebarCollapsed ? $t.nav.expandSidebar : $t.nav.collapseSidebar}
          onclick={toggleSidebar}
        >
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M15.5 5 8.5 12l7 7-1.4 1.4L5.7 12l8.4-8.4L15.5 5Z" />
          </svg>
        </button>
      </div>
      <nav class="side-nav" aria-label={$t.nav.primary}>
        {#each nav as item}
          <a class:active={active === item.id} class="nav-link" href={item.href} aria-label={item.label}>
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d={item.path} />
            </svg>
            <span>{item.label}</span>
          </a>
        {/each}
      </nav>
    </div>
    <div class="side-status">
      <p class="label">{sideLabel}</p>
      <p class="money">{sideValue}</p>
      <p class="sub" data-sensitive={sideSubSensitive ? "" : undefined}>{sideSub}</p>
    </div>
  </aside>

  <main class="page">
    <header class="topbar">
      <div>
        <p class="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      <div class="topbar-actions">
        <slot name="topbar-actions">
          {#if searchPlaceholder}
            <input class="search" type="search" bind:value={search} placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
          {:else if syncLabel}
            <span class="chip good">{syncLabel}</span>
          {/if}
          <ValueVisibilityToggle bind:visible={valuesVisible} />
        </slot>
      </div>
    </header>

    <slot />
  </main>
</div>

<style>
  @media (max-width: 760px) {
    .nav-link,
    .shell-page.sidebar-collapsed .nav-link {
      min-width: 0;
      min-height: 56px;
      flex-direction: column;
      gap: 2px;
      padding: 4px;
      font-size: 11px;
    }

    .nav-link span,
    .shell-page.sidebar-collapsed .nav-link span {
      display: block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
</style>
