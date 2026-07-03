<script lang="ts">
  import { t, translateKnownLabel } from "$lib/i18n/i18n.ts";
  import type { AccountRowDto, AssetPositionDto } from "$lib/shared-ledger/types.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";

  type SortKey = "symbol" | "name" | "units" | "value" | "change";
  type SortDirection = "asc" | "desc";
  type SortColumn = { key: SortKey; label: string; right?: boolean };

  export let open = false;
  export let account: AccountRowDto | null = null;
  export let rows: AssetPositionDto[] = [];

  const returnKeys = ["trade", "deposit", "reward"] as const;
  $: returnOptions = [
    { key: "trade" as const, label: $t.positions.trade },
    { key: "deposit" as const, label: $t.positions.deposit },
    { key: "reward" as const, label: $t.positions.reward },
  ];
  type ReturnKey = (typeof returnKeys)[number];
  type ReturnSelection = Record<ReturnKey, boolean>;

  let selectedReturns: ReturnSelection = { trade: true, deposit: true, reward: true };
  let expandedSymbols: Record<string, boolean> = {};
  let sortKey: SortKey | null = null;
  let sortDirection: SortDirection = "asc";
  let sortColumns: SortColumn[] = [];

  function closeOnEscape(event: KeyboardEvent) {
    if (open && event.key === "Escape") open = false;
  }

  function changeValue(change: string) {
    const value = Number.parseFloat(change);
    return Number.isFinite(value) ? value : 0;
  }

  $: metricLabels = [...new Set(rows.map((row) => row.metricLabel ?? "Return"))];
  $: metricLabel = metricLabels.length === 1 ? translateKnownLabel($t, metricLabels[0]) : $t.positions.metric;

  function isReturnMetric(row: AssetPositionDto) {
    return (row.metricLabel ?? "Return") === "Return";
  }

  function toggleReturn(key: ReturnKey) {
    const next = { ...selectedReturns, [key]: !selectedReturns[key] };
    if (!next.trade && !next.deposit && !next.reward) return;
    selectedReturns = next;
  }

  function categoryReturn(children: AssetPositionDto[], selection: ReturnSelection) {
    const selectedChildren = children.filter((row) => row.returnCategory && selection[row.returnCategory]);
    if (selectedChildren.length === 0) return "--";
    return selectedReturn(selectedChildren);
  }

  function selectedReturn(changeRows: AssetPositionDto[]) {
    const value = changeRows.reduce((sum, row) => sum + row.value, 0);
    const cost = changeRows.reduce((sum, row) => sum + (row.returnCostTwd ?? 0), 0);
    return cost > 0 ? `${(((value - cost) / cost) * 100).toFixed(2)}%` : "--";
  }

  function toggleExpanded(symbol: string) {
    expandedSymbols = { ...expandedSymbols, [symbol]: !expandedSymbols[symbol] };
  }

  function rowChange(row: AssetPositionDto, childRows: AssetPositionDto[], selection: ReturnSelection) {
    return childRows.length > 0 ? categoryReturn(childRows, selection) : row.change;
  }

  function numericText(value: string) {
    const parsed = Number.parseFloat(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function sortPositions(
    sourceRows: AssetPositionDto[],
    key: SortKey | null,
    direction: SortDirection,
    childrenBySymbol: Record<string, AssetPositionDto[]>,
    selection: ReturnSelection,
  ) {
    if (!key) return sourceRows;
    return [...sourceRows].sort((left, right) => comparePositions(left, right, key, direction, childrenBySymbol, selection));
  }

  function comparePositions(
    left: AssetPositionDto,
    right: AssetPositionDto,
    key: SortKey,
    direction: SortDirection,
    childrenBySymbol: Record<string, AssetPositionDto[]>,
    selection: ReturnSelection,
  ) {
    const leftValue = positionSortValue(left, key, childrenBySymbol, selection);
    const rightValue = positionSortValue(right, key, childrenBySymbol, selection);
    const result =
      typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue));
    return direction === "asc" ? result : -result;
  }

  function positionSortValue(
    row: AssetPositionDto,
    key: SortKey,
    childrenBySymbol: Record<string, AssetPositionDto[]>,
    selection: ReturnSelection,
  ) {
    if (key === "units") return numericText(row.units);
    if (key === "value") return row.value;
    if (key === "change") return changeValue(rowChange(row, childrenBySymbol[row.symbol] ?? [], selection));
    return row[key];
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDirection = key === "units" || key === "value" || key === "change" ? "desc" : "asc";
    }
  }

  $: returnRows = rows.filter((row) => row.returnCategory);
  $: hasReturnBreakdown = returnRows.length > 0;
  $: parentRows = rows.filter((row) => !row.returnCategory);
  $: childRowsBySymbol = returnRows.reduce<Record<string, AssetPositionDto[]>>((bucket, row) => {
    bucket[row.symbol] = [...(bucket[row.symbol] ?? []), row];
    return bucket;
  }, {});
  $: sortedParentRows = sortPositions(parentRows, sortKey, sortDirection, childRowsBySymbol, selectedReturns);
  $: sortColumns = [
    { key: "symbol", label: $t.positions.symbol },
    { key: "name", label: $t.positions.name },
    { key: "units", label: $t.positions.units, right: true },
    { key: "value", label: $t.positions.value, right: true },
    { key: "change", label: metricLabel, right: true },
  ];
</script>

<svelte:window on:keydown={closeOnEscape} />

{#if open}
  <div class="modal open">
    <button class="modal-backdrop" type="button" aria-label={$t.common.close} on:click={() => (open = false)}></button>
    <div class="modal-panel" role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-head">
        <div>
          <h2>{account ? $t.positions.accountTitle(account.label) : $t.positions.title}</h2>
          <p class="lead">{account ? `${account.institution} / ${translateKnownLabel($t, account.typeLabel)}` : ""}</p>
        </div>
        <button class="modal-close" type="button" aria-label={$t.common.close} on:click={() => (open = false)}>x</button>
      </div>
      <div class="modal-body">
        {#if hasReturnBreakdown}
          <div class="return-controls">
            <div class="return-options">
              {#each returnOptions as option}
                <button
                  class="filter-btn"
                  type="button"
                  aria-pressed={selectedReturns[option.key]}
                  on:click={() => toggleReturn(option.key)}
                >
                  {option.label}
                </button>
              {/each}
            </div>
          </div>
        {/if}
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
            {#each sortedParentRows as row}
              {@const childRows = childRowsBySymbol[row.symbol] ?? []}
              {@const expanded = expandedSymbols[row.symbol] ?? false}
              {@const change = rowChange(row, childRows, selectedReturns)}
              <tr>
                <td>{row.symbol}</td>
                <td>
                  <div class="position-name">
                    {#if childRows.length > 0}
                      <button
                        class="expand-btn"
                        type="button"
                        aria-label={expanded ? $t.positions.collapseReturnDetails(row.symbol) : $t.positions.expandReturnDetails(row.symbol)}
                        aria-expanded={expanded}
                        on:click={() => toggleExpanded(row.symbol)}
                      >
                        <span class="caret"></span>
                      </button>
                    {/if}
                    <span>{row.name}</span>
                  </div>
                </td>
                <td class="right num">{row.units}</td>
                <td class="right money">{formatMoney({ currency: row.currency, value: row.value })}</td>
                <td
                  class="right"
                  class:return-positive={isReturnMetric(row) && changeValue(change) > 0}
                  class:return-negative={isReturnMetric(row) && changeValue(change) < 0}
                >
                  {change}
                </td>
              </tr>
              {#if expanded}
                {#each childRows as child}
                  <tr class="child-row">
                    <td></td>
                    <td>
                      <span class="child-name">{child.name}</span>
                    </td>
                    <td class="right num">{child.units}</td>
                    <td class="right money">{formatMoney({ currency: child.currency, value: child.value })}</td>
                    <td
                      class="right"
                      class:return-positive={isReturnMetric(child) && changeValue(child.change) > 0}
                      class:return-negative={isReturnMetric(child) && changeValue(child.change) < 0}
                    >
                      {child.change}
                    </td>
                  </tr>
                {/each}
              {/if}
            {:else}
              <tr><td colspan="5">{$t.positions.noRows}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>
{/if}

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

  .return-positive {
    color: var(--success);
  }

  .return-negative {
    color: var(--danger);
  }

  .return-controls {
    align-items: center;
    display: flex;
    justify-content: flex-end;
    padding-bottom: var(--space-3);
  }

  .return-options {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .return-options .filter-btn[aria-pressed="true"] {
    background: var(--fg);
    border-color: var(--fg);
    color: white;
  }

  .return-options .filter-btn[aria-pressed="false"] {
    background: var(--surface);
    border-color: var(--border);
    color: var(--muted);
  }

  .position-name {
    align-items: center;
    display: flex;
    gap: var(--space-2);
  }

  .expand-btn {
    width: 28px;
    height: 28px;
    display: inline-grid;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--muted);
  }

  .caret {
    width: 7px;
    height: 7px;
    border-right: 2px solid currentColor;
    border-bottom: 2px solid currentColor;
    transform: rotate(45deg) translateY(-1px);
  }

  .expand-btn[aria-expanded="true"] .caret {
    transform: rotate(180deg);
  }

  .child-row td {
    background: var(--surface-soft);
    padding-top: var(--space-3);
    padding-bottom: var(--space-3);
  }

  .child-name {
    color: var(--muted);
    padding-left: 36px;
  }
</style>
