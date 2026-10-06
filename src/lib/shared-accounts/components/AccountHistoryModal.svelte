<script lang="ts">
  import { ChevronLeft, ChevronRight, Download } from "@lucide/svelte";

  import { locale, t } from "$lib/i18n/i18n.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import {
    buildBalanceHistory,
    historyCurrencies,
    historyKind,
    historyStats,
    type HistoryEntry,
  } from "$lib/shared-accounts/balance-history.ts";
  import { downloadCsv } from "$lib/shared-accounts/download-csv.ts";
  import { accountModalTitle, localizeAccount } from "$lib/shared-accounts/localize-account.ts";
  import {
    addDays,
    daysInRange,
    pageOf,
    type DateRange,
    type RangePreset,
  } from "$lib/shared-accounts/transaction-filters.ts";
  import { dateInTimeZone } from "$lib/shared-ledger/twd-valuation.ts";
  import type { AccountRowDto, DailyHistoryRowDto, TransactionRowDto } from "$lib/shared-ledger/types.ts";
  import { formatAmountLines } from "$lib/shared-money/money.ts";
  import AccountModalHeader from "./AccountModalHeader.svelte";
  import BalanceHistoryChart from "./BalanceHistoryChart.svelte";
  import DateRangeFilter from "./DateRangeFilter.svelte";

  export let open = false;
  export let account: AccountRowDto | null = null;
  /** The account's recorded daily balances. */
  export let rows: DailyHistoryRowDto[] = [];
  /** The account's transactions, which cash accounts work their balance back through. */
  export let transactions: TransactionRowDto[] = [];

  const PAGE_SIZE = 10;

  let currency = "TWD";
  let range: DateRange | null = null;
  let preset: RangePreset = "custom";
  let page = 1;
  let rangeOpen = false;
  let shownAccountId: string | null = null;

  $: today = dateInTimeZone(new Date(), $systemTimezone);
  $: kind = account ? historyKind(account) : "snapshots";
  // Each account opens on its own default window: a year of statements, or thirty days of balances.
  $: if (open && account && account.id !== shownAccountId) {
    shownAccountId = account.id;
    range = recentDays(kind === "card" ? 365 : 30);
    preset = "custom";
    page = 1;
    rangeOpen = false;
  }
  $: currencies = account ? historyCurrencies(account, rows) : [];
  $: if (!currencies.includes(currency)) currency = currencies[0] ?? "TWD";
  $: activeRange = range ?? { start: earliestDay(), end: today };
  $: history = account
    ? buildBalanceHistory({ account, transactions, dailyHistory: rows, currency, range: activeRange, today, timeZone: $systemTimezone })
    : null;
  $: stats = history ? historyStats(history) : null;
  $: current = pageOf(history?.entries ?? [], page, PAGE_SIZE);
  $: liability = account?.group === "liability";
  $: columns = kind === "ledger"
    ? { up: $t.accountHistory.moneyIn, down: $t.accountHistory.moneyOut, balance: $t.accountHistory.balance }
    : { up: $t.accountHistory.increase, down: $t.accountHistory.decrease, balance: kind === "card" ? $t.accountHistory.used : $t.accountHistory.balance };
  $: number = new Intl.NumberFormat($locale, { maximumFractionDigits: currency === "TWD" || currency === "JPY" ? 0 : 2 });
  $: institution = account ? localizeAccount(account, $t).institution : "";

  function recentDays(days: number): DateRange {
    return { start: addDays(today, -(days - 1)), end: today };
  }

  /** "All time" reaches back to the oldest record this account has. */
  function earliestDay() {
    const days = [
      ...rows.map((row) => row.date),
      ...transactions.map((row) => row.date),
      ...(account?.creditCard?.statements ?? []).map((statement) => statement.cycleEnd),
    ].sort();
    return days[0] ?? today;
  }

  function applyRange(next: DateRange | null, nextPreset: RangePreset) {
    range = next;
    preset = nextPreset;
    page = 1;
    rangeOpen = false;
  }

  function countIn(candidate: DateRange | null) {
    if (!account) return 0;
    return buildBalanceHistory({
      account,
      transactions,
      dailyHistory: rows,
      currency,
      range: candidate ?? { start: earliestDay(), end: today },
      today,
      timeZone: $systemTimezone,
    }).entries.length;
  }

  function close() {
    open = false;
    rangeOpen = false;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!open || event.key !== "Escape") return;
    if (rangeOpen) rangeOpen = false;
    else close();
  }

  function shortDate(day: string) {
    return day.slice(0, 4) === today.slice(0, 4) ? day.slice(5).replace("-", "/") : day.replaceAll("-", "/");
  }

  function entryTitle(entry: HistoryEntry) {
    if (entry.kind === "transaction") return entry.label ?? "";
    if (entry.kind === "statement") return $t.accountHistory.statementTitle(Number(entry.day.slice(5, 7)));
    return $t.accountHistory.snapshotTitle;
  }

  function entryDetail(entry: HistoryEntry) {
    if (entry.kind === "statement" && entry.cycle) {
      return `${shortDate(entry.cycle.start)} – ${shortDate(entry.cycle.end)} · ${$t.accountHistory.transactionCount(entry.transactionCount ?? 0)}`;
    }
    if (entry.kind !== "today") return "";
    if (kind === "card") return $t.accountHistory.reportedUsed(institution);
    const reported = $t.accountHistory.reportedBalance(institution);
    if (history?.consistent === true) return `${reported} · ${$t.accountHistory.matchesLedger}`;
    if (history?.consistent === false) return `${reported} · ${$t.accountHistory.differsFromLedger}`;
    return reported;
  }

  function exportCsv() {
    if (!account || !history) return;
    const cell = (value: string) => (/[",\r\n]/u.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value);
    const lines = [
      [$t.transactions.date, $t.transactions.description, columns.up, columns.down, columns.balance, $t.transactions.currency, $t.transactions.note],
      ...history.entries.map((entry) => [
        entry.day,
        [entryTitle(entry), entryDetail(entry)].filter(Boolean).join(" · "),
        entry.increase === null ? "" : String(entry.increase),
        entry.decrease === null ? "" : String(entry.decrease),
        String(entry.balance),
        currency,
        entry.note ?? "",
      ]),
    ];
    downloadCsv(
      `${accountModalTitle(account, $t)} ${$t.accountHistory.title} ${activeRange.start}_${activeRange.end}`,
      `﻿${lines.map((cells) => cells.map(cell).join(",")).join("\r\n")}\r\n`,
    );
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div class="modal open">
    <button class="modal-backdrop" type="button" aria-label={$t.common.close} onclick={close}></button>
    <div class="modal-panel history-panel" role="dialog" aria-modal="true" aria-labelledby="history-title" tabindex="-1">
      <AccountModalHeader {account} eyebrow={$t.accountHistory.title} titleId="history-title" onClose={close}>
        {#if account}
          <div class="current">
            <span>{kind === "card" ? $t.accountHistory.currentUsed : $t.accountHistory.currentBalance}</span>
            <strong class="money" data-sensitive>{formatAmountLines(account.amountLines)}</strong>
          </div>
        {/if}
      </AccountModalHeader>

      <div class="history-toolbar">
        <DateRangeFilter
          {range}
          {preset}
          {today}
          {countIn}
          open={rangeOpen}
          onToggle={() => (rangeOpen = !rangeOpen)}
          onClose={() => (rangeOpen = false)}
          onApply={applyRange}
        />
        <div class="toolbar-end">
          {#if currencies.length > 1}
            <label class="chip select-chip" for="account-history-currency">
              <select id="account-history-currency" aria-label={$t.accountHistory.currencyAria} bind:value={currency}>
                {#each currencies as option}<option>{option}</option>{/each}
              </select>
            </label>
          {/if}
        </div>
      </div>

      <div class="modal-body">
        <section class="history-summary" aria-label={$t.accountHistory.chartTitle[kind]}>
          <div class="summary-head">
            <div>
              <h3>{$t.accountHistory.chartTitle[kind]}</h3>
              <p>{$t.accountHistory.chartNote[kind]}</p>
            </div>
            {#if stats}
              <dl class="stats" data-history-stats>
                {#if stats.kind === "card"}
                  <div><dt>{$t.accountHistory.lastStatement}</dt><dd class="num" data-sensitive>{number.format(stats.lastStatement.balance)} · {shortDate(stats.lastStatement.day)}</dd></div>
                  <div><dt>{$t.accountHistory.highest}</dt><dd class="num" data-sensitive>{number.format(stats.high.balance)} · {shortDate(stats.high.day)}</dd></div>
                  <div><dt>{$t.accountHistory.monthlyAverage}</dt><dd class="num" data-sensitive>{number.format(stats.average)}</dd></div>
                {:else}
                  <div>
                    <dt>{$t.accountHistory.netChange(daysInRange(activeRange))}</dt>
                    <dd class="num" data-sensitive data-tone={stats.net === 0 ? "flat" : (stats.net > 0) !== liability ? "good" : "bad"}>
                      {stats.net > 0 ? "+" : ""}{number.format(stats.net)}
                    </dd>
                  </div>
                  <div><dt>{$t.accountHistory.highest}</dt><dd class="num" data-sensitive>{number.format(stats.high.balance)} · {shortDate(stats.high.day)}</dd></div>
                  <div><dt>{$t.accountHistory.lowest}</dt><dd class="num" data-sensitive>{number.format(stats.low.balance)} · {shortDate(stats.low.day)}</dd></div>
                {/if}
              </dl>
            {/if}
          </div>
          <BalanceHistoryChart
            points={history?.points ?? []}
            stepped={kind === "ledger"}
            tone={liability ? "liability" : "asset"}
            {today}
            todayLabel={$t.accountHistory.today}
            {currency}
            label={$t.accountHistory.chartTitle[kind]}
          />
        </section>

        <table class="table history-table">
          <thead>
            <tr>
              <th>{$t.transactions.date}</th>
              <th>{$t.transactions.description}</th>
              <th class="right">{columns.up}</th>
              <th class="right">{columns.down}</th>
              <th class="right">{columns.balance}</th>
              <th>{$t.transactions.note}</th>
            </tr>
          </thead>
          <tbody>
            {#each current.rows as entry}
              <tr data-entry-kind={entry.kind}>
                <td class="date num">{shortDate(entry.day)}</td>
                <td class="description">
                  <strong>{entryTitle(entry)}</strong>
                  {#if entryDetail(entry)}<span class="detail">{entryDetail(entry)}</span>{/if}
                </td>
                <td class="right money" class:good={!liability} class:bad={liability} data-sensitive>{entry.increase === null ? "" : number.format(entry.increase)}</td>
                <td class="right money" class:good={liability} class:bad={!liability} data-sensitive>{entry.decrease === null ? "" : number.format(entry.decrease)}</td>
                <td class="right money balance" data-sensitive>{number.format(entry.balance)}</td>
                <td class="note">
                  {#if entry.kind === "today"}
                    <span class="today-badge">{$t.accountHistory.today}</span>
                  {:else}
                    {entry.note || "—"}
                  {/if}
                </td>
              </tr>
            {:else}
              <tr><td class="empty" colspan="6">{$t.accountHistory.noRows}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="history-footer">
        <span>{$t.transactions.pageRange(current.first, current.last, current.total)}</span>
        <div class="pager">
          <button class="pager-step" type="button" aria-label={$t.transactions.previousPage} disabled={current.page <= 1} onclick={() => (page = current.page - 1)}>
            <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
          </button>
          <span class="num">{current.page} / {current.pageCount}</span>
          <button class="pager-step" type="button" aria-label={$t.transactions.nextPage} disabled={current.page >= current.pageCount} onclick={() => (page = current.page + 1)}>
            <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <button class="button primary export" type="button" disabled={current.total === 0} onclick={exportCsv}>
          <Download size={15} strokeWidth={2} aria-hidden="true" />
          {$t.transactions.exportCsv}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .history-panel { overflow: visible; }

  .current {
    display: grid;
    justify-items: end;
    gap: 2px;
  }

  .current span {
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
  }

  .current strong {
    font-family: var(--font-mono);
    font-size: 18px;
    white-space: nowrap;
  }

  .history-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 0 var(--space-6) var(--space-4);
  }

  .toolbar-end {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .history-summary {
    display: grid;
    gap: var(--space-2);
    padding: 0 var(--space-6) var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .summary-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .summary-head h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 750;
  }

  .summary-head p {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 11px;
  }

  .stats {
    display: flex;
    gap: var(--space-6);
    margin: 0;
  }

  .stats div { display: grid; justify-items: end; gap: 2px; }
  .stats dt { color: var(--muted); font-size: 11px; font-weight: 650; }
  .stats dd { margin: 0; font-size: 13px; font-weight: 750; }
  .stats dd[data-tone="good"] { color: var(--success); }
  .stats dd[data-tone="bad"] { color: var(--danger); }

  .history-table td { vertical-align: middle; }
  .history-table .date { color: var(--muted); font-size: 12px; white-space: nowrap; }

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

  .good { color: var(--success); font-weight: 750; }
  .bad { color: var(--danger); font-weight: 750; }
  .balance { font-weight: 750; }
  .note { color: var(--muted); font-size: 12px; }

  .today-badge {
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 11px;
    font-weight: 750;
  }

  .empty { color: var(--muted); text-align: center; }

  .history-footer {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-6);
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
  }

  .history-footer > span { margin-right: auto; }

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
