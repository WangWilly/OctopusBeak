<script lang="ts">
  import { PieChart } from "layerchart";
  import { cubicInOut } from "svelte/easing";
  import { t } from "$lib/i18n/i18n.ts";
  import type { AccountRowDto } from "$lib/shared-ledger/types.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import {
    buildAllocationDonutData,
    getAllocationCurrencies,
    type AllocationDonutMode,
  } from "./allocation-donut-data.ts";

  export let accounts: AccountRowDto[] = [];
  export let mode: AllocationDonutMode = "asset";
  export let title = "";

  let currency = "TWD";

  $: currencies = getAllocationCurrencies(accounts, mode);
  $: if (currencies.length > 0 && !currencies.includes(currency)) currency = currencies[0];
  $: chart = buildAllocationDonutData(accounts, mode, currency);
  $: selectId = `allocation-${mode}-currency`;
  $: displayTitle = title || $t.allocation.defaultTitle;

  function selectValue(event: Event) {
    return (event.currentTarget as HTMLSelectElement).value;
  }
</script>

<article class="card allocation-card">
  <div class="panel-title">
    <h2>{displayTitle}</h2>
    {#if currencies.length > 1}
      <label class="chip select-chip" for={selectId}>
        <select
          id={selectId}
          aria-label={$t.allocation.currencyAria(displayTitle)}
          bind:value={currency}
          onchange={(event) => (currency = selectValue(event))}
          oninput={(event) => (currency = selectValue(event))}
        >
          {#each currencies as item}
            <option>{item}</option>
          {/each}
        </select>
      </label>
    {:else}
      <span class="chip">{currency}</span>
    {/if}
  </div>

  <div class="allocation-panel">
    {#if chart.items.length > 0}
      <div class="allocation-content">
        <div class="allocation-donut-stage" aria-label={$t.allocation.stageAria(displayTitle, currency)}>
          {#key chart.currency}
            <PieChart
              data={chart.items}
              key="key"
              label="label"
              value="value"
              c="key"
              innerRadius={0.62}
              outerRadius={88}
              cornerRadius={4}
              padAngle={0.018}
              legend={false}
              tooltipContext={false}
              props={{ pie: { motion: { type: "tween", duration: 800, easing: cubicInOut } } }}
              height={212}
              padding={{ top: 6, right: 6, bottom: 6, left: 6 }}
            />
          {/key}
          <div class="allocation-donut-center" aria-hidden="true">
            <span>{$t.common.total}</span>
            <strong class="allocation-donut-total" data-sensitive>
              {formatMoney({ currency: chart.currency, value: chart.total })}
            </strong>
          </div>
        </div>

        <div class="allocation-legend" aria-label={$t.allocation.breakdownAria(displayTitle)}>
          {#each chart.items as item}
            <div class="allocation-legend-item">
              <span class="allocation-swatch" style:background-color={item.color}></span>
              <span class="allocation-label">{item.label}</span>
              <span class="allocation-percent money">{item.percent.toFixed(1)}%</span>
              <span class="allocation-amount money" data-sensitive>
                {formatMoney({ currency: chart.currency, value: item.value })}
              </span>
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <div class="allocation-empty">{$t.allocation.empty(currency)}</div>
    {/if}
  </div>
</article>

<style>
  .allocation-card {
    min-width: 0;
  }

  .allocation-panel {
    min-height: 280px;
    padding: var(--space-5);
  }

  .allocation-content {
    display: grid;
    grid-template-columns: minmax(176px, 212px) minmax(0, 1fr);
    align-items: center;
    gap: var(--space-4);
  }

  .allocation-donut-stage {
    position: relative;
    min-width: 0;
    height: 212px;
  }

  .allocation-donut-center {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    gap: 2px;
    text-align: center;
    pointer-events: none;
  }

  .allocation-donut-center span {
    color: var(--muted);
    font-size: 10px;
    font-weight: 760;
    letter-spacing: 0.075em;
    text-transform: uppercase;
  }

  .allocation-donut-total {
    max-width: 132px;
    color: var(--fg);
    font-size: 16px;
    font-weight: 780;
    line-height: 1.15;
    overflow-wrap: anywhere;
  }

  .allocation-legend {
    min-width: 0;
    display: grid;
    gap: 12px;
  }

  .allocation-legend-item {
    min-width: 0;
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr) auto;
    gap: 6px 8px;
    align-items: center;
  }

  .allocation-swatch {
    width: 10px;
    height: 10px;
    border-radius: 999px;
  }

  .allocation-label {
    min-width: 0;
    color: var(--fg);
    font-size: 13px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .allocation-percent {
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
  }

  .allocation-amount {
    grid-column: 2 / 4;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.2;
  }

  .allocation-empty {
    min-height: 240px;
    display: grid;
    place-items: center;
    color: var(--muted);
    font-size: 14px;
    font-weight: 700;
  }

  @media (max-width: 980px) {
    .allocation-content {
      grid-template-columns: 1fr;
    }

    .allocation-donut-stage {
      height: 200px;
    }
  }
</style>
