<script lang="ts">
  import { t } from "$lib/i18n/i18n.ts";
  import { renderBlockContent, type BlockState } from "$lib/shared-shell/block-load-state.ts";
  import type { DashboardBlockPayload } from "$lib/shared-shell/dashboard-blocks.ts";

  export let state: BlockState<DashboardBlockPayload> = { status: "loading" };
  export let label = "data block";
  export let showSpinner = true;
  export let retry: () => void = () => {};

  $: hasData = "data" in state && state.data !== undefined;
  $: blockData = renderBlockContent(state, (data) => data);
</script>

{#if hasData}
  <div class="block-frame" data-progressive-block={label} data-block-state={state.status} aria-busy={state.status === "loading"}>
    <slot data={blockData} />
    {#if showSpinner && state.status === "loading"}
      <span class="block-spinner" role="status" aria-label={$t.common.refreshing}></span>
    {:else if state.status === "error"}
      <div class="block-error" role="alert">
        <span>{state.message}</span>
        <button class="button secondary" type="button" onclick={retry}>{$t.common.retry}</button>
      </div>
    {/if}
  </div>
{:else if state.status === "loading"}
  <div class="block-skeleton" data-progressive-block={label} data-block-state="skeleton" role="status" aria-label={$t.common.loading}></div>
{:else if state.status === "error"}
  <div class="block-error standalone" data-progressive-block={label} role="alert">
    <span>{state.message}</span>
    <button class="button secondary" type="button" onclick={retry}>{$t.common.retry}</button>
  </div>
{/if}

<style>
  .block-frame { position: relative; min-width: 0; }

  .block-spinner {
    position: absolute;
    top: 14px;
    right: 14px;
    width: 14px;
    height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: progressive-block-spin 700ms linear infinite;
  }

  .block-skeleton {
    min-height: 128px;
    border-radius: 14px;
    background: linear-gradient(100deg, var(--surface-soft), color-mix(in srgb, var(--surface-soft) 55%, white), var(--surface-soft));
    background-size: 220% 100%;
    animation: progressive-block-shimmer 1.4s ease-in-out infinite;
  }

  .block-error {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--danger, #b42318) 35%, var(--border));
    border-radius: 10px;
    color: var(--danger, #b42318);
    font-size: 0.85rem;
  }

  .block-error.standalone { min-height: 128px; justify-content: center; margin-top: 0; }
  .block-error .button { margin-left: auto; }

  @keyframes progressive-block-spin { to { transform: rotate(360deg); } }
  @keyframes progressive-block-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }

  @media (prefers-reduced-motion: reduce) {
    .block-spinner, .block-skeleton { animation: none; }
  }
</style>
