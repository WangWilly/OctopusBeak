<script lang="ts">
  import { onMount } from "svelte";
  import projectIcon from "../assets/project-icon.webp";
  import ValueVisibilityToggle from "./ValueVisibilityToggle.svelte";

  export let active: "overview" | "assets" | "liabilities" | "automation" = "overview";
  export let eyebrow = "Overview";
  export let title = "Portfolio";
  export let sideLabel = "Net position";
  export let sideValue = "--";
  export let sideSub = "";
  export let sideSubSensitive = false;
  export let search = "";
  export let searchPlaceholder: string | null = null;
  export let syncLabel: string | null = null;
  export let valuesVisible = true;

  const sidebarStorageKey = "octopusbeak-sidebar-collapsed";
  const valuesStorageKey = "octopusbeak-values-visible";
  let sidebarCollapsed = false;
  let valuesStorageLoaded = false;

  onMount(() => {
    sidebarCollapsed = localStorage.getItem(sidebarStorageKey) === "1";
    const storedValuesVisible = localStorage.getItem(valuesStorageKey);
    if (storedValuesVisible) valuesVisible = storedValuesVisible === "1";
    valuesStorageLoaded = true;
  });

  $: if (valuesStorageLoaded) {
    localStorage.setItem(valuesStorageKey, valuesVisible ? "1" : "0");
  }

  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    localStorage.setItem(sidebarStorageKey, sidebarCollapsed ? "1" : "0");
  }

  const nav = [
    {
      id: "overview",
      label: "Overview",
      href: "#/overview",
      path: "M3 13h8V3H3v10Zm2-8h4v6H5V5Zm-2 16h8v-6H3v6Zm2-4h4v2H5v-2Zm8 4h8V11h-8v10Zm2-8h4v6h-4v-6Zm-2-10v6h8V3h-8Zm2 2h4v2h-4V5Z",
    },
    {
      id: "assets",
      label: "Assets",
      href: "#/assets",
      path: "M21 7h-2V5c0-1.1-.9-2-2-2H5C3.34 3 2 4.34 2 6v12c0 1.1.9 2 2 2h17c.55 0 1-.45 1-1V8c0-.55-.45-1-1-1ZM5 5h12v2H5c-.55 0-1-.45-1-1s.45-1 1-1Zm15 10h-4c-1.1 0-2-.9-2-2s.9-2 2-2h4v4Zm-4-1.5c.28 0 .5-.22.5-.5s-.22-.5-.5-.5-.5.22-.5.5.22.5.5.5Z",
    },
    {
      id: "liabilities",
      label: "Liabilities",
      href: "#/liabilities",
      path: "M3 6h18c.55 0 1 .45 1 1v10c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1V7c0-.55.45-1 1-1Zm3 2c0 1.1-.9 2-2 2v4c1.1 0 2 .9 2 2h12c0-1.1.9-2 2-2v-4c-1.1 0-2-.9-2-2H6Zm6 7a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z",
    },
    {
      id: "automation",
      label: "Automation",
      href: "#/automation",
      path: "M5 4h14v2H5V4Zm2 4h10v2H7V8Zm-2 4h14v8H5v-8Zm2 2v4h10v-4H7Z",
    },
  ] as const;
</script>

<div class:values-hidden={!valuesVisible} class:sidebar-collapsed={sidebarCollapsed} class="shell-page">
  <aside class="sidebar">
    <div>
      <div class="brand-row">
        <a class="brand" href="#/overview" aria-label="OctopusBeak home">
          <span class="brand-mark">
            <img class="brand-icon" src={projectIcon} alt="" width="32" height="32" aria-hidden="true" />
          </span>
          <span class="brand-copy">
            <strong class="brand-title">OctopusBeak</strong>
            <span class="brand-subtitle">Personal portfolio</span>
          </span>
        </a>
        <button
          class="sidebar-toggle"
          type="button"
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!sidebarCollapsed}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onclick={toggleSidebar}
        >
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M15.5 5 8.5 12l7 7-1.4 1.4L5.7 12l8.4-8.4L15.5 5Z" />
          </svg>
        </button>
      </div>
      <nav class="side-nav" aria-label="Primary">
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
