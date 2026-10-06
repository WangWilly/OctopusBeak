<script lang="ts">
  import { CalendarDays, ChevronDown } from "@lucide/svelte";

  import { t } from "$lib/i18n/i18n.ts";
  import type { DateRange, RangePreset } from "$lib/shared-accounts/transaction-filters.ts";
  import DateRangePopover from "./DateRangePopover.svelte";

  export let range: DateRange | null;
  export let preset: RangePreset;
  export let today: string;
  export let open: boolean;
  export let countIn: (range: DateRange | null) => number;
  export let onToggle: () => void;
  export let onClose: () => void;
  export let onApply: (range: DateRange | null, preset: RangePreset) => void;

  $: label = range
    ? `${range.start.replaceAll("-", "/")} – ${range.end.slice(0, 4) === range.start.slice(0, 4) ? range.end.slice(5).replace("-", "/") : range.end.replaceAll("-", "/")}`
    : $t.transactions.rangePresets.all;
</script>

<div class="range-filter">
  <button
    class="filter-chip"
    class:applied={range !== null}
    type="button"
    aria-expanded={open}
    aria-label={`${$t.transactions.dateRange}: ${label}`}
    onclick={onToggle}
  >
    <CalendarDays size={15} strokeWidth={2} aria-hidden="true" />
    <span class:num={range !== null}>{label}</span>
    <ChevronDown class="chevron" size={14} strokeWidth={2} aria-hidden="true" />
  </button>
  {#if open}
    <DateRangePopover {range} {preset} {today} {countIn} {onApply} {onClose} />
  {/if}
</div>

<style>
  .range-filter { position: relative; }

  .filter-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 32px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }

  .filter-chip.applied {
    border-color: color-mix(in oklch, var(--accent) 30%, var(--border));
    background: var(--accent-soft);
  }

  .filter-chip[aria-expanded="true"] { border-color: var(--fg); }
  .filter-chip[aria-expanded="true"] :global(.chevron) { transform: rotate(180deg); }
</style>
