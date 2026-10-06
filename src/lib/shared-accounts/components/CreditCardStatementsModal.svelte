<script lang="ts">
  import { CalendarCheck, CalendarClock, CalendarDays, Check, ChevronDown, Download, FileText } from "@lucide/svelte";

  import { locale, t } from "$lib/i18n/i18n.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import { downloadCsv } from "$lib/shared-accounts/download-csv.ts";
  import { accountModalTitle } from "$lib/shared-accounts/localize-account.ts";
  import {
    latestStatementRevisions,
    statementStatus,
    statementYears,
    statementsCsv,
  } from "$lib/shared-accounts/statement-list.ts";
  import { dateInTimeZone } from "$lib/shared-ledger/twd-valuation.ts";
  import type { AccountRowDto, CreditCardStatementDto, CurrencyAmountDto } from "$lib/shared-ledger/types.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import AccountModalHeader from "./AccountModalHeader.svelte";

  export let open = false;
  export let account: AccountRowDto | null = null;

  let year: number | null = null;
  let yearMenuOpen = false;
  let expandedId: string | null = null;
  let transactionsShownId: string | null = null;
  let shownAccountId: string | null = null;

  $: statements = latestStatementRevisions(account?.creditCard?.statements ?? []);
  $: years = statementYears(statements);
  // Each card opens on its newest statement year with that statement unfolded.
  $: if (open && account && account.id !== shownAccountId) {
    shownAccountId = account.id;
    year = years[0] ?? null;
    expandedId = statements[0]?.statementId ?? null;
    transactionsShownId = null;
    yearMenuOpen = false;
  }
  $: shown = year === null ? statements : statements.filter((statement) => statement.cycleEnd.startsWith(`${year}-`));
  $: today = dateInTimeZone(new Date(), $systemTimezone);
  $: primaryCurrency = account?.amountLines[0]?.currency ?? "TWD";

  function close() {
    open = false;
    yearMenuOpen = false;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!open || event.key !== "Escape") return;
    if (yearMenuOpen) yearMenuOpen = false;
    else close();
  }

  function chooseYear(next: number | null) {
    year = next;
    yearMenuOpen = false;
  }

  function shortDate(value: string) {
    if (!value) return "--";
    return value.slice(0, 4) === today.slice(0, 4) ? value.slice(5).replace("-", "/") : value.replaceAll("-", "/");
  }

  /** Amounts in the card's own currency read as plain numbers, as on a paper statement. */
  function amount(value: CurrencyAmountDto | null) {
    if (!value) return "—";
    const text = formatMoney(value, { locale: $locale });
    return value.currency === primaryCurrency ? text.slice(value.currency.length + 1) : text;
  }

  function monthLabel(statement: CreditCardStatementDto) {
    return $t.statements.statementMonth(Number(statement.cycleEnd.slice(0, 4)), Number(statement.cycleEnd.slice(5, 7)));
  }

  function toggle(statement: CreditCardStatementDto) {
    expandedId = expandedId === statement.statementId ? null : statement.statementId;
    transactionsShownId = null;
  }

  function exportCsv() {
    if (!account) return;
    downloadCsv(`${accountModalTitle(account, $t)} ${$t.statements.title} ${year ?? $t.statements.allYears}`, statementsCsv(shown, {
      cycleStart: $t.statements.cycleStart,
      cycleEnd: $t.statements.cycleEnd,
      issueDate: $t.statements.issueDate,
      dueDate: $t.statements.dueDate,
      minimumPayment: $t.statements.minimumPayment,
      statementBalance: $t.statements.statementAmount,
      currency: $t.transactions.currency,
      transactions: $t.statements.statementTransactions,
      statementId: $t.statements.statementId,
    }));
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open}
  <div class="modal open" data-statement-modal>
    <button class="modal-backdrop" type="button" aria-label={$t.common.close} on:click={close}></button>
    <div class="modal-panel statements-panel" role="dialog" aria-modal="true" aria-labelledby="statements-title" tabindex="-1">
      <AccountModalHeader {account} eyebrow={$t.statements.title} titleId="statements-title" onClose={close}>
        {#if statements.length > 0}
          <div class="latest">
            <span>{$t.statements.latestStatementAmount}</span>
            <strong class="money" data-sensitive>{formatMoney(statements[0].statementBalance, { locale: $locale })}</strong>
          </div>
        {/if}
      </AccountModalHeader>

      {#if years.length > 0}
        <div class="statements-toolbar">
          <div class="menu-anchor">
            <button
              class="filter-chip"
              class:applied={year !== null}
              type="button"
              aria-haspopup="menu"
              aria-expanded={yearMenuOpen}
              aria-label={`${$t.statements.yearFilter}: ${year === null ? $t.statements.allYears : $t.statements.year(year)}`}
              on:click={() => (yearMenuOpen = !yearMenuOpen)}
            >
              <CalendarDays size={15} strokeWidth={2} aria-hidden="true" />
              {year === null ? $t.statements.allYears : $t.statements.year(year)}
              <ChevronDown class="chevron" size={14} strokeWidth={2} aria-hidden="true" />
            </button>
            {#if yearMenuOpen}
              <div class="year-menu" role="menu" aria-label={$t.statements.yearFilter}>
                {#each [...years, null] as option}
                  <button type="button" role="menuitemradio" aria-checked={year === option} on:click={() => chooseYear(option)}>
                    {option === null ? $t.statements.allYears : $t.statements.year(option)}
                    {#if year === option}<Check size={15} strokeWidth={2.25} aria-hidden="true" />{/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <div class="modal-body">
        {#if statements.length === 0}
          <div class="empty-state" role="status">{$t.statements.noRows}</div>
        {:else}
          <table class="table statements-table">
            <thead>
              <tr>
                <th>{$t.statements.cycle}</th>
                <th>{$t.statements.issueDate}</th>
                <th>{$t.statements.dueDate}</th>
                <th class="right">{$t.statements.minimumPayment}</th>
                <th class="right">{$t.statements.statementAmount}</th>
                <th>{$t.statements.status}</th>
                <th aria-hidden="true"></th>
              </tr>
            </thead>
            <tbody>
              {#each shown as statement (statement.statementId)}
                {@const status = statementStatus(statement, today)}
                {@const expanded = expandedId === statement.statementId}
                <tr class="statement-row" class:expanded data-statement-id={statement.statementId} data-statement-revision-id={statement.statementRevisionId}>
                  <td class="cycle">
                    <strong>{monthLabel(statement)}</strong>
                    <span class="num">{shortDate(statement.cycleStart)} – {shortDate(statement.cycleEnd)} · {$t.statements.transactionCount(statement.memberships.length)}</span>
                  </td>
                  <td class="num muted">{shortDate(statement.issueDate)}</td>
                  <td class="num muted">{shortDate(statement.dueDate)}</td>
                  <td class="right money" data-sensitive>{amount(statement.minimumPayment)}</td>
                  <td class="right money strong" data-sensitive>{amount(statement.statementBalance)}</td>
                  <td>
                    {#if status.kind === "past-due"}
                      <span class="status"><CalendarCheck size={13} strokeWidth={2} aria-hidden="true" />{$t.statements.pastDue}</span>
                    {:else if status.kind === "due"}
                      <span class="status due"><CalendarClock size={13} strokeWidth={2} aria-hidden="true" />{status.days === 0 ? $t.statements.dueToday : $t.statements.dueIn(status.days)}</span>
                    {:else}
                      <span class="muted">—</span>
                    {/if}
                  </td>
                  <td class="toggle-cell">
                    <button
                      class="row-toggle"
                      type="button"
                      aria-expanded={expanded}
                      aria-label={expanded ? $t.statements.collapse(monthLabel(statement)) : $t.statements.expand(monthLabel(statement))}
                      on:click={() => toggle(statement)}
                    >
                      <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
                {#if expanded}
                  <tr class="detail-row">
                    <td colspan="7">
                      <div class="detail">
                        <dl class="identity-facts">
                          <div><dt>{$t.statements.statementId}</dt><dd><code>{statement.statementId}</code></dd></div>
                          <div><dt>{$t.statements.statementRevisionId}</dt><dd><code>{statement.statementRevisionId}</code></dd></div>
                          <div><dt>{$t.statements.statementKey}</dt><dd><code>{statement.statementKey}</code></dd></div>
                          <div><dt>{$t.statements.statementTransactions}</dt><dd class="num">{$t.statements.transactionCount(statement.memberships.length)}</dd></div>
                        </dl>
                        {#if statement.memberships.length > 0}
                          <button
                            class="button lineage-toggle"
                            type="button"
                            aria-expanded={transactionsShownId === statement.statementId}
                            on:click={() => (transactionsShownId = transactionsShownId === statement.statementId ? null : statement.statementId)}
                          >
                            <FileText size={15} strokeWidth={2} aria-hidden="true" />
                            {transactionsShownId === statement.statementId ? $t.statements.hideTransactions : $t.statements.viewTransactions}
                          </button>
                        {/if}
                      </div>
                      {#if transactionsShownId === statement.statementId}
                        <ul class="membership-list">
                          {#each statement.memberships as membership}
                            <li
                              data-transaction-id={membership.transactionId}
                              data-transaction-revision-id={membership.transactionRevisionId}
                              data-source-record-id={membership.sourceRecordId}
                            >
                              <dl class="identity-facts">
                                <div><dt>{$t.statements.transactionId}</dt><dd><code>{membership.transactionId}</code></dd></div>
                                <div><dt>{$t.statements.transactionRevisionId}</dt><dd><code>{membership.transactionRevisionId}</code></dd></div>
                                <div><dt>{$t.statements.sourceRecordId}</dt><dd><code>{membership.sourceRecordId}</code></dd></div>
                              </dl>
                            </li>
                          {/each}
                        </ul>
                      {/if}
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        {/if}
      </div>

      <div class="statements-footer">
        <button class="button primary export" type="button" disabled={shown.length === 0} on:click={exportCsv}>
          <Download size={15} strokeWidth={2} aria-hidden="true" />
          {$t.transactions.exportCsv}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .statements-panel { overflow: visible; }

  .latest {
    display: grid;
    justify-items: end;
    gap: 2px;
  }

  .latest span {
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
  }

  .latest strong {
    font-family: var(--font-mono);
    font-size: 18px;
    white-space: nowrap;
  }

  .statements-toolbar {
    padding: 0 var(--space-6) var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .menu-anchor { position: relative; width: fit-content; }

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

  .filter-chip[aria-expanded="true"] :global(.chevron) { transform: rotate(180deg); }

  .year-menu {
    position: absolute;
    z-index: 5;
    top: calc(100% + 8px);
    left: 0;
    display: grid;
    min-width: 160px;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: 0 18px 48px rgb(7 31 74 / 16%);
  }

  .year-menu button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 34px;
    padding: 0 var(--space-3);
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--fg);
    font: inherit;
    font-size: 13px;
    font-weight: 650;
    cursor: pointer;
  }

  .year-menu button:hover,
  .year-menu button[aria-checked="true"] { background: var(--surface-soft); }

  .statements-table td { vertical-align: middle; }
  .statement-row.expanded td { background: var(--surface-soft); border-bottom-color: transparent; }

  .cycle strong {
    display: block;
    font-size: 13px;
    font-weight: 750;
  }

  .cycle span {
    display: block;
    margin-top: 2px;
    color: var(--muted);
    font-size: 11px;
  }

  .muted { color: var(--muted); font-size: 12px; }
  .strong { font-weight: 750; }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--surface-soft);
    color: var(--muted);
    font-size: 11px;
    font-weight: 700;
    white-space: nowrap;
  }

  .status.due {
    background: color-mix(in oklch, var(--warn) 14%, var(--surface));
    color: var(--warn);
  }

  .toggle-cell { width: 40px; }

  .row-toggle {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--muted);
    cursor: pointer;
  }

  .row-toggle[aria-expanded="true"] { transform: rotate(180deg); color: var(--fg); }

  .detail-row td { background: var(--surface-soft); }

  .detail {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }

  .identity-facts {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-4);
    flex: 1;
    margin: 0;
  }

  .identity-facts dt { color: var(--muted); font-size: 11px; font-weight: 650; }
  .identity-facts dd { margin: 2px 0 0; font-size: 12px; overflow-wrap: anywhere; }
  .identity-facts code { font-family: var(--font-mono); }

  .lineage-toggle {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
  }

  .membership-list {
    display: grid;
    gap: var(--space-2);
    margin: var(--space-3) 0 0;
    padding: 0;
    list-style: none;
  }

  .membership-list li {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .membership-list .identity-facts { grid-template-columns: repeat(3, minmax(0, 1fr)); }

  .empty-state {
    padding: var(--space-6);
    color: var(--muted);
    text-align: center;
  }

  .statements-footer {
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
