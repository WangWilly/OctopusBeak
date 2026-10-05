<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { Check, ChevronDown, ChevronUp, CreditCard, GitMerge, Landmark, Link, Receipt, Tag, Unlink, X } from "@lucide/svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { SPENDING_CATEGORY_GROUP_IDS, spendingCategoryCodesForGroup } from "../category-groups.ts";
  import type { SpendingCandidatePageItem, SpendingCandidatePairRef } from "../model.ts";
  import type { SpendingPurchaseRecordView as PurchaseRecord } from "../purchase-matching.ts";
  import type { SpendingReviewStore } from "../spending-review-store.ts";
  import {
    SPENDING_GROUP_COLORS,
    codeLabel,
    decidedAtText,
    fullDateText,
    groupLabel,
    longDateText,
    mergedReasons,
    monthDayText,
    paymentText,
    periodText,
    purchaseTimeText,
    reasonTexts,
    recordCategoryCode,
    recordCategoryDetailText,
    recordGroups,
    recordMerchant,
    timeOfDay,
  } from "../spending-display.ts";
  import { moneyText, type ExactMoney } from "./money-text.ts";

  export let record: PurchaseRecord;
  export let pendingItem: SpendingCandidatePageItem | null = null;
  export let pendingTotal: number | null = null;
  export let position: Readonly<{ index: number; total: number }>;
  export let review: SpendingReviewStore;
  export let busy = false;
  export let onStep: (offset: -1 | 1) => void;
  export let onDecide: (pair: SpendingCandidatePairRef, action: "confirm" | "deny") => void;
  export let onRevoke: (record: PurchaseRecord) => void;
  export let onOpenPairing: (record: PurchaseRecord) => void;
  export let onOpenMerge: (tab: "pending" | "merged") => void;
  export let onClose: () => void;

  const state = review.state;
  let panel: HTMLElement | null = null;
  let pickerOpen = false;
  let shownPurchaseId = "";

  $: if (record.purchaseId !== shownPurchaseId) {
    shownPurchaseId = record.purchaseId;
    pickerOpen = false;
    review.showMerchantStats(record.purchaseId);
    void tick().then(() => panel?.focus());
  }
  onDestroy(() => review.showMerchantStats(null));

  $: groups = recordGroups(record);
  $: mainGroup = groups[0] ?? "unclassified";
  $: merged = record.basis === "linked";
  $: pending = record.possibleDuplicate && !merged;
  $: stats = $state.merchantStats?.purchaseId === record.purchaseId ? $state.merchantStats : null;
  $: statsTotal = stats?.totalsByCurrency.find((total) => total.currency === record.amount?.currency) ?? stats?.totalsByCurrency[0] ?? null;
  $: currentCode = recordCategoryCode(record);
  $: saving = $state.categorySaving === record.purchaseId;
  $: billingPeriod = record.paymentSource?.billingPeriod ?? null;
  $: reasons = merged ? mergedReasons(record) : pendingItem?.candidate.reasons ?? null;
  $: pairInvoice = merged ? record : pendingItem?.invoiceRecord ?? (record.invoice ? record : null);
  $: ownInvoice = record.basis === "invoice";
  $: counterpart = pendingItem ? (ownInvoice ? pendingItem.paymentRecord : pendingItem.invoiceRecord) : null;
  $: itemsRecord = pairInvoice?.invoice ? pairInvoice : null;
  $: postingDate = record.transaction ? record.transaction.postingDate ?? record.transaction.effectiveOn : null;

  function amountText(amount: ExactMoney | null, signed = false) {
    return amount ? moneyText(amount, $locale, signed) : $t.purchaseSpending.amountUnavailable;
  }

  function exactText(value: { coefficient: string; scale: number } | null) {
    if (!value) return "—";
    if (value.scale === 0) return value.coefficient;
    const negative = value.coefficient.startsWith("-");
    const digits = (negative ? value.coefficient.slice(1) : value.coefficient).padStart(value.scale + 1, "0");
    const split = digits.length - value.scale;
    return `${negative ? "-" : ""}${digits.slice(0, split)}.${digits.slice(split)}`;
  }

  function invoiceMeta(source: PurchaseRecord) {
    const time = source.occurrence.precision === "date" ? null : timeOfDay(source.occurrence.value);
    return [`${monthDayText(source.occurrence.value)}${time ? ` ${time}` : ""}`, source.invoice?.revision.seller.name].filter(Boolean).join(" · ");
  }

  function paymentMeta(source: PurchaseRecord) {
    const transaction = source.transaction;
    if (!transaction) return "";
    const posted = transaction.postingDate ?? transaction.effectiveOn;
    const dates = transaction.stream === "credit-card"
      ? [transaction.consumeDate ? $t.spendingReview.consumedOn(monthDayText(transaction.consumeDate)) : null, $t.spendingReview.postedOn(monthDayText(posted))]
      : [$t.spendingReview.debitedOn(monthDayText(posted))];
    return [...dates, transaction.description].filter(Boolean).join(" · ");
  }

  function pairRef(item: SpendingCandidatePageItem): SpendingCandidatePairRef {
    return { candidateId: item.candidate.candidateId, invoiceIdentityId: item.candidate.invoiceId, transactionIdentityId: item.candidate.transactionId };
  }

  async function chooseCategory(code: string | null) {
    if (await review.setPurchaseCategory(record.purchaseId, code)) pickerOpen = false;
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      if (pickerOpen) pickerOpen = false;
      else onClose();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="modal purchase-modal" role="dialog" aria-modal="true" aria-labelledby="purchase-modal-title" data-purchase-modal data-purchase-id={record.purchaseId} data-state={merged ? "merged" : pending ? "pending" : "single"}>
  <button class="modal-backdrop" type="button" aria-label={$t.spendingReview.close} onclick={onClose}></button>
  <section class="modal-panel purchase-panel" bind:this={panel} tabindex="-1" aria-busy={busy || saving}>
    <header class="modal-head purchase-head">
      <span class="category-mark" style:color={SPENDING_GROUP_COLORS[mainGroup]} aria-hidden="true"><Tag size={18} strokeWidth={2} /></span>
      <div class="head-titles">
        <div class="title-row">
          <h2 id="purchase-modal-title">{recordMerchant($t, record)}</h2>
          {#if merged}
            <span class="status-tag merged"><Link size={12} strokeWidth={2.2} aria-hidden="true" />{$t.spendingReview.statusMerged}</span>
          {:else if pending}
            <span class="status-tag pending"><GitMerge size={12} strokeWidth={2.2} aria-hidden="true" />{$t.spendingReview.statusPending}</span>
          {/if}
        </div>
        <p>{recordCategoryDetailText($t, record)} · {longDateText(record.occurrence.value, $locale)}{record.occurrence.precision === "date" ? "" : ` ${timeOfDay(record.occurrence.value) ?? ""}`}</p>
      </div>
      <button type="button" class="icon-button" aria-label={$t.spendingReview.previousPurchase} disabled={position.index <= 0} data-previous-purchase onclick={() => onStep(-1)}><ChevronUp size={18} strokeWidth={2} aria-hidden="true" /></button>
      <button type="button" class="icon-button" aria-label={$t.spendingReview.nextPurchase} disabled={position.index >= position.total - 1} data-next-purchase onclick={() => onStep(1)}><ChevronDown size={18} strokeWidth={2} aria-hidden="true" /></button>
      <button type="button" class="icon-button" aria-label={$t.spendingReview.close} onclick={onClose}><X size={18} strokeWidth={2} aria-hidden="true" /></button>
    </header>

    <div class="modal-body purchase-body">
      {#if pickerOpen}
        <section class="category-picker" aria-labelledby="category-picker-title" data-category-picker>
          <header>
            <h3 id="category-picker-title">{$t.spendingReview.categoryPickerTitle}</h3>
            {#if saving}<span role="status">{$t.spendingReview.savingCategory}</span>{/if}
            <button type="button" class="text-button" onclick={() => pickerOpen = false}>{$t.common.cancel}</button>
          </header>
          {#if $state.categoryError}<p class="picker-error" role="alert">{$state.categoryError}</p>{/if}
          <div class="picker-groups">
            {#each SPENDING_CATEGORY_GROUP_IDS as group}
              <fieldset>
                <legend><span class="category-dot" style:background={SPENDING_GROUP_COLORS[group]} aria-hidden="true"></span>{groupLabel($t, group)}</legend>
                <div class="picker-codes">
                  {#each spendingCategoryCodesForGroup(group) as code}
                    <button type="button" class="code-option" aria-pressed={currentCode === code} disabled={saving} data-category-code={code} onclick={() => void chooseCategory(code)}>
                      {#if currentCode === code}<Check size={12} strokeWidth={2.4} aria-hidden="true" />{/if}{codeLabel($t, code)}
                    </button>
                  {/each}
                </div>
              </fieldset>
            {/each}
          </div>
          <button type="button" class="button" disabled={saving} data-clear-category onclick={() => void chooseCategory(null)}>{$t.spendingReview.clearCategory}</button>
        </section>
      {/if}

      <div class="purchase-columns">
        <div class="purchase-facts">
          <div class="amount-block">
            <span class="fact-label">{$t.spendingReview.purchaseAmount}</span>
            <strong class="money" data-sensitive>{amountText(record.amount, record.basis === "refund")}</strong>
            <span class="amount-caption">{merged ? $t.spendingReview.mergedCaption : record.basis === "refund" ? $t.purchaseSpending.refundPeriod : $t.spendingReview.recognizedIn(new Intl.DateTimeFormat($locale, { month: "long", timeZone: "UTC" }).format(new Date(`${record.occurrence.value.slice(0, 10)}T00:00:00Z`)))}</span>
          </div>
          <dl>
            <div><dt>{$t.spendingReview.purchaseTime}</dt><dd>{purchaseTimeText(record.occurrence)}</dd></div>
            {#if postingDate}<div><dt>{$t.spendingReview.postingDate}</dt><dd>{fullDateText(postingDate)}</dd></div>{/if}
            <div><dt>{$t.spendingReview.paymentMethod}</dt><dd>{record.transaction ? paymentText($t, record.transaction, record.paymentSource) : $t.spendingReview.einvoice}</dd></div>
            <div class="category-fact">
              <dt>{$t.spendingReview.category}</dt>
              <dd>
                <span class="category-dot" style:background={SPENDING_GROUP_COLORS[mainGroup]} aria-hidden="true"></span>
                <span>{recordCategoryDetailText($t, record)}</span>
                <button type="button" class="text-button" aria-expanded={pickerOpen} data-change-category onclick={() => pickerOpen = !pickerOpen}>{$t.spendingReview.change}</button>
              </dd>
            </div>
            {#if stats && stats.count > 0}
              <div data-same-merchant><dt>{$t.spendingReview.sameMerchant}</dt><dd>{$t.spendingReview.sameMerchantCount(stats.count)}{#if statsTotal}{" · "}<span class="money" data-sensitive>{amountText(statsTotal)}</span>{/if}</dd></div>
            {/if}
            {#if billingPeriod}<div><dt>{$t.spendingReview.billingPeriod}</dt><dd>{periodText(billingPeriod)}</dd></div>{/if}
            {#if record.occurrence.basis === "posting-date-fallback"}<div><dt>{$t.spendingReview.purchaseTime}</dt><dd class="caution" data-date-basis="posting-date-fallback">{$t.purchaseSpending.postingDateFallback}</dd></div>{/if}
          </dl>
        </div>

        <div class="purchase-sources">
          {#if merged}
            <div class="section-head">
              <h3>{$t.spendingReview.mergedSources(2)}</h3>
              {#if record.link}<span>{record.link.origin === "user" ? $t.spendingReview.mergedByYou(decidedAtText(record.link.decidedAt)) : $t.spendingReview.mergedAutomatically(decidedAtText(record.link.decidedAt))}</span>{/if}
            </div>
            <div class="merged-group">
              {#if record.invoice}
                <div class="source-card">
                  <span class="source-icon" aria-hidden="true"><Receipt size={15} strokeWidth={2} /></span>
                  <span class="source-texts"><strong>{$t.spendingReview.invoiceNumber(record.invoice.revision.invoiceNumber)}</strong><span>{invoiceMeta(record)}</span></span>
                  <span class="money" data-sensitive>{amountText(record.difference?.invoiceAmount ?? record.invoice.revision.total)}</span>
                </div>
              {/if}
              {#if record.transaction}
                <div class="source-card">
                  <span class="source-icon" aria-hidden="true">{#if record.transaction.stream === "credit-card"}<CreditCard size={15} strokeWidth={2} />{:else}<Landmark size={15} strokeWidth={2} />{/if}</span>
                  <span class="source-texts"><strong>{paymentText($t, record.transaction, record.paymentSource)}</strong><span>{paymentMeta(record)}</span></span>
                  <span class="money" data-sensitive>{amountText(record.transaction.amount)}</span>
                </div>
              {/if}
              <div class="counted-once"><span>{$t.spendingReview.countedOnce}</span><span class="money" data-sensitive>{amountText(record.amount)}</span></div>
            </div>
            {#if record.difference && !record.difference.exactAmountEqual}
              <p class="difference-note" data-link-difference>{$t.purchaseSpending.amountDifferenceNotInferred}</p>
            {/if}
            {#if reasons}<ul class="reason-chips">{#each reasonTexts($t, reasons) as reason}<li><Check size={11} strokeWidth={2.4} aria-hidden="true" />{reason}</li>{/each}</ul>{/if}
            {#if record.link}
              <div class="source-actions">
                <button type="button" class="button danger" disabled={busy} data-revoke-link onclick={() => onRevoke(record)}><Unlink size={14} strokeWidth={2} aria-hidden="true" />{$t.spendingReview.unmerge}</button>
                <span>{$t.spendingReview.unmergeHint}</span>
              </div>
            {/if}
          {:else}
            <div class="section-head"><h3>{ownInvoice ? $t.spendingReview.invoiceRecord : $t.spendingReview.paymentRecord}</h3></div>
            {#if ownInvoice && record.invoice}
              <div class="source-card">
                <span class="source-icon" aria-hidden="true"><Receipt size={15} strokeWidth={2} /></span>
                <span class="source-texts"><strong>{$t.spendingReview.invoiceNumber(record.invoice.revision.invoiceNumber)}</strong><span>{invoiceMeta(record)}</span></span>
                <span class="money" data-sensitive>{amountText(record.amount)}</span>
              </div>
            {:else if record.transaction}
              <div class="source-card">
                <span class="source-icon" aria-hidden="true">{#if record.transaction.stream === "credit-card"}<CreditCard size={15} strokeWidth={2} />{:else}<Landmark size={15} strokeWidth={2} />{/if}</span>
                <span class="source-texts"><strong>{paymentText($t, record.transaction, record.paymentSource)}</strong><span>{paymentMeta(record)}</span></span>
                <span class="money" data-sensitive>{amountText(record.amount)}</span>
              </div>
            {/if}

            {#if pending && pendingItem && counterpart}
              <div class="section-head match-head">
                <h3>{ownInvoice ? $t.spendingReview.possiblePayment : $t.spendingReview.possibleInvoice}</h3>
                <span class="strength" class:strong={pendingItem.candidate.strength === "strong"}>{pendingItem.candidate.strength === "strong" ? $t.spendingReview.strong : $t.spendingReview.possible}</span>
              </div>
              <div class="match-box" data-pending-match={pendingItem.candidate.candidateId}>
                <div class="source-card">
                  {#if counterpart.invoice}
                    <span class="source-icon" aria-hidden="true"><Receipt size={15} strokeWidth={2} /></span>
                    <span class="source-texts"><strong>{$t.spendingReview.invoiceNumber(counterpart.invoice.revision.invoiceNumber)}</strong><span>{invoiceMeta(counterpart)}</span></span>
                  {:else if counterpart.transaction}
                    <span class="source-icon" aria-hidden="true">{#if counterpart.transaction.stream === "credit-card"}<CreditCard size={15} strokeWidth={2} />{:else}<Landmark size={15} strokeWidth={2} />{/if}</span>
                    <span class="source-texts"><strong>{paymentText($t, counterpart.transaction, counterpart.paymentSource)}</strong><span>{paymentMeta(counterpart)}</span></span>
                  {/if}
                  <span class="money" data-sensitive>{amountText(counterpart.amount)}</span>
                </div>
                {#if reasons}<ul class="reason-chips">{#each reasonTexts($t, reasons) as reason}<li><Check size={11} strokeWidth={2.4} aria-hidden="true" />{reason}</li>{/each}</ul>{/if}
                {#if itemsRecord && itemsRecord.items.length > 0}
                  {@render invoiceItems(itemsRecord)}
                {/if}
                <div class="source-actions">
                  <button type="button" class="button primary" disabled={busy} data-confirm-candidate onclick={() => onDecide(pairRef(pendingItem), "confirm")}><GitMerge size={14} strokeWidth={2} aria-hidden="true" />{ownInvoice ? $t.spendingReview.merge : $t.spendingReview.mergeInvoice}</button>
                  <button type="button" class="button" disabled={busy} data-deny-candidate onclick={() => onDecide(pairRef(pendingItem), "deny")}>{$t.spendingReview.notSame}</button>
                  <span>{$t.spendingReview.mergeHint}</span>
                </div>
              </div>
            {:else if pending}
              <p class="pair-note" role="status">{$t.spendingReview.pairNotLoaded}</p>
            {:else}
              {#if ownInvoice && record.items.length > 0}
                {@render invoiceItems(record)}
              {/if}
              {#if ownInvoice && record.invoice}
                <div class="source-actions">
                  <button type="button" class="button secondary" disabled={busy} data-open-pairing onclick={() => onOpenPairing(record)}>{$t.spendingReview.matchPayment}</button>
                </div>
              {/if}
            {/if}
          {/if}
          {#if record.refund}<p class="pair-note">{$t.purchaseSpending.refundPeriod} · {record.refund.provenanceReference}</p>{/if}
        </div>
      </div>
    </div>

    <footer class="purchase-footer">
      {#if pending && pendingTotal}
        <button type="button" class="text-button" data-view-in-merge onclick={() => onOpenMerge("pending")}><GitMerge size={14} strokeWidth={2} aria-hidden="true" />{$t.spendingReview.viewAllPending(pendingTotal)}</button>
      {:else if merged}
        <button type="button" class="text-button" data-view-in-merge onclick={() => onOpenMerge("merged")}><GitMerge size={14} strokeWidth={2} aria-hidden="true" />{$t.spendingReview.viewMerged}</button>
      {/if}
      <button type="button" class="button" onclick={onClose}>{$t.spendingReview.close}</button>
    </footer>
  </section>
</div>

{#snippet invoiceItems(source: PurchaseRecord)}
  <table class="items-table" data-item-details>
    <thead>
      <tr><th scope="col">{$t.spendingReview.invoiceItems(source.items.length)}</th><th scope="col">{$t.spendingReview.quantity}</th><th scope="col">{$t.spendingReview.itemAmount}</th></tr>
    </thead>
    <tbody>
      {#each source.items as item (item.itemId)}
        <tr>
          <td>{item.name ?? $t.purchaseSpending.itemNameUnavailable}</td>
          <td class="num">×{exactText(item.quantity)}</td>
          <td><span class="money" data-sensitive>{item.amount ? exactText(item.amount) : "—"}</span></td>
        </tr>
      {/each}
    </tbody>
    {#if source.invoice}
      <tfoot><tr><th scope="row" colspan="2">{$t.spendingReview.invoiceTotal}</th><td><span class="money" data-sensitive>{amountText(source.invoice.revision.total)}</span></td></tr></tfoot>
    {/if}
  </table>
{/snippet}

<style>
  .purchase-panel { width: min(780px, 100%); outline: none; }
  .purchase-head { align-items: center; gap: 14px; }
  .category-mark { display: grid; flex: none; place-items: center; width: 40px; height: 40px; border-radius: var(--radius); background: color-mix(in oklch, currentColor 10%, white); }
  .head-titles { flex: 1; min-width: 0; }
  .title-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .title-row h2 { overflow: hidden; margin: 0; font-size: 22px; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
  .head-titles p { margin: 3px 0 0; color: var(--muted); font-size: 13px; }
  .icon-button { display: grid; flex: none; place-items: center; width: 40px; height: 40px; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--fg); cursor: pointer; }
  .icon-button:hover:not(:disabled) { background: var(--surface-soft); }
  .icon-button:disabled { opacity: 0.48; cursor: not-allowed; }
  .status-tag { display: inline-flex; flex: none; align-items: center; gap: 4px; padding: 3px 8px; border-radius: var(--radius-sm); background: var(--surface-soft); color: var(--muted); font-size: 12px; font-weight: 720; white-space: nowrap; }
  .status-tag.pending { background: var(--accent-soft); color: var(--accent); }
  .purchase-body { flex: 1; min-height: 0; }
  .purchase-columns { display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: var(--space-6); padding: var(--space-5); }
  .purchase-facts { display: grid; align-content: start; gap: var(--space-4); min-width: 0; }
  .amount-block { display: grid; gap: 4px; }
  .fact-label { color: var(--muted); font-size: 11px; font-weight: 720; letter-spacing: 0.06em; }
  .amount-block > .money { font-size: 32px; font-weight: 750; line-height: 1.15; overflow-wrap: anywhere; }
  .amount-caption { color: var(--muted); font-size: 12px; }
  .purchase-facts dl { margin: 0; border-top: 1px solid var(--border); }
  .purchase-facts dl > div { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 10px 0; border-bottom: 1px solid var(--border); }
  .purchase-facts dt { flex: none; color: var(--muted); font-size: 12px; font-weight: 560; }
  .purchase-facts dd { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; margin: 0; font-size: 13px; font-weight: 650; text-align: right; }
  .purchase-facts dd.caution { color: var(--warn); }
  .category-dot { flex: none; width: 8px; height: 8px; border-radius: 999px; }
  .text-button { display: inline-flex; align-items: center; gap: 6px; padding: 0; border: 0; background: none; color: var(--accent); font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; }
  .text-button:hover { text-decoration: underline; text-underline-offset: 3px; }
  .purchase-sources { display: grid; align-content: start; gap: var(--space-3); min-width: 0; }
  .section-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
  .section-head h3 { margin: 0; font-size: 13px; font-weight: 700; }
  .section-head span { color: var(--muted); font-size: 11px; }
  .match-head { padding-top: 4px; }
  .source-card { display: flex; align-items: center; gap: 10px; min-width: 0; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
  .source-icon { display: grid; flex: none; place-items: center; width: 32px; height: 32px; border-radius: 8px; background: var(--surface-soft); color: var(--muted); }
  .source-texts { display: grid; flex: 1; gap: 1px; min-width: 0; }
  .source-texts strong { overflow: hidden; font-size: 13px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .source-texts span { overflow: hidden; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .source-card > .money { flex: none; font-size: 13px; font-weight: 750; }
  .merged-group { display: grid; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--border); border-radius: 12px; background: var(--surface-soft); }
  .counted-once { display: flex; align-items: center; justify-content: space-between; padding: 6px 4px 0; font-size: 12px; font-weight: 650; }
  .counted-once .money { font-size: 13px; font-weight: 750; }
  .match-box { display: grid; gap: 10px; padding: var(--space-3); border: 1px solid color-mix(in oklch, var(--accent) 24%, var(--border)); border-radius: 12px; background: var(--accent-soft); }
  .strength { padding: 2px 8px; border-radius: 999px; background: var(--surface-soft); color: var(--muted) !important; font-size: 11px !important; font-weight: 720; }
  .strength.strong { background: color-mix(in oklch, var(--success) 10%, white); color: var(--success) !important; }
  .reason-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .reason-chips li { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: var(--radius-sm); background: color-mix(in oklch, var(--surface-soft) 80%, white); color: var(--muted); font-size: 11px; font-weight: 560; }
  .items-table { width: 100%; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); border-collapse: separate; border-spacing: 0; background: var(--surface); font-size: 13px; }
  .items-table th, .items-table td { padding: 7px 12px; text-align: right; }
  .items-table th:first-child, .items-table td:first-child { text-align: left; }
  .items-table thead th { background: var(--surface-soft); color: var(--muted); font-size: 11px; font-weight: 650; }
  .items-table thead th:first-child { font-size: 12px; font-weight: 720; }
  .items-table tbody td, .items-table tfoot th, .items-table tfoot td { border-top: 1px solid var(--border); }
  .items-table td.num { width: 48px; color: var(--muted); font-size: 12px; font-weight: 700; }
  .items-table td .money { font-size: 12px; font-weight: 750; }
  .items-table tfoot th { font-size: 12px; font-weight: 720; }
  .items-table tfoot .money { font-size: 13px; }
  .source-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .source-actions .button { min-height: 38px; }
  .source-actions > span { flex: 1; min-width: 140px; color: var(--muted); font-size: 11px; text-align: right; }
  .difference-note, .pair-note { margin: 0; color: var(--muted); font-size: 12px; }
  .category-picker { display: grid; gap: var(--space-3); margin: var(--space-5) var(--space-5) 0; padding: var(--space-4); border: 1px solid var(--border); border-radius: 12px; background: var(--surface); box-shadow: 0 14px 36px rgb(15 23 42 / 0.14); }
  .category-picker header { display: flex; align-items: center; gap: var(--space-3); }
  .category-picker h3 { flex: 1; margin: 0; font-size: 14px; }
  .category-picker header span { color: var(--muted); font-size: 12px; }
  .picker-error { margin: 0; color: var(--danger); font-size: 12px; }
  .picker-groups { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--space-3); }
  .picker-groups fieldset { display: grid; align-content: start; gap: 6px; min-width: 0; margin: 0; padding: 0; border: 0; }
  .picker-groups legend { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 6px; padding: 0; font-size: 12px; font-weight: 720; }
  .picker-codes { display: flex; flex-wrap: wrap; align-content: flex-start; align-items: flex-start; gap: 6px; }
  .code-option { display: inline-flex; align-items: center; gap: 4px; min-height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--fg); font: inherit; font-size: 12px; cursor: pointer; }
  .code-option:hover:not(:disabled) { border-color: color-mix(in oklch, var(--accent) 35%, var(--border)); background: var(--accent-soft); }
  .code-option[aria-pressed="true"] { border-color: var(--fg); background: var(--fg); color: white; }
  .category-picker > .button { justify-self: start; min-height: 34px; }
  .purchase-footer { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: 14px var(--space-5); border-top: 1px solid var(--border); background: var(--bg); }
  .purchase-footer .text-button { font-size: 13px; }
  .purchase-footer .button { min-height: 38px; margin-left: auto; }
  .icon-button:focus-visible, .text-button:focus-visible, .code-option:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent) 18%, transparent); }

  @media (max-width: 760px) {
    .purchase-columns { grid-template-columns: minmax(0, 1fr); }
    .purchase-head { flex-wrap: wrap; }
    .head-titles { flex-basis: calc(100% - 60px); }
  }
</style>
