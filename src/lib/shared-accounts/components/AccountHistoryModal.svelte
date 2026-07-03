<script lang="ts">
  import { t, translateKnownLabel } from "$lib/i18n/i18n.ts";
  import DailyHistoryTable from "$lib/overview/components/DailyHistoryTable.svelte";
  import SnapshotSparkline from "$lib/overview/components/SnapshotSparkline.svelte";
  import type { AccountRowDto, DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";

  export let open = false;
  export let account: AccountRowDto | null = null;
  export let rows: DailyHistoryRowDto[] = [];

  let currency = "TWD";

  $: currencies = [
    ...new Set(rows.flatMap((row) => row.netAssets.map((amount) => amount.currency))),
  ];
  $: if (!currencies.includes(currency)) currency = currencies[0] ?? "TWD";
  $: chartRows = [...rows].sort((left, right) => left.date.localeCompare(right.date)).slice(-30);

  function closeOnEscape(event: KeyboardEvent) {
    if (open && event.key === "Escape") open = false;
  }

  function selectValue(event: Event) {
    return (event.currentTarget as HTMLSelectElement).value;
  }
</script>

<svelte:window onkeydown={closeOnEscape} />

{#if open}
  <div class="modal open">
    <button class="modal-backdrop" type="button" aria-label={$t.common.close} onclick={() => (open = false)}></button>
    <div class="modal-panel" role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-head">
        <div>
          <h2>{account ? $t.accountHistory.accountTitle(account.label) : $t.accountHistory.title}</h2>
          <p class="lead">{account ? `${account.institution} / ${translateKnownLabel($t, account.typeLabel)}` : ""}</p>
        </div>
        <div class="modal-actions">
          {#if currencies.length > 0}
            <label class="chip select-chip" for="account-history-currency">
              <select
                id="account-history-currency"
                aria-label={$t.accountHistory.currencyAria}
                bind:value={currency}
                onchange={(event) => (currency = selectValue(event))}
                oninput={(event) => (currency = selectValue(event))}
              >
                {#each currencies as option}
                  <option>{option}</option>
                {/each}
              </select>
            </label>
          {/if}
          <button class="modal-close" type="button" aria-label={$t.common.close} onclick={() => (open = false)}>x</button>
        </div>
      </div>
      <div class="modal-body history-modal-body">
        <div class="history-chart">
          <SnapshotSparkline rows={chartRows} {currency} label={$t.common.balance} />
        </div>
        {#key currency}
          <DailyHistoryTable rows={rows} {currency} netLabel={$t.common.balance} paginate pageSize={20} visibleRows={6} />
        {/key}
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .history-modal-body {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-5);
  }

  .history-chart {
    min-height: 220px;
    aspect-ratio: 720 / 220;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-soft);
  }

  .history-chart :global(.sparkline) {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
