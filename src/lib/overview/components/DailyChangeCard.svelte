<script lang="ts">
  import { ArrowRight, ChartColumn } from "@lucide/svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import CardPlaceholder from "$lib/overview/components/CardPlaceholder.svelte";
  import type { DailyBar } from "$lib/overview/overview-model.ts";
  import { formatShortDate, formatTwdNumber } from "$lib/overview/overview-format.ts";

  export let bars: DailyBar[] = [];
  export let hasDetail = false;
  export let openDetail: () => void = () => {};

  $: hasChange = bars.some((bar) => bar.change !== null);
  $: maxAbs = Math.max(1, ...bars.map((bar) => Math.abs(bar.change ?? 0)));
  $: lastWithChange = bars.findLast((bar) => bar.change !== null)?.date ?? null;
</script>

<article class="card daily-change-card" data-daily-change>
  <header class="card-head">
    <div>
      <h2>{`${$t.overview.dailyChangeTitle} · ${$t.overview.dailyChangeRange}`}</h2>
      <p>{$t.overview.dailyChangeLead}</p>
    </div>
    {#if hasDetail}
      <button type="button" class="link-button" onclick={openDetail}>
        {$t.overview.dailyDetail}<ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    {/if}
  </header>
  {#if hasChange}
    <ol class="bars">
      {#each bars as bar (bar.date)}
        {@const height = bar.change === null ? 0 : (Math.abs(bar.change) / maxAbs) * 50}
        <li
          class="bar-day"
          data-direction={bar.change === null ? "none" : bar.change < 0 ? "down" : "up"}
          data-latest={bar.date === lastWithChange ? "" : undefined}
          title={bar.change === null ? $t.overview.dailyChangeNoRecord : undefined}
        >
          <span class="bar-plot" aria-hidden="true">
            {#if bar.change !== null}
              <span class="bar" style:height={`${Math.max(height, 1)}%`}></span>
            {:else}
              <span class="bar-missing"></span>
            {/if}
          </span>
          <span class="bar-date">{formatShortDate(bar.date, $locale)}</span>
          <span class="visually-hidden" data-sensitive>
            {bar.change === null ? $t.overview.dailyChangeNoRecord : formatTwdNumber(bar.change, $locale, true)}
          </span>
        </li>
      {/each}
    </ol>
  {:else}
    <CardPlaceholder state="daily-change" title={$t.overview.dailyChangeEmptyTitle} body={$t.overview.dailyChangeEmptyBody}>
      <ChartColumn size={18} strokeWidth={2} />
    </CardPlaceholder>
  {/if}
</article>

<style>
  .daily-change-card {
    display: grid;
    grid-template-rows: auto 1fr;
    gap: var(--space-4);
    padding: var(--space-5) var(--space-6);
  }

  .card-head {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .card-head h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
  }

  .card-head p {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  .link-button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
  }

  .bars {
    min-height: 260px;
    display: grid;
    grid-template-columns: repeat(14, minmax(0, 1fr));
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .bar-day {
    display: grid;
    grid-template-rows: 1fr auto;
    gap: var(--space-2);
    min-width: 0;
  }

  .bar-plot {
    position: relative;
    display: block;
    background: linear-gradient(var(--border), var(--border)) center / 100% 1px no-repeat;
  }

  .bar {
    position: absolute;
    left: 15%;
    right: 15%;
    border-radius: 2px;
    background: color-mix(in oklch, var(--accent) 62%, white);
  }

  [data-direction="up"] .bar {
    bottom: 50%;
  }

  [data-direction="down"] .bar {
    top: 50%;
    background: color-mix(in oklch, var(--danger) 52%, white);
  }

  [data-latest][data-direction="up"] .bar {
    background: var(--accent);
  }

  [data-latest][data-direction="down"] .bar {
    background: var(--danger);
  }

  .bar-missing {
    position: absolute;
    top: calc(50% - 2px);
    left: calc(50% - 2px);
    width: 4px;
    height: 4px;
    border-radius: 999px;
    background: var(--border);
  }

  .bar-date {
    overflow: hidden;
    color: var(--muted);
    font-size: 10px;
    font-weight: 600;
    text-align: center;
    white-space: nowrap;
  }

  [data-latest] .bar-date {
    color: var(--fg);
    font-weight: 750;
  }
</style>
