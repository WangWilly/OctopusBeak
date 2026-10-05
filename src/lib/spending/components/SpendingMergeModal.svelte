<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { ArrowLeft, Check, CreditCard, GitMerge, History, Info, Landmark, Receipt, TriangleAlert, Unlink, X } from "@lucide/svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import type { SpendingCandidatePageItem, SpendingCandidatePairRef } from "../model.ts";
  import type { SpendingPurchaseRecordView as PurchaseRecord } from "../purchase-matching.ts";
  import type { SpendingReviewStore } from "../spending-review-store.ts";
  import {
    decidedAtText,
    monthDayText,
    paymentText,
    reasonTexts,
    recordCategoryText,
    recordMerchant,
    timeOfDay,
  } from "../spending-display.ts";
  import { moneyText, type ExactMoney } from "./money-text.ts";

  export let review: SpendingReviewStore;
  export let initialTab: "pending" | "merged" = "pending";
  export let busy = false;
  export let onDecide: (pair: SpendingCandidatePairRef, action: "confirm" | "deny") => void;
  export let onRevoke: (record: PurchaseRecord) => void;
  export let onClose: () => void;

  const state = review.state;
  let tab: "pending" | "merged" | "log" = initialTab;
  let panel: HTMLElement | null = null;

  onMount(() => {
    review.showMergeLists();
    void tick().then(() => panel?.focus());
  });
  onDestroy(() => review.hideMergeLists());

  $: overview = $state.overview;
  $: pending = $state.pending;
  $: merged = $state.merged;
  $: log = $state.log;
  $: pendingTotal = pending.meta?.total ?? overview?.pendingCount ?? null;
  $: strongCount = overview?.strongPairs.length ?? 0;
  $: batchBusy = $state.strongBatch.kind === "busy";

  function amountText(amount: ExactMoney | null) {
    return amount ? moneyText(amount, $locale) : $t.purchaseSpending.amountUnavailable;
  }

  function showLog() {
    tab = "log";
    review.showLog();
  }

  function pairRef(item: SpendingCandidatePageItem): SpendingCandidatePairRef {
    return { candidateId: item.candidate.candidateId, invoiceIdentityId: item.candidate.invoiceId, transactionIdentityId: item.candidate.transactionId };
  }

  function pairMerchant(item: SpendingCandidatePageItem) {
    const record = item.paymentRecord ?? item.invoiceRecord;
    return record ? recordMerchant($t, record) : $t.purchaseSpending.merchantUnavailable;
  }

  function pairCategory(item: SpendingCandidatePageItem) {
    const record = item.invoiceRecord ?? item.paymentRecord;
    const date = item.invoiceRecord?.occurrence.value ?? item.paymentRecord?.occurrence.value;
    return [record ? recordCategoryText($t, record) : null, date ? monthDayText(date) : null].filter(Boolean).join(" · ");
  }

  function invoiceMeta(record: PurchaseRecord) {
    const time = record.occurrence.precision === "date" ? null : timeOfDay(record.occurrence.value);
    const when = `${monthDayText(record.occurrence.value)}${time ? ` ${time}` : ""}`;
    return [when, record.invoice?.revision.seller.name].filter(Boolean).join(" · ");
  }

  function paymentMeta(record: PurchaseRecord) {
    const transaction = record.transaction;
    if (!transaction) return "";
    const posted = transaction.postingDate ?? transaction.effectiveOn;
    if (transaction.stream !== "credit-card") return $t.spendingReview.debitedOn(monthDayText(posted));
    return [
      transaction.consumeDate ? $t.spendingReview.consumedOn(monthDayText(transaction.consumeDate)) : null,
      $t.spendingReview.postedOn(monthDayText(posted)),
    ].filter(Boolean).join(" · ");
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="modal merge-modal" role="dialog" aria-modal="true" aria-labelledby="merge-modal-title" data-merge-modal>
  <button class="modal-backdrop" type="button" aria-label={$t.spendingReview.close} onclick={onClose}></button>
  <section class="modal-panel merge-panel" bind:this={panel} tabindex="-1" aria-busy={busy || batchBusy}>
    <header class="modal-head merge-head">
      <span class="head-icon" aria-hidden="true"><GitMerge size={18} strokeWidth={2} /></span>
      <div class="head-titles">
        <h2 id="merge-modal-title">{$t.spendingReview.mergeTitle}</h2>
        <p>{$t.spendingReview.mergeDescription}</p>
      </div>
      {#if tab === "log"}
        <button type="button" class="head-link" onclick={() => tab = "pending"}><ArrowLeft size={15} strokeWidth={2} aria-hidden="true" />{$t.spendingReview.backToMerge}</button>
      {:else}
        <button type="button" class="head-link" data-open-merge-log onclick={showLog}><History size={15} strokeWidth={2} aria-hidden="true" />{$t.spendingReview.mergeLog}</button>
      {/if}
      <button type="button" class="modal-close" aria-label={$t.spendingReview.close} onclick={onClose}><X size={18} strokeWidth={2} aria-hidden="true" /></button>
    </header>

    {#if tab !== "log"}
      <div class="merge-tabs" role="tablist" aria-label={$t.spendingReview.mergeTitle}>
        <button type="button" role="tab" aria-selected={tab === "pending"} data-merge-tab="pending" onclick={() => tab = "pending"}>
          {$t.spendingReview.pendingTab}{#if pendingTotal !== null}<span class="tab-count num">{pendingTotal}</span>{/if}
        </button>
        <button type="button" role="tab" aria-selected={tab === "merged"} data-merge-tab="merged" onclick={() => tab = "merged"}>
          {$t.spendingReview.mergedTab}{#if merged.status === "ready"}<span class="tab-count num">{merged.items.length}{merged.hasMore ? "+" : ""}</span>{/if}
        </button>
      </div>
    {/if}

    <div class="modal-body merge-body">
      {#if tab === "pending"}
        <div role="tabpanel" class="merge-tabpanel" data-merge-panel="pending">
          {#if $state.strongBatch.kind === "conflict"}
            <p class="notice caution" role="status" data-strong-conflict><TriangleAlert size={15} strokeWidth={2} aria-hidden="true" />{$t.spendingReview.strongConflict($state.strongBatch.offered)}</p>
          {:else if $state.strongBatch.kind === "error"}
            <p class="notice danger" role="alert">{$state.strongBatch.message}</p>
          {/if}
          {#if overview && overview.pendingCount > 0}
            <div class="notice caution impact" data-impact-notice>
              <Info size={15} strokeWidth={2} aria-hidden="true" />
              <strong>{$t.spendingReview.duplicateNotice(overview.pendingCount)}</strong>
              <span class="impact-label">{$t.spendingReview.affectedAmount}</span>
              <span class="impact-amounts">{#each overview.affectedByCurrency as amount (amount.currency)}<span class="money" data-sensitive>{amountText(amount)}</span>{/each}</span>
            </div>
          {/if}
          {#if pending.status === "loading" && pending.items.length === 0}
            <div class="list-skeleton" role="status" aria-label={$t.common.loading}></div>
          {:else if pending.status === "error"}
            <p class="notice danger" role="alert">{$t.spendingReview.loadFailed} {pending.error}</p>
          {:else if pending.items.length === 0}
            <p class="list-empty">{$t.spendingReview.noPending}</p>
          {/if}
          {#each pending.items as item (item.candidate.candidateId)}
            <article class="pair-card" data-pair-id={item.candidate.candidateId} data-strength={item.candidate.strength}>
              <div class="pair-merchant">
                <strong>{pairMerchant(item)}</strong>
                <span>{pairCategory(item)}</span>
                <span class="strength" class:strong={item.candidate.strength === "strong"}>{item.candidate.strength === "strong" ? $t.spendingReview.strong : $t.spendingReview.possible}</span>
              </div>
              <div class="pair-evidence">
                <div class="pair-sources">
                  {#if item.invoiceRecord}
                    <div class="source-line">
                      <span class="source-icon" aria-hidden="true"><Receipt size={14} strokeWidth={2} /></span>
                      <span class="source-texts">
                        <strong>{item.invoiceRecord.invoice ? $t.spendingReview.invoiceNumber(item.invoiceRecord.invoice.revision.invoiceNumber) : $t.spendingReview.einvoice}</strong>
                        <span>{invoiceMeta(item.invoiceRecord)}</span>
                      </span>
                      <span class="money" data-sensitive>{amountText(item.invoiceRecord.amount)}</span>
                    </div>
                  {/if}
                  {#if item.paymentRecord?.transaction}
                    <div class="source-line">
                      <span class="source-icon" aria-hidden="true">{#if item.paymentRecord.transaction.stream === "credit-card"}<CreditCard size={14} strokeWidth={2} />{:else}<Landmark size={14} strokeWidth={2} />{/if}</span>
                      <span class="source-texts">
                        <strong>{paymentText($t, item.paymentRecord.transaction, item.paymentRecord.paymentSource)}</strong>
                        <span>{paymentMeta(item.paymentRecord)}</span>
                      </span>
                      <span class="money" data-sensitive>{amountText(item.paymentRecord.amount)}</span>
                    </div>
                  {/if}
                </div>
                <ul class="reason-chips">
                  {#each reasonTexts($t, item.candidate.reasons) as reason}
                    <li><Check size={11} strokeWidth={2.4} aria-hidden="true" />{reason}</li>
                  {/each}
                </ul>
              </div>
              <div class="pair-actions">
                <button type="button" class="button primary" disabled={busy || batchBusy} data-confirm-candidate onclick={() => onDecide(pairRef(item), "confirm")}>
                  <GitMerge size={14} strokeWidth={2} aria-hidden="true" />{$t.spendingReview.merge}
                </button>
                <button type="button" class="button" disabled={busy || batchBusy} data-deny-candidate onclick={() => onDecide(pairRef(item), "deny")}>{$t.spendingReview.notSame}</button>
              </div>
            </article>
          {/each}
          {#if pending.hasMore}
            <button type="button" class="button show-more" disabled={pending.loadingMore} data-show-more-pairs onclick={() => void review.morePending()}>{pending.loadingMore ? $t.common.loading : $t.spendingReview.showMore}</button>
          {/if}
        </div>
      {:else if tab === "merged"}
        <div role="tabpanel" class="merge-tabpanel" data-merge-panel="merged">
          {#if merged.status === "loading" && merged.items.length === 0}
            <div class="list-skeleton" role="status" aria-label={$t.common.loading}></div>
          {:else if merged.status === "error"}
            <p class="notice danger" role="alert">{$t.spendingReview.loadFailed} {merged.error}</p>
          {:else if merged.items.length === 0}
            <p class="list-empty">{$t.spendingReview.noMerged}</p>
          {/if}
          {#each merged.items as record (record.purchaseId)}
            <article class="merged-row" data-merged-purchase={record.purchaseId}>
              <div class="merged-texts">
                <strong>{recordMerchant($t, record)}</strong>
                <span>{recordCategoryText($t, record)} · {monthDayText(record.occurrence.value)}{#if record.transaction}{" · "}{paymentText($t, record.transaction, record.paymentSource)}{/if}</span>
                {#if record.link}<span class="merged-when">{record.link.origin === "user" ? $t.spendingReview.mergedByYou(decidedAtText(record.link.decidedAt)) : $t.spendingReview.mergedAutomatically(decidedAtText(record.link.decidedAt))}</span>{/if}
              </div>
              <span class="money merged-amount" data-sensitive>{amountText(record.amount)}</span>
              {#if record.link}
                <button type="button" class="button danger" disabled={busy} data-revoke-link onclick={() => onRevoke(record)}><Unlink size={14} strokeWidth={2} aria-hidden="true" />{$t.spendingReview.unmerge}</button>
              {/if}
            </article>
          {/each}
          {#if merged.hasMore}
            <button type="button" class="button show-more" disabled={merged.loadingMore} onclick={() => void review.moreMerged()}>{merged.loadingMore ? $t.common.loading : $t.spendingReview.showMore}</button>
          {/if}
        </div>
      {:else}
        <div class="merge-tabpanel" data-merge-panel="log">
          <h3 class="log-title">{$t.spendingReview.mergeLog}</h3>
          {#if log.status === "loading" && log.items.length === 0}
            <div class="list-skeleton" role="status" aria-label={$t.common.loading}></div>
          {:else if log.status === "error"}
            <p class="notice danger" role="alert">{$t.spendingReview.loadFailed} {log.error}</p>
          {:else if log.items.length === 0}
            <p class="list-empty">{$t.spendingReview.logEmpty}</p>
          {/if}
          <ol class="log-list">
            {#each log.items as entry (entry.eventId)}
              <li class="log-entry" data-log-kind={entry.kind}>
                <div class="log-head">
                  <span class="log-kind" data-kind={entry.kind}>{entry.kind === "confirmed" ? $t.spendingReview.logConfirmed : entry.kind === "denied" ? $t.spendingReview.logDenied : $t.spendingReview.logRevoked}</span>
                  <span>{entry.origin === "user" ? $t.spendingReview.byYou(decidedAtText(entry.decidedAt)) : $t.spendingReview.automatically(decidedAtText(entry.decidedAt))}</span>
                </div>
                {#if entry.invoice}
                  <div class="source-line">
                    <span class="source-icon" aria-hidden="true"><Receipt size={14} strokeWidth={2} /></span>
                    <span class="source-texts"><strong>{$t.spendingReview.invoiceNumber(entry.invoice.invoiceNumber)}</strong><span>{[monthDayText(entry.invoice.occurrence), entry.invoice.sellerName].filter(Boolean).join(" · ")}</span></span>
                    <span class="money" data-sensitive>{amountText(entry.invoice.amount)}</span>
                  </div>
                {/if}
                {#if entry.payment}
                  <div class="source-line">
                    <span class="source-icon" aria-hidden="true">{#if entry.payment.cardMask}<CreditCard size={14} strokeWidth={2} />{:else}<Landmark size={14} strokeWidth={2} />{/if}</span>
                    <span class="source-texts">
                      <strong>{paymentText($t, { stream: entry.payment.cardMask ? "credit-card" : "account" }, { institution: entry.payment.institution, cardMask: entry.payment.cardMask, billingPeriod: null })}</strong>
                      <span>{[monthDayText(entry.payment.date), entry.payment.description].filter(Boolean).join(" · ")}</span>
                    </span>
                    <span class="money" data-sensitive>{amountText(entry.payment.amount)}</span>
                  </div>
                {/if}
              </li>
            {/each}
          </ol>
          {#if log.hasMore}
            <button type="button" class="button show-more" disabled={log.loadingMore} onclick={() => void review.moreLog()}>{log.loadingMore ? $t.common.loading : $t.spendingReview.showMore}</button>
          {/if}
        </div>
      {/if}
    </div>

    <footer class="merge-footer">
      <p><Info size={14} strokeWidth={2} aria-hidden="true" />{$t.spendingReview.footerNote}</p>
      <button type="button" class="button" data-merge-later onclick={onClose}>{$t.spendingReview.later}</button>
      {#if tab === "pending"}
        <button type="button" class="button primary" disabled={strongCount === 0 || busy || batchBusy} data-merge-all-strong onclick={() => void review.confirmStrong()}>
          <Check size={15} strokeWidth={2.2} aria-hidden="true" />{$t.spendingReview.mergeAllStrong(strongCount)}
        </button>
      {/if}
    </footer>
  </section>
</div>

<style>
  .merge-modal { z-index: 45; }
  .merge-panel { width: min(880px, 100%); outline: none; }
  .merge-head { align-items: center; gap: var(--space-3); }
  .head-icon { display: grid; flex: none; place-items: center; width: 40px; height: 40px; border-radius: var(--radius); background: var(--accent-soft); color: var(--accent); }
  .head-titles { flex: 1; min-width: 0; }
  .head-titles h2 { margin: 0; font-size: 22px; line-height: 1.3; }
  .head-titles p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
  .head-link { display: inline-flex; flex: none; align-items: center; gap: 6px; height: 40px; padding: 0 12px; border: 0; border-radius: var(--radius); background: none; color: var(--accent); font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; }
  .head-link:hover { background: var(--accent-soft); }
  .merge-head .modal-close { display: grid; flex: none; place-items: center; padding: 0; cursor: pointer; }
  .merge-tabs { display: flex; gap: 4px; padding: 0 var(--space-5); border-bottom: 1px solid var(--border); }
  .merge-tabs button { display: inline-flex; align-items: center; gap: 6px; margin-bottom: -1px; padding: 12px 14px 11px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--muted); font: inherit; font-size: 14px; font-weight: 560; cursor: pointer; }
  .merge-tabs button[aria-selected="true"] { border-bottom-color: var(--fg); color: var(--fg); font-weight: 700; }
  .tab-count { padding: 1px 7px; border-radius: 999px; background: var(--surface-soft); color: var(--muted); font-size: 11px; font-weight: 750; }
  .merge-tabs button[aria-selected="true"] .tab-count { background: var(--accent); color: white; }
  .merge-body { flex: 1; min-height: 0; background: var(--bg); }
  .merge-tabpanel { display: grid; gap: var(--space-3); padding: var(--space-5); }
  .notice { display: flex; align-items: center; gap: 10px; margin: 0; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); font-size: 13px; }
  .notice.caution { border-color: color-mix(in oklch, var(--warn) 34%, var(--border)); background: color-mix(in oklch, var(--warn) 6%, white); }
  .notice.caution :global(svg) { flex: none; color: var(--warn); }
  .notice.danger { border-color: color-mix(in oklch, var(--danger) 35%, var(--border)); color: var(--danger); }
  .impact strong { flex: 1; min-width: 0; }
  .impact-label { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .impact-amounts { display: inline-flex; gap: var(--space-2); color: color-mix(in oklch, var(--warn) 82%, var(--fg)); font-weight: 750; white-space: nowrap; }
  .pair-card { display: grid; grid-template-columns: 170px minmax(0, 1fr) 128px; align-items: center; gap: var(--space-5); padding: var(--space-4); border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
  .pair-merchant { display: grid; justify-items: start; gap: 6px; min-width: 0; }
  .pair-merchant strong { max-width: 100%; overflow: hidden; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
  .pair-merchant > span { color: var(--muted); font-size: 12px; }
  .strength { padding: 2px 8px; border-radius: 999px; background: var(--surface-soft); color: var(--muted) !important; font-size: 11px !important; font-weight: 720; }
  .strength.strong { background: color-mix(in oklch, var(--success) 10%, white); color: var(--success) !important; }
  .pair-evidence { display: grid; gap: 10px; min-width: 0; }
  .pair-sources { display: grid; gap: var(--space-2); padding-left: var(--space-3); border-left: 2px solid var(--border); }
  .source-line { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .source-icon { display: grid; flex: none; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--surface-soft); color: var(--muted); }
  .source-texts { display: grid; flex: 1; gap: 1px; min-width: 0; }
  .source-texts strong { overflow: hidden; font-size: 13px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .source-texts span { overflow: hidden; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .source-line .money { flex: none; font-size: 13px; font-weight: 750; }
  .reason-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .reason-chips li { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: var(--radius-sm); background: var(--surface-soft); color: var(--muted); font-size: 11px; font-weight: 560; }
  .pair-actions { display: grid; gap: var(--space-2); }
  .pair-actions .button { min-height: 34px; border-radius: 8px; }
  .show-more { width: 100%; }
  .list-empty { margin: 0; padding: var(--space-8) var(--space-5); border: 1px dashed var(--border); border-radius: 12px; color: var(--muted); text-align: center; }
  .list-skeleton { min-height: 220px; border-radius: 12px; background: var(--surface-soft); }
  .merged-row { display: flex; align-items: center; gap: var(--space-4); padding: var(--space-4); border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
  .merged-texts { display: grid; flex: 1; gap: 2px; min-width: 0; }
  .merged-texts strong { font-size: 14px; }
  .merged-texts span { overflow: hidden; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .merged-when { font-size: 11px !important; }
  .merged-amount { flex: none; font-size: 14px; font-weight: 750; }
  .merged-row .button { flex: none; min-height: 34px; border-radius: 8px; }
  .log-title { margin: 0; font-size: 14px; }
  .log-list { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
  .log-entry { display: grid; gap: var(--space-2); padding: var(--space-3) var(--space-4); border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
  .log-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); color: var(--muted); font-size: 12px; }
  .log-kind { padding: 2px 8px; border-radius: var(--radius-sm); background: var(--surface-soft); color: var(--fg); font-weight: 720; }
  .log-kind[data-kind="confirmed"] { background: var(--accent-soft); color: var(--accent); }
  .merge-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 14px var(--space-5); border-top: 1px solid var(--border); }
  .merge-footer p { display: flex; flex: 1; align-items: center; gap: 8px; min-width: 220px; margin: 0; color: var(--muted); font-size: 12px; }
  .merge-footer p :global(svg) { flex: none; }
  .head-link:focus-visible, .merge-tabs button:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent) 18%, transparent); }

  @media (max-width: 760px) {
    .pair-card { grid-template-columns: minmax(0, 1fr); gap: var(--space-3); }
    .pair-actions { grid-template-columns: 1fr 1fr; }
    .head-titles p { display: none; }
    .merged-row { flex-wrap: wrap; }
  }
</style>
