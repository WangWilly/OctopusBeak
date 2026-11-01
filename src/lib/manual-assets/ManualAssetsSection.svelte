<script lang="ts">
  import { Plus } from "@lucide/svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import type { AccountRowDto } from "$lib/shared-ledger/types.ts";
  import { formatAmountLines } from "$lib/shared-money/money.ts";
  import { sendCommand } from "./manual-asset-form.ts";
  import { manualValuationStale, monthsBetween } from "./manual-assets.ts";
  import ManualAssetCreateModal from "./ManualAssetCreateModal.svelte";
  import ManualAssetModal from "./ManualAssetModal.svelte";
  import ManualMarker from "./ManualMarker.svelte";

  /** The page's manual rows; every other row is ignored. */
  export let accounts: readonly AccountRowDto[] = [];
  export let today: string;

  let creating = false;
  let detailOpen = false;
  let selectedId: string | null = null;
  let confirmingDeleteAll = false;
  let deleteAllError = "";

  $: manualRows = accounts.filter((account) => account.manual);
  $: selected = manualRows.find((account) => account.id === selectedId) ?? null;
  $: if (detailOpen && selectedId !== null && !selected) detailOpen = false;

  function status(account: AccountRowDto) {
    const manual = account.manual!;
    if (manual.endedOn) return { kind: "ended" as const, text: $t.manualAssets.ended };
    const latest = manual.valuations.at(-1);
    if (!latest) return null;
    if (manual.category === "cash") return { kind: "fresh" as const, text: $t.manualAssets.countedDate(latest.valuedOn) };
    const text = $t.manualAssets.valuedMonthsAgo(monthsBetween(latest.valuedOn, today));
    return manualValuationStale(manual.category, latest.valuedOn, today)
      ? { kind: "stale" as const, text }
      : { kind: "fresh" as const, text };
  }

  function openAsset(account: AccountRowDto) {
    selectedId = account.id;
    detailOpen = true;
  }

  async function deleteAll() {
    const failure = await sendCommand({ kind: "deleteAllManualAssets" }, $t);
    deleteAllError = failure ?? "";
    if (!failure) confirmingDeleteAll = false;
  }
</script>

<section class="card manual-assets" aria-labelledby="manual-assets-title" data-manual-assets>
  <div class="panel-title">
    <h2 id="manual-assets-title">{$t.manualAssets.title}</h2>
    <button class="button secondary add" type="button" onclick={() => (creating = true)} data-manual-add>
      <Plus size={14} strokeWidth={2.2} aria-hidden="true" />{$t.manualAssets.add}
    </button>
  </div>
  {#if manualRows.length === 0}
    <p class="empty" data-manual-empty>{$t.manualAssets.empty}</p>
  {:else}
    <ul class="rows">
      {#each manualRows as account (account.id)}
        {@const state = status(account)}
        <li>
          <button class="row" type="button" onclick={() => openAsset(account)} data-manual-row={account.manual?.category} class:ended={account.manual?.endedOn}>
            <span class="name">
              <strong>{account.label}</strong>
              <small>{$t.manualAssets.categories[account.manual!.category]}</small>
            </span>
            {#if state}
              <span class="state" data-manual-state={state.kind}>
                {#if state.kind === "stale"}<span class="chip stale">{$t.manualAssets.stale}</span>{/if}
                {state.text}
              </span>
            {/if}
            <span class="value money" data-sensitive>
              {account.amountLines.length > 0 ? formatAmountLines(account.amountLines, $locale) : "—"}
            </span>
          </button>
        </li>
      {/each}
    </ul>
    <div class="footer">
      <ManualMarker />
      {#if confirmingDeleteAll}
        <div class="confirm" role="alertdialog" aria-describedby="manual-delete-all-confirm">
          <p id="manual-delete-all-confirm">{$t.manualAssets.deleteAllConfirm}</p>
          <button class="button secondary" type="button" onclick={() => (confirmingDeleteAll = false)}>{$t.manualAssets.cancel}</button>
          <button class="button danger" type="button" onclick={() => void deleteAll()} data-manual-confirm-delete-all>{$t.manualAssets.deleteAll}</button>
        </div>
      {:else}
        <button class="link danger" type="button" onclick={() => (confirmingDeleteAll = true)} data-manual-delete-all>{$t.manualAssets.deleteAll}</button>
      {/if}
    </div>
    {#if deleteAllError}<p class="error" role="alert">{deleteAllError}</p>{/if}
  {/if}
</section>

<ManualAssetCreateModal bind:open={creating} {today} />
<ManualAssetModal bind:open={detailOpen} account={selected} manualAccounts={manualRows} {today} />

<style>
  .add {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }

  .empty {
    margin: 0;
    padding: var(--space-4) var(--space-5) var(--space-5);
    color: var(--muted);
    font-size: 13px;
  }

  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .rows li + li {
    border-top: 1px solid var(--border);
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(120px, auto);
    align-items: center;
    gap: var(--space-4);
    width: 100%;
    padding: var(--space-3) var(--space-5);
    border: 0;
    background: none;
    color: var(--fg);
    text-align: left;
  }

  .row:hover {
    background: var(--surface-soft);
  }

  .row.ended {
    color: var(--muted);
  }

  .name {
    display: grid;
    min-width: 0;
  }

  .name strong {
    overflow: hidden;
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name small,
  .state {
    color: var(--muted);
    font-size: 12px;
  }

  .state {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .stale {
    min-height: 22px;
    color: var(--warn);
    font-size: 11px;
    background: color-mix(in oklch, var(--warn) 10%, var(--surface));
  }

  .value {
    font-weight: 650;
    text-align: right;
  }

  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
  }

  .confirm {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .confirm p {
    margin: 0;
    font-size: 13px;
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    font-size: 12px;
    font-weight: 650;
  }

  .link.danger,
  .error {
    color: var(--warn);
  }

  .error {
    margin: 0;
    padding: 0 var(--space-5) var(--space-3);
    font-size: 13px;
  }

  @media (max-width: 640px) {
    .row {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .state {
      grid-column: 1 / -1;
      grid-row: 2;
    }
  }
</style>
