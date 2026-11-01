<script lang="ts">
  import { X } from "@lucide/svelte";
  import { PERSONAL_CATEGORY_CODES } from "../../ledger/canonical/personal-category-codes.ts";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { groupDigits } from "$lib/shared-ledger/preview-account.ts";
  import type { AccountRowDto } from "$lib/shared-ledger/types.ts";
  import { formatAmountLines } from "$lib/shared-money/money.ts";
  import { checkedCommand, sendCommand } from "./manual-asset-form.ts";
  import {
    MANUAL_ASSET_CATEGORIES,
    manualValuationStale,
    monthsBetween,
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
  let valuation = { valuedOn: today, amount: "", source: "", note: "" };
  let endDate = today;
  let confirmingDelete = false;
  let draft: TransactionDraft | null = null;
  let shownAssetId: string | null = null;

  $: manual = account?.manual ?? null;
  $: rule = manual ? MANUAL_ASSET_CATEGORIES[manual.category] : null;
  $: cash = rule?.recordsTransactions === true;
  $: if (manual && manual.assetId !== shownAssetId) {
    shownAssetId = manual.assetId;
    resetForms();
  }
  $: latest = manual?.valuations.at(-1) ?? null;
  $: stale = manual && latest ? manualValuationStale(manual.category, latest.valuedOn, today) : false;
  $: counterparts = manualAccounts.filter((row) => row.manual
    && row.manual.assetId !== manual?.assetId
    && MANUAL_ASSET_CATEGORIES[row.manual.category].recordsTransactions
    && row.manual.currency === manual?.currency
    && row.manual.endedOn === null);
  $: names = new Map(manualAccounts.flatMap((row) => row.manual ? [[row.manual.assetId, row.label] as const] : []));
  $: newestFirst = [...(manual?.valuations ?? [])].reverse();
  $: transactionsNewestFirst = [...(manual?.transactions ?? [])].reverse();

  function resetForms() {
    error = "";
    renaming = null;
    valuation = { valuedOn: today, amount: "", source: rule?.sources[0] ?? "", note: "" };
    endDate = today;
    confirmingDelete = false;
    draft = null;
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

  function money(amount: string) {
    return `${manual?.currency ?? ""} ${groupDigits(amount)}`;
  }

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

  function editTransaction(row: ManualTransaction) {
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
    draft = {
      id: null, kind: "purchase", occurredOn: today, amount: "", note: "", personalCategory: "",
      direction: "out", counterpartAccountId: counterparts[0]?.manual?.assetId ?? "",
    };
  }

  function draftInput(current: TransactionDraft) {
    const core = { occurredOn: current.occurredOn, amount: decimal(current.amount), note: current.note };
    if (current.kind === "purchase") return { ...core, kind: "purchase", personalCategory: current.personalCategory || null };
    if (current.kind === "receipt") return { ...core, kind: "receipt" };
    return { ...core, kind: "transfer", direction: current.direction, counterpartAccountId: current.counterpartAccountId };
  }

  function saveTransaction(current: TransactionDraft) {
    const transaction = draftInput(current);
    void run(current.id
      ? { kind: "updateTransaction", transactionId: current.id, transaction }
      : { kind: "addTransaction", accountId: manual!.assetId, transaction }, () => (draft = null));
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open && account && manual && rule}
  <div class="modal open">
    <button class="modal-backdrop" type="button" aria-label={$t.common.close} onclick={close}></button>
    <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="manual-asset-title" tabindex="-1" data-manual-asset={manual.category}>
      <div class="modal-head">
        <div class="identity">
          <p class="eyebrow-label">{$t.manualAssets.categories[manual.category]} <ManualMarker /></p>
          {#if renaming !== null}
            <form class="inline" onsubmit={(event) => { event.preventDefault(); void run({ kind: "renameAsset", assetId: manual.assetId, name: renaming }, () => (renaming = null)); }}>
              <input bind:value={renaming} maxlength="200" aria-label={$t.manualAssets.name} />
              <button class="button primary" type="submit" disabled={saving}>{$t.manualAssets.save}</button>
              <button class="button secondary" type="button" onclick={() => (renaming = null)}>{$t.manualAssets.cancel}</button>
            </form>
          {:else}
            <h2 id="manual-asset-title">{account.label}</h2>
            <button class="link" type="button" onclick={() => (renaming = account.label)}>{$t.manualAssets.rename}</button>
          {/if}
        </div>
        <div class="balance">
          <span>{cash ? $t.manualAssets.balance : $t.manualAssets.currentValue}</span>
          {#if manual.balance}
            <strong class="money" data-sensitive data-manual-balance>{formatAmountLines([manual.balance.amount], $locale)}</strong>
            <small>{$t.manualAssets.balanceAsOf(manual.balance.asOf)}</small>
          {/if}
        </div>
        <button class="modal-close" type="button" aria-label={$t.common.close} onclick={close}><X size={16} strokeWidth={2} aria-hidden="true" /></button>
      </div>
      <div class="modal-body">
        {#if manual.endedOn}
          <p class="note" role="note" data-manual-ended={manual.endedOn}>{$t.manualAssets.endedOn(manual.endedOn)}</p>
        {:else if stale && latest}
          <p class="note caution" role="note" data-manual-stale>
            {$t.manualAssets.valuedMonthsAgo(monthsBetween(latest.valuedOn, today))} · {$t.manualAssets.staleHint}
          </p>
        {/if}
        {#if error}<p class="error" role="alert">{error}</p>{/if}

        {#if cash}
          <p class="note">{$t.manualAssets.balanceNote}</p>
          <div class="section-head">
            <h3>{$t.manualAssets.transactions}</h3>
            {#if !manual.endedOn && draft === null}
              <button class="button secondary" type="button" onclick={newTransaction} data-manual-add-transaction>{$t.manualAssets.addTransaction}</button>
            {/if}
          </div>
          {#if draft}
            <form class="grid-form" onsubmit={(event) => { event.preventDefault(); if (draft) saveTransaction(draft); }} data-manual-transaction-form>
              <label><span>{$t.manualAssets.occurredOn}</span><input type="date" max={today} bind:value={draft.occurredOn} /></label>
              <label>
                <span>{$t.manualAssets.kinds.purchase} / {$t.manualAssets.kinds.receipt} / {$t.manualAssets.kinds.transfer}</span>
                <select bind:value={draft.kind} data-field="kind">
                  {#each ["purchase", "receipt", "transfer"] as const as kind}
                    <option value={kind} disabled={kind === "transfer" && counterparts.length === 0}>{$t.manualAssets.kinds[kind]}</option>
                  {/each}
                </select>
              </label>
              <label><span>{$t.manualAssets.transactionAmount} ({manual.currency})</span><input bind:value={draft.amount} inputmode="decimal" class="num" data-field="amount" /></label>
              {#if draft.kind === "purchase"}
                <label>
                  <span>{$t.manualAssets.personalCategory}</span>
                  <select bind:value={draft.personalCategory} data-field="personalCategory">
                    <option value="">{$t.manualAssets.unclassified}</option>
                    {#each PERSONAL_CATEGORY_CODES as code}
                      <option value={code}>{$t.spending.personalCategories[code]}</option>
                    {/each}
                  </select>
                </label>
              {:else if draft.kind === "transfer"}
                <label>
                  <span>{$t.manualAssets.direction}</span>
                  <select bind:value={draft.direction}>
                    <option value="out">{$t.manualAssets.directions.out}</option>
                    <option value="in">{$t.manualAssets.directions.in}</option>
                  </select>
                </label>
                <label>
                  <span>{$t.manualAssets.counterpart}</span>
                  <select bind:value={draft.counterpartAccountId}>
                    {#each counterparts as row (row.id)}
                      <option value={row.manual?.assetId}>{row.label}</option>
                    {/each}
                  </select>
                </label>
              {/if}
              <label class="wide"><span>{$t.manualAssets.note} <small>{$t.manualAssets.optional}</small></span><input bind:value={draft.note} maxlength="200" /></label>
              <p class="hint wide">{$t.manualAssets.kindHints[draft.kind]}</p>
              <div class="actions wide">
                <button class="button secondary" type="button" onclick={() => (draft = null)}>{$t.manualAssets.cancel}</button>
                <button class="button primary" type="submit" disabled={saving} data-manual-save-transaction>{$t.manualAssets.save}</button>
              </div>
            </form>
          {/if}
          <table class="table" data-manual-transactions>
            <thead><tr><th>{$t.manualAssets.occurredOn}</th><th>{$t.manualAssets.category}</th><th>{$t.manualAssets.note}</th><th class="right">{$t.manualAssets.transactionAmount}</th><th></th></tr></thead>
            <tbody>
              {#each transactionsNewestFirst as row (row.id)}
                <tr data-manual-transaction={row.kind}>
                  <td class="num date">{row.occurredOn}</td>
                  <td>{describe(row)}</td>
                  <td>{row.note ?? ""}</td>
                  <td class="right money" data-sensitive>{signed(row)}</td>
                  <td class="right row-actions">
                    <button class="link" type="button" onclick={() => editTransaction(row)}>{$t.manualAssets.edit}</button>
                    <button class="link danger" type="button" disabled={saving} onclick={() => void run({ kind: "deleteTransaction", transactionId: row.id })}>{$t.manualAssets.remove}</button>
                  </td>
                </tr>
              {:else}
                <tr><td class="empty" colspan="5">{$t.manualAssets.noTransactions}</td></tr>
              {/each}
            </tbody>
          </table>
        {/if}

        <div class="section-head">
          <h3>{cash ? $t.manualAssets.counts : $t.manualAssets.valuations}</h3>
        </div>
        {#if !manual.endedOn}
          <form class="grid-form" onsubmit={(event) => { event.preventDefault(); void run({ kind: "upsertValuation", assetId: manual.assetId, valuation: { ...valuation, amount: decimal(valuation.amount) } }, () => (valuation = { ...valuation, amount: "", note: "" })); }} data-manual-valuation-form>
            <label><span>{cash ? $t.manualAssets.countedOn : $t.manualAssets.valuedOn}</span><input type="date" max={today} bind:value={valuation.valuedOn} /></label>
            <label><span>{cash ? $t.manualAssets.countedAmount : $t.manualAssets.amount} ({manual.currency})</span><input bind:value={valuation.amount} inputmode="decimal" class="num" data-field="valuation-amount" /></label>
            <label>
              <span>{$t.manualAssets.source}</span>
              <select bind:value={valuation.source} disabled={rule.sources.length === 1}>
                {#each rule.sources as id}<option value={id}>{$t.manualAssets.sources[id]}</option>{/each}
              </select>
            </label>
            <label><span>{$t.manualAssets.note} <small>{$t.manualAssets.optional}</small></span><input bind:value={valuation.note} maxlength="200" /></label>
            <p class="hint wide">{$t.manualAssets.sameDateReplaces}</p>
            <div class="actions wide">
              <button class="button primary" type="submit" disabled={saving} data-manual-save-valuation>{cash ? $t.manualAssets.addCount : $t.manualAssets.addValuation}</button>
            </div>
          </form>
        {/if}
        <table class="table" data-manual-valuations>
          <thead><tr><th>{cash ? $t.manualAssets.countedOn : $t.manualAssets.valuedOn}</th><th>{$t.manualAssets.source}</th><th>{$t.manualAssets.note}</th><th class="right">{$t.manualAssets.amount}</th><th></th></tr></thead>
          <tbody>
            {#each newestFirst as entry (entry.valuedOn)}
              <tr data-manual-valuation={entry.valuedOn}>
                <td class="num date">{entry.valuedOn}</td>
                <td>{$t.manualAssets.sources[entry.source]}</td>
                <td>{entry.note ?? ""}</td>
                <td class="right money" data-sensitive>{money(entry.amount)}</td>
                <td class="right">
                  {#if manual.valuations.length > 1}
                    <button class="link danger" type="button" disabled={saving} onclick={() => void run({ kind: "deleteValuation", assetId: manual.assetId, valuedOn: entry.valuedOn })}>{$t.manualAssets.remove}</button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>

        <div class="lifecycle">
          {#if manual.endedOn}
            <button class="button secondary" type="button" disabled={saving} onclick={() => void run({ kind: "endAsset", assetId: manual.assetId, endedOn: null })}>{$t.manualAssets.reopen}</button>
          {:else}
            <form class="inline" onsubmit={(event) => { event.preventDefault(); void run({ kind: "endAsset", assetId: manual.assetId, endedOn: endDate }); }}>
              <label><span>{$t.manualAssets.endDate}</span><input type="date" max={today} bind:value={endDate} /></label>
              <button class="button secondary" type="submit" disabled={saving} data-manual-end>{$t.manualAssets.endAsset}</button>
            </form>
          {/if}
          {#if confirmingDelete}
            <div class="confirm" role="alertdialog" aria-describedby="manual-delete-confirm">
              <p id="manual-delete-confirm">{$t.manualAssets.deleteAssetConfirm}</p>
              <button class="button secondary" type="button" onclick={() => (confirmingDelete = false)}>{$t.manualAssets.cancel}</button>
              <button class="button danger" type="button" disabled={saving} data-manual-confirm-delete onclick={() => void run({ kind: "deleteAsset", assetId: manual.assetId }, close)}>{$t.manualAssets.deleteAsset}</button>
            </div>
          {:else}
            <button class="button danger" type="button" onclick={() => (confirmingDelete = true)} data-manual-delete>{$t.manualAssets.deleteAsset}</button>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .identity {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .eyebrow-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    font-weight: 650;
  }

  .balance {
    display: grid;
    justify-items: end;
    gap: 2px;
    margin-left: auto;
  }

  .balance span,
  .balance small {
    color: var(--muted);
    font-size: 12px;
  }

  .balance strong {
    font-size: 20px;
  }

  .note {
    margin: var(--space-4) var(--space-5) 0;
    color: var(--muted);
    font-size: 13px;
  }

  .note.caution,
  .error {
    color: var(--warn);
    font-weight: 600;
  }

  .error {
    margin: var(--space-3) var(--space-5) 0;
    font-size: 13px;
  }

  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin: var(--space-5) var(--space-5) var(--space-2);
  }

  h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
  }

  .grid-form {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: var(--space-3);
    margin: 0 var(--space-5) var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-soft);
  }

  .grid-form .wide {
    grid-column: 1 / -1;
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
    min-height: 34px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .inline {
    display: flex;
    align-items: end;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .table {
    margin: 0 var(--space-5);
    width: calc(100% - 2 * var(--space-5));
  }

  .date {
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }

  .row-actions {
    white-space: nowrap;
  }

  .empty {
    color: var(--muted);
    text-align: center;
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font-size: 12px;
    font-weight: 650;
    justify-self: start;
  }

  .link.danger {
    margin-left: var(--space-2);
    color: var(--warn);
  }

  .lifecycle {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin: var(--space-5);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }

  .confirm {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    max-width: 520px;
  }

  .confirm p {
    margin: 0;
    font-size: 13px;
  }
</style>
