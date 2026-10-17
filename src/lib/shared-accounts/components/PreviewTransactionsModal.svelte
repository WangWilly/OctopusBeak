<script lang="ts">
  import { t } from "$lib/i18n/i18n.ts";
  import type { AccountRowDto, PreviewTransactionRowDto } from "$lib/shared-ledger/types.ts";
  import { formatAmountLines } from "$lib/shared-money/money.ts";
  import AccountModalHeader from "./AccountModalHeader.svelte";

  export let open = false;
  export let account: AccountRowDto | null = null;

  $: rows = account?.preview?.transactions ?? [];

  function close() {
    open = false;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (open && event.key === "Escape") close();
  }

  function postedAt(row: PreviewTransactionRowDto) {
    return row.postedAt.value.replace("T", " ");
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open && account?.preview}
  <div class="modal open">
    <button class="modal-backdrop" type="button" aria-label={$t.common.close} on:click={close}></button>
    <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="preview-transactions-title" tabindex="-1" data-preview-transactions>
      <AccountModalHeader {account} eyebrow={$t.preview.transactionsEyebrow} titleId="preview-transactions-title" onClose={close}>
        <div class="balance">
          <span>{$t.transactions.currentBalance}</span>
          <strong class="money" data-sensitive>{formatAmountLines(account.amountLines)}</strong>
        </div>
      </AccountModalHeader>
      <p class="source-note">{$t.preview.transactionsNote}</p>
      <div class="modal-body">
        <table class="table">
          <thead>
            <tr>
              <th>{$t.transactions.date}</th>
              <th>{$t.transactions.description}</th>
              <th>{$t.preview.direction}</th>
              <th class="right">{$t.preview.amount}</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row}
              <tr data-direction={row.direction}>
                <td class="date num">{postedAt(row)}</td>
                <td class="description">{row.description ?? "—"}</td>
                <td><span class="chip direction" data-direction={row.direction}>{$t.preview.directions[row.direction]}</span></td>
                <td class="right money" data-sensitive>{row.currency} {row.amount}</td>
              </tr>
            {:else}
              <tr><td class="empty" colspan="4">{$t.preview.noTransactions}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>
{/if}

<style>
  .balance {
    display: grid;
    justify-items: end;
    gap: 2px;
  }

  .balance span {
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
  }

  .balance strong {
    font-family: var(--font-mono);
    font-size: 18px;
    white-space: nowrap;
  }

  .source-note {
    margin: 0;
    padding: 0 var(--space-6) var(--space-4);
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
  }

  .date {
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }

  .description {
    font-size: 13px;
    font-weight: 600;
  }

  .direction {
    min-height: 24px;
    font-size: 11px;
  }

  .direction[data-direction="unknown"] {
    color: var(--warn);
    background: color-mix(in oklch, var(--warn) 10%, white);
  }

  .empty {
    color: var(--muted);
    text-align: center;
  }
</style>
