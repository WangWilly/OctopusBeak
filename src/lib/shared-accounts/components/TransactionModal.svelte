<script lang="ts">
  import {
    ArrowDownLeft,
    ArrowUpRight,
    CalendarDays,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Download,
    ListFilter,
    List,
  } from "@lucide/svelte";

  import { locale, t } from "$lib/i18n/i18n.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import { downloadCsv } from "$lib/shared-accounts/download-csv.ts";
  import { accountModalTitle } from "$lib/shared-accounts/localize-account.ts";
  import {
    filterTransactions,
    flowCounts,
    pageOf,
    transactionDay,
    transactionsCsv,
    type DateRange,
    type FlowFilter,
    type RangePreset,
  } from "$lib/shared-accounts/transaction-filters.ts";
  import { dateInTimeZone } from "$lib/shared-ledger/twd-valuation.ts";
  import type { AccountRowDto, TransactionRowDto } from "$lib/shared-ledger/types.ts";
  import { formatAmountLines, formatExactQuantity, formatMoney } from "$lib/shared-money/money.ts";
  import AccountModalHeader from "./AccountModalHeader.svelte";
  import DateRangePopover from "./DateRangePopover.svelte";

  export let open = false;
  export let account: AccountRowDto | null = null;
  export let rows: TransactionRowDto[] = [];

  const PAGE_SIZE = 10;
  const FLOWS: readonly FlowFilter[] = ["all", "in", "out"];

  let range: DateRange | null = null;
  let preset: RangePreset = "all";
  let flow: FlowFilter = "all";
  let page = 1;
  let menu: "range" | "type" | null = null;
  let shownAccountId: string | null = null;

  // Each account opens on its full history.
  $: if (open && account?.id !== shownAccountId) {
    shownAccountId = account?.id ?? null;
    range = null;
    preset = "all";
    flow = "all";
    page = 1;
    menu = null;
  }
  $: today = dateInTimeZone(new Date(), $systemTimezone);
  $: exportName = account ? accountModalTitle(account, $t) : $t.transactions.title;
  $: primaryCurrency = account?.amountLines[0]?.currency ?? "TWD";
  $: inRange = filterTransactions(rows, { range, flow: "all", timeZone: $systemTimezone });
  $: counts = flowCounts(inRange);
  $: filtered = flow === "all" ? inRange : filterTransactions(inRange, { range: null, flow, timeZone: $systemTimezone });
  $: current = pageOf(filtered, page, PAGE_SIZE);
  $: rangeLabel = range
    ? `${range.start.replaceAll("-", "/")} – ${range.end.slice(0, 4) === range.start.slice(0, 4) ? range.end.slice(5).replace("-", "/") : range.end.replaceAll("-", "/")}`
    : $t.transactions.rangePresets.all;

  function close() {
    open = false;
    menu = null;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!open || event.key !== "Escape") return;
    if (menu) menu = null;
    else close();
  }

  function toggleMenu(next: "range" | "type") {
    menu = menu === next ? null : next;
  }

  function applyRange(next: DateRange | null, nextPreset: RangePreset) {
    range = next;
    preset = nextPreset;
    page = 1;
    menu = null;
  }

  function chooseFlow(next: FlowFilter) {
    flow = next;
    page = 1;
    menu = null;
  }

  function countIn(candidate: DateRange | null) {
    return filterTransactions(rows, { range: candidate, flow: "all", timeZone: $systemTimezone }).length;
  }

  function shortDate(row: TransactionRowDto) {
    const day = transactionDay(row, $systemTimezone);
    return day.slice(0, 4) === today.slice(0, 4) ? day.slice(5).replace("-", "/") : day.replaceAll("-", "/");
  }

  /** Unsigned amount; the column already says which way the money moved. */
  function columnAmount(row: TransactionRowDto) {
    const exact = row.amountExact
      ? { ...row.amountExact, coefficient: row.amountExact.coefficient.replace(/^-/, "") }
      : undefined;
    const text = formatMoney({ currency: row.currency, value: Math.abs(row.amount), exact }, { locale: $locale });
    return row.currency === primaryCurrency ? text.slice(row.currency.length + 1) : text;
  }

  function transactionType(row: TransactionRowDto) {
    return $t.transactions.investmentActions[row.type as keyof typeof $t.transactions.investmentActions] ?? row.type;
  }

  function exportCsv() {
    const csv = transactionsCsv(filtered, {
      date: $t.transactions.date,
      description: $t.transactions.description,
      out: $t.transactions.moneyOut,
      in: $t.transactions.moneyIn,
      currency: $t.transactions.currency,
      note: $t.transactions.note,
    }, $systemTimezone);
    downloadCsv(`${exportName} ${range ? `${range.start}_${range.end}` : $t.transactions.rangePresets.all}`, csv);
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open}
  <div class="modal open">
    <button class="modal-backdrop" type="button" aria-label={$t.common.close} on:click={close}></button>
    <div class="modal-panel transactions-panel" role="dialog" aria-modal="true" aria-labelledby="transactions-title" tabindex="-1">
      <AccountModalHeader {account} eyebrow={$t.transactions.eyebrow} titleId="transactions-title" onClose={close}>
        {#if account}
          <div class="balance">
            <span>{$t.transactions.currentBalance}</span>
            <strong class="money" data-sensitive>{formatAmountLines(account.amountLines)}</strong>
          </div>
        {/if}
      </AccountModalHeader>

      <div class="transactions-toolbar">
        <div class="menu-anchor">
          <button
            class="filter-chip"
            class:applied={range !== null}
            type="button"
            aria-expanded={menu === "range"}
            aria-label={`${$t.transactions.dateRange}: ${rangeLabel}`}
            on:click={() => toggleMenu("range")}
          >
            <CalendarDays size={15} strokeWidth={2} aria-hidden="true" />
            <span class:num={range !== null}>{rangeLabel}</span>
            <ChevronDown class="chevron" size={14} strokeWidth={2} aria-hidden="true" />
          </button>
          {#if menu === "range"}
            <DateRangePopover
              {range}
              {preset}
              {today}
              {countIn}
              onApply={applyRange}
              onClose={() => (menu = null)}
            />
          {/if}
        </div>
        <div class="menu-anchor">
          <button
            class="filter-chip"
            class:applied={flow !== "all"}
            type="button"
            aria-expanded={menu === "type"}
            aria-haspopup="menu"
            on:click={() => toggleMenu("type")}
          >
            <ListFilter size={15} strokeWidth={2} aria-hidden="true" />
            {$t.transactions.flows[flow]}
            <ChevronDown class="chevron" size={14} strokeWidth={2} aria-hidden="true" />
          </button>
          {#if menu === "type"}
            <div class="type-menu" role="menu" aria-label={$t.transactions.typeMenu}>
              <p class="menu-title">{$t.transactions.typeMenu}</p>
              {#each FLOWS as item}
                <button type="button" role="menuitemradio" aria-checked={flow === item} data-flow={item} on:click={() => chooseFlow(item)}>
                  <span class="flow-icon" data-flow={item}>
                    {#if item === "in"}<ArrowDownLeft size={14} strokeWidth={2} aria-hidden="true" />
                    {:else if item === "out"}<ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
                    {:else}<List size={14} strokeWidth={2} aria-hidden="true" />{/if}
                  </span>
                  <span class="flow-label">{$t.transactions.flows[item]}</span>
                  <span class="flow-count num">{counts[item]}</span>
                  <span class="flow-check">{#if flow === item}<Check size={15} strokeWidth={2.25} aria-hidden="true" />{/if}</span>
                </button>
              {/each}
              <p class="menu-note">{$t.transactions.typeMenuNote}</p>
            </div>
          {/if}
        </div>
      </div>

      <div class="modal-body">
        <table class="table transactions-table">
          <thead>
            <tr>
              <th>{$t.transactions.date}</th>
              <th>{$t.transactions.description}</th>
              <th class="right">{$t.transactions.moneyOut}</th>
              <th class="right">{$t.transactions.moneyIn}</th>
              <th>{$t.transactions.note}</th>
            </tr>
          </thead>
          <tbody>
            {#each current.rows as row}
              <tr>
                <td class="date num">{shortDate(row)}</td>
                <td class="description">
                  {#if row.investment}
                    <strong>{row.investment.securityName}</strong>
                    <span class="detail">{transactionType(row)} · {$t.transactions.quantity} {formatExactQuantity(row.investment.quantity, $locale) ?? "--"}</span>
                    {#if row.label && row.label !== row.investment.securityName}<span class="detail">{row.label}</span>{/if}
                  {:else}
                    <strong>{row.label}</strong>
                  {/if}
                </td>
                <td
                  class="right money amount-out"
                  class:amount-settled={account?.kind === "credit-card" && row.type.toLowerCase() === "billed"}
                  data-sensitive
                >{row.amount < 0 ? columnAmount(row) : ""}</td>
                <td class="right money amount-in" data-sensitive>{row.amount > 0 ? columnAmount(row) : ""}</td>
                <td class="note">{row.note || "—"}</td>
              </tr>
            {:else}
              <tr><td class="empty" colspan="5">{rows.length === 0 ? $t.transactions.noRows : $t.transactions.noRowsInRange}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="transactions-footer">
        <span>{$t.transactions.pageRange(current.first, current.last, current.total)}</span>
        <div class="pager">
          <button class="pager-step" type="button" aria-label={$t.transactions.previousPage} disabled={current.page <= 1} on:click={() => (page = current.page - 1)}>
            <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
          </button>
          <span class="num">{current.page} / {current.pageCount}</span>
          <button class="pager-step" type="button" aria-label={$t.transactions.nextPage} disabled={current.page >= current.pageCount} on:click={() => (page = current.page + 1)}>
            <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <button class="button primary export" type="button" disabled={filtered.length === 0} on:click={exportCsv}>
          <Download size={15} strokeWidth={2} aria-hidden="true" />
          {$t.transactions.exportCsv}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .transactions-panel { overflow: visible; }

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

  .transactions-toolbar {
    display: flex;
    gap: var(--space-2);
    padding: 0 var(--space-6) var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .menu-anchor { position: relative; }

  .filter-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 32px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }

  .filter-chip.applied {
    border-color: color-mix(in oklch, var(--accent) 30%, var(--border));
    background: var(--accent-soft);
  }

  .filter-chip[aria-expanded="true"] { border-color: var(--fg); }
  .filter-chip[aria-expanded="true"] :global(.chevron) { transform: rotate(180deg); }

  .type-menu {
    position: absolute;
    z-index: 5;
    top: calc(100% + 8px);
    left: 0;
    display: grid;
    width: 258px;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: 0 18px 48px rgb(7 31 74 / 16%);
  }

  .menu-title,
  .menu-note {
    margin: 0;
    padding: var(--space-2);
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
  }

  .menu-note {
    margin-top: var(--space-1);
    border-top: 1px solid var(--border);
    font-weight: 500;
  }

  .type-menu button {
    display: grid;
    grid-template-columns: 26px 1fr auto 18px;
    align-items: center;
    gap: var(--space-3);
    min-height: 38px;
    padding: 0 var(--space-2);
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--fg);
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    text-align: left;
    cursor: pointer;
  }

  .type-menu button:hover,
  .type-menu button[aria-checked="true"] { background: var(--surface-soft); }
  .type-menu button[data-flow="all"] { margin-bottom: var(--space-1); }

  .flow-icon {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--muted);
  }

  .flow-icon[data-flow="in"] { color: var(--success); }
  .flow-icon[data-flow="out"] { color: var(--danger); }
  .flow-count { color: var(--muted); font-size: 11px; }

  .transactions-table td { vertical-align: middle; }
  .transactions-table .date { color: var(--muted); font-size: 12px; white-space: nowrap; }

  .description strong {
    display: block;
    font-size: 13px;
    font-weight: 700;
  }

  .detail {
    display: block;
    margin-top: 2px;
    color: var(--muted);
    font-size: 11px;
  }

  .amount-out { color: var(--danger); font-weight: 750; }
  .amount-in { color: var(--success); font-weight: 750; }

  .amount-settled {
    text-decoration: line-through;
    text-decoration-thickness: 2px;
  }

  .note { color: var(--muted); font-size: 12px; }
  .empty { color: var(--muted); text-align: center; }

  .transactions-footer {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-6);
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
  }

  .transactions-footer > span { margin-right: auto; }

  .pager {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    color: var(--fg);
  }

  .pager-step {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
    cursor: pointer;
  }

  .pager-step:disabled { color: var(--muted); opacity: 0.5; cursor: default; }

  .export {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
</style>
