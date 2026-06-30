<script lang="ts">
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

  let filter: AccountKind | "all" = "all";
  let selectedAccountId: string | null = null;
  let transactionsOpen = false;
  let positionsOpen = false;
  let historyOpen = false;
  let sortKey: SortKey | null = null;
  let sortDirection: SortDirection = "asc";
  let sortColumns: SortColumn[] = [];

  const assetFilters: Filter[] = [
    { id: "all", label: "All Assets" },
    { id: "bank", label: "Bank" },
    { id: "fund", label: "Fund" },
    { id: "brokerage", label: "Brokerage" },
    { id: "crypto", label: "Crypto" },
    { id: "foreign", label: "Foreign" },
  ];
  const liabilityFilters: Filter[] = [
    { id: "all", label: "All Debts" },
    { id: "credit-card", label: "Credit Card" },
    { id: "loan", label: "Loan" },
    { id: "crypto", label: "Crypto" },
    { id: "other", label: "Other" },
  ];

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
  $: if (sorted.length > 0 && !sorted.some((account) => account.id === selectedAccountId)) {
    selectedAccountId = sorted[0].id;
  }
  $: selectedAccount =
    accounts.find((account) => account.id === selectedAccountId) ?? sorted[0] ?? null;
  $: selectedTransactions =
    selectedAccount ? transactionsByAccount[selectedAccount.id] ?? [] : [];
  $: selectedPositions =
    selectedAccount ? positionsByAccount[selectedAccount.id] ?? [] : [];
  $: selectedDailyHistory =
    selectedAccount ? dailyHistoryByAccount[selectedAccount.id] ?? [] : [];
  $: sortColumns = [
    { key: "label", label: "Account Name" },
    { key: "institution", label: "Institution" },
    { key: "type", label: "Type" },
    { key: "balance", label: "Balance", right: true },
    { key: "allocation", label: mode === "asset" ? "Allocation" : "Exposure", right: true },
  ];

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
</script>

<div class="toolbar">
  <div class="filters" aria-label={mode === "asset" ? "Asset filters" : "Debt filters"}>
    {#each filters as item}
      <button class="filter-btn" type="button" aria-pressed={filter === item.id} on:click={() => (filter = item.id)}>
        {item.label}
      </button>
    {/each}
  </div>
</div>

<section class="layout-accounts">
  <div>
    <div class="account-list card">
      <div class="table-wrap">
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
              <th class="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each sorted as account}
              {@const percent = percentage(account)}
              <tr
                class:selected={account.id === selectedAccountId}
                class="account-card"
                on:click={() => (selectedAccountId = account.id)}
              >
                <td>
                  <strong>{account.label}</strong><br />
                  <span class="account-meta">{account.product} / {account.transactionCount} TX</span>
                </td>
                <td>{account.institution}</td>
                <td><span class="chip">{account.typeLabel}</span></td>
                <td class="right">
                  <strong class="money">{formatAmountLines(account.amountLines)}</strong><br />
                  <span class="account-meta">Updated {account.lastUpdated ?? "--"}</span>
                </td>
                <td class="right">
                  <span class="account-meta">{percent}%</span>
                  <div class="row-bar" aria-hidden="true">
                    <span style={`width:${percent}%`}></span>
                  </div>
                </td>
                <td class="right actions-cell">
                  <button
                    class="chip"
                    type="button"
                    on:click|stopPropagation={() => {
                      selectedAccountId = account.id;
                      transactionsOpen = true;
                    }}>TX</button
                  >
                  <button
                    class="chip"
                    type="button"
                    on:click|stopPropagation={() => {
                      selectedAccountId = account.id;
                      historyOpen = true;
                    }}>History</button
                  >
                  {#if mode === "asset" && account.assetPositionCount > 0}
                    <button
                      class="chip"
                      type="button"
                      on:click|stopPropagation={() => {
                        selectedAccountId = account.id;
                        positionsOpen = true;
                      }}>Positions</button
                    >
                  {/if}
                </td>
              </tr>
            {:else}
              <tr>
                <td colspan="6">{mode === "asset" ? "No matching asset accounts." : "No matching liabilities."}</td>
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
</style>
