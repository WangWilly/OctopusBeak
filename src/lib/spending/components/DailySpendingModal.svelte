<script lang="ts">
  import { onMount } from "svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import type { DailySpendingRow } from "$lib/spending/model.ts";
  import SpendingBarChart from "./SpendingBarChart.svelte";

  export let month: string;
  export let total: number;
  export let invoiceCount: number;
  export let rows: readonly DailySpendingRow[] = [];
  export let onClose: () => void | Promise<void> = () => {};

  let closeButton: HTMLButtonElement | null = null;

  onMount(() => closeButton?.focus());

  function closeOnEscape(event: KeyboardEvent) {
    if (event.key === "Escape") void onClose();
  }

  function containFocus(event: KeyboardEvent) {
    if (event.key !== "Tab") return;
    const focusable = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<svelte:window onkeydown={closeOnEscape} />

<div class="modal open">
  <button
    class="modal-backdrop"
    type="button"
    aria-label={$t.spending.closeDailyChart}
    onclick={() => void onClose()}
  ></button>
  <div
    class="modal-panel daily-modal-panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="daily-spending-title"
    tabindex="-1"
    onkeydown={containFocus}
  >
    <div class="modal-head daily-modal-head">
      <div class="daily-modal-title">
        <p class="eyebrow">{$t.spending.dailyEyebrow}</p>
        <h2 id="daily-spending-title">{$t.spending.dailyTitle(month)}</h2>
        <div class="daily-modal-summary">
          <span>{$t.spending.monthTotal}</span>
          <strong class="money" data-sensitive>
            {formatMoney({ currency: "TWD", value: total }, { locale: $locale })}
          </strong>
          <span>{$t.spending.invoiceCount(invoiceCount)}</span>
        </div>
      </div>
      <button
        bind:this={closeButton}
        class="modal-close"
        type="button"
        aria-label={$t.spending.closeDailyChart}
        onclick={() => void onClose()}
      >&times;</button>
    </div>
    <div class="modal-body daily-modal-body">
      <SpendingBarChart
        {rows}
        kind="day"
        label={$t.spending.dailyChartAria(month)}
      />
    </div>
  </div>
</div>

<style>
  .daily-modal-panel {
    width: min(1120px, 100%);
  }

  .daily-modal-title {
    min-width: 0;
    display: grid;
    gap: 4px;
  }

  .daily-modal-title p,
  .daily-modal-title h2 {
    margin: 0;
  }

  .daily-modal-summary {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px;
    color: var(--muted);
    font-size: 12px;
  }

  .daily-modal-summary strong {
    color: var(--fg);
    font-size: 14px;
  }

  .daily-modal-body {
    min-width: 0;
    padding: var(--space-4) var(--space-5) var(--space-5);
  }

  @media (max-width: 760px) {
    .daily-modal-body {
      padding-inline: var(--space-2);
    }
  }
</style>
