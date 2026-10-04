<script lang="ts">
  import { t } from "$lib/i18n/i18n.ts";
  import type { ViewLoadState } from "$lib/shared-shell/view-load-state.ts";

  export let state: ViewLoadState<unknown>;
  export let retry: () => void;

  $: hasData = "data" in state && state.data !== undefined;
</script>

{#if hasData && state.status === "loading"}
  <div class="route-load-notice updating" role="status" aria-live="polite">
    <span class="notice-spinner" aria-hidden="true"></span>
    <span>{$t.common.refreshing}</span>
  </div>
{:else if hasData && state.status === "error"}
  <div class="route-load-notice failed" role="alert">
    <span>{state.message}</span>
    <button class="button secondary" type="button" onclick={retry}>{$t.common.retry}</button>
  </div>
{/if}

<style>
  .route-load-notice {
    position: fixed;
    right: 24px;
    bottom: 24px;
    z-index: 40;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    max-width: min(420px, calc(100vw - 48px));
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: 0 12px 30px rgb(15 23 42 / 0.14);
    color: var(--muted);
  }

  .route-load-notice.failed {
    color: var(--danger);
  }

  .notice-spinner {
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: notice-spin 700ms linear infinite;
  }

  @keyframes notice-spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .notice-spinner { animation: none; }
  }
</style>
