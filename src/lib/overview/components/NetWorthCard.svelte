<script lang="ts">
  import { ArrowDownRight, ArrowUpRight, ChartLine, CircleDashed } from "@lucide/svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import CardPlaceholder from "$lib/overview/components/CardPlaceholder.svelte";
  import NetWorthChart from "$lib/overview/components/NetWorthChart.svelte";
  import PreviewMarker from "$lib/shared-shell/components/PreviewMarker.svelte";
  import {
    seriesInRange,
    type NetWorth,
    type NetWorthChip,
    type NetWorthPoint,
    type SeriesRange,
  } from "$lib/overview/overview-model.ts";
  import { formatPct, formatShortDate, formatTwd, formatTwdNumber } from "$lib/overview/overview-format.ts";

  export let netWorth: NetWorth;
  export let series: NetWorthPoint[] = [];
  export let asOfLabel = "";
  /** A preview credit account owes an unknown amount, so the net position is not a figure. */
  export let incomplete = false;

  const ranges: SeriesRange[] = ["30d", "90d", "all"];
  let range: SeriesRange = "all";

  $: rangeLabels = { "30d": $t.overview.range30, "90d": $t.overview.range90, all: $t.overview.rangeAll };
  $: visible = seriesInRange(series, range);
  $: hasTrend = series.length > 1;

  function chipLabel(chip: NetWorthChip) {
    if (chip.kind === "latest") return chip.isToday ? $t.overview.chipToday : $t.overview.chipOnDate(formatShortDate(chip.date, $locale));
    if (chip.kind === "trailing-30") return $t.overview.chipTrailing30;
    return $t.overview.chipSince(formatShortDate(chip.since, $locale));
  }
</script>

<article class="card net-worth-card" data-net-worth>
  <p class="net-worth-label">
    {$t.overview.netWorth}{#if asOfLabel}{` · ${asOfLabel}`}{/if}
    {#if netWorth.includesPreview}<PreviewMarker />{/if}
  </p>
  {#if incomplete}
    <p class="net-worth-figure incomplete" data-total-incomplete>{$t.preview.incomplete}</p>
    <p class="net-worth-note">{$t.preview.incompleteNote}</p>
  {:else if netWorth.value === null}
    <p class="net-worth-figure empty" aria-label={$t.overview.noDataYet}>—</p>
  {:else}
    <p class="net-worth-figure money" data-sensitive>{formatTwd(netWorth.value, $locale)}</p>
  {/if}
  {#if netWorth.unconvertedPreviewCurrencies.length > 0}
    <p class="net-worth-note">{$t.overview.unconverted(netWorth.unconvertedPreviewCurrencies.join(", "))}</p>
  {/if}
  <div class="net-worth-toolbar">
    {#if !incomplete}
      <ul class="chips" aria-label={$t.overview.netWorth}>
        {#each netWorth.chips as chip (chip.kind)}
          <li class="change-chip" data-chip={chip.kind} data-direction={chip.change < 0 ? "down" : "up"}>
            <span>{chipLabel(chip)}</span>
            {#if chip.change < 0}
              <ArrowDownRight size={13} strokeWidth={2.2} aria-hidden="true" />
            {:else}
              <ArrowUpRight size={13} strokeWidth={2.2} aria-hidden="true" />
            {/if}
            <strong class="money" data-sensitive>{formatTwdNumber(chip.change, $locale, true)}</strong>
            {#if chip.pct !== null}<span class="pct" data-sensitive>{formatPct(chip.pct, $locale)}</span>{/if}
          </li>
        {:else}
          <li class="change-chip pending"><CircleDashed size={13} strokeWidth={2.2} aria-hidden="true" />{$t.overview.noDataYet}</li>
        {/each}
      </ul>
    {/if}
    <div class="filters range-filter" role="group" aria-label={$t.overview.rangeAria}>
      {#each ranges as option}
        <button
          type="button"
          class="filter-btn"
          aria-pressed={range === option}
          disabled={!hasTrend}
          onclick={() => (range = option)}
        >{rangeLabels[option]}</button>
      {/each}
    </div>
  </div>
  {#if hasTrend}
    <NetWorthChart points={visible} label={$t.overview.chartAria} />
    <p class="caption">
      {$t.overview.chartCaption}
      {#if visible.some((point) => point.includesPreview)}<PreviewMarker placement="above" />{/if}
    </p>
  {:else}
    <CardPlaceholder state="net-worth" title={$t.overview.chartEmptyTitle} body={$t.overview.chartEmptyBody}>
      <ChartLine size={18} strokeWidth={2} />
    </CardPlaceholder>
  {/if}
</article>

<style>
  .net-worth-card {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-6);
  }

  .net-worth-label {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    font-weight: 680;
  }

  .net-worth-note {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }

  .net-worth-figure {
    margin: 0;
    font-size: clamp(30px, 3.6vw, 44px);
    font-weight: 750;
    line-height: 1.1;
  }

  .net-worth-figure.incomplete {
    color: var(--warn);
    font-size: clamp(24px, 2.6vw, 32px);
  }

  .net-worth-figure.empty {
    color: var(--muted);
  }

  .net-worth-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .change-chip {
    min-height: 28px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    border-radius: var(--radius);
    background: var(--surface-soft);
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }

  .change-chip strong {
    font-size: 12px;
    font-weight: 750;
  }

  .change-chip[data-direction="up"] :is(strong, :global(svg)) {
    color: var(--success);
  }

  .change-chip[data-direction="down"] :is(strong, :global(svg)) {
    color: var(--danger);
  }

  .change-chip.pending {
    color: var(--muted);
  }

  .range-filter {
    display: inline-flex;
    gap: 2px;
    padding: 4px;
    border: 1px solid color-mix(in oklch, var(--border) 58%, transparent);
    border-radius: 12px;
    background: var(--surface-soft);
  }

  .caption {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }
</style>
