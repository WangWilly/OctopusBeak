<script lang="ts">
  import { X } from "@lucide/svelte";
  import { t } from "$lib/i18n/i18n.ts";
  import { checkedCommand, sendCommand } from "./manual-asset-form.ts";
  import {
    MANUAL_ASSET_CATEGORIES,
    MANUAL_ASSET_CATEGORY_IDS,
    MANUAL_ASSET_CURRENCIES,
    type ManualAssetCategory,
  } from "./manual-assets.ts";

  export let open = false;
  export let today: string;

  let category: ManualAssetCategory = "cash";
  let name = "";
  let currency = "TWD";
  let amount = "";
  let valuedOn = today;
  let source: string = MANUAL_ASSET_CATEGORIES.cash.sources[0]!;
  let note = "";
  let error = "";
  let saving = false;

  $: sources = MANUAL_ASSET_CATEGORIES[category].sources;
  $: if (!sources.includes(source as never)) source = sources[0]!;
  $: counting = category === "cash";

  function reset() {
    category = "cash";
    name = "";
    currency = "TWD";
    amount = "";
    valuedOn = today;
    note = "";
    error = "";
  }

  function close() {
    open = false;
    reset();
  }

  async function save() {
    const checked = checkedCommand({
      kind: "createAsset",
      category,
      name,
      currency,
      firstValuation: { valuedOn, amount: amount.trim().replaceAll(",", ""), source, note },
    }, today, $t);
    if (!checked.ok) {
      error = checked.message;
      return;
    }
    saving = true;
    const failure = await sendCommand(checked.command, $t);
    saving = false;
    if (failure) error = failure;
    else close();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (open && event.key === "Escape") close();
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open}
  <div class="modal open">
    <button class="modal-backdrop" type="button" aria-label={$t.common.close} onclick={close}></button>
    <div class="modal-panel create-panel" role="dialog" aria-modal="true" aria-labelledby="manual-create-title" tabindex="-1" data-manual-create>
      <header class="create-head">
        <h2 id="manual-create-title">{$t.manualAssets.createTitle}</h2>
        <button class="modal-close" type="button" aria-label={$t.common.close} onclick={close}><X size={16} strokeWidth={2} aria-hidden="true" /></button>
      </header>
      <form class="create-form" onsubmit={(event) => { event.preventDefault(); void save(); }}>
        <div class="modal-body fields">
          <label class="wide">
            <span>{$t.manualAssets.category}</span>
            <select bind:value={category} data-field="category">
              {#each MANUAL_ASSET_CATEGORY_IDS as id}
                <option value={id}>{$t.manualAssets.categories[id]}</option>
              {/each}
            </select>
          </label>
          <label class="wide">
            <span>{$t.manualAssets.name}</span>
            <input bind:value={name} maxlength="200" data-field="name" />
          </label>
          <label>
            <span>{$t.manualAssets.currency}</span>
            <select bind:value={currency} data-field="currency">
              {#each MANUAL_ASSET_CURRENCIES as code}<option value={code}>{code}</option>{/each}
            </select>
          </label>
          <label>
            <span>{counting ? $t.manualAssets.countedAmount : $t.manualAssets.amount}</span>
            <input bind:value={amount} inputmode="decimal" class="num" placeholder="0" data-field="amount" />
          </label>
          <label>
            <span>{counting ? $t.manualAssets.countedOn : $t.manualAssets.valuedOn}</span>
            <input type="date" max={today} bind:value={valuedOn} data-field="valuedOn" />
          </label>
          <label>
            <span>{$t.manualAssets.source}</span>
            <select bind:value={source} disabled={sources.length === 1} data-field="source" aria-describedby="manual-category-hint">
              {#each sources as id}
                <option value={id}>{$t.manualAssets.sources[id]}</option>
              {/each}
            </select>
            <small class="hint" class:caution={category === "other"} id="manual-category-hint" data-category-hint={category}>{$t.manualAssets.categoryHints[category]}</small>
          </label>
          <label class="wide">
            <span>{$t.manualAssets.note} <small>{$t.manualAssets.optional}</small></span>
            <input bind:value={note} maxlength="200" data-field="note" />
          </label>
          {#if error}<p class="wide error" role="alert">{error}</p>{/if}
        </div>
        <footer class="create-foot">
          <button class="button" type="button" onclick={close}>{$t.manualAssets.cancel}</button>
          <button class="button primary" type="submit" disabled={saving} data-manual-save>{$t.manualAssets.save}</button>
        </footer>
      </form>
    </div>
  </div>
{/if}

<style>
  .create-panel {
    width: min(520px, 100%);
  }

  .create-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-5) var(--space-6);
    border-bottom: 1px solid var(--border);
  }

  h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 750;
  }

  .modal-close {
    display: grid;
    flex: none;
    place-items: center;
  }

  .create-form {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .fields {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--space-4) var(--space-3);
    padding: var(--space-5) var(--space-6);
  }

  .wide {
    grid-column: 1 / -1;
  }

  label {
    display: grid;
    gap: 6px;
    min-width: 0;
  }

  label > span {
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
  }

  label small {
    font-weight: 500;
  }

  input,
  select {
    width: 100%;
    min-width: 0;
    min-height: 40px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
    font-size: 14px;
  }

  .num {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .fields {
    align-items: start;
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }

  .hint.caution {
    color: var(--warn);
    font-weight: 600;
  }

  .error {
    margin: 0;
    color: var(--danger);
    font-size: 13px;
    font-weight: 600;
  }

  .create-foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-6);
    border-top: 1px solid var(--border);
  }
</style>
