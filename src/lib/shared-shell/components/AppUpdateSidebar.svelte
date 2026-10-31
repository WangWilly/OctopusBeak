<script lang="ts">
  import { getContext } from "svelte";
  import { readable } from "svelte/store";
  import { t } from "$lib/i18n/i18n.ts";
  import type { AppUpdateRestartResult } from "$lib/settings/app-updates.ts";
  import {
    APP_UPDATE_CONTEXT_KEY,
    downloadPercent,
    megabytes,
    type AppUpdateUiContext,
  } from "$lib/shared-shell/app-update-context.ts";

  export let collapsed = false;

  const context = getContext<AppUpdateUiContext | undefined>(APP_UPDATE_CONTEXT_KEY);
  const view = context?.view ?? readable(null);
  const runActive = context?.runActive ?? readable(false);
  let pending = false;
  let restartResult: AppUpdateRestartResult | null = null;

  const RING_RADIUS = 15;
  const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

  $: state = $view?.state ?? null;
  $: percent = state?.status === "downloading" ? downloadPercent(state.received, state.release.size) : 0;
  $: restartBlocked = $runActive || (restartResult?.ok === false && restartResult.reason === "run-active");
  $: if (state?.status !== "ready") restartResult = null;

  async function run(action: () => Promise<unknown>) {
    pending = true;
    try {
      await action();
    } catch {
      // The pushed state is the source of truth; nothing to show for a lost request.
    } finally {
      pending = false;
    }
  }

  async function restart() {
    if (!context) return;
    await run(async () => (restartResult = await context.restart()));
  }
</script>

{#if state?.status === "available" || (state?.status === "failed" && state.code !== "check-failed")}
  {@const retry = state.status === "failed"}
  {@const label = retry ? $t.settings.appUpdateRetry : $t.settings.appUpdateDownload(state.release.version)}
  <div class="side-update" class:collapsed data-app-update={state.status}>
    {#if retry && !collapsed}
      <p class="side-update-note">{$t.settings.appUpdateFailedShort[state.code]}</p>
    {/if}
    <button
      class="side-update-button"
      type="button"
      title={label}
      aria-label={collapsed ? label : undefined}
      disabled={pending}
      onclick={() => context && run(context.download)}
    >
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M11 4h2v8.17l3.59-3.58L18 10l-6 6-6-6 1.41-1.41L11 12.17V4Zm-6 14h14v2H5v-2Z" />
      </svg>
      {#if !collapsed}<span>{label}</span>{/if}
    </button>
  </div>
{:else if state?.status === "downloading"}
  {@const label = $t.settings.appUpdateProgressLabel(state.release.version, percent)}
  <div
    class="side-update"
    class:collapsed
    data-app-update="downloading"
    role="progressbar"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={percent}
    aria-label={label}
    title={label}
  >
    {#if collapsed}
      <svg class="side-update-ring" viewBox="0 0 36 36" aria-hidden="true">
        <circle class="ring-track" cx="18" cy="18" r={RING_RADIUS} />
        <circle
          class="ring-fill"
          cx="18"
          cy="18"
          r={RING_RADIUS}
          stroke-dasharray={RING_LENGTH}
          stroke-dashoffset={RING_LENGTH * (1 - percent / 100)}
        />
      </svg>
    {:else}
      <p class="side-update-head" aria-hidden="true">
        <span>{$t.settings.appUpdateDownloading(state.release.version)}</span>
        <span class="side-update-figure">{percent}%</span>
      </p>
      <span class="side-update-track" aria-hidden="true"><span style:width={`${percent}%`}></span></span>
      <p class="side-update-note side-update-figure" aria-hidden="true">
        {$t.settings.appUpdateMegabytes(megabytes(state.received), megabytes(state.release.size))}
      </p>
    {/if}
  </div>
{:else if state?.status === "installing"}
  <div
    class="side-update side-update-installing"
    class:collapsed
    data-app-update="installing"
    role="status"
    aria-label={collapsed ? $t.settings.appUpdateInstalling : undefined}
    title={$t.settings.appUpdateInstalling}
  >
    <span class="side-update-spinner" aria-hidden="true"></span>
    {#if !collapsed}<span>{$t.settings.appUpdateInstalling}</span>{/if}
  </div>
{:else if state?.status === "ready"}
  {@const label = restartBlocked ? `${$t.settings.appUpdatesRestart}: ${$t.settings.appUpdateRunActive}` : $t.settings.appUpdatesRestart}
  <div class="side-update" class:collapsed data-app-update="ready">
    {#if !collapsed}
      <p class="side-update-note">{$t.settings.appUpdateReadyShort(state.version)}</p>
    {/if}
    <button
      id="app-update-restart"
      class="side-update-button primary"
      type="button"
      title={label}
      aria-label={collapsed ? label : undefined}
      aria-describedby={restartBlocked && !collapsed ? "app-update-run-active" : undefined}
      disabled={restartBlocked || pending}
      onclick={restart}
    >
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M17.65 6.35A7.95 7.95 0 0 0 12 4V1L7 6l5 5V7a5 5 0 1 1-4.9 6H5.02A7 7 0 1 0 17.65 6.35Z" />
      </svg>
      {#if !collapsed}<span>{$t.settings.appUpdatesRestart}</span>{/if}
    </button>
    {#if restartBlocked && !collapsed}
      <p id="app-update-run-active" class="side-update-note">{$t.settings.appUpdateRunActive}</p>
    {/if}
  </div>
{/if}

<style>
  .side-update {
    display: grid;
    gap: var(--space-2);
    margin-bottom: var(--space-5);
    color: rgba(255, 255, 255, 0.78);
    font-size: 12px;
  }

  .side-update p {
    margin: 0;
  }

  .side-update-note {
    color: rgba(255, 255, 255, 0.5);
    font-size: 12px;
    line-height: 1.4;
  }

  .side-update-button {
    min-height: 40px;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 0 var(--space-3);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: var(--radius);
    background: rgba(255, 255, 255, 0.06);
    color: white;
    font-size: 13px;
    font-weight: 620;
    text-align: left;
    transition: background 160ms ease, border-color 160ms ease;
  }

  .side-update-button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.22);
  }

  .side-update-button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.24);
  }

  .side-update-button.primary {
    background: white;
    border-color: white;
    color: var(--surface-strong);
  }

  .side-update-button.primary:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.88);
  }

  .side-update-head {
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
    font-weight: 620;
  }

  .side-update-figure {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  .side-update-track {
    display: block;
    height: 6px;
    overflow: hidden;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.14);
  }

  .side-update-track > span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: rgba(255, 255, 255, 0.86);
    transition: width 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .side-update-installing {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 40px;
  }

  .side-update-spinner {
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: side-update-spin 700ms linear infinite;
  }

  @keyframes side-update-spin {
    to { transform: rotate(360deg); }
  }

  .side-update.collapsed {
    justify-items: center;
  }

  .side-update.collapsed .side-update-button {
    width: 48px;
    min-height: 48px;
    justify-content: center;
    padding: 0;
    border-radius: 14px;
  }

  .side-update.collapsed.side-update-installing {
    width: 48px;
    min-height: 48px;
    justify-content: center;
  }

  .side-update-ring {
    width: 36px;
    height: 36px;
    transform: rotate(-90deg);
  }

  .side-update-ring circle {
    fill: none;
    stroke-width: 3;
  }

  .ring-track {
    stroke: rgba(255, 255, 255, 0.14);
  }

  .ring-fill {
    stroke: rgba(255, 255, 255, 0.86);
    stroke-linecap: round;
    transition: stroke-dashoffset 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  @media (prefers-reduced-motion: reduce) {
    .side-update-spinner { animation: none; }
    .side-update-track > span,
    .ring-fill { transition: none; }
  }
</style>
