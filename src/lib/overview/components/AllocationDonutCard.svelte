<script lang="ts">
  import { Arc, PieChart } from "layerchart";
  import { cubicInOut } from "svelte/easing";
  import { t } from "$lib/i18n/i18n.ts";
  import type { AccountKind, AccountRowDto } from "$lib/shared-ledger/types.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import {
    buildAllocationDonutData,
    getAllocationCurrencies,
    type AllocationDonutItem,
    type AllocationDonutMode,
  } from "./allocation-donut-data.ts";

  export let accounts: AccountRowDto[] = [];
  export let mode: AllocationDonutMode = "asset";
  export let title = "";

  let currency = "TWD";
  let activeKey: AccountKind | null = null;

  $: currencies = getAllocationCurrencies(accounts, mode);
  $: if (currencies.length > 0 && !currencies.includes(currency)) currency = currencies[0];
  $: chart = buildAllocationDonutData(accounts, mode, currency);
  $: selectId = `allocation-${mode}-currency`;
  $: displayTitle = title || $t.allocation.defaultTitle;
  $: activeItem = chart.items.find((item) => item.key === activeKey) ?? null;
  $: if (activeKey && !chart.items.some((item) => item.key === activeKey)) activeKey = null;

  function selectValue(event: Event) {
    return (event.currentTarget as HTMLSelectElement).value;
  }

  function tooltipStyle(key: AccountKind) {
    let start = 0;
    for (const item of chart.items) {
      const angle = chart.total > 0 ? (item.value / chart.total) * Math.PI * 2 : 0;
      if (item.key === key) {
        const middle = start + angle / 2;
        return `--tooltip-x:${106 + Math.sin(middle) * 88}px; --tooltip-y:${106 - Math.cos(middle) * 88}px;`;
      }
      start += angle;
    }
    return "--tooltip-x:106px; --tooltip-y:24px;";
  }

  function sliceProps(props: Record<string, unknown>, item: AllocationDonutItem): Record<string, unknown> {
    return {
      ...props,
      offset: activeKey === item.key ? 8 : 0,
      class: `allocation-slice ${activeKey === item.key ? "active" : ""}`,
      tabindex: 0,
      "aria-label": `${item.label}: ${item.percent.toFixed(1)}%, ${formatMoney({ currency: chart.currency, value: item.value })}`,
    };
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
            >
              {#snippet arc({ props })}
                {@const item = props.data as AllocationDonutItem}
                <Arc
                  {...sliceProps(props, item)}
                  onpointerenter={() => (activeKey = item.key)}
                  onpointerleave={() => (activeKey = null)}
                  onfocus={() => (activeKey = item.key)}
                  onblur={() => (activeKey = null)}
                />
              {/snippet}
            </PieChart>
          {/key}
          <div class="allocation-donut-center" aria-hidden="true">
            <span>{$t.common.total}</span>
            <strong class="allocation-donut-total" data-sensitive>
              {formatMoney({ currency: chart.currency, value: chart.total })}
            </strong>
          </div>
          {#if activeItem}
            <div class="allocation-tooltip" style={tooltipStyle(activeItem.key)}>
              <div>
                <span class="allocation-tooltip-swatch" style:background-color={activeItem.color}></span>
                <strong>{activeItem.label}</strong>
                <span class="money">{activeItem.percent.toFixed(1)}%</span>
              </div>
              <span class="money" data-sensitive>
                {formatMoney({ currency: chart.currency, value: activeItem.value })}
              </span>
            </div>
          {/if}
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
    place-items: center;
  }

  .allocation-donut-stage {
    position: relative;
    width: min(100%, 260px);
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

  .allocation-empty {
    min-height: 240px;
    display: grid;
    place-items: center;
    color: var(--muted);
    font-size: 14px;
    font-weight: 700;
  }

  .allocation-tooltip {
    position: absolute;
    left: clamp(74px, var(--tooltip-x), 186px);
    top: clamp(42px, var(--tooltip-y), 174px);
    z-index: 3;
    min-width: 154px;
    padding: 10px 12px;
    border: 1px solid color-mix(in oklch, var(--border) 72%, transparent);
    border-radius: var(--radius);
    background: color-mix(in oklch, var(--surface) 94%, transparent);
    box-shadow: 0 18px 40px rgb(15 23 42 / 0.16);
    pointer-events: none;
    animation: allocation-tooltip-in 140ms ease-out both;
  }

  .allocation-tooltip div {
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    color: var(--fg);
    font-size: 13px;
    font-weight: 760;
  }

  .allocation-tooltip > span {
    display: block;
    margin-top: 4px;
    padding-left: 18px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 680;
  }

  .allocation-tooltip-swatch {
    width: 10px;
    height: 10px;
    border-radius: 999px;
  }

  :global(.allocation-slice) {
    cursor: pointer;
    outline: none;
    transition: opacity 140ms ease, filter 140ms ease;
  }

  :global(.allocation-donut-stage:has(.allocation-slice.active) .allocation-slice:not(.active)) {
    opacity: 0.42;
  }

  :global(.allocation-slice.active) {
    filter: drop-shadow(0 10px 12px rgb(15 23 42 / 0.22));
  }

  :global(.allocation-slice:focus-visible) {
    stroke: var(--fg);
    stroke-width: 2px;
  }

  @keyframes allocation-tooltip-in {
    from {
      opacity: 0;
      transform: translate(-50%, -82%) scale(0.96);
    }

    to {
      opacity: 1;
      transform: translate(-50%, -104%) scale(1);
    }
  }

  @media (max-width: 980px) {
    .allocation-donut-stage {
      height: 200px;
    }
  }
</style>
