<script lang="ts">
  import { ArrowRight, CalendarDays, Check, ChevronLeft, ChevronRight } from "@lucide/svelte";

  import { locale, t } from "$lib/i18n/i18n.ts";
  import {
    RANGE_PRESETS,
    addDays,
    addMonths,
    daysInRange,
    presetRange,
    type DateRange,
    type RangePreset,
  } from "$lib/shared-accounts/transaction-filters.ts";

  export let range: DateRange | null;
  export let preset: RangePreset;
  export let today: string;
  export let countIn: (range: DateRange | null) => number;
  export let onApply: (range: DateRange | null, preset: RangePreset) => void;
  export let onClose: () => void;

  let draftPreset = preset;
  let draftStart: string | null = range?.start ?? null;
  let draftEnd: string | null = range?.end ?? null;
  /** First day of the left-hand month; the right-hand month follows it. */
  let leftMonth = addMonths(range?.end ?? today, -1);

  $: draftRange = draftStart ? { start: draftStart, end: draftEnd ?? draftStart } : null;
  $: months = [leftMonth, addMonths(leftMonth, 1)].map((first) => monthGrid(first, $locale));
  $: weekdays = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat($locale, { weekday: "narrow", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + index))));
  $: summary = draftRange
    ? $t.transactions.rangeSummary(daysInRange(draftRange), countIn(draftRange))
    : `${$t.transactions.rangePresets.all} · ${countIn(null)}`;

  function monthGrid(first: string, language: string) {
    const lead = new Date(`${first}T00:00:00Z`).getUTCDay();
    const length = Number(addDays(addMonths(first, 1), -1).slice(8));
    return {
      first,
      label: new Intl.DateTimeFormat(language, { year: "numeric", month: "long", timeZone: "UTC" })
        .format(new Date(`${first}T00:00:00Z`)),
      cells: [
        ...Array.from({ length: lead }, () => null),
        ...Array.from({ length }, (_, index) => addDays(first, index)),
      ],
    };
  }

  function choosePreset(next: Exclude<RangePreset, "custom">) {
    draftPreset = next;
    const resolved = presetRange(next, today);
    draftStart = resolved?.start ?? null;
    draftEnd = resolved?.end ?? null;
    if (resolved) leftMonth = addMonths(resolved.end, -1);
  }

  function chooseDay(day: string) {
    draftPreset = "custom";
    if (!draftStart || draftEnd) {
      draftStart = day;
      draftEnd = null;
    } else if (day < draftStart) {
      draftStart = day;
    } else {
      draftEnd = day;
    }
  }

  function typeDate(edge: "start" | "end", value: string) {
    if (!value) return;
    draftPreset = "custom";
    if (edge === "start") draftStart = value;
    else draftEnd = value;
    if (draftStart && draftEnd && draftStart > draftEnd) [draftStart, draftEnd] = [draftEnd, draftStart];
  }

  function clear() {
    draftPreset = "all";
    draftStart = null;
    draftEnd = null;
  }

  function apply() {
    onApply(draftRange, draftRange ? draftPreset : "all");
  }
</script>

<div class="range-popover" role="dialog" aria-label={$t.transactions.dateRange} data-date-range-popover>
  <ul class="presets">
    {#each [...RANGE_PRESETS, "custom" as const] as item}
      <li>
        <button
          type="button"
          aria-pressed={draftPreset === item}
          disabled={item === "custom"}
          onclick={() => item !== "custom" && choosePreset(item)}
        >
          {$t.transactions.rangePresets[item]}
          {#if draftPreset === item}<Check size={15} strokeWidth={2.25} aria-hidden="true" />{/if}
        </button>
      </li>
    {/each}
  </ul>

  <div class="calendar-side">
    <div class="date-inputs">
      <label>
        <span>{$t.transactions.startDate}</span>
        <span class="date-input">
          <CalendarDays size={15} strokeWidth={2} aria-hidden="true" />
          <input type="date" max={today} value={draftStart ?? ""} onchange={(event) => typeDate("start", event.currentTarget.value)} />
        </span>
      </label>
      <ArrowRight class="date-arrow" size={15} strokeWidth={2} aria-hidden="true" />
      <label>
        <span>{$t.transactions.endDate}</span>
        <span class="date-input" class:pending={Boolean(draftStart) && !draftEnd}>
          <CalendarDays size={15} strokeWidth={2} aria-hidden="true" />
          <input type="date" max={today} value={draftEnd ?? ""} onchange={(event) => typeDate("end", event.currentTarget.value)} />
        </span>
      </label>
    </div>

    <div class="months">
      {#each months as month, index}
        <div class="month">
          <div class="month-head">
            {#if index === 0}
              <button class="month-step" type="button" aria-label={$t.transactions.previousMonth} onclick={() => (leftMonth = addMonths(leftMonth, -1))}>
                <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
              </button>
            {/if}
            <strong>{month.label}</strong>
            {#if index === 1}
              <button
                class="month-step next"
                type="button"
                aria-label={$t.transactions.nextMonth}
                disabled={addMonths(month.first, 1) > today}
                onclick={() => (leftMonth = addMonths(leftMonth, 1))}
              >
                <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
              </button>
            {/if}
          </div>
          <div class="days" role="grid">
            {#each weekdays as weekday}<span class="weekday" aria-hidden="true">{weekday}</span>{/each}
            {#each month.cells as day}
              {#if day}
                {@const inRange = draftRange !== null && day >= draftRange.start && day <= draftRange.end}
                <button
                  type="button"
                  class="day num"
                  class:in-range={inRange}
                  class:edge={day === draftStart || day === draftEnd}
                  class:today={day === today}
                  disabled={day > today}
                  aria-pressed={inRange}
                  aria-label={day}
                  onclick={() => chooseDay(day)}
                >{Number(day.slice(8))}</button>
              {:else}
                <span aria-hidden="true"></span>
              {/if}
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </div>

  <div class="range-footer">
    <span>{summary}</span>
    <button class="text-button" type="button" onclick={clear}>{$t.transactions.clearRange}</button>
    <button class="button" type="button" onclick={onClose}>{$t.common.cancel}</button>
    <button class="button primary" type="button" onclick={apply}>{$t.transactions.applyRange}</button>
  </div>
</div>

<style>
  .range-popover {
    position: absolute;
    z-index: 5;
    top: calc(100% + 8px);
    left: 0;
    display: grid;
    grid-template-columns: 160px minmax(0, 1fr);
    width: min(694px, calc(100vw - 80px));
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: 0 18px 48px rgb(7 31 74 / 16%);
  }

  .presets {
    display: grid;
    align-content: start;
    gap: 2px;
    margin: 0;
    padding: var(--space-3) var(--space-2);
    border-right: 1px solid var(--border);
    list-style: none;
  }

  .presets button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    min-height: 32px;
    padding: 0 var(--space-3);
    border: 1px solid transparent;
    border-radius: var(--radius);
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 13px;
    font-weight: 650;
    text-align: left;
    cursor: pointer;
  }

  .presets button:disabled { cursor: default; }
  .presets button:not(:disabled):hover { color: var(--fg); }

  .presets button[aria-pressed="true"] {
    border-color: var(--border);
    color: var(--fg);
  }

  .calendar-side {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-4);
  }

  .date-inputs {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: end;
    gap: var(--space-2);
  }

  .date-inputs label {
    display: grid;
    gap: var(--space-1);
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
  }

  .date-inputs :global(.date-arrow) { margin-bottom: 11px; color: var(--muted); }

  .date-input {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 36px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--muted);
  }

  .date-input.pending,
  .date-input:focus-within { border-color: var(--fg); }

  .date-input input {
    min-width: 0;
    border: 0;
    background: none;
    color: var(--fg);
    font: inherit;
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 700;
  }

  .date-input input:focus { outline: none; }
  .date-input input::-webkit-calendar-picker-indicator { display: none; }

  .months {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-5);
  }

  .month-head {
    position: relative;
    display: grid;
    place-items: center;
    min-height: 28px;
    margin-bottom: var(--space-2);
    font-size: 13px;
  }

  .month-step {
    position: absolute;
    left: 0;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--fg);
    cursor: pointer;
  }

  .month-step.next { right: 0; left: auto; }
  .month-step:disabled { color: var(--muted); opacity: 0.4; cursor: default; }

  .days {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    row-gap: 4px;
  }

  .weekday {
    padding-bottom: var(--space-1);
    color: var(--muted);
    font-size: 11px;
    text-align: center;
  }

  .day {
    height: 30px;
    padding: 0;
    border: 1px solid transparent;
    background: none;
    color: var(--fg);
    font-size: 12px;
    font-weight: 650;
    cursor: pointer;
  }

  .day:hover:not(:disabled) { border-color: var(--border); border-radius: var(--radius); }
  .day:disabled { color: color-mix(in oklch, var(--muted) 55%, transparent); cursor: default; }
  .day.in-range { background: var(--accent-soft); }

  .day.edge {
    border-radius: var(--radius);
    background: color-mix(in oklch, var(--accent) 70%, var(--fg));
    color: white;
  }

  .day.today:not(.edge) { border-color: var(--border); border-radius: var(--radius); }

  .range-footer {
    display: flex;
    grid-column: 1 / -1;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
  }

  .range-footer span { margin-right: auto; }

  .text-button {
    padding: 0 var(--space-2);
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    font-weight: 650;
    cursor: pointer;
  }
</style>
