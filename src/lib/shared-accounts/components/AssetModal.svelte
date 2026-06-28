<script lang="ts">
  import type { AccountRowDto, AssetPositionDto } from "$lib/shared-ledger/types.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";

  export let open = false;
  export let account: AccountRowDto | null = null;
  export let rows: AssetPositionDto[] = [];

  function changeValue(change: string) {
    const value = Number.parseFloat(change);
    return Number.isFinite(value) ? value : 0;
  }

  $: metricLabels = [...new Set(rows.map((row) => row.metricLabel ?? "Return"))];
  $: metricLabel = metricLabels.length === 1 ? metricLabels[0] : "Metric";

  function isReturnMetric(row: AssetPositionDto) {
    return (row.metricLabel ?? "Return") === "Return";
  }
</script>

{#if open}
  <div class="modal open">
    <button class="modal-backdrop" type="button" aria-label="Close" on:click={() => (open = false)}></button>
    <div class="modal-panel" role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-head">
        <div>
          <h2>{account ? `${account.label} Positions` : "Positions"}</h2>
          <p class="lead">{account ? `${account.institution} / ${account.typeLabel}` : ""}</p>
        </div>
        <button class="modal-close" type="button" aria-label="Close" on:click={() => (open = false)}>x</button>
      </div>
      <div class="modal-body">
        <table class="table">
          <thead>
            <tr><th>Symbol</th><th>Name</th><th class="right">Units</th><th class="right">Value</th><th class="right">{metricLabel}</th></tr>
          </thead>
          <tbody>
            {#each rows as row}
              <tr>
                <td>{row.symbol}</td>
                <td>{row.name}</td>
                <td class="right num">{row.units}</td>
                <td class="right money">{formatMoney({ currency: row.currency, value: row.value })}</td>
                <td
                  class="right"
                  class:return-positive={isReturnMetric(row) && changeValue(row.change) > 0}
                  class:return-negative={isReturnMetric(row) && changeValue(row.change) < 0}
                >
                  {row.change}
                </td>
              </tr>
            {:else}
              <tr><td colspan="5">No asset positions for this account.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>
{/if}

<style>
  .return-positive {
    color: var(--success);
  }

  .return-negative {
    color: var(--danger);
  }
</style>
