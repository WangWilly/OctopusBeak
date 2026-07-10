<script lang="ts">
  import { onMount } from "svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";
  import { SPENDING_CATEGORY_IDS, type SpendingCategory } from "$lib/spending/categories.ts";
  import type { SpendingInvoiceDto } from "$lib/spending/model.ts";

  export let invoice: SpendingInvoiceDto;
  export let savingItemKeys: ReadonlySet<string> = new Set();
  export let errorItemKeys: ReadonlySet<string> = new Set();
  export let onClose: () => void | Promise<void> = () => {};
  export let onCategoryChange: (itemKey: string, category: string) => void | Promise<void> = () => {};

  let displayInvoiceCategories: SpendingCategory[] = [];
  let closeButton: HTMLButtonElement | null = null;

  onMount(() => closeButton?.focus());

  $: dateFormatter = new Intl.DateTimeFormat($locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Taipei",
  });
  $: quantityFormatter = new Intl.NumberFormat($locale, { maximumFractionDigits: 3 });
  $: invoiceCategories = SPENDING_CATEGORY_IDS.filter((category) =>
    invoice.items.some((item) => item.category === category),
  );
  $: displayInvoiceCategories = invoiceCategories.length > 0
    ? invoiceCategories
    : ["other"];

  function closeOnEscape(event: KeyboardEvent) {
    if (event.key === "Escape") void onClose();
  }

  function containFocus(event: KeyboardEvent) {
    if (event.key !== "Tab") return;
    const focusable = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

  function categoryValue(event: Event) {
    return (event.currentTarget as HTMLSelectElement).value;
  }

  function formatAmount(value: number | null) {
    return value === null
      ? $t.spending.notAvailable
      : formatMoney({ currency: "TWD", value }, { locale: $locale });
  }

  function formatQuantity(value: number | null) {
    return value === null ? $t.spending.notAvailable : quantityFormatter.format(value);
  }

  function categoryClass(category: SpendingCategory) {
    return `category-select category-${category}`;
  }
</script>

<svelte:window onkeydown={closeOnEscape} />

<div class="modal open">
  <button
    class="modal-backdrop"
    type="button"
    aria-label={$t.spending.closeInvoiceDetails}
    onclick={() => void onClose()}
  ></button>
  <div
    class="modal-panel invoice-detail-panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="invoice-detail-title"
    tabindex="-1"
    onkeydown={containFocus}
  >
    <div class="modal-head invoice-detail-head">
      <div class="invoice-title">
        <p>
          <span>{$t.spending.invoiceNumber}</span>
          <strong>{invoice.invoiceId}</strong>
        </p>
        <h2 id="invoice-detail-title">{$t.spending.invoiceDetails}</h2>
        <p>{$t.spending.date}: {dateFormatter.format(new Date(invoice.issuedAt * 1000))}</p>
      </div>
      <button
        bind:this={closeButton}
        class="modal-close"
        type="button"
        aria-label={$t.spending.closeInvoiceDetails}
        onclick={() => void onClose()}
      >&times;</button>
    </div>

    <div class="modal-body invoice-detail-body">
      <section class="seller-section" aria-labelledby="invoice-seller-title">
        <p class="eyebrow">{$t.spending.seller}</p>
        <h3 id="invoice-seller-title">{invoice.sellerName || $t.spending.unknownSeller}</h3>
        <dl class="seller-metadata">
          <div>
            <dt>{$t.spending.category}</dt>
            <dd class="category-summary">
              {#each displayInvoiceCategories as category}
                <span class="category-chip category-{category}">{$t.spending.categories[category]}</span>
              {/each}
            </dd>
          </div>
          <div>
            <dt>{$t.spending.businessNumber}</dt>
            <dd>{invoice.sellerBusinessAccountNumber || $t.spending.notAvailable}</dd>
          </div>
          <div class="seller-address">
            <dt>{$t.spending.address}</dt>
            <dd>{invoice.sellerAddr || $t.spending.notAvailable}</dd>
          </div>
        </dl>
      </section>

      <section class="items-section" aria-labelledby="invoice-items-title">
        <div class="items-heading">
          <h3 id="invoice-items-title">{$t.spending.purchaseItems}</h3>
          <span>{$t.spending.itemCount(invoice.items.length)}</span>
        </div>
        <div class="item-list">
          {#each invoice.items as item (item.itemKey)}
            <div class="item-row">
              <div class="item-main">
                <strong>{item.productName || $t.spending.unknownProduct}</strong>
                <dl class="item-values">
                  <div>
                    <dt>{$t.spending.quantity}</dt>
                    <dd>{formatQuantity(item.quantity)}</dd>
                  </div>
                  <div>
                    <dt>{$t.spending.unitPrice}</dt>
                    <dd class="money" data-sensitive>{formatAmount(item.unitPrice)}</dd>
                  </div>
                  <div>
                    <dt>{$t.spending.paidAmount}</dt>
                    <dd class="money" data-sensitive>{formatAmount(item.paidAmount)}</dd>
                  </div>
                </dl>
              </div>
              <label class="item-category-control">
                <span>{$t.spending.itemCategory}</span>
                <span class={categoryClass(item.category)}>
                  <select
                    value={item.category}
                    disabled={savingItemKeys.has(item.itemKey)}
                    onchange={(event) => void onCategoryChange(item.itemKey, categoryValue(event))}
                  >
                    {#each SPENDING_CATEGORY_IDS as category}
                      <option value={category}>{$t.spending.categories[category]}</option>
                    {/each}
                  </select>
                </span>
              </label>
              {#if savingItemKeys.has(item.itemKey)}
                <span class="item-status" role="status">{$t.spending.savingCategory}</span>
              {:else if errorItemKeys.has(item.itemKey)}
                <span class="item-error" role="alert">{$t.spending.categorySaveError}</span>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    </div>

    <div class="invoice-total-footer">
      <span>{$t.spending.thisPurchase}</span>
      <strong class="money" data-sensitive>{formatAmount(invoice.amount)}</strong>
    </div>
  </div>
</div>

<style>
  .invoice-detail-panel {
    width: min(680px, 100%);
  }

  .invoice-title {
    min-width: 0;
    display: grid;
    gap: 3px;
  }

  .invoice-title p,
  .invoice-title h2 {
    margin: 0;
  }

  .invoice-title p {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    color: var(--muted);
    font-size: 12px;
  }

  .invoice-title strong {
    color: var(--fg);
    font-family: var(--font-mono);
  }

  .invoice-detail-body {
    display: grid;
  }

  .seller-section,
  .items-section {
    padding: var(--space-5);
  }

  .seller-section {
    border-bottom: 1px solid var(--border);
  }

  .seller-section > p,
  .seller-section h3,
  .items-heading h3 {
    margin: 0;
  }

  .seller-section h3 {
    margin-top: 4px;
    font-family: var(--font-display);
    font-size: 20px;
  }

  .seller-metadata,
  .item-values {
    margin: var(--space-4) 0 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3) var(--space-5);
  }

  .seller-metadata > div,
  .item-values > div {
    min-width: 0;
  }

  .seller-address {
    grid-column: 1 / -1;
  }

  dt,
  dd {
    margin: 0;
  }

  dt,
  .item-category-control > span:first-child {
    color: var(--muted);
    font-size: 11px;
  }

  dd {
    margin-top: 3px;
    font-size: 13px;
    font-weight: 650;
    overflow-wrap: anywhere;
  }

  .category-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .category-chip,
  .category-select {
    --swatch: var(--spending-other);

    width: fit-content;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
  }

  .category-chip {
    padding: 2px 7px;
    color: var(--muted);
    font-size: 10px;
    font-weight: 500;
  }

  .category-chip::before,
  .category-select::before {
    width: 7px;
    height: 7px;
    flex: 0 0 auto;
    border-radius: 999px;
    background: var(--swatch);
    content: "";
  }

  .category-food { --swatch: var(--spending-food); }
  .category-daily { --swatch: var(--spending-daily); }
  .category-transport { --swatch: var(--spending-transport); }
  .category-shopping { --swatch: var(--spending-shopping); }
  .category-home { --swatch: var(--spending-home); }
  .category-leisure { --swatch: var(--spending-leisure); }
  .category-other { --swatch: var(--spending-other); }

  .items-section {
    display: grid;
    gap: var(--space-3);
  }

  .items-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .items-heading span {
    color: var(--muted);
    font-size: 12px;
  }

  .item-list {
    display: grid;
    border-top: 1px solid var(--border);
  }

  .item-row {
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--space-3) var(--space-4);
    padding: var(--space-4) 0;
    border-bottom: 1px solid var(--border);
  }

  .item-main {
    min-width: 0;
  }

  .item-main > strong {
    display: block;
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .item-values {
    grid-template-columns: repeat(3, minmax(0, auto));
    justify-content: start;
    margin-top: var(--space-2);
  }

  .item-category-control {
    align-self: start;
    display: grid;
    justify-items: end;
    gap: 4px;
  }

  .category-select {
    padding-left: 7px;
  }

  .category-select select {
    min-width: 0;
    max-width: 180px;
    border: 0;
    padding: 3px 24px 3px 0;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: 11px;
  }

  .category-select:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .category-select select:disabled {
    cursor: wait;
    opacity: 0.55;
  }

  .item-status,
  .item-error {
    grid-column: 1 / -1;
    font-size: 11px;
  }

  .item-status {
    color: var(--muted);
  }

  .item-error {
    color: var(--danger);
  }

  .invoice-total-footer {
    min-height: 72px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--border);
    background: var(--surface);
    color: var(--muted);
    font-size: 12px;
  }

  .invoice-total-footer strong {
    color: var(--fg);
    font-size: 28px;
  }

  @media (max-width: 560px) {
    .seller-metadata,
    .item-row {
      grid-template-columns: 1fr;
    }

    .seller-address,
    .item-status,
    .item-error {
      grid-column: auto;
    }

    .item-category-control {
      justify-items: start;
    }
  }
</style>
