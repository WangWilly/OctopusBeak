<script lang="ts">
  import { TriangleAlert } from "@lucide/svelte";
  import { tick } from "svelte";
  import { t, type Translation } from "$lib/i18n/i18n.ts";
  import type {
    AccountKind,
    AccountRowDto,
    AssetPositionDto,
    DailyHistoryRowDto,
    TransactionRowDto,
  } from "$lib/shared-ledger/types.ts";
  import { formatAmountLines, amountValue } from "$lib/shared-money/money.ts";
  import AccountHistoryModal from "./AccountHistoryModal.svelte";
  import AssetModal from "./AssetModal.svelte";
  import TransactionModal from "./TransactionModal.svelte";

  type Filter = {
    id: AccountKind | "all";
    label: string;
  };
  type SortKey = "label" | "institution" | "type" | "balance" | "allocation";
  type SortDirection = "asc" | "desc";
  type SortColumn = { key: SortKey; label: string; right?: boolean };

  export let accounts: AccountRowDto[] = [];
  export let positionsByAccount: Record<string, AssetPositionDto[]> = {};
  export let transactionsByAccount: Record<string, TransactionRowDto[]> = {};
  export let dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]> = {};
  export let search = "";
  export let mode: "asset" | "liability" = "asset";
  export let onReportDataIssue: ((account: AccountRowDto) => void) | null = null;

  export let filter: AccountKind | "all" = "all";
  let selectedAccountId: string | null = null;
  let transactionsOpen = false;
  let positionsOpen = false;
  let historyOpen = false;
  let sortKey: SortKey | null = null;
  let sortDirection: SortDirection = "asc";
  let sortColumns: SortColumn[] = [];
  let tableWrap: HTMLDivElement | null = null;
  let tableWrapHeight: string | null = null;
  let tableWrapAnimating = false;
  let tableWrapTimeout: ReturnType<typeof setTimeout> | null = null;
  let tableWrapFrame = 0;

  $: assetFilters = [
    { id: "all" as const, label: $t.accounts.allAssets },
    { id: "bank" as const, label: $t.accounts.bank },
    { id: "fund" as const, label: $t.accounts.fund },
    { id: "brokerage" as const, label: $t.accounts.brokerage },
    { id: "crypto" as const, label: $t.accounts.crypto },
    { id: "foreign" as const, label: $t.accounts.foreign },
  ] satisfies Filter[];
  $: liabilityFilters = [
    { id: "all" as const, label: $t.accounts.allDebts },
    { id: "credit-card" as const, label: $t.accounts.creditCard },
    { id: "loan" as const, label: $t.accounts.loan },
    { id: "crypto" as const, label: $t.accounts.crypto },
    { id: "other" as const, label: $t.accounts.other },
  ] satisfies Filter[];

  $: availableKinds = new Set(accounts.map((account) => account.kind));
  $: filters = (mode === "asset" ? assetFilters : liabilityFilters).filter(
    (item) => item.id === "all" || availableKinds.has(item.id),
  );
  $: if (!filters.some((item) => item.id === filter)) filter = "all";
  $: query = search.trim().toLowerCase();
  $: filtered = accounts.filter((account) => {
    const filterMatch = filter === "all" || account.kind === filter;
    const text = [
      account.label,
      account.institution,
      account.product,
      account.typeLabel,
    ]
      .join(" ")
      .toLowerCase();
    return filterMatch && (!query || text.includes(query));
  });
  $: total = accounts.reduce((sum, account) => sum + amountValue(account.amountLines), 0);
  $: sorted = sortAccounts(filtered, sortKey, sortDirection, total);
  $: if (sorted.length === 0 && selectedAccountId !== null) {
    selectedAccountId = null;
  }
  $: if (sorted.length > 0 && !sorted.some((account) => account.id === selectedAccountId)) {
    selectedAccountId = sorted[0].id;
  }
  $: selectedAccount =
    sorted.find((account) => account.id === selectedAccountId) ?? null;
  $: selectedTransactions =
    selectedAccount ? transactionsByAccount[selectedAccount.id] ?? [] : [];
  $: selectedPositions =
    selectedAccount ? positionsByAccount[selectedAccount.id] ?? [] : [];
  $: selectedDailyHistory =
    selectedAccount ? dailyHistoryByAccount[selectedAccount.id] ?? [] : [];
  $: sortColumns = [
    { key: "label", label: $t.accounts.accountName },
    { key: "institution", label: $t.accounts.institution },
    { key: "type", label: $t.accounts.type },
    { key: "balance", label: $t.accounts.balance, right: true },
    { key: "allocation", label: mode === "asset" ? $t.accounts.allocation : $t.accounts.exposure, right: true },
  ];

  function selectAccount(accountId: string) {
    selectedAccountId = accountId;
  }

  function percentage(account: AccountRowDto) {
    if (total <= 0) return 0;
    return Math.min(100, Math.round((amountValue(account.amountLines) / total) * 100));
  }

  function sortAccounts(rows: AccountRowDto[], key: SortKey | null, direction: SortDirection, totalValue: number) {
    if (!key) return rows;
    return [...rows].sort((left, right) => compareAccounts(left, right, key, direction, totalValue));
  }

  function compareAccounts(
    left: AccountRowDto,
    right: AccountRowDto,
    key: SortKey,
    direction: SortDirection,
    totalValue: number,
  ) {
    const leftValue = sortValue(left, key, totalValue);
    const rightValue = sortValue(right, key, totalValue);
    const result =
      typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue));
    return direction === "asc" ? result : -result;
  }

  function sortValue(account: AccountRowDto, key: SortKey, totalValue: number) {
    if (key === "label") return `${account.label} ${account.product}`;
    if (key === "institution") return account.institution;
    if (key === "type") return account.typeLabel;
    if (key === "allocation") return totalValue > 0 ? amountValue(account.amountLines) / totalValue : 0;
    return amountValue(account.amountLines);
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDirection = key === "balance" || key === "allocation" ? "desc" : "asc";
    }
  }

  function tableHeight() {
    return tableWrap?.querySelector("table")?.getBoundingClientRect().height ?? 0;
  }

  async function selectFilter(nextFilter: AccountKind | "all") {
    if (filter === nextFilter) return;
    const from = tableHeight();
    if (from > 0) {
      tableWrapAnimating = false;
      tableWrapHeight = `${from}px`;
    }
    filter = nextFilter;
    await tick();
    const to = tableHeight();
    if (!from || !to) {
      tableWrapHeight = null;
      return;
    }
    // Commit the fixed starting height before transitioning to the new table height.
    tableWrap?.getBoundingClientRect();
    if (tableWrapFrame) cancelAnimationFrame(tableWrapFrame);
    tableWrapFrame = requestAnimationFrame(() => {
      tableWrapAnimating = true;
      tableWrapHeight = `${to}px`;
      if (tableWrapTimeout) clearTimeout(tableWrapTimeout);
      tableWrapTimeout = setTimeout(() => {
        tableWrapHeight = null;
        tableWrapAnimating = false;
        tableWrapTimeout = null;
      }, 340);
    });
  }

  function translateKnownLabel(value: string, dictionary: Translation) {
    return (dictionary.knownLabels as Record<string, string>)[value] ?? value;
  }
</script>

<div class="toolbar account-toolbar">
  <div class="filters" aria-label={mode === "asset" ? $t.accounts.assetFiltersAria : $t.accounts.debtFiltersAria}>
    {#each filters as item}
      <button class="filter-btn" type="button" aria-pressed={filter === item.id} on:click={() => selectFilter(item.id)}>
        {item.label}
      </button>
    {/each}
  </div>
  {#if selectedAccount}
    <div class="selected-actions" aria-label={$t.accounts.actions}>
      <div class="selected-actions-label">
        <span class="label">{$t.accounts.actions}</span>
        <strong>{selectedAccount.label}</strong>
      </div>
      <div class="action-group">
        <button class="button secondary" type="button" on:click={() => (transactionsOpen = true)}>{$t.accounts.tx}</button>
        <button class="button secondary" type="button" on:click={() => (historyOpen = true)}>{$t.accounts.history}</button>
        {#if onReportDataIssue}
          <button
            class="button secondary report-issue-button"
            type="button"
            aria-label={$t.dataIssues.reportProblem}
            title={$t.dataIssues.reportProblem}
            on:click={() => onReportDataIssue?.(selectedAccount)}
          >
            <TriangleAlert size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        {/if}
        {#if mode === "asset" && selectedPositions.length > 0}
          <button class="button secondary" type="button" on:click={() => (positionsOpen = true)}>{$t.accounts.positions}</button>
        {/if}
      </div>
    </div>
  {/if}
</div>

<section class="layout-accounts">
  <div>
    <div class="account-list card">
      <div
        class="table-wrap account-table-wrap"
        class:account-table-wrap-animating={tableWrapAnimating}
        bind:this={tableWrap}
        style:height={tableWrapHeight}
      >
        <table class="table">
          <thead>
            <tr>
              {#each sortColumns as column}
                <th
                  class:right={column.right}
                  aria-sort={sortKey === column.key ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button
                    class="sort-button"
                    class:right={column.right}
                    class:sorted={sortKey === column.key}
                    type="button"
                    on:click={() => toggleSort(column.key)}
                  >
                    <span>{column.label}</span>
                    <span
                      class:active={sortKey === column.key}
                      class:asc={sortKey === column.key && sortDirection === "asc"}
                      class="sort-mark"
                      aria-hidden="true"
                    ></span>
                  </button>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each sorted as account}
              {@const percent = percentage(account)}
              <tr
                class:selected={account.id === selectedAccountId}
                class="account-card"
                on:click={() => selectAccount(account.id)}
              >
                <td>
                  <strong>{account.label}</strong><br />
                  <span class="account-meta">{account.product} / {$t.accounts.txCount(account.transactionCount)}</span>
                </td>
                <td>{account.institution}</td>
                <td><span class="chip">{translateKnownLabel(account.typeLabel, $t)}</span></td>
                <td class="right">
                  <strong class="money">
                    {#if account.valueAvailability === "unavailable"}
                      <span>{$t.accounts.noAvailableData}</span>
                      {#if account.dataIssueId}
                        <a href={`#/data-issues/${account.dataIssueId}`}>{$t.dataIssues.viewIssue}</a>
                      {/if}
                    {:else}
                      {formatAmountLines(account.amountLines)}
                    {/if}
                  </strong><br />
                  <span class="account-meta">{$t.accounts.updated(account.lastUpdated ?? "--")}</span>
                </td>
                <td class="right">
                  {#if account.valueAvailability === "available"}
                    <span class="account-meta">{percent}%</span>
                    <div class="row-bar" aria-hidden="true">
                      <span style={`width:${percent}%`}></span>
                    </div>
                  {/if}
                </td>
              </tr>
            {:else}
              <tr>
                <td colspan="5">{mode === "asset" ? $t.accounts.noAssetMatches : $t.accounts.noLiabilityMatches}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>
</section>

<TransactionModal bind:open={transactionsOpen} account={selectedAccount} rows={selectedTransactions} />
<AssetModal bind:open={positionsOpen} account={selectedAccount} rows={selectedPositions} />
<AccountHistoryModal bind:open={historyOpen} account={selectedAccount} rows={selectedDailyHistory} />

<style>
  .report-issue-button {
    width: 38px;
    min-width: 38px;
    padding-inline: 0;
  }

  .sort-button {
    width: 100%;
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
  }

  .sort-button.right {
    justify-content: flex-end;
  }

  .sort-button:hover,
  .sort-button:focus-visible,
  .sort-button.sorted {
    color: var(--fg);
    outline: none;
  }

  .sort-mark {
    width: 10px;
    height: 10px;
    display: inline-grid;
    place-items: center;
    color: var(--accent);
  }

  .sort-mark::before {
    content: "";
    width: 0;
    height: 0;
    border-left: 4px solid transparent;
    border-right: 4px solid transparent;
    border-top: 5px solid currentColor;
    opacity: 0;
  }

  .sort-mark.active::before {
    opacity: 1;
  }

  .sort-mark.asc::before {
    transform: rotate(180deg);
  }

  .account-table-wrap-animating {
    overflow-y: hidden;
    transition: height 320ms ease;
  }

  @media (prefers-reduced-motion: reduce) {
    .account-table-wrap-animating {
      transition: none;
    }
  }
</style>
