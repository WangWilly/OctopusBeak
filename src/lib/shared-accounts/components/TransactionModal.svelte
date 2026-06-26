<script lang="ts">
  import type { AccountRowDto, TransactionRowDto } from "$lib/shared-ledger/types.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";

  export let open = false;
  export let account: AccountRowDto | null = null;
  export let rows: TransactionRowDto[] = [];
</script>

{#if open}
  <div class="modal open">
    <button class="modal-backdrop" type="button" aria-label="Close" on:click={() => (open = false)}></button>
    <div class="modal-panel" role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-head">
        <div>
          <h2>{account ? `${account.label} Transactions` : "Transactions"}</h2>
          <p class="lead">{account ? `${account.institution} / ${account.typeLabel}` : ""}</p>
        </div>
        <button class="modal-close" type="button" aria-label="Close" on:click={() => (open = false)}>x</button>
      </div>
      <div class="modal-body">
        <table class="table">
          <thead>
            <tr><th>Date</th><th>Description</th><th>Type</th><th class="right">Amount</th><th class="right">Note</th></tr>
          </thead>
          <tbody>
            {#each rows as row}
              <tr>
                <td>{row.date}</td>
                <td>{row.label}</td>
                <td>{row.type}</td>
                <td
                  class="right money"
                  class:amount-positive={row.amount > 0}
                  class:amount-negative={row.amount < 0}
                >
                  {formatMoney({ currency: row.currency, value: row.amount }, { signed: true })}
                </td>
                <td class="right">{row.note || "--"}</td>
              </tr>
            {:else}
              <tr><td colspan="5">No transactions for this account.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>
{/if}

<style>
  .amount-positive {
    color: var(--success);
  }

  .amount-negative {
    color: var(--danger);
  }
</style>
