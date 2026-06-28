<script lang="ts">
  import type { AccountKind, AccountRowDto, AssetPositionDto, TransactionRowDto } from "$lib/shared-ledger/types.ts";
  import { formatAmountLines, amountValue } from "$lib/shared-money/money.ts";
  import AssetModal from "./AssetModal.svelte";
  import TransactionModal from "./TransactionModal.svelte";

  type Filter = {
    id: AccountKind | "all";
    label: string;
  };

  export let accounts: AccountRowDto[] = [];
  export let positionsByAccount: Record<string, AssetPositionDto[]> = {};
  export let transactionsByAccount: Record<string, TransactionRowDto[]> = {};
  export let search = "";
  export let mode: "asset" | "liability" = "asset";

  let filter: AccountKind | "all" = "all";
  let selectedAccountId: string | null = null;
  let transactionsOpen = false;
  let positionsOpen = false;

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
  $: if (filtered.length > 0 && !filtered.some((account) => account.id === selectedAccountId)) {
    selectedAccountId = filtered[0].id;
  }
  $: selectedAccount =
    accounts.find((account) => account.id === selectedAccountId) ?? filtered[0] ?? null;
  $: selectedTransactions =
    selectedAccount ? transactionsByAccount[selectedAccount.id] ?? [] : [];
  $: selectedPositions =
    selectedAccount ? positionsByAccount[selectedAccount.id] ?? [] : [];
  $: total = accounts.reduce((sum, account) => sum + amountValue(account.amountLines), 0);

  function percentage(account: AccountRowDto) {
    if (total <= 0) return 0;
    return Math.min(100, Math.round((amountValue(account.amountLines) / total) * 100));
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
              <th>Account Name</th>
              <th>Institution</th>
              <th>Type</th>
              <th class="right">Balance</th>
              <th class="right">{mode === "asset" ? "Allocation" : "Exposure"}</th>
              <th class="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each filtered as account}
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
