<script lang="ts">
  import { Check, Pencil, Plus, Trash2, X } from "@lucide/svelte";
  import { PERSONAL_CATEGORY_CODES } from "../../ledger/canonical/personal-category-codes.ts";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { groupDigits } from "$lib/shared-ledger/preview-account.ts";
  import type { AccountRowDto } from "$lib/shared-ledger/types.ts";
  import { formatAmountLines } from "$lib/shared-money/money.ts";
  import { checkedCommand, sendCommand } from "./manual-asset-form.ts";
  import {
    MANUAL_ASSET_CATEGORIES,
    manualValuationState,
    type ManualTransaction,
    type ManualTransactionKind,
  } from "./manual-assets.ts";
  import ManualMarker from "./ManualMarker.svelte";

  export let open = false;
  export let account: AccountRowDto | null = null;
  /** Every manual row, for transfer counterparts. */
  export let manualAccounts: readonly AccountRowDto[] = [];
  export let today: string;

  type TransactionDraft = {
    id: string | null;
    kind: ManualTransactionKind;
    occurredOn: string;
    amount: string;
    note: string;
    personalCategory: string;
    direction: "out" | "in";
    counterpartAccountId: string;
  };

  let error = "";
  let saving = false;
  let renaming: string | null = null;
  let valuation: { valuedOn: string; amount: string; source: string; note: string } | null = null;
  let draft: TransactionDraft | null = null;
  let ending: string | null = null;
  let confirmingDelete = false;
  let tab: "transactions" | "counts" = "transactions";
  let shownAssetId: string | null = null;

  $: manual = account?.manual ?? null;
  $: rule = manual ? MANUAL_ASSET_CATEGORIES[manual.category] : null;
  $: cash = rule?.recordsTransactions === true;
  $: if (manual && manual.assetId !== shownAssetId) {
    shownAssetId = manual.assetId;
    resetForms();
    tab = "transactions";
  }
  $: state = manual ? manualValuationState({ ...manual, endedOn: null }, today) : null;
  $: counterparts = manualAccounts.filter((row) => row.manual
    && row.manual.assetId !== manual?.assetId
    && MANUAL_ASSET_CATEGORIES[row.manual.category].recordsTransactions
    && row.manual.currency === manual?.currency
    && row.manual.endedOn === null);
  $: names = new Map(manualAccounts.flatMap((row) => row.manual ? [[row.manual.assetId, row.label] as const] : []));
  $: valuations = [...(manual?.valuations ?? [])].reverse();
  $: transactions = [...(manual?.transactions ?? [])].reverse();
  $: showValuations = !cash || tab === "counts";

  function resetForms() {
    error = "";
    renaming = null;
    valuation = null;
    draft = null;
    ending = null;
    confirmingDelete = false;
  }

  function close() {
    open = false;
    shownAssetId = null;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (open && event.key === "Escape") close();
  }

  async function run(input: unknown, after: () => void = () => {}) {
    const checked = checkedCommand(input, today, $t);
    if (!checked.ok) {
      error = checked.message;
      return;
    }
    saving = true;
    const failure = await sendCommand(checked.command, $t);
    saving = false;
    error = failure ?? "";
    if (!failure) after();
  }

  const decimal = (value: string) => value.trim().replaceAll(",", "");
  const money = (amount: string) => `${manual?.currency ?? ""} ${groupDigits(amount)}`;

  function signed(row: ManualTransaction) {
    const inflow = row.kind === "receipt" || (row.kind === "transfer" && row.direction === "in");
    return `${inflow ? "+" : "−"}${money(row.amount)}`;
  }

  function describe(row: ManualTransaction) {
    if (row.kind === "transfer") {
      const other = names.get(row.counterpartAccountId) ?? "—";
      return row.direction === "out" ? $t.manualAssets.transferTo(other) : $t.manualAssets.transferFrom(other);
    }
    if (row.kind === "purchase") {
      const category = row.personalCategory ? $t.spending.personalCategories[row.personalCategory] : $t.manualAssets.unclassified;
      return `${$t.manualAssets.kinds.purchase} · ${category}`;
    }
    return $t.manualAssets.kinds.receipt;
  }

  function startValuation() {
    error = "";
    valuation = { valuedOn: today, amount: "", source: rule?.sources[0] ?? "", note: "" };
  }

  function saveValuation() {
    if (!valuation || !manual) return;
    void run({
      kind: "upsertValuation",
      assetId: manual.assetId,
      valuation: { ...valuation, amount: decimal(valuation.amount) },
    }, () => (valuation = null));
  }

  function editTransaction(row: ManualTransaction) {
    error = "";
    draft = {
      id: row.id,
      kind: row.kind,
      occurredOn: row.occurredOn,
      amount: row.amount,
      note: row.note ?? "",
      personalCategory: row.kind === "purchase" ? row.personalCategory ?? "" : "",
      direction: row.kind === "transfer" ? row.direction : "out",
      counterpartAccountId: row.kind === "transfer" ? row.counterpartAccountId : counterparts[0]?.manual?.assetId ?? "",
    };
  }

  function newTransaction() {
    error = "";
    draft = {
      id: null, kind: "purchase", occurredOn: today, amount: "", note: "", personalCategory: "",
      direction: "out", counterpartAccountId: counterparts[0]?.manual?.assetId ?? "",
    };
  }

  function saveTransaction(current: TransactionDraft) {
    const core = { occurredOn: current.occurredOn, amount: decimal(current.amount), note: current.note };
    const transaction = current.kind === "purchase"
      ? { ...core, kind: "purchase", personalCategory: current.personalCategory || null }
      : current.kind === "receipt"
        ? { ...core, kind: "receipt" }
        : { ...core, kind: "transfer", direction: current.direction, counterpartAccountId: current.counterpartAccountId };
    void run(current.id
      ? { kind: "updateTransaction", transactionId: current.id, transaction }
      : { kind: "addTransaction", accountId: manual!.assetId, transaction }, () => (draft = null));
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#snippet transactionForm()}
  {#if draft}
  <form class="grid-row form-row" onsubmit={(event) => { event.preventDefault(); if (draft) saveTransaction(draft); }} data-manual-transaction-form>
    <input type="date" max={today} bind:value={draft.occurredOn} aria-label={$t.manualAssets.occurredOn} />
    <div class="pair">
      <select bind:value={draft.kind} aria-label={$t.manualAssets.transactionKind} data-field="kind">
        {#each ["purchase", "receipt", "transfer"] as const as kind}
          <option value={kind} disabled={kind === "transfer" && counterparts.length === 0}>{$t.manualAssets.kinds[kind]}</option>
        {/each}
      </select>
      {#if draft.kind === "purchase"}
        <select bind:value={draft.personalCategory} aria-label={$t.manualAssets.personalCategory} data-field="personalCategory">
          <option value="">{$t.manualAssets.unclassified}</option>
          {#each PERSONAL_CATEGORY_CODES as code}<option value={code}>{$t.spending.personalCategories[code]}</option>{/each}
        </select>
      {:else if draft.kind === "transfer"}
        <select bind:value={draft.direction} aria-label={$t.manualAssets.direction}>
          <option value="out">{$t.manualAssets.directions.out}</option>
          <option value="in">{$t.manualAssets.directions.in}</option>
        </select>
        <select bind:value={draft.counterpartAccountId} aria-label={$t.manualAssets.counterpart}>
          {#each counterparts as row (row.id)}<option value={row.manual?.assetId}>{row.label}</option>{/each}
        </select>
      {/if}
    </div>
    <input bind:value={draft.note} maxlength="200" placeholder={$t.manualAssets.optional} aria-label={$t.manualAssets.note} data-field="note" />
    <input bind:value={draft.amount} inputmode="decimal" class="num right" placeholder="0" aria-label={$t.manualAssets.transactionAmount} data-field="amount" />
    <span class="row-actions visible">
      <button class="icon-button" type="submit" disabled={saving} aria-label={$t.manualAssets.save} title={$t.manualAssets.save} data-manual-save-transaction><Check size={15} strokeWidth={2.2} aria-hidden="true" /></button>
      <button class="icon-button" type="button" aria-label={$t.manualAssets.cancel} title={$t.manualAssets.cancel} onclick={() => (draft = null)}><X size={15} strokeWidth={2.2} aria-hidden="true" /></button>
    </span>
    <p class="row-help">{$t.manualAssets.kindHints[draft.kind]}</p>
  </form>
  {/if}
{/snippet}

{#if open && account && manual && rule}
  <div class="modal open">
    <button class="modal-backdrop" type="button" aria-label={$t.common.close} onclick={close}></button>
    <div class="modal-panel manual-panel" role="dialog" aria-modal="true" aria-label={account.label} tabindex="-1" data-manual-asset={manual.category}>
      <header class="manual-head">
        <div class="identity">
          <p class="eyebrow-label"><span class="chip category-chip">{$t.manualAssets.categories[manual.category]}</span><ManualMarker /></p>
          {#if renaming !== null}
            <form class="rename" onsubmit={(event) => { event.preventDefault(); void run({ kind: "renameAsset", assetId: manual.assetId, name: renaming }, () => (renaming = null)); }}>
              <!-- svelte-ignore a11y_autofocus -->
              <input bind:value={renaming} maxlength="200" aria-label={$t.manualAssets.name} autofocus />
              <button class="icon-button" type="submit" disabled={saving} aria-label={$t.manualAssets.save} title={$t.manualAssets.save}><Check size={15} strokeWidth={2.2} aria-hidden="true" /></button>
              <button class="icon-button" type="button" aria-label={$t.manualAssets.cancel} title={$t.manualAssets.cancel} onclick={() => (renaming = null)}><X size={15} strokeWidth={2.2} aria-hidden="true" /></button>
            </form>
          {:else}
            <h2>
              {account.label}
              <button class="icon-button" type="button" aria-label={$t.manualAssets.rename} title={$t.manualAssets.rename} onclick={() => (renaming = account.label)} data-manual-rename>
                <Pencil size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            </h2>
          {/if}
        </div>
        <div class="value">
          <span class="value-label">{cash ? $t.manualAssets.balance : $t.manualAssets.currentValue}</span>
          <strong class="money" data-sensitive data-manual-balance>
            {manual.balance ? formatAmountLines([manual.balance.amount], $locale) : "—"}
          </strong>
          {#if state && state.kind !== "ended"}
            <span class="value-meta" data-manual-state={state.kind}>
              {#if state.kind === "stale" && manual.endedOn === null}<span class="chip stale-chip" title={$t.manualAssets.staleTitle} data-manual-stale>{$t.manualAssets.stale}</span>{/if}
              {state.source === "counted" ? $t.manualAssets.countLine(state.date) : $t.manualAssets.valuationLine(state.date, $t.manualAssets.sources[state.source])}
            </span>
          {/if}
        </div>
        <button class="modal-close" type="button" aria-label={$t.common.close} onclick={close}><X size={16} strokeWidth={2} aria-hidden="true" /></button>
      </header>

      {#if cash}
        <div class="tabs" role="tablist" aria-label={account.label}>
          <button type="button" role="tab" aria-selected={tab === "transactions"} data-manual-tab="transactions" onclick={() => (tab = "transactions")}>{$t.manualAssets.transactionsTab}</button>
          <button type="button" role="tab" aria-selected={tab === "counts"} data-manual-tab="counts" onclick={() => (tab = "counts")}>{$t.manualAssets.countsTab}</button>
        </div>
      {/if}

      <div class="modal-body manual-body">
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        {#if cash}<p class="balance-note" data-manual-balance-note>{$t.manualAssets.balanceNote}</p>{/if}

        {#if cash && tab === "transactions"}
          <div class="panel" role="tabpanel" aria-label={$t.manualAssets.transactionsTab}>
            <div class="section-head">
              <h3>{$t.manualAssets.transactionsTab}</h3>
              {#if !manual.endedOn && draft === null}
                <button class="button secondary compact" type="button" onclick={newTransaction} data-manual-add-transaction><Plus size={14} strokeWidth={2.2} aria-hidden="true" />{$t.manualAssets.addTransaction}</button>
              {/if}
            </div>
            <div class="grid-list" data-manual-transactions>
              <div class="grid-row grid-head" aria-hidden="true">
                <span>{$t.manualAssets.occurredOn}</span><span>{$t.manualAssets.category}</span><span>{$t.manualAssets.note}</span><span class="right">{$t.manualAssets.transactionAmount}</span><span></span>
              </div>
              {#if draft && draft.id === null}{@render transactionForm()}{/if}
              {#each transactions as row (row.id)}
                {#if draft && draft.id === row.id}
                  {@render transactionForm()}
                {:else}
                  <div class="grid-row" data-manual-transaction={row.kind}>
                    <span class="num">{row.occurredOn}</span>
                    <span class="cell">{describe(row)}</span>
                    <span class="cell muted">{row.note ?? ""}</span>
                    <span class="num right money" data-sensitive>{signed(row)}</span>
                    <span class="row-actions">
                      <button class="icon-button" type="button" aria-label={$t.manualAssets.edit} title={$t.manualAssets.edit} onclick={() => editTransaction(row)}><Pencil size={14} strokeWidth={2} aria-hidden="true" /></button>
                      <button class="icon-button danger" type="button" disabled={saving} aria-label={$t.manualAssets.remove} title={$t.manualAssets.remove} onclick={() => void run({ kind: "deleteTransaction", transactionId: row.id })}><Trash2 size={14} strokeWidth={2} aria-hidden="true" /></button>
                    </span>
                  </div>
                {/if}
              {:else}
                {#if !draft}<p class="empty">{$t.manualAssets.noTransactions}</p>{/if}
              {/each}
            </div>
          </div>
        {/if}

        {#if showValuations}
          <div class="panel" role={cash ? "tabpanel" : undefined} aria-label={cash ? $t.manualAssets.countsTab : undefined}>
            <div class="section-head">
              <h3>{cash ? $t.manualAssets.counts : $t.manualAssets.valuations}</h3>
              {#if !manual.endedOn && valuation === null}
                <button class="button secondary compact" type="button" onclick={startValuation} data-manual-add-valuation><Plus size={14} strokeWidth={2.2} aria-hidden="true" />{cash ? $t.manualAssets.addCount : $t.manualAssets.addValuation}</button>
              {/if}
            </div>
            <div class="grid-list" data-manual-valuations>
              <div class="grid-row grid-head" aria-hidden="true">
                <span>{cash ? $t.manualAssets.countedOn : $t.manualAssets.valuedOn}</span><span>{$t.manualAssets.source}</span><span>{$t.manualAssets.note}</span><span class="right">{cash ? $t.manualAssets.countedAmount : $t.manualAssets.amount}</span><span></span>
              </div>
              {#if valuation}
                <form class="grid-row form-row" onsubmit={(event) => { event.preventDefault(); saveValuation(); }} data-manual-valuation-form>
                  <input type="date" max={today} bind:value={valuation.valuedOn} title={$t.manualAssets.sameDateReplaces} aria-label={cash ? $t.manualAssets.countedOn : $t.manualAssets.valuedOn} aria-describedby="manual-same-date" />
                  <select bind:value={valuation.source} disabled={rule.sources.length === 1} aria-label={$t.manualAssets.source}>
                    {#each rule.sources as id}<option value={id}>{$t.manualAssets.sources[id]}</option>{/each}
                  </select>
                  <input bind:value={valuation.note} maxlength="200" placeholder={$t.manualAssets.optional} aria-label={$t.manualAssets.note} />
                  <input bind:value={valuation.amount} inputmode="decimal" class="num right" placeholder="0" aria-label={cash ? $t.manualAssets.countedAmount : $t.manualAssets.amount} data-field="valuation-amount" />
                  <span class="row-actions visible">
                    <button class="icon-button" type="submit" disabled={saving} aria-label={$t.manualAssets.save} title={$t.manualAssets.save} data-manual-save-valuation><Check size={15} strokeWidth={2.2} aria-hidden="true" /></button>
                    <button class="icon-button" type="button" aria-label={$t.manualAssets.cancel} title={$t.manualAssets.cancel} onclick={() => (valuation = null)}><X size={15} strokeWidth={2.2} aria-hidden="true" /></button>
                  </span>
                  <p class="row-help" id="manual-same-date">{$t.manualAssets.sameDateReplaces}</p>
                </form>
              {/if}
              {#each valuations as entry (entry.valuedOn)}
                <div class="grid-row" data-manual-valuation={entry.valuedOn}>
                  <span class="num">{entry.valuedOn}</span>
                  <span class="cell">{$t.manualAssets.sources[entry.source]}</span>
                  <span class="cell muted">{entry.note ?? ""}</span>
                  <span class="num right money" data-sensitive>{money(entry.amount)}</span>
                  <span class="row-actions">
                    {#if manual.valuations.length > 1}
                      <button class="icon-button danger" type="button" disabled={saving} aria-label={$t.manualAssets.remove} title={$t.manualAssets.remove} onclick={() => void run({ kind: "deleteValuation", assetId: manual.assetId, valuedOn: entry.valuedOn })}><Trash2 size={14} strokeWidth={2} aria-hidden="true" /></button>
                    {/if}
                  </span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      <footer class="manual-foot">
        <div class="foot-start">
          {#if manual.endedOn}
            <span class="muted" data-manual-ended={manual.endedOn}>{$t.manualAssets.endedLine(manual.endedOn)}</span>
            <button class="text-button" type="button" disabled={saving} onclick={() => void run({ kind: "endAsset", assetId: manual.assetId, endedOn: null })} data-manual-unend>{$t.manualAssets.reopen}</button>
          {:else if ending !== null}
            <form class="inline" onsubmit={(event) => { event.preventDefault(); void run({ kind: "endAsset", assetId: manual.assetId, endedOn: ending }, () => (ending = null)); }}>
              <input type="date" max={today} bind:value={ending} aria-label={$t.manualAssets.endDate} data-manual-end-date />
              <button class="button secondary compact" type="submit" disabled={saving} data-manual-end>{$t.manualAssets.confirm}</button>
              <button class="text-button" type="button" onclick={() => (ending = null)}>{$t.manualAssets.cancel}</button>
            </form>
          {:else}
            <button class="text-button" type="button" onclick={() => (ending = today)} data-manual-start-end>{$t.manualAssets.endAsset}</button>
          {/if}
        </div>
        <div class="foot-end">
          {#if confirmingDelete}
            <span class="muted confirm-text" id="manual-delete-confirm">{$t.manualAssets.deleteAssetConfirm}</span>
            <button class="text-button" type="button" onclick={() => (confirmingDelete = false)}>{$t.manualAssets.cancel}</button>
            <button class="button danger compact" type="button" disabled={saving} aria-describedby="manual-delete-confirm" data-manual-confirm-delete onclick={() => void run({ kind: "deleteAsset", assetId: manual.assetId }, close)}>{$t.manualAssets.deleteAsset}</button>
          {:else}
            <button class="text-button danger" type="button" onclick={() => (confirmingDelete = true)} data-manual-delete>{$t.manualAssets.deleteAsset}</button>
          {/if}
        </div>
      </footer>
    </div>
  </div>
{/if}

<style>
  .manual-panel {
    width: min(760px, 100%);
  }

  .manual-head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-4);
    padding: var(--space-6) var(--space-6) var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .identity {
    display: grid;
    flex: 1;
    gap: 4px;
    min-width: 0;
  }

  .eyebrow-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
  }

  .category-chip {
    min-height: 22px;
    padding: 0 var(--space-2);
    font-size: 11px;
    letter-spacing: 0.02em;
  }

  h2 {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin: 0;
    font-size: 20px;
    font-weight: 750;
  }

  .rename {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .rename input {
    font-size: 16px;
    font-weight: 650;
  }

  .value {
    display: grid;
    justify-items: end;
    gap: 2px;
    text-align: right;
  }

  .value-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
  }

  .value strong {
    font-size: 20px;
  }

  .value-meta {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--muted);
    font-size: 12px;
  }

  .stale-chip {
    min-height: 20px;
    padding: 0 var(--space-2);
    border-color: color-mix(in oklch, var(--warn) 30%, var(--border));
    background: color-mix(in oklch, var(--warn) 10%, var(--surface));
    color: var(--warn);
    font-size: 11px;
    letter-spacing: 0.02em;
    cursor: help;
  }

  .modal-close {
    display: grid;
    flex: none;
    place-items: center;
  }

  .tabs {
    display: flex;
    gap: 4px;
    padding: 0 var(--space-6);
    border-bottom: 1px solid var(--border);
  }

  .tabs button {
    margin-bottom: -1px;
    padding: 12px 14px 11px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--muted);
    font-size: 14px;
    font-weight: 560;
  }

  .tabs button[aria-selected="true"] {
    border-bottom-color: var(--fg);
    color: var(--fg);
    font-weight: 700;
  }

  .manual-body {
    flex: 1;
    min-height: 0;
    padding: var(--space-4) var(--space-6) var(--space-5);
  }

  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }

  h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
  }

  .grid-list {
    display: grid;
  }

  .grid-row {
    display: grid;
    grid-template-columns: 120px minmax(0, 1.1fr) minmax(0, 1.2fr) 150px 64px;
    align-items: center;
    gap: var(--space-3);
    min-height: 44px;
    padding: 0 var(--space-2);
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }

  .grid-head {
    min-height: 32px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 700;
  }

  .form-row {
    padding-top: var(--space-2);
    padding-bottom: var(--space-2);
    background: var(--surface-soft);
  }

  .balance-note {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }

  .row-help {
    grid-column: 1 / -1;
    margin: 0;
    color: var(--muted);
    font-size: 11px;
  }

  .cell {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .num {
    font-family: var(--font-mono);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .right {
    text-align: right;
    justify-self: end;
  }

  input.right {
    justify-self: stretch;
  }

  .muted {
    color: var(--muted);
  }

  .pair {
    display: flex;
    gap: var(--space-1);
    min-width: 0;
  }

  .pair select {
    flex: 1;
    min-width: 0;
  }

  input,
  select {
    width: 100%;
    min-width: 0;
    min-height: 32px;
    padding: 0 var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--fg);
    font-size: 13px;
  }

  .row-actions {
    display: flex;
    justify-content: flex-end;
    gap: 2px;
    opacity: 0;
  }

  .row-actions.visible,
  .grid-row:hover .row-actions,
  .grid-row:focus-within .row-actions {
    opacity: 1;
  }

  .icon-button {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--muted);
  }

  .icon-button:hover {
    border-color: var(--border);
    background: var(--surface-soft);
    color: var(--fg);
  }

  .icon-button.danger:hover {
    color: var(--danger);
  }

  .empty {
    margin: 0;
    padding: var(--space-4) 0;
    color: var(--muted);
    font-size: 13px;
    text-align: center;
  }

  .error {
    margin: 0 0 var(--space-3);
    color: var(--danger);
    font-size: 13px;
    font-weight: 600;
  }

  .panel + .panel {
    margin-top: var(--space-5);
  }

  .manual-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-6);
    border-top: 1px solid var(--border);
  }

  .foot-start,
  .foot-end,
  .inline {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .inline input {
    width: 150px;
  }

  .confirm-text {
    max-width: 300px;
    font-size: 12px;
  }

  .text-button {
    padding: 0 var(--space-1);
    border: 0;
    background: none;
    color: var(--accent);
    font-size: 13px;
    font-weight: 650;
  }

  .text-button.danger {
    color: var(--danger);
  }

  .button.compact {
    min-height: 30px;
    padding: 0 var(--space-3);
  }

  @media (max-width: 640px) {
    .grid-row {
      grid-template-columns: 96px minmax(0, 1fr) 110px 56px;
    }

    .grid-row > :nth-child(3) {
      display: none;
    }

    .manual-foot {
      flex-wrap: wrap;
    }
  }
</style>
