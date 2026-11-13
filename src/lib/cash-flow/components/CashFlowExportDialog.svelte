<script lang="ts">
  import { Download } from "@lucide/svelte";
  import { t } from "$lib/i18n/i18n.ts";
  import Modal from "$lib/shared-shell/components/Modal.svelte";
  import { downloadCsv } from "$lib/shared-accounts/download-csv.ts";
  import type { CashFlowPeriod, CashFlowRow } from "../model.ts";
  import { cashFlowCsv, cashFlowCsvName, cashFlowCsvRows, type CashFlowCsvContent } from "../csv.ts";

  export let period: CashFlowPeriod;
  export let periodText: string;
  /** Every in-period row, whatever the search or filters. */
  export let periodRows: readonly CashFlowRow[];
  /** The rows the list shows now, under the search and filters; null when neither narrows it. */
  export let shownRows: readonly CashFlowRow[] | null;
  export let onClose: () => void;

  let content: CashFlowCsvContent = "flow";
  let searchOnly = shownRows !== null;

  $: source = searchOnly && shownRows !== null ? shownRows : periodRows;
  $: flowCount = cashFlowCsvRows(source, "flow").length;
  $: allCount = cashFlowCsvRows(source, "flow_and_transfers").length;
  $: csv = cashFlowCsv(source, content, $t);
  $: preview = csv.replace(/^﻿/u, "").split("\r\n").slice(0, 3).join("\n");
  $: name = cashFlowCsvName($t, period);
  $: columns = $t.cashFlow.csv.columns;
  $: columnList = [columns.date, columns.time, columns.description, columns.category, columns.account, columns.amount, columns.currency,
    columns.note, columns.sourceDescription, ...(content === "flow_and_transfers" ? [columns.pairing] : [])];
  $: exportCount = content === "flow" ? flowCount : allCount;

  function download() {
    downloadCsv(name, csv);
    onClose();
  }
</script>

<Modal titleId="cash-flow-export-title" title={$t.cashFlow.csv.title} subtitle={$t.cashFlow.csv.subtitle} {onClose} width="min(560px, 100%)">
  <div class="modal-body body" data-cash-flow-export>
    <section class="field">
      <h3>{$t.cashFlow.csv.period}</h3>
      <p data-export-period>{periodText}</p>
    </section>

    <section class="field">
      <h3>{$t.cashFlow.csv.content}</h3>
      <label class="choice">
        <input type="radio" name="cash-flow-export-content" value="flow" bind:group={content} data-export-content="flow" />
        <span><strong>{$t.cashFlow.csv.flow}</strong><span class="muted">{$t.cashFlow.csv.flowNote(flowCount)}</span></span>
      </label>
      <label class="choice">
        <input type="radio" name="cash-flow-export-content" value="flow_and_transfers" bind:group={content} data-export-content="flow_and_transfers" />
        <span><strong>{$t.cashFlow.csv.flowAndTransfers}</strong><span class="muted">{$t.cashFlow.csv.flowAndTransfersNote(allCount)}</span></span>
      </label>
      <label class="choice">
        <input type="checkbox" bind:checked={searchOnly} disabled={shownRows === null} data-export-search-only />
        <span><strong>{$t.cashFlow.csv.searchOnly}</strong><span class="muted">{shownRows === null ? $t.cashFlow.csv.searchOnlyNone : $t.cashFlow.csv.searchOnlyCount(shownRows.length)}</span></span>
      </label>
    </section>

    <section class="field">
      <h3>{$t.cashFlow.csv.columnsTitle}</h3>
      <p class="chips">{#each columnList as column (column)}<span class="chip-tag">{column}</span>{/each}</p>
    </section>

    <section class="field">
      <h3>{$t.cashFlow.csv.format}</h3>
      <dl class="format">
        <dt>{$t.cashFlow.csv.encoding}</dt><dd>{$t.cashFlow.csv.encodingValue}</dd>
        <dt>{$t.cashFlow.csv.amountRule}</dt><dd>{$t.cashFlow.csv.amountRuleValue}</dd>
      </dl>
    </section>

    <section class="field">
      <h3>{$t.cashFlow.csv.preview}</h3>
      <pre class="preview" data-sensitive data-export-preview>{preview}</pre>
    </section>

    <section class="field">
      <h3>{$t.cashFlow.csv.fileNameLabel}</h3>
      <p class="num" data-export-name>{name}.csv</p>
    </section>

    <footer class="foot">
      {#if exportCount === 0}<span class="muted">{$t.cashFlow.csv.empty}</span>{/if}
      <button type="button" class="button" onclick={onClose}>{$t.cashFlow.csv.cancel}</button>
      <button type="button" class="button primary" disabled={exportCount === 0} data-export-download onclick={download}><Download size={14} strokeWidth={2} aria-hidden="true" />{$t.cashFlow.csv.download}</button>
    </footer>
  </div>
</Modal>

<style>
  .body {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-5);
  }

  .field {
    display: grid;
    gap: var(--space-2);
  }

  h3 {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
  }

  p {
    margin: 0;
    font-size: 13.5px;
  }

  .muted {
    color: var(--muted);
    font-size: 12.5px;
  }

  .choice {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    font-size: 13.5px;
  }

  .choice > span {
    display: grid;
    gap: 2px;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip-tag {
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 12px;
  }

  .format {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px var(--space-3);
    margin: 0;
    font-size: 13px;
  }

  .format dt {
    color: var(--muted);
  }

  .format dd {
    margin: 0;
  }

  .preview {
    margin: 0;
    padding: var(--space-3);
    overflow-x: auto;
    border-radius: var(--radius);
    background: var(--surface-soft);
    font-size: 12px;
    line-height: 1.6;
  }

  .foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
  }
</style>
