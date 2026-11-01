<script lang="ts">
  import { X } from "@lucide/svelte";
  import { t } from "$lib/i18n/i18n.ts";
  import { checkedCommand, sendCommand } from "./manual-asset-form.ts";
  import { MANUAL_ASSET_CATEGORIES, MANUAL_ASSET_CATEGORY_IDS, type ManualAssetCategory } from "./manual-assets.ts";

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
      currency: currency.trim().toUpperCase(),
      firstValuation: { valuedOn, amount: amount.trim().replaceAll(",", ""), source, note },
    }, $t);
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
    <div class="modal-panel manual-form-panel" role="dialog" aria-modal="true" aria-labelledby="manual-create-title" tabindex="-1" data-manual-create>
      <div class="modal-head">
        <h2 id="manual-create-title">{$t.manualAssets.createTitle}</h2>
        <button class="modal-close" type="button" aria-label={$t.common.close} onclick={close}><X size={16} strokeWidth={2} aria-hidden="true" /></button>
      </div>
      <form class="modal-body manual-form" onsubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>
          <span>{$t.manualAssets.category}</span>
          <select bind:value={category} data-field="category">
            {#each MANUAL_ASSET_CATEGORY_IDS as id}
              <option value={id}>{$t.manualAssets.categories[id]}</option>
            {/each}
          </select>
        </label>
        <p class="hint" class:caution={category === "other"} data-category-hint={category}>{$t.manualAssets.categoryHints[category]}</p>
        <label>
          <span>{$t.manualAssets.name}</span>
          <input bind:value={name} maxlength="200" data-field="name" />
        </label>
        <div class="row">
          <label>
            <span>{counting ? $t.manualAssets.countedAmount : $t.manualAssets.amount}</span>
            <input bind:value={amount} inputmode="decimal" class="num" data-field="amount" />
          </label>
          <label class="narrow">
            <span>{$t.manualAssets.currency}</span>
            <input bind:value={currency} maxlength="3" class="num" data-field="currency" />
          </label>
        </div>
        <div class="row">
          <label>
            <span>{counting ? $t.manualAssets.countedOn : $t.manualAssets.valuedOn}</span>
            <input type="date" bind:value={valuedOn} data-field="valuedOn" />
          </label>
          <label>
            <span>{$t.manualAssets.source}</span>
            <select bind:value={source} disabled={sources.length === 1} data-field="source">
              {#each sources as id}
                <option value={id}>{$t.manualAssets.sources[id]}</option>
              {/each}
            </select>
          </label>
        </div>
        <label>
          <span>{$t.manualAssets.note} <small>{$t.manualAssets.optional}</small></span>
          <input bind:value={note} maxlength="200" data-field="note" />
        </label>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <div class="actions">
          <button class="button secondary" type="button" onclick={close}>{$t.manualAssets.cancel}</button>
          <button class="button primary" type="submit" disabled={saving} data-manual-save>{$t.manualAssets.save}</button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .manual-form-panel {
    width: min(520px, 100%);
  }

  .manual-form {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-5);
  }

  label {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  label > span {
    color: var(--muted);
    font-size: 12px;
    font-weight: 650;
  }

  input,
  select {
    min-height: 36px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--space-3);
  }

  .row .narrow {
    max-width: 120px;
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }

  .hint.caution,
  .error {
    color: var(--warn);
    font-weight: 600;
  }

  .error {
    margin: 0;
    font-size: 13px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }
</style>
