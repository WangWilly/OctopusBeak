<script lang="ts">
  import { tick } from "svelte";
  import { ListFilter, Search, X } from "@lucide/svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import Modal from "$lib/shared-shell/components/Modal.svelte";
  import InstitutionLogo from "$lib/institutions/InstitutionLogo.svelte";
  import { institutionLogo } from "$lib/institutions/institutions.ts";
  import { MAX_CATEGORIZATION_TARGETS } from "../../financial/page-actions.ts";
  import type { PersonalCategoryCode } from "../../../ledger/canonical/personal-category-codes.ts";
  import { SPENDING_CATEGORY_GROUP_BY_CODE, type SpendingCategoryGroup } from "../category-groups.ts";
  import {
    classifyInboxList,
    classifyGroupCodes,
    classifyKeyCommand,
    followingKey,
    keepsMerchantFilter,
    movedKey,
    type ClassifyMode,
    type ClassifyView,
  } from "../classify-inbox.ts";
  import type { ClassifyApplyTargets, ClassifyMerchantGroup } from "../classify-queue.ts";
  import type { ClassifyQueueStore } from "../classify-queue-store.ts";
  import type { SpendingClassifyDetails, SpendingClassifyQueueItem } from "../model.ts";
  import type { SpendingPageActionOutcome } from "../purchase-spending-session.ts";
  import { institutionKeyLogo, plainDecimalText, monthDayText, paymentText } from "../spending-display.ts";
  import CategoryKeyPicker from "./CategoryKeyPicker.svelte";
  import { moneyTotals } from "$lib/shared-money/exact-money.ts";
  import { moneyText } from "./money-text.ts";

  export let queue: ClassifyQueueStore;
  /** Sets, or with null clears, the user's category on these purchases in one commit. */
  export let onApply: (purchaseIds: readonly string[], categoryCode: PersonalCategoryCode | null) => Promise<SpendingPageActionOutcome>;
  export let onClose: () => void;
  /** Another Spending action is running; the page takes one action at a time. */
  export let busy = false;

  type Toast =
    | Readonly<{ kind: "applied"; purchaseIds: readonly string[] }>
    | Readonly<{ kind: "undone"; count: number }>;

  const state = queue.state;
  let mode: ClassifyMode = "time";
  let query = "";
  /** 「逐筆看」: the by-time list narrowed to one merchant group. */
  let merchantFilter: ClassifyMerchantGroup | null = null;
  let currentKey: string | null = null;
  let shownKeys: readonly string[] = [];
  let group: SpendingCategoryGroup | null = null;
  let code: PersonalCategoryCode | null = null;
  let saving = false;
  let toast: Toast | null = null;
  let notice = "";
  let list: HTMLElement | null = null;
  let searchInput: HTMLInputElement | null = null;

  $: items = $state.items ?? [];
  $: view = { mode, query, merchantKey: mode === "merchant" ? null : merchantFilter?.key ?? null } satisfies ClassifyView;
  $: inbox = classifyInboxList(items, view);
  $: ({ purchaseRows, merchantRows, keys, searchTargets } = inbox);
  $: followRows(keys);
  $: currentTargets = inbox.currentTargets(currentKey);
  $: categoryText = code ? categoryLabel(code) : "";
  $: disabled = saving || busy;

  /** 「居家 › 資訊與通訊」, or one name when the code reads as its group, such as 交通. */
  function categoryLabel(value: PersonalCategoryCode) {
    const groupName = $t.spending.categoryGroups[SPENDING_CATEGORY_GROUP_BY_CODE[value]];
    const codeName = $t.spending.personalCategories[value];
    return groupName === codeName ? codeName : `${groupName} › ${codeName}`;
  }

  function followRows(next: readonly string[]) {
    currentKey = followingKey(shownKeys, next, currentKey);
    shownKeys = next;
  }

  function chooseMode(next: ClassifyMode) {
    if (next === mode) return;
    mode = next;
    merchantFilter = null;
    shownKeys = [];
    currentKey = null;
  }

  function reviewEach(entry: ClassifyMerchantGroup) {
    mode = "time";
    merchantFilter = entry;
    query = "";
    shownKeys = [];
    currentKey = null;
    void focusCurrent();
  }

  function showAll() {
    merchantFilter = null;
    void focusCurrent();
  }

  function pickGroup(next: SpendingCategoryGroup) {
    group = next;
    code = classifyGroupCodes(next)[0]!;
  }

  function pickCode(next: PersonalCategoryCode) {
    group = SPENDING_CATEGORY_GROUP_BY_CODE[next];
    code = next;
  }

  function select(key: string) {
    currentKey = key;
  }

  /** Focus follows the current row, so the ring shows where the next key lands. */
  async function focusCurrent() {
    await tick();
    const row = currentKey === null ? null : list?.querySelector<HTMLElement>(`[data-classify-row="${CSS.escape(currentKey)}"]`);
    if (row) {
      row.focus({ preventScroll: true });
      // A row taller than the list, an invoice with many items, shows its head first.
      const tall = list !== null && row.getBoundingClientRect().height > list.getBoundingClientRect().height;
      row.scrollIntoView({ block: tall ? "start" : "nearest" });
    } else {
      searchInput?.focus();
    }
  }

  async function apply(targets: ClassifyApplyTargets | null, scope: "current" | "search") {
    if (!targets?.purchaseIds.length || !code || disabled) return;
    const shown = view;
    saving = true;
    notice = "";
    const result = await onApply(targets.purchaseIds, code);
    saving = false;
    if (result.status === "committed") {
      toast = { kind: "applied", purchaseIds: targets.purchaseIds };
      group = null;
      code = null;
      if (scope === "search") query = "";
      if (merchantFilter && !keepsMerchantFilter(items, shown, targets.purchaseIds)) merchantFilter = null;
      queue.committed(targets.purchaseIds, result.knowledgeAt);
    } else {
      // A failed call may still have committed, so only a refusal can say nothing was written.
      notice = result.status === "failed" ? $t.classifyInbox.unconfirmed : $t.classifyInbox.conflict;
      queue.reload();
    }
    void focusCurrent();
  }

  async function undo() {
    if (toast?.kind !== "applied" || disabled) return;
    const { purchaseIds } = toast;
    saving = true;
    notice = "";
    const result = await onApply(purchaseIds, null);
    saving = false;
    if (result.status === "committed") {
      toast = { kind: "undone", count: purchaseIds.length };
      queue.committed([], result.knowledgeAt);
    } else {
      notice = result.status === "failed" ? $t.classifyInbox.undoUnconfirmed : $t.classifyInbox.undoRefused;
      queue.reload();
    }
    void focusCurrent();
  }

  function typing(target: EventTarget | null) {
    return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
    const command = classifyKeyCommand(event.key, group);
    if (!command) return;
    // Enter on a control activates that control.
    if (command.kind === "apply" && event.target instanceof HTMLElement && event.target.closest("button, a")) return;
    event.preventDefault();
    // A pick made during a save would be cleared when the save lands, so keys wait for it.
    if (disabled && command.kind !== "move") return;
    if (command.kind === "move") {
      currentKey = movedKey(keys, currentKey, command.delta);
      void focusCurrent();
    } else if (command.kind === "group") {
      pickGroup(command.group);
    } else if (command.kind === "code") {
      pickCode(command.code);
    } else {
      void apply(currentTargets, "current");
    }
  }

  function onSearchKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      query = "";
    } else if (event.key === "ArrowDown" || (event.key === "Enter" && !event.isComposing)) {
      event.preventDefault();
      void focusCurrent();
    }
  }

  function amountText(item: SpendingClassifyQueueItem) {
    return item.amount ? moneyText(item.amount, $locale) : $t.purchaseSpending.amountUnavailable;
  }

  /** The paying Institution's logo; an invoice-only purchase shows the e-invoice platform's. */
  function paymentLogo(item: SpendingClassifyQueueItem) {
    if (!item.payment) return institutionLogo("einvoice");
    return institutionKeyLogo(item.payment.institution);
  }

  function accountText(item: SpendingClassifyQueueItem) {
    return item.payment
      ? paymentText($t, item.payment, { institution: item.payment.institution, cardMask: item.payment.cardMask, billingPeriod: null })
      : $t.classifyInbox.noPayment;
  }

  function hasDetails(details: SpendingClassifyDetails) {
    return details.time !== null || details.bankDescription !== null || details.items.length > 0;
  }

  /** 「衛生紙 ×2」: a quantity of one goes unsaid. */
  function itemText(item: SpendingClassifyDetails["items"][number]) {
    const name = item.name ?? $t.purchaseSpending.itemNameUnavailable;
    if (!item.quantity) return name;
    const quantity = plainDecimalText(item.quantity);
    return quantity === "1" ? name : `${name} ×${quantity}`;
  }

  /** A merchant member's items, every name in full. */
  function itemNames(details: SpendingClassifyDetails) {
    return details.items.map((item) => item.name ?? $t.purchaseSpending.itemNameUnavailable).join("、");
  }

  function dateRange(members: readonly SpendingClassifyQueueItem[]) {
    const dates = members.map((item) => item.date).sort();
    const first = dates[0], last = dates.at(-1);
    return !first || !last ? "" : first === last ? monthDayText(first) : `${monthDayText(first)} – ${monthDayText(last)}`;
  }
</script>

{#snippet payment(item: SpendingClassifyQueueItem, size: number)}
  <span class="payment">{#if paymentLogo(item)}<InstitutionLogo institution={paymentLogo(item)} {size} />{/if}{accountText(item)}</span>
{/snippet}

{#snippet details(facts: SpendingClassifyDetails)}
  <div class="row-details" data-classify-details>
    {#if facts.time !== null || facts.bankDescription !== null}
      <p class="detail-line">
        {#if facts.time !== null}<span class="num" data-classify-time>{facts.time}</span>{/if}
        {#if facts.bankDescription !== null}
          <span class="bank-description" data-classify-bank-description><span class="detail-label">{$t.classifyInbox.bankDescription}</span>{facts.bankDescription}</span>
        {/if}
      </p>
    {/if}
    {#if facts.items.length > 0}
      <ul class="detail-items" data-classify-items={facts.items.length}>
        {#each facts.items as line, index (index)}
          <li>
            <span class="item-name">{itemText(line)}</span>
            <span class="money" data-sensitive>{line.amount ? moneyText(line.amount, $locale) : "—"}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/snippet}

<svelte:window onkeydown={onKeydown} />

<Modal
  titleId="spending-classify-title"
  title={$t.classifyInbox.title}
  subtitle={$t.classifyInbox.subtitle(items.length)}
  {onClose}
  closable={!saving}
  width="min(880px, 100%)"
  height="min(760px, calc(100vh - 40px))"
>
  <div class="toolbar">
    <div class="filters mode" role="group" aria-label={$t.classifyInbox.modeAria}>
      <button type="button" class="filter-btn" aria-pressed={mode === "time"} data-classify-mode="time" onclick={() => chooseMode("time")}>{$t.classifyInbox.byTime}</button>
      <button type="button" class="filter-btn" aria-pressed={mode === "merchant"} data-classify-mode="merchant" onclick={() => chooseMode("merchant")}>{$t.classifyInbox.byMerchant}</button>
    </div>
    <label class="search-field">
      <Search size={15} strokeWidth={2} aria-hidden="true" />
      <input
        type="search"
        class="search"
        placeholder={$t.classifyInbox.search}
        aria-label={$t.classifyInbox.search}
        bind:value={query}
        bind:this={searchInput}
        onkeydown={onSearchKeydown}
        data-classify-search
      />
    </label>
    {#if merchantFilter && mode !== "merchant"}
      <span class="merchant-filter" data-classify-merchant-filter>
        <ListFilter size={14} strokeWidth={2} aria-hidden="true" />{$t.classifyInbox.merchantOnly(merchantFilter.displayName ?? merchantFilter.key)}
        <button type="button" class="text-button" onclick={showAll}><X size={13} strokeWidth={2} aria-hidden="true" />{$t.classifyInbox.showAll}</button>
      </span>
    {/if}
  </div>

  {#if notice}
    <p class="notice danger" role="alert" data-classify-notice>{notice}</p>
  {/if}

  <div class="modal-body list-body" bind:this={list}>
    {#if $state.items === null}
      {#if $state.error}
        <p class="notice danger" role="alert">
          {$t.classifyInbox.loadFailed} {$state.error}
          <button type="button" class="text-button" disabled={$state.loading} data-classify-retry onclick={() => queue.reload()}>{$t.classifyInbox.retry}</button>
        </p>
      {:else}
        <div class="list-skeleton" role="status" aria-label={$t.common.loading}></div>
      {/if}
    {:else if items.length === 0}
      <p class="list-empty" data-classify-empty>{$t.classifyInbox.empty}</p>
    {:else if keys.length === 0}
      <p class="list-empty">{$t.classifyInbox.noMatch}</p>
    {:else}
      <div class="rows" role="listbox" aria-label={$t.classifyInbox.listAria} aria-busy={saving || $state.loading}>
        {#if mode !== "merchant"}
          {#each purchaseRows as item (item.purchaseId)}
            <div
              class="row"
              role="option"
              tabindex={item.purchaseId === currentKey ? 0 : -1}
              aria-selected={item.purchaseId === currentKey}
              data-classify-row={item.purchaseId}
              onclick={() => select(item.purchaseId)}
              onkeydown={onKeydown}
            >
              <div class="row-head">
                <span class="row-texts">
                  <strong>{item.title ?? $t.purchaseSpending.merchantUnavailable}</strong>
                  <span class="row-meta">{monthDayText(item.date)} · {@render payment(item, 14)}</span>
                </span>
                <span class="money" data-sensitive>{amountText(item)}</span>
              </div>
              {#if item.purchaseId === currentKey && hasDetails(item.details)}
                {@render details(item.details)}
              {/if}
            </div>
          {/each}
        {:else}
          {#each merchantRows as { group: entry, members, unmatched } (entry.key)}
            {@const current = entry.key === currentKey}
            <div
              class="row merchant"
              role="option"
              tabindex={current ? 0 : -1}
              aria-selected={current}
              data-classify-row={entry.key}
              onclick={() => select(entry.key)}
              onkeydown={onKeydown}
            >
              <div class="row-head">
                <span class="row-texts">
                  <strong>{entry.displayName ?? $t.purchaseSpending.merchantUnavailable}</strong>
                  <span>{$t.classifyInbox.purchases(members.length)} · {dateRange(members)}</span>
                </span>
                <span class="money" data-sensitive>{moneyTotals(members.flatMap((member) => member.amount ? [member.amount] : [])).map((total) => moneyText(total, $locale)).join(" / ")}</span>
              </div>
              {#if current}
                <ul class="members" data-classify-members>
                  {#each members as member (member.purchaseId)}
                    <li>
                      <span class="member-date num">{monthDayText(member.date)}</span>
                      <span class="member-title">
                        {member.title ?? $t.purchaseSpending.merchantUnavailable} · {@render payment(member, 12)}
                        {#if member.details.items.length > 0}<span class="member-items">{itemNames(member.details)}</span>{/if}
                      </span>
                      <span class="money" data-sensitive>{amountText(member)}</span>
                    </li>
                  {/each}
                </ul>
                {#if unmatched > 0}<p class="unmatched" data-classify-unmatched>{$t.classifyInbox.unmatched(unmatched)}</p>{/if}
                <button type="button" class="text-button" data-classify-review-each onclick={(event) => { event.stopPropagation(); reviewEach(entry); }}>{$t.classifyInbox.reviewEach}</button>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </div>

  <footer class="classify-footer">
    <CategoryKeyPicker {group} {code} {disabled} onGroup={pickGroup} onCode={pickCode} />
    <div class="apply-row">
      {#if query.trim() !== ""}
        <div class="search-apply" data-classify-search-apply>
          <span data-classify-search-covers={searchTargets.purchaseIds.length}>{$t.classifyInbox.searchCovers(searchTargets.purchaseIds.length)}</span>
          {#if searchTargets.overflow > 0}
            <span class="overflow" data-classify-overflow>{$t.classifyInbox.overflow(MAX_CATEGORIZATION_TARGETS, searchTargets.overflow)}</span>
          {/if}
          <button
            type="button"
            class="button"
            disabled={disabled || !code || searchTargets.purchaseIds.length === 0}
            data-classify-apply-search
            onclick={() => void apply(searchTargets, "search")}
          >{$t.classifyInbox.applySearch(searchTargets.purchaseIds.length, code ? categoryText : "…")}</button>
        </div>
      {/if}
      {#if currentTargets && currentTargets.overflow > 0}
        <span class="overflow" data-classify-current-overflow>{$t.classifyInbox.overflow(MAX_CATEGORIZATION_TARGETS, currentTargets.overflow)}</span>
      {/if}
      <button
        type="button"
        class="button primary apply-current"
        disabled={disabled || !code || !currentTargets || currentTargets.purchaseIds.length === 0}
        data-classify-apply
        data-classify-apply-count={currentTargets?.purchaseIds.length ?? 0}
        onclick={() => void apply(currentTargets, "current")}
      >
        {#if saving}{$t.classifyInbox.saving}
        {:else if !code}{$t.classifyInbox.keysApply}
        {:else if mode === "merchant" && currentTargets}{$t.classifyInbox.applyGroup(currentTargets.purchaseIds.length, categoryText)}
        {:else}{$t.classifyInbox.applyOne(categoryText)}{/if}
      </button>
    </div>
    <div class="status-row">
      <p class="keys" aria-hidden="true">
        <span><kbd>↑</kbd><kbd>↓</kbd> {$t.classifyInbox.keysMove}</span>
        <span><kbd>1</kbd>–<kbd>7</kbd> {$t.classifyInbox.keysGroup}</span>
        <span><kbd>A</kbd>–<kbd>F</kbd> {$t.classifyInbox.keysCode}</span>
        <span><kbd>↵</kbd> {$t.classifyInbox.keysApply}</span>
      </p>
      <div class="toast" role="status" data-classify-toast={toast?.kind ?? ""}>
        {#if toast?.kind === "applied"}
          {$t.classifyInbox.applied(toast.purchaseIds.length)}
          <button type="button" class="text-button" disabled={disabled} data-classify-undo onclick={() => void undo()}>{$t.classifyInbox.undo}</button>
        {:else if toast?.kind === "undone"}
          {$t.classifyInbox.undone(toast.count)}
        {/if}
      </div>
    </div>
  </footer>
</Modal>

<style>
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-5); border-bottom: 1px solid var(--border); }
  .mode { display: inline-flex; gap: 2px; padding: 4px; border-radius: 10px; background: var(--surface-soft); }
  .search-field { position: relative; display: flex; flex: 1; align-items: center; min-width: 200px; }
  .search-field :global(svg) { position: absolute; left: 12px; color: var(--muted); pointer-events: none; }
  .search-field .search { flex: 1; min-height: 36px; padding-left: 34px; }
  .merchant-filter { display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px 4px 10px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 650; }
  .text-button { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border: 0; border-radius: 6px; background: none; color: var(--accent); font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; }
  .text-button:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 3px; }
  .text-button:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent) 18%, transparent); }
  .notice { margin: var(--space-3) var(--space-5) 0; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius); font-size: 13px; }
  .notice.danger { border-color: color-mix(in oklch, var(--danger) 35%, var(--border)); background: color-mix(in oklch, var(--danger) 6%, var(--surface)); color: var(--danger); }
  .list-body { flex: 1; min-height: 0; padding: var(--space-3) var(--space-5); background: var(--bg); }
  .rows { display: grid; gap: 4px; }
  .row { display: grid; gap: var(--space-2); padding: 10px 14px; border: 1px solid transparent; border-radius: 10px; background: var(--surface); cursor: pointer; }
  .row:hover { border-color: var(--border); }
  .row[aria-selected="true"] { border-color: var(--fg); box-shadow: 0 1px 2px rgb(15 23 42 / 0.08); }
  .row:focus { outline: none; }
  .row:focus-visible { box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent) 18%, transparent); }
  .row-head { display: flex; align-items: center; gap: var(--space-4); }
  /* The paying Institution's logo leads its name, as on the account tables. */
  .payment { display: inline; }
  .payment :global(.institution-logo) { margin-right: 4px; vertical-align: -2px; }
  .row-texts .payment { overflow: visible; }
  /* The row being classified shows what its sources say beyond the title. */
  .row-details { display: grid; gap: 6px; padding: 8px 0 2px; border-top: 1px solid var(--border); font-size: 12px; }
  .detail-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px var(--space-3); margin: 0; color: var(--muted); }
  .detail-line .num { color: var(--fg); font-weight: 650; }
  .bank-description { display: inline-flex; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
  .detail-label { flex: none; font-weight: 650; }
  .detail-items { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
  /* Names wrap in full; each amount sits on its name's last line. */
  .detail-items li { display: flex; align-items: last baseline; justify-content: space-between; gap: var(--space-3); }
  .item-name { min-width: 0; overflow-wrap: anywhere; }
  .detail-items .money { flex: none; color: var(--muted); font-size: 12px; font-weight: 560; }
  .member-items { display: block; color: var(--muted); white-space: normal; overflow-wrap: anywhere; }
  .row-texts { display: grid; flex: 1; gap: 2px; min-width: 0; }
  .row-texts strong { overflow: hidden; font-size: 14px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .row-texts span { overflow: hidden; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .row .money { flex: none; font-size: 14px; font-weight: 720; white-space: nowrap; }
  .members { display: grid; gap: 2px; max-height: 220px; margin: 0; padding: 6px 0 0; overflow: auto; border-top: 1px solid var(--border); list-style: none; }
  .members li { display: flex; align-items: baseline; gap: var(--space-3); padding: 3px 0; font-size: 12px; }
  .member-date { flex: none; width: 44px; color: var(--muted); }
  .member-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .members .money { font-size: 12px; font-weight: 650; }
  .unmatched { margin: 0; color: var(--muted); font-size: 12px; }
  .row.merchant .text-button { justify-self: start; }
  .list-empty { margin: 0; padding: var(--space-8) var(--space-5); border: 1px dashed var(--border); border-radius: 12px; color: var(--muted); text-align: center; }
  .list-skeleton { min-height: 220px; border-radius: 12px; background: var(--surface-soft); }
  .classify-footer { display: grid; gap: var(--space-3); padding: var(--space-4) var(--space-5); border-top: 1px solid var(--border); }
  .apply-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-3); }
  .search-apply { display: flex; flex: 1; flex-wrap: wrap; align-items: center; gap: var(--space-2); min-width: 0; color: var(--muted); font-size: 12px; }
  .overflow { color: var(--warn); font-weight: 650; }
  .apply-current { min-width: 180px; }
  .status-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .keys { display: flex; flex-wrap: wrap; gap: var(--space-3); margin: 0; color: var(--muted); font-size: 12px; }
  .keys kbd { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 3px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-soft); font-family: var(--font-body); font-size: 11px; font-weight: 700; }
  .toast { display: inline-flex; align-items: center; gap: var(--space-2); font-size: 13px; font-weight: 650; }
  .toast:empty { display: none; }

  @media (max-width: 760px) {
    .keys { display: none; }
  }
</style>
