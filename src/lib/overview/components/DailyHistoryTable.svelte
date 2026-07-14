<script lang="ts">
  import { t } from "$lib/i18n/i18n.ts";
  import { historyPointKey, type DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";
  import {
    formatAmountLines,
    formatMoney,
    formatSignedAmountLines,
  } from "$lib/shared-money/money.ts";

  type SortKey = "date" | "netAssets" | "dailyChange" | "assets" | "liabilities";
  type SortDirection = "asc" | "desc";
  type Column = { key: SortKey; label: string; right: boolean };

  export let rows: DailyHistoryRowDto[] = [];
  export let compact = false;
  export let netLabel = "";
  export let currency = "TWD";
  export let paginate = false;
  export let pageSize = 30;
  export let visibleRows = 4;

  let sortKey: SortKey = "date";
  let sortDirection: SortDirection = "desc";
  let page = 0;
  let columns: Column[] = [];

  $: columns = compact
    ? [
        { key: "date", label: $t.historyTable.date, right: false },
        { key: "netAssets", label: netLabel || $t.historyTable.netAssets, right: true },
        { key: "assets", label: $t.historyTable.assets, right: true },
        { key: "liabilities", label: $t.historyTable.liabilities, right: true },
      ]
    : [
        { key: "date", label: $t.historyTable.date, right: false },
        { key: "netAssets", label: netLabel || $t.historyTable.netAssets, right: true },
        { key: "dailyChange", label: $t.historyTable.dailyChange, right: true },
        { key: "assets", label: $t.historyTable.assets, right: true },
        { key: "liabilities", label: $t.historyTable.liabilities, right: true },
      ];
  $: sortedRows = sortRows(rows, sortKey, sortDirection);
  $: totalPages = paginate ? Math.max(1, Math.ceil(sortedRows.length / pageSize)) : 1;
  $: if (page >= totalPages) page = totalPages - 1;
  $: pageRows = paginate ? sortedRows.slice(page * pageSize, (page + 1) * pageSize) : sortedRows;
  $: rangeStart = sortedRows.length === 0 ? 0 : page * pageSize + 1;
  $: rangeEnd = Math.min((page + 1) * pageSize, sortedRows.length);

  function formatCurrencyAmount(
    row: DailyHistoryRowDto,
    key: Exclude<SortKey, "date">,
    signed = false,
  ) {
    const amounts = row[key];
    if (row.exchangeRateMissing) {
      return signed ? formatSignedAmountLines(amounts) : formatAmountLines(amounts);
    }
    const amount = amounts.find((item) => item.currency === currency);
    return amount ? formatMoney(amount, { signed }) : "--";
  }

  function currencyValue(amounts: DailyHistoryRowDto["netAssets"]) {
    return amounts.find((item) => item.currency === currency)?.value ?? 0;
  }

  function sortValue(row: DailyHistoryRowDto, key: SortKey) {
    if (key === "date") return historyPointKey(row);
    return currencyValue(row[key]);
  }

  function sortRows(sourceRows: DailyHistoryRowDto[], key: SortKey, direction: SortDirection) {
    return [...sourceRows].sort((left, right) => compareRows(left, right, key, direction));
  }

  function compareRows(left: DailyHistoryRowDto, right: DailyHistoryRowDto, key: SortKey, direction: SortDirection) {
    const leftValue = sortValue(left, key);
    const rightValue = sortValue(right, key);
    const result =
      typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue));
    return direction === "asc" ? result : -result;
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDirection = "desc";
    }
    page = 0;
  }

  function pointLabel(row: DailyHistoryRowDto) {
    return row.pointAt ? row.pointAt.slice(0, 16).replace("T", " ") : row.date;
  }

</script>

<div class="history-table-shell" style={`--history-visible-rows:${visibleRows}`}>
  <div class="table-wrap history-table-wrap">
    <table class="table history-table" class:compact>
      <thead>
        <tr>
          {#each columns as column}
            <th
              class:right={column.right}
              aria-sort={sortKey === column.key ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
            >
              <button
                class="sort-button"
                class:right={column.right}
                class:sorted={sortKey === column.key}
                type="button"
                onclick={() => toggleSort(column.key)}
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
        {#each pageRows as row}
          <tr>
            <td>
              {pointLabel(row)}
              {#if row.exchangeRateMissing}
                <span
                  class="rate-note missing"
                  role="img"
                  aria-label={$t.historyTable.missingExchangeRate}
                  title={$t.historyTable.missingExchangeRate}
                >!</span>
              {:else if row.exchangeRateDates?.length}
                <span
                  class="rate-note"
                  role="img"
                  aria-label={$t.historyTable.rateDates(row.exchangeRateDates.join(", "))}
                  title={$t.historyTable.rateDates(row.exchangeRateDates.join(", "))}
                >
                  FX
                </span>
              {/if}
            </td>
            <td class="right money">{formatCurrencyAmount(row, "netAssets")}</td>
            {#if !compact}
              {@const dailyChange = currencyValue(row.dailyChange)}
              <td
                class="right money"
                class:amount-positive={dailyChange > 0}
                class:amount-negative={dailyChange < 0}
              >
                {formatCurrencyAmount(row, "dailyChange", true)}
              </td>
              <td class="right money">{formatCurrencyAmount(row, "assets")}</td>
              <td class="right money">{formatCurrencyAmount(row, "liabilities")}</td>
            {:else}
              <td class="right money">{formatCurrencyAmount(row, "assets")}</td>
              <td class="right money">{formatCurrencyAmount(row, "liabilities")}</td>
            {/if}
          </tr>
        {:else}
          <tr>
            <td colspan={compact ? 4 : 5}>{$t.historyTable.noSnapshotHistory}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if paginate}
    <div class="table-pager" aria-label={$t.historyTable.paginationAria}>
      <span class="pager-count">{$t.common.pagerCount(rangeStart, rangeEnd, sortedRows.length)}</span>
      <div class="pager-actions">
        <button class="button pager-button" type="button" disabled={page === 0} onclick={() => (page -= 1)}>
          {$t.historyTable.prev}
        </button>
        <span class="chip">{$t.common.page(page + 1, totalPages)}</span>
        <button
          class="button pager-button"
          type="button"
          disabled={page >= totalPages - 1}
          onclick={() => (page += 1)}
        >
          {$t.historyTable.next}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .history-table-shell {
    --history-header-height: 56px;
    --history-row-height: 72px;
  }

  .history-table-wrap {
    overflow-x: auto;
    overflow-y: hidden;
  }

  .history-table {
    min-width: 820px;
    table-layout: fixed;
  }

  .history-table.compact {
    min-width: 680px;
  }

  .history-table thead {
    display: table;
    width: 100%;
    table-layout: fixed;
    background: var(--surface);
  }

  .history-table th {
    height: var(--history-header-height);
    padding: 0;
    background: var(--surface);
  }

  .history-table tbody {
    display: block;
    max-height: calc((var(--history-row-height) + 1px) * var(--history-visible-rows));
    overflow-y: auto;
  }

  .history-table tbody tr {
    display: table;
    width: 100%;
    table-layout: fixed;
  }

  .history-table td {
    height: var(--history-row-height);
    white-space: nowrap;
  }

  .sort-button {
    width: 100%;
    min-height: var(--history-header-height);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-5);
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
    background: var(--surface-soft);
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

  .table-pager {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
  }

  .pager-count {
    color: var(--muted);
    font-size: 11px;
    font-weight: 720;
    letter-spacing: 0.075em;
    text-transform: uppercase;
  }

  .pager-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .pager-button {
    min-height: 32px;
    padding: 0 var(--space-3);
  }

  .pager-button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .amount-positive {
    color: var(--success);
  }

  .amount-negative {
    color: var(--danger);
  }

  .rate-note {
    margin-left: var(--space-2);
    color: var(--muted);
    font-size: 10px;
    font-weight: 760;
  }

  .rate-note.missing {
    color: var(--danger);
  }
</style>
