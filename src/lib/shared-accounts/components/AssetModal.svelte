<script lang="ts">
  import type { AccountRowDto, AssetPositionDto } from "$lib/shared-ledger/types.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";

  export let open = false;
  export let account: AccountRowDto | null = null;
  export let rows: AssetPositionDto[] = [];

  const returnOptions = [
    { key: "trade", label: "Trade" },
    { key: "deposit", label: "Deposit" },
    { key: "reward", label: "Reward" },
  ] as const;
  type ReturnKey = (typeof returnOptions)[number]["key"];
  type ReturnSelection = Record<ReturnKey, boolean>;

  let selectedReturns: ReturnSelection = { trade: true, deposit: true, reward: true };
  let expandedSymbols: Record<string, boolean> = {};

  function changeValue(change: string) {
    const value = Number.parseFloat(change);
    return Number.isFinite(value) ? value : 0;
  }

  $: metricLabels = [...new Set(rows.map((row) => row.metricLabel ?? "Return"))];
  $: metricLabel = metricLabels.length === 1 ? metricLabels[0] : "Metric";

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

  $: returnRows = rows.filter((row) => row.returnCategory);
  $: hasReturnBreakdown = returnRows.length > 0;
  $: parentRows = rows.filter((row) => !row.returnCategory);
  $: childRowsBySymbol = returnRows.reduce<Record<string, AssetPositionDto[]>>((bucket, row) => {
    bucket[row.symbol] = [...(bucket[row.symbol] ?? []), row];
    return bucket;
  }, {});
</script>

{#if open}
  <div class="modal open">
    <button class="modal-backdrop" type="button" aria-label="Close" on:click={() => (open = false)}></button>
    <div class="modal-panel" role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-head">
        <div>
          <h2>{account ? `${account.label} Positions` : "Positions"}</h2>
          <p class="lead">{account ? `${account.institution} / ${account.typeLabel}` : ""}</p>
        </div>
        <button class="modal-close" type="button" aria-label="Close" on:click={() => (open = false)}>x</button>
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
            <tr><th>Symbol</th><th>Name</th><th class="right">Units</th><th class="right">Value</th><th class="right">{metricLabel}</th></tr>
          </thead>
          <tbody>
            {#each parentRows as row}
              {@const childRows = childRowsBySymbol[row.symbol] ?? []}
              {@const expanded = expandedSymbols[row.symbol] ?? false}
              {@const change = childRows.length > 0 ? categoryReturn(childRows, selectedReturns) : row.change}
              <tr>
                <td>{row.symbol}</td>
                <td>
                  <div class="position-name">
                    {#if childRows.length > 0}
                      <button
                        class="expand-btn"
                        type="button"
                        aria-label={expanded ? `Collapse ${row.symbol} return details` : `Expand ${row.symbol} return details`}
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
              <tr><td colspan="5">No asset positions for this account.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>
{/if}

<style>
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
