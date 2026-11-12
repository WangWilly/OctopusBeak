<script lang="ts">
  import { ArrowRight, ChevronLeft, ChevronRight } from "@lucide/svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import {
    clampRange,
    monthGrid,
    quickRange,
    rangeDays,
    shiftMonth,
    type CashFlowQuickPreset,
    type CashFlowRange,
  } from "../period.ts";

  export let range: CashFlowRange;
  export let today: string;
  export let apply: (range: CashFlowRange) => void;
  export let cancel: () => void;

  let start = range.startDate;
  let end: string | null = range.endDate;
  let month = range.endDate.slice(0, 7);
  const quick: readonly CashFlowQuickPreset[] = ["week", "month", "lastMonth", "last90", "year"];

  $: grid = monthGrid(month);
  $: canGoNext = shiftMonth(month, 1) <= today.slice(0, 7);
  $: chosen = end === null ? null : clampRange({ startDate: start, endDate: end }, today);
  $: activeQuick = chosen === null ? null : quick.find((preset) => {
    const candidate = quickRange(preset, today);
    return candidate.startDate === chosen.startDate && candidate.endDate === chosen.endDate;
  }) ?? null;

  function choose(date: string) {
    if (date > today) return;
    if (end !== null) {
      start = date;
      end = null;
    } else if (date < start) {
      end = start;
      start = date;
    } else {
      end = date;
    }
  }

  function chooseQuick(preset: CashFlowQuickPreset) {
    const next = quickRange(preset, today);
    start = next.startDate;
    end = next.endDate;
    month = next.endDate.slice(0, 7);
  }

  function inRange(date: string): boolean {
    return end !== null && date >= start && date <= end;
  }

  function slash(date: string | null): string {
    return date ? date.replaceAll("-", "/") : "—";
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") cancel();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="range-picker" role="dialog" aria-label={$t.cashFlow.presets.custom} data-range-picker>
  <div class="picker-body">
    <div class="picker-quick">
      <span class="picker-label">{$t.cashFlow.pickerQuick}</span>
      {#each quick as preset (preset)}
        <button type="button" class="quick-option" aria-pressed={activeQuick === preset} onclick={() => chooseQuick(preset)}>
          {$t.cashFlow.pickerQuickPresets[preset]}
        </button>
      {/each}
    </div>
    <div class="picker-calendar">
      <div class="picker-ends">
        <div class="picker-end" class:current={end !== null}>
          <span>{$t.cashFlow.pickerStart}</span>
          <strong class="num">{slash(start)}</strong>
        </div>
        <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
        <div class="picker-end" class:current={end === null}>
          <span>{$t.cashFlow.pickerEnd}</span>
          <strong class="num">{slash(end)}</strong>
        </div>
      </div>
      <div class="picker-month">
        <button type="button" class="icon-button" aria-label={$t.cashFlow.pickerPreviousMonth} onclick={() => month = shiftMonth(month, -1)}>
          <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
        </button>
        <strong>{new Intl.DateTimeFormat($locale, { year: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`))}</strong>
        <button type="button" class="icon-button" aria-label={$t.cashFlow.pickerNextMonth} disabled={!canGoNext} onclick={() => month = shiftMonth(month, 1)}>
          <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      <div class="picker-grid" role="grid">
        {#each $t.cashFlow.weekdays as weekday (weekday)}<span class="weekday" role="columnheader">{weekday}</span>{/each}
        {#each grid as date, index (date ?? `pad-${index}`)}
          {#if date === null}
            <span aria-hidden="true"></span>
          {:else}
            <button
              type="button"
              class="day num"
              class:in-range={inRange(date)}
              class:edge={date === start || date === end}
              disabled={date > today}
              aria-pressed={date === start || date === end}
              data-date={date}
              onclick={() => choose(date)}
            >{Number(date.slice(8, 10))}</button>
          {/if}
        {/each}
      </div>
    </div>
  </div>
  <footer class="picker-foot">
    <div>
      <strong>{chosen ? $t.cashFlow.pickerSelected(rangeDays(chosen)) : "—"}</strong>
      <span>{$t.cashFlow.pickerNoFuture}</span>
    </div>
    <div class="picker-actions">
      <button type="button" class="button" onclick={cancel}>{$t.cashFlow.pickerCancel}</button>
      <button type="button" class="button primary" disabled={chosen === null} onclick={() => chosen && apply(chosen)}>{$t.cashFlow.pickerApply}</button>
    </div>
  </footer>
</div>

<style>
  .range-picker {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 30;
    width: min(560px, calc(100vw - 32px));
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: 0 14px 34px rgb(15 23 42 / 0.12);
    overflow: hidden;
  }

  .picker-body {
    display: grid;
    grid-template-columns: 148px 1fr;
  }

  .picker-quick {
    display: grid;
    align-content: start;
    gap: 2px;
    padding: 12px 8px;
    background: var(--surface-soft);
  }

  .picker-label {
    padding: 4px 8px 6px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 720;
    letter-spacing: 0.075em;
  }

  .quick-option {
    height: 34px;
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .quick-option:hover {
    background: color-mix(in oklch, var(--surface) 70%, transparent);
  }

  .quick-option[aria-pressed="true"] {
    border-color: var(--border);
    background: var(--surface);
    font-weight: 680;
  }

  .picker-calendar {
    display: grid;
    gap: 12px;
    padding: 16px;
  }

  .picker-ends {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 8px;
    color: var(--muted);
  }

  .picker-end {
    display: grid;
    gap: 2px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .picker-end.current {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--surface-soft);
  }

  .picker-end span {
    font-size: 11px;
  }

  .picker-end strong {
    color: var(--fg);
    font-size: 13px;
  }

  .picker-month {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 14px;
  }

  .picker-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px 0;
    text-align: center;
  }

  .weekday {
    padding: 4px 0;
    color: var(--muted);
    font-size: 11px;
  }

  .day {
    height: 32px;
    border: 0;
    background: transparent;
    color: var(--fg);
    font-size: 12px;
    cursor: pointer;
  }

  .day.in-range {
    background: var(--accent-soft);
  }

  .day.edge {
    border-radius: 8px;
    background: var(--accent);
    color: white;
    font-weight: 750;
  }

  .day:disabled {
    color: color-mix(in oklch, var(--muted) 45%, white);
    cursor: not-allowed;
  }

  .day:not(:disabled):not(.edge):hover {
    border-radius: 8px;
    background: var(--surface-soft);
  }

  .picker-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }

  .picker-foot div:first-child {
    display: grid;
    gap: 2px;
    font-size: 12px;
  }

  .picker-foot span {
    color: var(--muted);
  }

  .picker-actions {
    display: flex;
    gap: 8px;
  }

  @media (max-width: 760px) {
    .picker-body {
      grid-template-columns: 1fr;
    }

    .picker-quick {
      grid-auto-flow: column;
      overflow-x: auto;
    }
  }
</style>
