<script lang="ts">
  import type { SummaryMetricDto } from "$lib/shared-ledger/types.ts";
  import { formatAmountLines } from "$lib/shared-money/money.ts";

  export let metrics: SummaryMetricDto[] = [];
</script>

<div class="grid metrics">
  {#each metrics as metric}
    <article class="card metric-card">
      <span class="label">{metric.label}</span>
      <strong class="value money">{formatAmountLines(metric.amounts)}</strong>
      <span class="breakdown">{metric.breakdown.join(" + ")}</span>
    </article>
  {/each}
</div>
