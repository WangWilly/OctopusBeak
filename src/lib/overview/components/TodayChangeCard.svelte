<script lang="ts">
  import { Activity } from "@lucide/svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import CardPlaceholder from "$lib/overview/components/CardPlaceholder.svelte";
  import type { ChangeReason, TodayChange } from "$lib/overview/overview-model.ts";
  import { formatPct, formatShortDate, formatTwdNumber } from "$lib/overview/overview-format.ts";
  import { localizeAccount } from "$lib/shared-accounts/localize-account.ts";
  import type { AccountRowDto } from "$lib/shared-ledger/types.ts";

  export let change: TodayChange;

  const VISIBLE_ROWS = 5;

  $: ready = change.state === "ready" ? change : null;
  $: rows = ready?.rows.slice(0, VISIBLE_ROWS) ?? [];
  $: maxAbs = Math.max(1, ...rows.map((row) => Math.abs(row.change)));
  $: title = ready && !ready.isToday
    ? $t.overview.changeOnTitle(formatShortDate(ready.date, $locale))
    : $t.overview.todayTitle;

  function accountName(account: AccountRowDto) {
    const { institution, product } = localizeAccount(account, $t);
    return `${institution} · ${product}`;
  }

  function reasonText(reason: ChangeReason) {
    const pct = formatPct(reason.pct, $locale);
    if (reason.kind === "fx") return $t.overview.reasonFx(reason.currency, pct);
    return $t.overview.reasonPrice($t.overview.cryptoNames[reason.symbol] ?? reason.name, pct);
  }
</script>

<article class="card today-change-card" data-today-change={change.state}>
  <header class="card-head">
    <h2>{title}</h2>
    <p>{ready ? $t.overview.comparedWith(formatShortDate(ready.previousDate, $locale)) : $t.overview.needsPreviousDay}</p>
  </header>
  {#if ready}
    <p class="total" data-direction={ready.total < 0 ? "down" : "up"}>
      <strong class="money" data-sensitive>{formatTwdNumber(ready.total, $locale, true)}</strong>
      {#if ready.pct !== null}<span data-sensitive>{formatPct(ready.pct, $locale)}</span>{/if}
    </p>
    {#if rows.length > 0}
      <ul class="contributions">
        {#each rows as row (row.account.id)}
          {@const width = (Math.abs(row.change) / maxAbs) * 50}
          <li data-direction={row.change < 0 ? "down" : "up"}>
            <span class="who">
              <strong title={accountName(row.account)}>{accountName(row.account)}</strong>
              {#if row.reason}<span class="reason">{reasonText(row.reason)}</span>{/if}
            </span>
            <span class="track" aria-hidden="true"><span class="fill" style:width={`${Math.max(width, 0.8)}%`}></span></span>
            <span class="amount money" data-sensitive>{formatTwdNumber(row.change, $locale, true)}</span>
          </li>
        {/each}
      </ul>
      {#if ready.cryptoShare !== null}
        <p class="note">{$t.overview.cryptoShare.before}<span class="num" data-sensitive>{Math.round(ready.cryptoShare * 100)}%</span>{$t.overview.cryptoShare.after}</p>
      {/if}
    {:else if ready.newAccountCount === 0}
      <p class="note">{$t.overview.noAccountMoved}</p>
    {/if}
    {#if ready.newAccountCount > 0}
      <p class="note" data-new-accounts={ready.newAccountCount}>{$t.overview.newAccounts(ready.newAccountCount)}</p>
    {/if}
  {:else}
    <p class="total empty" aria-hidden="true">—</p>
    <CardPlaceholder state="today-change" title={$t.overview.todayEmptyTitle} body={$t.overview.todayEmptyBody}>
      <Activity size={18} strokeWidth={2} />
    </CardPlaceholder>
  {/if}
</article>

<style>
  .today-change-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5) var(--space-6);
  }

  .card-head h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
  }

  .card-head p {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  .total {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 13px;
    font-weight: 600;
  }

  .total strong {
    font-size: 28px;
    font-weight: 750;
    line-height: 1.1;
  }

  .total[data-direction="up"] strong {
    color: var(--success);
  }

  .total[data-direction="down"] strong {
    color: var(--danger);
  }

  .total.empty {
    border: 0;
  }

  .contributions {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .contributions li {
    min-height: 56px;
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(48px, 1fr) auto;
    align-items: center;
    gap: var(--space-3);
  }

  .contributions li + li {
    border-top: 1px solid var(--border);
  }

  .who {
    display: grid;
    min-width: 0;
  }

  .who strong {
    overflow: hidden;
    font-size: 13px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reason {
    color: var(--muted);
    font-size: 11px;
  }

  .track {
    position: relative;
    height: 12px;
  }

  .fill {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 2px;
  }

  [data-direction="up"] .fill {
    left: 50%;
    background: var(--accent);
  }

  [data-direction="down"] .fill {
    right: 50%;
    background: color-mix(in oklch, var(--danger) 62%, white);
  }

  .amount {
    min-width: 80px;
    font-size: 13px;
    font-weight: 750;
    text-align: right;
  }

  [data-direction="up"] .amount {
    color: var(--success);
  }

  [data-direction="down"] .amount {
    color: var(--danger);
  }

  .note {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }
</style>
