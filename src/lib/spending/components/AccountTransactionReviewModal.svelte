<script lang="ts">
  import { onMount } from "svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import { bankFullName } from "$lib/shared-ledger/bank-name.ts";
  import { SPENDING_CATEGORY_IDS, type SpendingCategory } from "$lib/spending/categories.ts";
  import type { SpendingAccountRecord, SpendingState } from "$lib/spending/model.ts";

  export let record: SpendingAccountRecord;
  export let saving = false;
  export let error = false;
  export let onClose: () => void | Promise<void> = () => {};
  export let onSave: (
    record: SpendingAccountRecord,
    state: SpendingState | null,
    category: SpendingCategory | null,
  ) => Promise<boolean> = async () => false;

  let closeButton: HTMLButtonElement | null = null;
  let selectedCategory = record.category;
  let selectedState: SpendingState = record.state === "pending" ? "included" : record.state;

  onMount(() => closeButton?.focus());

  $: dateFormatter = new Intl.DateTimeFormat($locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  function closeOnEscape(event: KeyboardEvent) {
    if (event.key === "Escape" && !saving) void onClose();
  }

  function containFocus(event: KeyboardEvent) {
    if (event.key !== "Tab") return;
    const focusable = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function formatDate(date: string) {
    return dateFormatter.format(new Date(`${date}T00:00:00Z`));
  }

  function formatAmount() {
    return formatMoney({ currency: record.currency, value: record.amount }, { locale: $locale });
  }

  function destination() {
    return record.destinationBankCode && record.destinationAccountNumber
      ? `${record.destinationBankCode} · ${record.destinationAccountNumber}`
      : $t.spending.notAvailable;
  }

  async function confirm() {
    if (await onSave(record, selectedState, selectedCategory)) await onClose();
  }

  async function restoreAutomatic() {
    if (await onSave(record, null, null)) await onClose();
  }
</script>

<svelte:window onkeydown={closeOnEscape} />

<div class="modal open" data-account-review-modal>
  <button
    class="modal-backdrop"
    type="button"
    aria-label={$t.spending.closeTransactionReview}
    disabled={saving}
    onclick={() => void onClose()}
  ></button>
  <div
    class="modal-panel transaction-review-panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="transaction-review-title"
    tabindex="-1"
    onkeydown={containFocus}
  >
    <div class="modal-head transaction-review-head">
      <div class="transaction-title">
        <p class="eyebrow">{$t.spending.accountSource}</p>
        <h2 id="transaction-review-title">{$t.spending.transactionReviewTitle}</h2>
        <strong>{record.label}</strong>
      </div>
      <div class="transaction-heading-amount">
        <strong class="money" data-sensitive>{formatAmount()}</strong>
        <span class="status-chip {record.state}">{$t.spending.states[record.state]}</span>
      </div>
      <button
        bind:this={closeButton}
        class="modal-close"
        type="button"
        aria-label={$t.spending.closeTransactionReview}
        disabled={saving}
        onclick={() => void onClose()}
      >&times;</button>
    </div>

    <div class="modal-body transaction-review-body">
      <dl class="transaction-details">
        <div>
          <dt>{$t.spending.bankName}</dt>
          <dd>{bankFullName(record.bank)}</dd>
        </div>
        <div>
          <dt>{$t.spending.outgoingAccount}</dt>
          <dd>{record.accountNumber || $t.spending.notAvailable}</dd>
        </div>
        <div>
          <dt>{$t.spending.inferredDestination}</dt>
          <dd>{destination()}</dd>
          {#if record.destinationAccountNumber}
            <small>{$t.spending.inferredDestinationHint}</small>
          {/if}
        </div>
        <div>
          <dt>{$t.spending.transferDate}</dt>
          <dd>{formatDate(record.date)}</dd>
        </div>
        <div>
          <dt>{$t.spending.transactionTime}</dt>
          <dd>{record.time || $t.spending.notAvailable}</dd>
        </div>
        <div>
          <dt>{$t.spending.currency}</dt>
          <dd>{record.currency}</dd>
        </div>
        <div>
          <dt>{$t.spending.transactionAmount}</dt>
          <dd class="money" data-sensitive>{formatAmount()}</dd>
        </div>
        <div class="transaction-note">
          <dt>{$t.spending.transactionNote}</dt>
          <dd>{record.note || $t.spending.notAvailable}</dd>
        </div>
      </dl>

      <label class="category-control">
        <span>{$t.spending.category}</span>
        <select bind:value={selectedCategory} disabled={saving}>
          {#each SPENDING_CATEGORY_IDS as category}
            <option value={category}>{$t.spending.categories[category]}</option>
          {/each}
        </select>
      </label>

      <fieldset class="decision-control" disabled={saving}>
        <legend>{$t.spending.spendingDecision}</legend>
        <label class:checked={selectedState === "included"}>
          <input type="radio" name="spending-decision" value="included" bind:group={selectedState} />
          <span>{$t.spending.includeDecision}</span>
        </label>
        <label class:checked={selectedState === "excluded"}>
          <input type="radio" name="spending-decision" value="excluded" bind:group={selectedState} />
          <span>{$t.spending.excludeDecision}</span>
        </label>
      </fieldset>

      {#if error}
        <p class="transaction-error" role="alert">{$t.spending.overrideError}</p>
      {/if}
    </div>

    <footer class="transaction-review-footer">
      {#if record.manual}
        <button class="button secondary" type="button" disabled={saving} onclick={() => void restoreAutomatic()}>
          {$t.spending.restoreAutomatic}
        </button>
      {/if}
      <span class="footer-spacer"></span>
      <button class="button" type="button" disabled={saving} onclick={() => void onClose()}>
        {$t.spending.cancel}
      </button>
      <button class="button primary" type="button" disabled={saving} onclick={() => void confirm()}>
        {$t.spending.confirm}
      </button>
    </footer>
  </div>
</div>

<style>
  .transaction-review-panel {
    width: min(720px, 100%);
  }

  .transaction-review-head {
    align-items: center;
  }

  .transaction-title {
    min-width: 0;
    display: grid;
    gap: 3px;
  }

  .transaction-title :is(p, h2) {
    margin: 0;
  }

  .transaction-title > strong {
    overflow: hidden;
    color: var(--muted);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .transaction-heading-amount {
    margin-left: auto;
    display: grid;
    justify-items: end;
    gap: 5px;
  }

  .transaction-heading-amount > strong {
    font-size: 18px;
  }

  .transaction-review-body {
    padding: var(--space-5);
    display: grid;
    gap: var(--space-5);
  }

  .transaction-details {
    margin: 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4) var(--space-5);
  }

  .transaction-details > div {
    min-width: 0;
  }

  .transaction-note {
    grid-column: 1 / -1;
  }

  dt,
  dd {
    margin: 0;
  }

  dt,
  .category-control > span,
  .decision-control legend,
  small {
    color: var(--muted);
    font-size: 11px;
  }

  dd {
    margin-top: 3px;
    font-size: 13px;
    font-weight: 650;
    overflow-wrap: anywhere;
  }

  small {
    display: block;
    margin-top: 2px;
  }

  .category-control {
    display: grid;
    gap: 6px;
  }

  .category-control select {
    min-height: 40px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
  }

  .decision-control {
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3);
    border: 0;
  }

  .decision-control legend {
    grid-column: 1 / -1;
    margin-bottom: 6px;
  }

  .decision-control label {
    min-height: 64px;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .decision-control label.checked {
    border-color: var(--fg);
    background: var(--surface-soft);
  }

  .decision-control input {
    accent-color: var(--fg);
  }

  .transaction-error {
    margin: 0;
    color: var(--danger);
    font-size: 12px;
  }

  .transaction-review-footer {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--border);
  }

  .footer-spacer {
    flex: 1;
  }

  .status-chip {
    display: inline-flex;
    width: fit-content;
    padding: 3px 7px;
    border-radius: 999px;
    font-size: 10px;
  }

  .status-chip.included { color: oklch(42% 0.08 165); background: oklch(94% 0.025 165); }
  .status-chip.excluded { color: var(--muted); background: var(--surface-soft); }
  .status-chip.pending { color: oklch(42% 0.10 70); background: oklch(93% 0.08 80); }

  @media (max-width: 620px) {
    .transaction-review-head {
      align-items: start;
    }

    .transaction-heading-amount {
      display: none;
    }

    .transaction-details,
    .decision-control {
      grid-template-columns: 1fr;
    }

    .transaction-note,
    .decision-control legend {
      grid-column: 1;
    }

    .transaction-review-footer {
      flex-wrap: wrap;
    }
  }
</style>
