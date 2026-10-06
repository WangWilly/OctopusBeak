<script lang="ts">
  import { Download } from "@lucide/svelte";

  import { locale, t } from "$lib/i18n/i18n.ts";
  import { formatShare, formatTwd } from "$lib/overview/overview-format.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import { downloadCsv } from "$lib/shared-accounts/download-csv.ts";
  import { accountModalTitle } from "$lib/shared-accounts/localize-account.ts";
  import {
    positionPrice,
    positionShares,
    positionsCsv,
    recentDividends,
  } from "$lib/shared-accounts/position-summary.ts";
  import { dateInTimeZone } from "$lib/shared-ledger/twd-valuation.ts";
  import type { AccountRowDto, AssetPositionDto, TransactionRowDto } from "$lib/shared-ledger/types.ts";
  import { formatAmountLines, formatMoney } from "$lib/shared-money/money.ts";
  import AccountModalHeader from "./AccountModalHeader.svelte";

  export let open = false;
  export let account: AccountRowDto | null = null;
  export let rows: AssetPositionDto[] = [];
  /** The account's transactions, for its recent dividends. */
  export let transactions: TransactionRowDto[] = [];
  /** The account's converted value; null when it has no rate or is already all TWD. */
  export let twdValue: number | null = null;

  // Largest holdings first; awaiting valuations follow.
  $: sortedRows = [...rows].sort((left, right) => (right.value ?? -1) - (left.value ?? -1));
  $: shares = positionShares(rows);
  $: today = dateInTimeZone(new Date(), $systemTimezone);
  $: dividends = recentDividends(transactions, today, $systemTimezone);
  $: showTwd = twdValue !== null && account?.amountLines.some((amount) => amount.currency !== "TWD");

  function close() {
    open = false;
  }

  function closeOnEscape(event: KeyboardEvent) {
    if (open && event.key === "Escape") close();
  }

  function formatPositionValue(row: AssetPositionDto) {
    return formatMoney({
      currency: row.currency,
      value: row.value ?? 0,
      exact: row.valueExact ?? undefined,
    }, { locale: $locale });
  }

  /** Quotes keep two decimals even for whole-unit currencies such as TWD. */
  function formatPrice(row: AssetPositionDto) {
    const price = positionPrice(row);
    if (price === null) return "--";
    const digits = new Intl.NumberFormat($locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price);
    return `${row.currency} ${digits}`;
  }

  function exportCsv() {
    if (!account) return;
    downloadCsv(`${accountModalTitle(account, $t)} ${$t.positions.title} ${today}`, positionsCsv(sortedRows, {
      symbol: $t.positions.symbol,
      name: $t.positions.name,
      units: $t.positions.units,
      price: $t.positions.price,
      value: $t.positions.value,
      currency: $t.positions.currency,
      share: $t.positions.share,
    }));
  }
</script>

<svelte:window on:keydown={closeOnEscape} />

{#if open}
  <div class="modal open">
    <button class="modal-backdrop" type="button" aria-label={$t.common.close} on:click={close}></button>
    <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="positions-title" tabindex="-1">
      <AccountModalHeader {account} eyebrow={$t.positions.title} titleId="positions-title" onClose={close}>
        {#if account}
          <div class="account-value">
            <span class="label">{$t.positions.accountValue}</span>
            <strong class="money" data-sensitive>{formatAmountLines(account.amountLines)}</strong>
            {#if showTwd && twdValue !== null}
              <span class="converted money" data-sensitive>≈ {formatTwd(twdValue, $locale)}</span>
            {/if}
            {#if dividends.count > 0}
              <span class="dividends" data-dividends>
                {$t.positions.dividends}
                <strong class="money" data-sensitive>{formatAmountLines(dividends.totals)}</strong>
                {$t.positions.dividendCount(dividends.count)}
              </span>
            {/if}
          </div>
        {/if}
      </AccountModalHeader>

      <div class="modal-body">
        <table class="table positions-table">
          <thead>
            <tr>
              <th>{$t.positions.symbol}</th>
              <th>{$t.positions.name}</th>
              <th class="right">{$t.positions.units}</th>
              <th class="right">{$t.positions.price}</th>
              <th class="right">{$t.positions.value}</th>
              <th>{$t.positions.share}</th>
            </tr>
          </thead>
          <tbody>
            {#each sortedRows as row}
              {@const share = shares.get(row.symbol)}
              <tr>
                <td class="symbol num">{row.symbol}</td>
                <td class="name">{row.name}</td>
                <td class="right num">{row.units}</td>
                <td class="right money" data-sensitive>{formatPrice(row)}</td>
                <td class="right money value">
                  {#if row.value === null && !row.valueExact}
                    <span class="awaiting-value">{$t.positions.valueAwaiting}</span>
                  {:else}
                    <span data-sensitive>{formatPositionValue(row)}</span>
                  {/if}
                </td>
                <td>
                  {#if share !== undefined}
                    <div class="share">
                      <span class="share-bar" aria-hidden="true"><span data-sensitive style:width={`${share * 100}%`}></span></span>
                      <span class="num" data-sensitive>{formatShare(share, $locale)}</span>
                    </div>
                  {:else}
                    <span class="muted">—</span>
                  {/if}
                </td>
              </tr>
            {:else}
              <tr><td class="empty" colspan="6">{$t.positions.noRows}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="positions-footer">
        <button class="button primary export" type="button" disabled={rows.length === 0} on:click={exportCsv}>
          <Download size={15} strokeWidth={2} aria-hidden="true" />
          {$t.transactions.exportCsv}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .account-value {
    display: grid;
    justify-items: end;
    gap: 2px;
    text-align: right;
  }

  .account-value .label {
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
  }

  .account-value > strong {
    font-family: var(--font-mono);
    font-size: 18px;
    white-space: nowrap;
  }

  .converted {
    color: var(--muted);
    font-size: 11px;
  }

  .dividends {
    margin-top: var(--space-2);
    color: var(--muted);
    font-size: 12px;
  }

  .dividends strong {
    margin: 0 2px;
    color: var(--success);
    font-family: var(--font-mono);
  }

  .positions-table td { vertical-align: middle; }
  .symbol { color: var(--muted); font-size: 12px; }
  .name { font-size: 13px; font-weight: 700; }
  .value { font-weight: 750; }

  .share {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 110px;
    font-size: 11px;
  }

  .share-bar {
    flex: none;
    width: 40px;
    height: 4px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface-soft);
  }

  .share-bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--fg);
  }

  .awaiting-value,
  .muted {
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
  }

  .empty { color: var(--muted); text-align: center; }

  .positions-footer {
    display: flex;
    justify-content: flex-end;
    padding: var(--space-4) var(--space-6);
    border-top: 1px solid var(--border);
  }

  .export {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
</style>
