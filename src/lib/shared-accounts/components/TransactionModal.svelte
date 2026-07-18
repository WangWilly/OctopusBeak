<script lang="ts">
  import { locale, t, translateKnownLabel } from "$lib/i18n/i18n.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import type { AccountRowDto, TransactionRowDto } from "$lib/shared-ledger/types.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import { formatUtcDate } from "$lib/time/timezone.ts";

  type SortKey = "date" | "label" | "type" | "amount" | "note";
  type SortDirection = "asc" | "desc";
  type SortColumn = { key: SortKey; label: string; right?: boolean };

  export let open = false;
  export let account: AccountRowDto | null = null;
  export let rows: TransactionRowDto[] = [];

  let sortKey: SortKey | null = null;
  let sortDirection: SortDirection = "asc";
  let sortColumns: SortColumn[] = [];

  $: sortedRows = sortRows(rows, sortKey, sortDirection);
  $: sortColumns = [
    { key: "date", label: $t.transactions.date },
    { key: "label", label: $t.transactions.description },
    { key: "type", label: $t.transactions.type },
    { key: "amount", label: $t.transactions.amount, right: true },
    { key: "note", label: $t.transactions.note, right: true },
  ] satisfies SortColumn[];

  function closeOnEscape(event: KeyboardEvent) {
    if (open && event.key === "Escape") open = false;
  }

  function sortRows(sourceRows: TransactionRowDto[], key: SortKey | null, direction: SortDirection) {
    if (!key) return sourceRows;
    return [...sourceRows].sort((left, right) => compareRows(left, right, key, direction));
  }

  function compareRows(left: TransactionRowDto, right: TransactionRowDto, key: SortKey, direction: SortDirection) {
    const leftValue = sortValue(left, key);
    const rightValue = sortValue(right, key);
    const result =
      typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue));
    return direction === "asc" ? result : -result;
  }

  function sortValue(row: TransactionRowDto, key: SortKey) {
    if (key === "amount") return row.amount;
    if (key === "note") return row.note ?? "";
    if (key === "date") return row.occurredAtUtc ?? row.date;
    return row[key];
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDirection = key === "amount" ? "desc" : "asc";
    }
  }
</script>

<svelte:window on:keydown={closeOnEscape} />

{#if open}
  <div class="modal open">
    <button class="modal-backdrop" type="button" aria-label={$t.common.close} on:click={() => (open = false)}></button>
    <div class="modal-panel" role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-head">
        <div>
          <h2>{account ? $t.transactions.accountTitle(account.label) : $t.transactions.title}</h2>
          <p class="lead">{account ? `${account.institution} / ${translateKnownLabel($t, account.typeLabel)}` : ""}</p>
        </div>
        <button class="modal-close" type="button" aria-label={$t.common.close} on:click={() => (open = false)}>x</button>
      </div>
      <div class="modal-body">
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
            {#each sortedRows as row}
              <tr>
                <td>{formatUtcDate(row.occurredAtUtc ?? row.date, $systemTimezone, $locale)}</td>
                <td>{row.label}</td>
                <td>{translateKnownLabel($t, row.type)}</td>
                <td
                  class="right money"
                  class:amount-positive={row.amount > 0}
                  class:amount-negative={row.amount < 0}
                  class:amount-settled={account?.kind === "credit-card" && row.type.toLowerCase() === "billed"}
                >
                  {formatMoney({ currency: row.currency, value: row.amount }, { signed: true })}
                </td>
                <td class="right">{row.note || "--"}</td>
              </tr>
            {:else}
              <tr><td colspan="5">{$t.transactions.noRows}</td></tr>
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

  .amount-positive {
    color: var(--success);
  }

  .amount-negative {
    color: var(--danger);
  }

  .amount-settled {
    text-decoration: line-through;
    text-decoration-thickness: 2px;
  }
</style>
