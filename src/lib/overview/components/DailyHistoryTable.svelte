<script lang="ts">
  import type { DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";

  export let rows: DailyHistoryRowDto[] = [];
  export let compact = false;
  export let netLabel = "Net assets";
  export let currency = "TWD";

  function formatCurrencyAmount(amounts: DailyHistoryRowDto["netAssets"], signed = false) {
    const amount = amounts.find((item) => item.currency === currency);
    return amount ? formatMoney(amount, { signed }) : "--";
  }

  function currencyValue(amounts: DailyHistoryRowDto["netAssets"]) {
    return amounts.find((item) => item.currency === currency)?.value ?? 0;
  }
</script>

<div class="table-wrap">
  <table class="table">
    <thead>
      <tr>
        <th>Date</th>
        <th class="right">{netLabel}</th>
        {#if !compact}
          <th class="right">Daily change</th>
          <th class="right">Assets</th>
          <th class="right">Liabilities</th>
        {:else}
          <th class="right">Assets</th>
          <th class="right">Liabilities</th>
        {/if}
      </tr>
    </thead>
    <tbody>
      {#each rows as row}
        <tr>
          <td>{row.date}</td>
          <td class="right money">{formatCurrencyAmount(row.netAssets)}</td>
          {#if !compact}
            {@const dailyChange = currencyValue(row.dailyChange)}
            <td
              class="right money"
              class:amount-positive={dailyChange > 0}
              class:amount-negative={dailyChange < 0}
            >
              {formatCurrencyAmount(row.dailyChange, true)}
            </td>
            <td class="right money">{formatCurrencyAmount(row.assets)}</td>
            <td class="right money">{formatCurrencyAmount(row.liabilities)}</td>
          {:else}
            <td class="right money">{formatCurrencyAmount(row.assets)}</td>
            <td class="right money">{formatCurrencyAmount(row.liabilities)}</td>
          {/if}
        </tr>
      {:else}
        <tr>
          <td colspan={compact ? 4 : 5}>No snapshot history yet.</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .amount-positive {
    color: var(--success);
  }

  .amount-negative {
    color: var(--danger);
  }
</style>
