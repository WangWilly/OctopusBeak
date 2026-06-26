<script lang="ts">
  import ValueVisibilityToggle from "./ValueVisibilityToggle.svelte";

  export let active: "overview" | "assets" | "liabilities" = "overview";
  export let eyebrow = "Overview";
  export let title = "Portfolio";
  export let sideLabel = "Net position";
  export let sideValue = "--";
  export let sideSub = "";
  export let search = "";
  export let searchPlaceholder: string | null = null;
  export let syncLabel: string | null = null;
  export let valuesVisible = true;

  const nav = [
    {
      id: "overview",
      label: "Overview",
      href: "/overview",
      path: "M3 13h8V3H3v10Zm2-8h4v6H5V5Zm-2 16h8v-6H3v6Zm2-4h4v2H5v-2Zm8 4h8V11h-8v10Zm2-8h4v6h-4v-6Zm-2-10v6h8V3h-8Zm2 2h4v2h-4V5Z",
    },
    {
      id: "assets",
      label: "Assets",
      href: "/assets",
      path: "M21 7h-2V5c0-1.1-.9-2-2-2H5C3.34 3 2 4.34 2 6v12c0 1.1.9 2 2 2h17c.55 0 1-.45 1-1V8c0-.55-.45-1-1-1ZM5 5h12v2H5c-.55 0-1-.45-1-1s.45-1 1-1Zm15 10h-4c-1.1 0-2-.9-2-2s.9-2 2-2h4v4Zm-4-1.5c.28 0 .5-.22.5-.5s-.22-.5-.5-.5-.5.22-.5.5.22.5.5.5Z",
    },
    {
      id: "liabilities",
      label: "Liabilities",
      href: "/liabilities",
      path: "M3 6h18c.55 0 1 .45 1 1v10c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1V7c0-.55.45-1 1-1Zm3 2c0 1.1-.9 2-2 2v4c1.1 0 2 .9 2 2h12c0-1.1.9-2 2-2v-4c-1.1 0-2-.9-2-2H6Zm6 7a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z",
    },
  ] as const;
</script>

<div class:values-hidden={!valuesVisible} class="shell-page">
  <aside class="sidebar">
    <div>
      <a class="brand" href="/overview" aria-label="LedgerLens home">
        <span class="brand-mark">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M4 10v7h3v-7H4Zm6 0v7h3v-7h-3Zm6 0v7h3v-7h-3ZM3 21h18v-2H3v2ZM12 3 3 8v1h18V8l-9-5Z"
            />
          </svg>
        </span>
        <span class="brand-copy">
          <strong class="brand-title">LedgerLens</strong>
          <span class="brand-subtitle">Personal portfolio</span>
        </span>
      </a>
      <nav class="side-nav" aria-label="Primary">
        {#each nav as item}
          <a class:active={active === item.id} class="nav-link" href={item.href}>
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
      <p class="sub">{sideSub}</p>
    </div>
  </aside>

  <main class="page">
    <header class="topbar">
      <div>
        <p class="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      <div class="topbar-actions">
        {#if searchPlaceholder}
          <input class="search" type="search" bind:value={search} placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
        {:else if syncLabel}
          <span class="chip good">{syncLabel}</span>
        {/if}
        <ValueVisibilityToggle bind:visible={valuesVisible} />
      </div>
    </header>

    <slot />
  </main>
</div>
