<script lang="ts">
  import { List } from "@lucide/svelte";
  import { tick } from "svelte";
  import { locale, t, type Translation } from "$lib/i18n/i18n.ts";
  import type {
    AccountKind,
    AccountRowDto,
    AssetPositionDto,
    DailyHistoryRowDto,
    TransactionRowDto,
  } from "$lib/shared-ledger/types.ts";
  import { formatShare } from "$lib/overview/overview-format.ts";
  import { formatAmountLines, amountValue } from "$lib/shared-money/money.ts";
  import InstitutionLogo from "$lib/institutions/InstitutionLogo.svelte";
  import { institutionForNamespace } from "$lib/institutions/institutions.ts";
  import { localizeAccount } from "$lib/shared-accounts/localize-account.ts";
  import AccountHistoryModal from "./AccountHistoryModal.svelte";
  import AssetModal from "./AssetModal.svelte";
  import CreditCardStatementsModal from "./CreditCardStatementsModal.svelte";
  import TransactionModal from "./TransactionModal.svelte";
  import EmptyPanel from "$lib/shared-shell/components/EmptyPanel.svelte";

  type Filter = {
    id: AccountKind | "all";
    label: string;
  };
  /** Before anything syncs, offer the categories a person would expect to connect. */
  const EMPTY_PAGE_FILTERS: Record<"asset" | "liability", ReadonlyArray<Filter["id"]>> = {
    asset: ["all", "bank", "fund", "brokerage", "crypto", "foreign"],
    liability: ["all", "credit-card", "loan"],
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
  export let focusAccountId: string | null = null;
  /** Each account's share of the converted page total; an absent account shows none. */
  export let shares: ReadonlyMap<string, number> = new Map();
  /** Converted account values, for the positions modal. */
  export let twdValues: ReadonlyMap<string, number> = new Map();

  export let filter: AccountKind | "all" = "all";
  let selectedAccountId: string | null = null;
  let handledFocusAccountId: string | null = null;
  let transactionsOpen = false;
  let positionsOpen = false;
  let historyOpen = false;
  let statementsOpen = false;
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
    { id: "fund" as const, label: $t.accounts.fund },
    { id: "brokerage" as const, label: $t.accounts.brokerage },
    { id: "crypto" as const, label: $t.accounts.crypto },
    { id: "other" as const, label: $t.accounts.other },
  ] satisfies Filter[];

  $: availableKinds = new Set(accounts.map((account) => account.kind));
  $: filters = (mode === "asset" ? assetFilters : liabilityFilters).filter((item) =>
    accounts.length === 0
      ? EMPTY_PAGE_FILTERS[mode].includes(item.id)
      : item.id === "all" || availableKinds.has(item.id),
  );
  $: emptyCopy = mode === "asset" ? $t.assets.empty : $t.liabilities.empty;
  $: if (!filters.some((item) => item.id === filter)) filter = "all";
  $: query = search.trim().toLowerCase();
  $: filtered = accounts.flatMap((account) => {
    const shown = localizeAccount(account, $t);
    const filterMatch = filter === "all" || account.kind === filter;
    const text = [
      shown.label,
      shown.institution,
      shown.product,
      account.institution,
      account.product,
      account.typeLabel,
    ]
      .join(" ")
      .toLowerCase();
    return filterMatch && (!query || text.includes(query)) ? [shown] : [];
  });
  $: latestUpdated = accounts.reduce<string | null>(
    (latest, account) => account.lastUpdated && (!latest || account.lastUpdated > latest) ? account.lastUpdated : latest,
    null,
  );
  $: sorted = sortAccounts(filtered, sortKey, sortDirection, shares);
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
  $: if (focusAccountId !== handledFocusAccountId) {
    handledFocusAccountId = focusAccountId;
    if (focusAccountId) void focusAccount(focusAccountId);
  }

  function selectAccount(accountId: string) {
    selectedAccountId = accountId;
  }

  async function focusAccount(accountId: string) {
    if (!accounts.some((account) => account.id === accountId)) return;
    selectedAccountId = accountId;
    await tick();
    const row = [...(tableWrap?.querySelectorAll<HTMLElement>("[data-account-id]") ?? [])]
      .find((element) => element.dataset.accountId === accountId);
    row?.scrollIntoView({ block: "nearest" });
    row?.focus({ preventScroll: true });
  }

  function sortAccounts(rows: AccountRowDto[], key: SortKey | null, direction: SortDirection, shareOf: ReadonlyMap<string, number>) {
    if (!key) return rows;
    return [...rows].sort((left, right) => compareAccounts(left, right, key, direction, shareOf));
  }

  function compareAccounts(
    left: AccountRowDto,
    right: AccountRowDto,
    key: SortKey,
    direction: SortDirection,
    shareOf: ReadonlyMap<string, number>,
  ) {
    const leftValue = sortValue(left, key, shareOf);
    const rightValue = sortValue(right, key, shareOf);
    const result =
      typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue));
    return direction === "asc" ? result : -result;
  }

  function sortValue(account: AccountRowDto, key: SortKey, shareOf: ReadonlyMap<string, number>) {
    if (key === "label") return `${account.label} ${account.product}`;
    if (key === "institution") return account.institution;
    if (key === "type") return account.typeLabel;
    if (key === "allocation") return shareOf.get(account.id) ?? -1;
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
        {#if selectedAccount.creditCard}
          <button class="button secondary" type="button" on:click={() => (statementsOpen = true)}>{$t.accounts.statements}</button>
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
      {#if accounts.length === 0}
        <div class="account-empty">
          <EmptyPanel icon={List} title={emptyCopy.listTitle} body={emptyCopy.listBody} />
        </div>
      {:else}
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
                    class:institution-cell={column.key === "institution"}
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
                {@const share = shares.get(account.id)}
                {@const availableBalanceBasis = account.amountLines.some((amount) =>
                  amount.traces?.some((trace) => trace.balanceKind === "available"),
                )}
                {@const estimatedCreditBasis = account.amountLines.some((amount) =>
                  amount.traces?.some((trace) => trace.estimateKind === "estimate"),
                )}
                <tr
                  class:selected={account.id === selectedAccountId}
                  class="account-card"
                  data-account-id={account.id}
                  tabindex={account.id === selectedAccountId ? 0 : -1}
                  on:click={() => selectAccount(account.id)}
                >
                  <td>
                    <span class="account-name">
                      <InstitutionLogo institution={institutionForNamespace(account.institutionKey)} />
                      <strong>{account.label}</strong>
                    </span>
                    <span class="account-meta">{translateKnownLabel(account.product, $t)} / <span class="num">{$t.accounts.txCount(account.transactionCount)}</span></span>
                  </td>
                  <td class="institution-cell">{account.institution}</td>
                  <td><span class="chip">{translateKnownLabel(account.typeLabel, $t)}</span></td>
                  <td class="right">
                    <strong
                      class="money"
                      data-balance-basis={estimatedCreditBasis ? "credit-card-estimate" : undefined}
                      title={estimatedCreditBasis ? $t.accounts.creditCardEstimateBasis : undefined}
                    >
                      {#if account.valueAvailability === "awaiting"}
                        <span>{$t.overview.currentAwaiting}</span>
                      {:else if account.valueAvailability === "unavailable"}
                        <span>{$t.accounts.noAvailableData}</span>
                      {:else}
                        {formatAmountLines(account.amountLines)}
                      {/if}
                    </strong><br />
                    {#if availableBalanceBasis}
                      <span class="account-meta">{$t.accounts.availableBalanceBasis}</span><br />
                    {/if}
                    {#if estimatedCreditBasis || account.lastUpdated !== latestUpdated}
                      <span class="account-meta">{$t.accounts.updated(account.lastUpdated ?? "--")}</span>
                    {/if}
                  </td>
                  <td class="right">
                    {#if account.valueAvailability === "available" && share !== undefined}
                      <span class="account-meta num" data-sensitive>{formatShare(share, $locale)}</span>
                      <div class="row-bar" aria-hidden="true">
                        <span data-sensitive style={`width:${share * 100}%`}></span>
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
      {/if}
      {#if latestUpdated}
        <p class="account-meta table-updated">{$t.accounts.updated(latestUpdated)}</p>
      {/if}
    </div>
  </div>
</section>

<TransactionModal bind:open={transactionsOpen} account={selectedAccount} rows={selectedTransactions} />
<AssetModal
  bind:open={positionsOpen}
  account={selectedAccount}
  rows={selectedPositions}
  transactions={selectedTransactions}
  twdValue={selectedAccount ? twdValues.get(selectedAccount.id) ?? null : null}
/>
<AccountHistoryModal
  bind:open={historyOpen}
  account={selectedAccount}
  rows={selectedDailyHistory}
  transactions={selectedTransactions}
/>
<CreditCardStatementsModal bind:open={statementsOpen} account={selectedAccount} />

<style>
  .account-empty {
    padding: var(--space-5);
  }

  .sort-button {
    width: 100%;
    min-height: 24px;
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
    flex-direction: row-reverse;
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

  .account-name {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .institution-cell {
    white-space: nowrap;
  }

  .table-updated {
    margin: 0;
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
  }

  @media (max-width: 1180px) {
    .institution-cell {
      display: none;
    }
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
