<script lang="ts">
  import { onMount, tick } from "svelte";
  import { fade, fly } from "svelte/transition";
  import { isMacPlatform } from "$lib/desktop/platform.ts";
  import { t } from "$lib/i18n/i18n.ts";
  import {
    DISPLAY_SCALE_DEFAULT,
    DISPLAY_SCALE_MAX,
    DISPLAY_SCALE_MIN,
    DISPLAY_SCALE_STEP,
    applyDisplayScale,
    displayScale,
    displayScaleShortcut,
    readStoredDisplayScale,
    supportsDisplayScale,
  } from "$lib/settings/display-scale.ts";
  import ValueVisibilityToggle from "./ValueVisibilityToggle.svelte";
  import { readStoredValuesVisible, writeStoredValuesVisible } from "./value-visibility.ts";

  export let active: "overview" | "assets" | "liabilities" | "spending" | "automation" | "data-issues" | "settings" = "overview";
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
  let scaleHudVisible = false;
  let scaleHudHovered = false;
  let scaleHudFocusWithin = false;
  let scaleHudTimer: ReturnType<typeof setTimeout> | null = null;
  let scaleShortcutPlatform: "mac" | "other" = "other";
  let scaleAnnouncement = "";
  let reduceMotion = false;
  let searchInput: HTMLInputElement | null = null;

  const searchPopoverId = "dashboard-search-popover";

  $: writeStoredValuesVisible(valuesVisible);

  onMount(() => {
    if (!supportsDisplayScale(window.octopusBeak)) return;
    scaleShortcutPlatform = isMacPlatform(navigator) ? "mac" : "other";
    reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    applyDisplayScale(readStoredDisplayScale());
    return clearScaleHudTimer;
  });

  function clearScaleHudTimer() {
    if (scaleHudTimer) clearTimeout(scaleHudTimer);
    scaleHudTimer = null;
  }

  function scheduleScaleHudDismissal() {
    clearScaleHudTimer();
    if (scaleHudHovered || scaleHudFocusWithin) return;
    scaleHudTimer = setTimeout(() => { scaleHudVisible = false; }, 1400);
  }

  function revealScaleHud() {
    scaleHudVisible = true;
    scheduleScaleHudDismissal();
  }

  async function changeDisplayScale(next: number, announce = false) {
    const previous = $displayScale;
    const normalized = applyDisplayScale(next);
    revealScaleHud();
    if (announce && normalized !== previous) {
      scaleAnnouncement = "";
      await tick();
      scaleAnnouncement = `${$t.settings.displaySize}: ${normalized}%`;
    }
  }

  function enterScaleHud() {
    scaleHudHovered = true;
    clearScaleHudTimer();
  }

  function leaveScaleHud() {
    scaleHudHovered = false;
    scheduleScaleHudDismissal();
  }

  function focusScaleHud() {
    scaleHudFocusWithin = true;
    clearScaleHudTimer();
  }

  function handleScaleHudFocusOut(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (next && (event.currentTarget as HTMLElement).contains(next)) return;
    scaleHudFocusWithin = false;
    scheduleScaleHudDismissal();
  }

  function handleDisplayScaleKeydown(event: KeyboardEvent) {
    if (!supportsDisplayScale(window.octopusBeak)) return;
    const action = displayScaleShortcut(event, scaleShortcutPlatform);
    if (!action) return;
    event.preventDefault();
    if (action === "decrease") changeDisplayScale($displayScale - DISPLAY_SCALE_STEP, true);
    if (action === "increase") changeDisplayScale($displayScale + DISPLAY_SCALE_STEP, true);
    if (action === "reset") changeDisplayScale(DISPLAY_SCALE_DEFAULT, true);
  }

  function focusSearchOnOpen(event: Event) {
    const popover = event.currentTarget as HTMLElement;
    setTimeout(() => {
      if (popover.matches(":popover-open")) searchInput?.focus();
    });
  }

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

<svelte:window onkeydown={handleDisplayScaleKeydown} />

<div class:values-hidden={!valuesVisible} class:sidebar-collapsed={sidebarCollapsed} class="shell-page">
  <header class="topbar">
    <div class="topbar-controls">
      <button
        class="sidebar-toggle"
        type="button"
        aria-label={sidebarCollapsed ? $t.nav.expandSidebar : $t.nav.collapseSidebar}
        aria-expanded={!sidebarCollapsed}
        title={sidebarCollapsed ? $t.nav.expandSidebar : $t.nav.collapseSidebar}
        onclick={toggleSidebar}
      >
        <svg class="sidebar-panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6M9 4v16" />
        </svg>
        {#if sidebarCollapsed}
          <svg class="sidebar-chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m9 18 6-6-6-6" />
          </svg>
        {:else}
          <svg class="sidebar-chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
        {/if}
      </button>
    </div>

    <h1 class="topbar-title"><span>{eyebrow}</span><span aria-hidden="true">—</span><strong>{title}</strong></h1>

    <div class="topbar-actions">
      <slot name="topbar-actions">
        {#if searchPlaceholder}
          <button
            class="topbar-tool search-trigger"
            type="button"
            aria-label={searchPlaceholder}
            aria-controls={searchPopoverId}
            popovertarget={searchPopoverId}
          >
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="m20.7 19.3-4.2-4.2a7 7 0 1 0-1.4 1.4l4.2 4.2 1.4-1.4ZM5 11a6 6 0 1 1 12 0 6 6 0 0 1-12 0Z" />
            </svg>
          </button>
          <div id={searchPopoverId} class="search-popover" popover="auto" ontoggle={focusSearchOnOpen}>
            <input
              class="search"
              type="search"
              bind:this={searchInput}
              bind:value={search}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
            />
          </div>
        {:else if syncLabel}
          <span class="chip good">{syncLabel}</span>
        {/if}
        <ValueVisibilityToggle bind:visible={valuesVisible} />
      </slot>
    </div>
  </header>

  <aside class="sidebar">
    <div>
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
    {#if scaleHudVisible}
      <div
        class="display-scale-hud"
        role="group"
        aria-label={$t.settings.displaySize}
        onmouseenter={enterScaleHud}
        onmouseleave={leaveScaleHud}
        onfocusin={focusScaleHud}
        onfocusout={handleScaleHudFocusOut}
        in:fly={{ y: reduceMotion ? 0 : -6, duration: reduceMotion ? 0 : 180 }}
        out:fade={{ duration: reduceMotion ? 0 : 220 }}
      >
        <output>{$displayScale}%</output>
        <button
          type="button"
          aria-label={$t.settings.decreaseScale}
          disabled={$displayScale <= DISPLAY_SCALE_MIN}
          onclick={() => changeDisplayScale($displayScale - DISPLAY_SCALE_STEP)}
        >−</button>
        <button
          type="button"
          aria-label={$t.settings.increaseScale}
          disabled={$displayScale >= DISPLAY_SCALE_MAX}
          onclick={() => changeDisplayScale($displayScale + DISPLAY_SCALE_STEP)}
        >+</button>
        <button
          type="button"
          disabled={$displayScale === DISPLAY_SCALE_DEFAULT}
          onclick={() => changeDisplayScale(DISPLAY_SCALE_DEFAULT)}
        >{$t.settings.resetScale}</button>
      </div>
    {/if}

    <span class="visually-hidden" aria-live="polite">{scaleAnnouncement}</span>

    <slot />
  </main>
</div>

<style>
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .display-scale-hud {
    position: fixed;
    top: calc(var(--topbar-height, 60px) + 24px);
    right: 24px;
    z-index: 30;
    min-height: 56px;
    display: inline-flex;
    align-items: stretch;
    overflow: hidden;
    border: 1px solid color-mix(in oklch, var(--border) 70%, transparent);
    border-radius: 999px;
    background: color-mix(in oklch, var(--surface) 92%, transparent);
    box-shadow: 0 16px 34px rgb(15 23 42 / 0.12);
    backdrop-filter: blur(18px) saturate(1.08);
  }

  .display-scale-hud :is(output, button) {
    min-width: 52px;
    display: grid;
    place-items: center;
    padding: 0 16px;
    border: 0;
    border-left: 1px solid var(--border);
    background: transparent;
    color: var(--fg);
  }

  .display-scale-hud output {
    min-width: 92px;
    border-left: 0;
    font-size: 20px;
    font-weight: 750;
    font-variant-numeric: tabular-nums;
  }

  .display-scale-hud button {
    min-height: 56px;
    font-size: 20px;
  }

  .display-scale-hud button:last-child {
    min-width: 78px;
    font-size: 13px;
    font-weight: 680;
  }

  .display-scale-hud button:hover:not(:disabled) { background: var(--surface-soft); }

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
