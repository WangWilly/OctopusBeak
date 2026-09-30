<script lang="ts">
  import { t } from "$lib/i18n/i18n.ts";
  import type { ViewLoadState } from "$lib/shared-shell/view-load-state.ts";

  export let state: ViewLoadState<unknown>;
  export let retry: () => void;

  $: hasData = "data" in state && state.data !== undefined;
</script>

{#if !hasData && state.status === "loading"}
  <div class="route-skeleton" aria-label={$t.common.loading} role="status">
    <span class="skeleton-heading"></span>
    <div class="skeleton-grid">
      <span></span><span></span><span></span>
    </div>
    <span class="skeleton-table"></span>
  </div>
{:else if !hasData && state.status === "error"}
  <div class="route-error" role="alert">
    <p>{state.message}</p>
    <button class="button secondary" type="button" onclick={retry}>{$t.common.retry}</button>
  </div>
{/if}

<style>
  .route-skeleton,
  .route-error {
    min-height: calc(100vh - var(--topbar-height, 60px));
    padding: clamp(24px, 5vw, 56px);
  }

  .route-skeleton {
    display: grid;
    align-content: start;
    gap: 20px;
  }

  .route-skeleton > span,
  .skeleton-grid span {
    display: block;
    border-radius: 12px;
    background: linear-gradient(100deg, var(--surface-soft), color-mix(in srgb, var(--surface-soft) 55%, white), var(--surface-soft));
    background-size: 220% 100%;
    animation: skeleton-shimmer 1.4s ease-in-out infinite;
  }

  .skeleton-heading {
    width: min(360px, 70%);
    height: 32px;
  }

  .skeleton-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
  }

  .skeleton-grid span { min-height: 104px; }
  .skeleton-table { min-height: 240px; }

  .route-error {
    display: grid;
    align-content: center;
    justify-items: start;
    gap: 16px;
    color: var(--muted);
  }

  .route-error p { margin: 0; }

  @keyframes skeleton-shimmer {
    from { background-position: 100% 0; }
    to { background-position: -100% 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .route-skeleton > span,
    .skeleton-grid span { animation: none; }
  }
</style>
