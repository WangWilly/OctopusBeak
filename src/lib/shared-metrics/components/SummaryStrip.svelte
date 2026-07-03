<script lang="ts">
  import type { SummaryMetricDto } from "$lib/shared-ledger/types.ts";
  import { formatMoney, primaryAmount } from "$lib/shared-money/money.ts";

  export let metrics: SummaryMetricDto[] = [];

  function secondaryAmounts(metric: SummaryMetricDto) {
    const primary = primaryAmount(metric.amounts);
    return primary ? metric.amounts.filter((amount) => amount !== primary) : [];
  }
</script>

<div class="grid metrics">
  {#each metrics as metric}
    {@const primary = primaryAmount(metric.amounts)}
    {@const secondary = secondaryAmounts(metric)}
    <article class="card metric-card">
      <span class="label">{metric.label}</span>
      <div class="metric-amounts">
        {#if primary}
          <strong class="value money">{formatMoney(primary)}</strong>
        {:else}
          <strong class="value money">--</strong>
        {/if}
        {#if secondary.length > 0}
          <div class="currency-list" aria-label={`${metric.label} secondary currencies`}>
            {#each secondary as amount}
              <span class="currency-chip money">{formatMoney(amount)}</span>
            {/each}
          </div>
        {/if}
      </div>
      <span class="breakdown">{metric.breakdown.join(" + ")}</span>
    </article>
  {/each}
</div>
