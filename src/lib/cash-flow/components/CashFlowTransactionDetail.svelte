<script lang="ts">
  import { tick } from "svelte";
  import { Check, Plus, Split, Tag, X } from "@lucide/svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import Modal from "$lib/shared-shell/components/Modal.svelte";
  import { moneyText } from "$lib/spending/components/money-text.ts";
  import { SPENDING_CATEGORY_GROUP_IDS, spendingCategoryCodesForGroup } from "$lib/spending/category-groups.ts";
  import { SPENDING_GROUP_COLORS, codeLabel, dayHeadingText, groupLabel } from "$lib/spending/spending-display.ts";
  import { PERSONAL_CATEGORY_CODES, isPersonalCategoryCode } from "../../../ledger/canonical/personal-category-codes.ts";
  import { absoluteExact, type ExactAmount } from "$lib/shared-money/exact-money.ts";
  import { NOTE_MAX_LENGTH, normalizeTagLabel, noteProblem, noteText, tagLabelProblem } from "$lib/financial/transaction-detail.ts";
  import type { CashFlowRow, CashFlowUserTag } from "../model.ts";
  import { accountInitial, accountLabel, rowCategoryText, rowTitle, signedAmount } from "../display.ts";
  import {
    allocationDraftState,
    allocationRequest,
    categoryRequest,
    detailRefusal,
    editableRow,
    initialAllocationLines,
    noteRequest,
    noteSaveEnabled,
    plainAmount,
    tagAddRequest,
    tagRemoveRequest,
    type AllocationDraftLine,
    type CashFlowDetailRequest,
  } from "../transaction-detail.ts";

  /** The row as the page last read it. */
  export let row: CashFlowRow;
  /** The period's rows, which a failed write names its refusal from once the page is read again. */
  export let rows: readonly CashFlowRow[];
  export let userTags: readonly CashFlowUserTag[];
  export let dataVersion: number;
  /** Send one write as a Financial page action; resolves once the page has read itself again (ADR 0136). */
  export let apply: (request: CashFlowDetailRequest) => Promise<void>;
  export let onClose: () => void;

  type Section = "category" | "allocation" | "note" | "tags";

  let busy: Section | null = null;
  let error: Readonly<{ section: Section; text: string }> | null = null;
  let saved: Section | null = null;
  let allocating = false;
  let lines: AllocationDraftLine[] = [];
  let noteDraft = row.details.note ?? "";
  let shownNote = row.details.note;
  let tagDraft = "";

  $: edit = editableRow(row) ? row.details.edit : null;
  $: currency = row.amount.currency;
  $: categorization = edit?.categorization ?? null;
  $: currentCode = categorization?.mode === "single" ? categorization.categoryCode : null;
  $: userCategory = categorization !== null && (categorization.mode === "allocated" || (categorization.mode === "single" && categorization.origin === "user"));
  $: draft = allocationDraftState(row, lines);
  // A note saved elsewhere, or a reload after a save, replaces the draft only while the person has not changed it.
  $: if (row.details.note !== shownNote) {
    if (noteDraft.trim() === (shownNote ?? "")) noteDraft = row.details.note ?? "";
    shownNote = row.details.note;
  }
  $: noteSavable = editableRow(row) && noteSaveEnabled(noteDraft, row);
  $: noteTooLong = noteProblem(noteDraft) !== null;
  $: appliedTags = new Set((edit?.tags ?? []).map((tag) => normalizeTagLabel(tag.label)));
  $: suggestions = userTags.filter((tag) => !appliedTags.has(normalizeTagLabel(tag.label))
    && (tagDraft.trim() === "" || normalizeTagLabel(tag.label).includes(normalizeTagLabel(tagDraft))));
  $: tagProblem = tagDraft.trim() === "" ? null : tagLabelProblem(tagDraft);

  function money(amount: ExactAmount, signed = false) {
    return moneyText({ ...amount, currency }, $locale, signed);
  }

  function dateLine(..._inputs: unknown[]) {
    const day = dayHeadingText(row.date, $locale);
    return [row.details.time ? `${day} ${row.details.time}` : day, accountLabel($t, row.details.account)].join(" · ");
  }

  function categoryState(..._inputs: unknown[]): string {
    const copy = $t.cashFlow.detail;
    if (!categorization || categorization.mode === "absent") return copy.categoryAbsent;
    if (categorization.mode === "allocated") return copy.categoryAllocated;
    return categorization.origin === "user" ? copy.categoryUser : copy.categoryAutomatic;
  }

  async function run(section: Section, request: CashFlowDetailRequest, after?: () => void) {
    if (busy !== null) return;
    busy = section;
    error = null;
    saved = null;
    try {
      await apply(request);
      // The page has been read again; let the reloaded row reach this component before the step that reads it.
      await tick();
      after?.();
      saved = section;
    } catch {
      // The worker's reason does not cross IPC; the page has been read again, so the reason is named from it.
      await tick();
      const refusal = detailRefusal(row.transactionId, rows);
      error = { section, text: refusal ? $t.cashFlow.detail.refusals[refusal] : $t.cashFlow.detail.failed };
    } finally {
      busy = null;
    }
  }

  function chooseCategory(code: string | null) {
    if (!editableRow(row)) return;
    if (code !== null && categorization?.mode === "single" && categorization.origin === "user" && code === currentCode) return;
    void run("category", categoryRequest(row, code, dataVersion), () => { allocating = false; });
  }

  function openAllocation() {
    if (!editableRow(row)) return;
    lines = initialAllocationLines(row, plainAmount);
    allocating = true;
    error = null;
  }

  function setLine(index: number, patch: Partial<AllocationDraftLine>) {
    lines = lines.map((line, at) => at === index ? { ...line, ...patch } : line);
  }

  function saveAllocation() {
    if (!editableRow(row) || draft.problem !== null) return;
    void run("allocation", allocationRequest(row, draft.components, dataVersion), () => { allocating = false; });
  }

  function saveNote(clear = false) {
    if (!editableRow(row) || (!clear && !noteSavable)) return;
    const note = clear ? null : noteText(noteDraft);
    // The draft follows the note the reload shows: clearing a user note may reveal a Derived one.
    void run("note", noteRequest(row, note, dataVersion), () => { noteDraft = row.details.note ?? ""; });
  }

  function addTag(label: string) {
    if (!editableRow(row) || tagLabelProblem(label) !== null) return;
    void run("tags", tagAddRequest(row, label, dataVersion), () => { tagDraft = ""; });
  }

  function removeTag(tagId: string) {
    if (!editableRow(row)) return;
    void run("tags", tagRemoveRequest(row, tagId, dataVersion));
  }

  function remainderText(..._inputs: unknown[]): string {
    const copy = $t.cashFlow.detail;
    if (draft.balance === 0) return copy.remainderExact;
    const amount = money(absoluteExact(draft.remainder));
    return draft.balance < 0 ? copy.remainderUnder(amount) : copy.remainderOver(amount);
  }
</script>

{#snippet status(section: Section)}
  {#if busy === section}<span class="status" role="status">{$t.cashFlow.detail.saving}</span>
  {:else if saved === section}<span class="status saved" role="status" data-detail-saved={section}><Check size={12} strokeWidth={2.4} aria-hidden="true" />{$t.cashFlow.detail.saved}</span>{/if}
{/snippet}

{#snippet errorLine(section: Section)}
  {#if error?.section === section}<p class="error" role="alert" data-detail-error={section}>{error.text}</p>{/if}
{/snippet}

<Modal titleId="cash-flow-detail-title" title={$t.cashFlow.detail.title} subtitle={dateLine(row, $t, $locale)} {onClose} closable={busy === null} width="min(640px, 100%)">
  <div class="modal-body body" data-transaction-detail={row.transactionId}>
    <header class="head">
      <span class="mark" aria-hidden="true">{accountInitial($t, row.details.account)}</span>
      <div class="head-text">
        <strong class="name">{rowTitle($t, row)}</strong>
        <span class="muted">{rowCategoryText($t, row)}</span>
      </div>
      <div class="head-amount">
        <strong class="money amount" class:positive={row.direction === "inflow" && row.cashFlow.class !== "not_counted"} data-sensitive data-detail-amount>
          {moneyText(signedAmount(row), $locale, row.cashFlow.class !== "not_counted")}
        </strong>
        {#if edit?.tags.length}
          <span class="tag-line">{#each edit.tags as tag (tag.tagId)}<span class="chip small">#{tag.label}</span>{/each}</span>
        {/if}
      </div>
    </header>

    {#if !edit}
      <p class="muted" data-detail-manual>{$t.cashFlow.detail.manual}</p>
      {#if row.details.note}
        <section class="block">
          <h3>{$t.cashFlow.detail.note}</h3>
          <p>{row.details.note}</p>
        </section>
      {/if}
    {:else}
      <section class="block" data-detail-category>
        <div class="block-head">
          <h3>{$t.cashFlow.detail.category}</h3>
          <span class="muted" data-detail-category-state>{categoryState(categorization, $t)}</span>
          {@render status("category")}
          {#if !allocating}{@render status("allocation")}{/if}
        </div>
        {#if !edit.categorizable}
          <p class="muted">{$t.cashFlow.detail.categoryNotApplicable}</p>
        {:else}
          <div class="groups">
            {#each SPENDING_CATEGORY_GROUP_IDS as group (group)}
              <fieldset>
                <legend><span class="dot" style:background={SPENDING_GROUP_COLORS[group]} aria-hidden="true"></span>{groupLabel($t, group)}</legend>
                <div class="codes">
                  {#each spendingCategoryCodesForGroup(group) as code (code)}
                    <button type="button" class="chip" aria-pressed={currentCode === code} disabled={busy !== null} data-detail-category-code={code} onclick={() => chooseCategory(code)}>
                      {#if currentCode === code}<Check size={12} strokeWidth={2.4} aria-hidden="true" />{/if}{codeLabel($t, code)}
                    </button>
                  {/each}
                </div>
              </fieldset>
            {/each}
          </div>
          <div class="actions">
            {#if userCategory}
              <button type="button" class="button" disabled={busy !== null} data-detail-restore-automatic onclick={() => chooseCategory(null)}>{$t.cashFlow.detail.restoreAutomatic}</button>
            {/if}
            {#if !allocating}
              <button type="button" class="button" disabled={busy !== null} data-detail-allocation-open onclick={openAllocation}>
                <Split size={14} strokeWidth={2} aria-hidden="true" />{categorization?.mode === "allocated" ? $t.cashFlow.detail.allocationEdit : $t.cashFlow.detail.allocationOpen}
              </button>
            {/if}
          </div>
          {#if categorization?.mode === "allocated" && !allocating}
            <ul class="parts" data-detail-allocation>
              {#each categorization.components as component (component.categoryCode)}
                <li><span>{isPersonalCategoryCode(component.categoryCode) ? codeLabel($t, component.categoryCode) : component.categoryCode}</span><span class="money" data-sensitive>{money(component.amount)}</span></li>
              {/each}
            </ul>
          {/if}
          {@render errorLine("category")}

          {#if allocating}
            <div class="allocation" data-detail-allocation-editor>
              <div class="block-head">
                <h3>{$t.cashFlow.detail.allocation}</h3>
                {@render status("allocation")}
              </div>
              <p class="muted">{$t.cashFlow.detail.allocationNote(money(row.amount))}</p>
              {#each lines as line, index (index)}
                <div class="line" data-allocation-line={index}>
                  <select aria-label={$t.cashFlow.detail.allocationCategory} value={line.categoryCode} onchange={(event) => setLine(index, { categoryCode: event.currentTarget.value })} data-allocation-category>
                    <option value="">{$t.cashFlow.detail.allocationChoose}</option>
                    {#each PERSONAL_CATEGORY_CODES as code (code)}<option value={code}>{codeLabel($t, code)}</option>{/each}
                  </select>
                  <input inputmode="decimal" aria-label={$t.cashFlow.detail.allocationAmount} value={line.amountText} oninput={(event) => setLine(index, { amountText: event.currentTarget.value })} data-allocation-amount />
                  <button type="button" class="icon-button" aria-label={$t.cashFlow.detail.allocationRemove} disabled={lines.length <= 1} onclick={() => lines = lines.filter((_, at) => at !== index)}><X size={14} strokeWidth={2} aria-hidden="true" /></button>
                </div>
              {/each}
              <button type="button" class="text-link add" onclick={() => lines = [...lines, { categoryCode: "", amountText: "" }]}><Plus size={13} strokeWidth={2.2} aria-hidden="true" />{$t.cashFlow.detail.allocationAdd}</button>
              <p class="remainder" class:exact={draft.balance === 0} data-allocation-remainder={draft.balance} data-sensitive>{remainderText(draft, $t, $locale)}</p>
              {#if draft.problem !== null && draft.problem !== "sum"}
                <p class="error" role="status" data-allocation-problem={draft.problem}>{$t.cashFlow.detail.allocationProblems[draft.problem]}</p>
              {/if}
              <div class="actions">
                <button type="button" class="button primary" disabled={busy !== null || draft.problem !== null} data-allocation-save onclick={saveAllocation}>{$t.cashFlow.detail.allocationSave}</button>
                <button type="button" class="button" disabled={busy !== null} onclick={() => allocating = false}>{$t.cashFlow.detail.allocationCancel}</button>
              </div>
              {@render errorLine("allocation")}
            </div>
          {/if}
          <p class="muted small" data-detail-spending-sync={edit.spendingPurchase}>{edit.spendingPurchase ? $t.cashFlow.detail.spendingSync : $t.cashFlow.detail.cashFlowOnly}</p>
        {/if}
      </section>

      <section class="block" data-detail-note>
        <div class="block-head">
          <h3><label for="cash-flow-detail-note">{$t.cashFlow.detail.note}</label></h3>
          {@render status("note")}
        </div>
        <textarea id="cash-flow-detail-note" rows="2" maxlength={NOTE_MAX_LENGTH + 50} placeholder={$t.cashFlow.detail.notePlaceholder} bind:value={noteDraft} data-detail-note-input></textarea>
        {#if noteTooLong}<p class="error" role="status">{$t.cashFlow.detail.noteTooLong}</p>{/if}
        <div class="actions">
          <button type="button" class="button primary" disabled={busy !== null || !noteSavable} data-detail-note-save onclick={() => saveNote()}>{$t.cashFlow.detail.noteSave}</button>
          {#if edit.userNote}
            <button type="button" class="button" disabled={busy !== null} data-detail-note-clear onclick={() => saveNote(true)}>{$t.cashFlow.detail.noteClear}</button>
          {/if}
        </div>
        {@render errorLine("note")}
      </section>

      <section class="block" data-detail-tags>
        <div class="block-head">
          <h3>{$t.cashFlow.detail.tags}</h3>
          {@render status("tags")}
        </div>
        <p class="muted small">{$t.cashFlow.detail.tagsNote}</p>
        {#if edit.tags.length > 0}
          <ul class="tag-list">
            {#each edit.tags as tag (tag.tagId)}
              <li class="chip applied" data-detail-tag={tag.label}>
                <Tag size={12} strokeWidth={2} aria-hidden="true" />{tag.label}
                <button type="button" class="chip-remove" aria-label={$t.cashFlow.detail.tagRemove(tag.label)} disabled={busy !== null} data-detail-tag-remove={tag.label} onclick={() => removeTag(tag.tagId)}><X size={12} strokeWidth={2.2} aria-hidden="true" /></button>
              </li>
            {/each}
          </ul>
        {/if}
        <form class="tag-form" onsubmit={(event) => { event.preventDefault(); addTag(tagDraft); }}>
          <input type="text" placeholder={$t.cashFlow.detail.tagPlaceholder} aria-label={$t.cashFlow.detail.tagPlaceholder} bind:value={tagDraft} data-detail-tag-input />
          <button type="submit" class="button" disabled={busy !== null || tagDraft.trim() === "" || tagProblem !== null} data-detail-tag-add>{$t.cashFlow.detail.tagAdd}</button>
        </form>
        {#if tagProblem}<p class="error" role="status">{$t.cashFlow.detail.tagProblems[tagProblem]}</p>{/if}
        {#if suggestions.length > 0}
          <div class="suggestions" aria-label={$t.cashFlow.detail.tagSuggestions} role="group">
            {#each suggestions.slice(0, 12) as tag (tag.tagId)}
              <button type="button" class="chip" disabled={busy !== null} data-detail-tag-suggestion={tag.label} onclick={() => addTag(tag.label)}>#{tag.label}</button>
            {/each}
          </div>
        {/if}
        {@render errorLine("tags")}
      </section>
    {/if}

    <section class="block source">
      <h3>{$t.cashFlow.detail.source}</h3>
      <dl>
        <dt>{$t.cashFlow.detail.account}</dt><dd>{accountLabel($t, row.details.account)}</dd>
        {#if row.details.description}<dt>{$t.cashFlow.detail.description}</dt><dd>{row.details.description}</dd>{/if}
        <dt>{$t.cashFlow.detail.currency}</dt><dd>{currency}</dd>
      </dl>
    </section>
  </div>
</Modal>

<style>
  .body {
    display: grid;
    gap: var(--space-5);
    padding: var(--space-5);
  }

  p {
    margin: 0;
  }

  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 720;
  }

  .muted {
    color: var(--muted);
    font-size: 12.5px;
  }

  .small {
    font-size: 12px;
  }

  .head {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-3);
  }

  .mark {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 9px;
    background: var(--surface-strong);
    color: white;
    font-weight: 750;
  }

  .head-text {
    display: grid;
    min-width: 0;
    gap: 2px;
  }

  .name {
    overflow: hidden;
    font-size: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .head-amount {
    display: grid;
    justify-items: end;
    gap: 4px;
  }

  .money {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }

  .amount {
    font-size: 22px;
  }

  .positive {
    color: oklch(47% 0.08 155);
  }

  .block {
    display: grid;
    gap: var(--space-3);
  }

  .block-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-left: auto;
    color: var(--muted);
    font-size: 12px;
  }

  .status.saved {
    color: oklch(47% 0.08 155);
  }

  .groups {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: var(--space-3);
  }

  fieldset {
    display: grid;
    align-content: start;
    gap: 6px;
    margin: 0;
    padding: 0;
    border: 0;
  }

  legend {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0;
    color: var(--muted);
    font-size: 12px;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
  }

  .codes,
  .suggestions,
  .tag-list,
  .tag-line {
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    align-items: center;
    gap: 6px;
  }

  .tag-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 28px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--fg);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }

  .chip[aria-pressed="true"] {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 680;
  }

  .chip:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .chip.small {
    min-height: 22px;
    padding: 0 8px;
    color: var(--muted);
    font-size: 11.5px;
    cursor: default;
  }

  .chip.applied {
    padding-right: 4px;
    border-color: transparent;
    background: var(--accent-soft);
    color: var(--accent);
    cursor: default;
  }

  .chip-remove {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: none;
    color: inherit;
    cursor: pointer;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .actions .button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
  }

  .parts {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 13px;
  }

  .parts li {
    display: flex;
    justify-content: space-between;
  }

  .allocation {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .line {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 140px 32px;
    gap: var(--space-2);
  }

  select,
  input,
  textarea {
    min-width: 0;
    min-height: 36px;
    padding: 0 var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
    font: inherit;
    font-size: 13px;
  }

  input[inputmode="decimal"] {
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  textarea {
    padding: var(--space-2);
    resize: vertical;
  }

  .add {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    justify-self: start;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .remainder {
    color: var(--danger);
    font-size: 13px;
    font-weight: 680;
  }

  .remainder.exact {
    color: oklch(47% 0.08 155);
  }

  .error {
    color: var(--danger);
    font-size: 12.5px;
  }

  .tag-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--space-2);
  }

  .source dl {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 6px 16px;
    margin: 0;
    font-size: 13px;
  }

  .source dt {
    color: var(--muted);
  }

  .source dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  @media (max-width: 560px) {
    .line {
      grid-template-columns: minmax(0, 1fr) 110px 32px;
    }
  }
</style>
