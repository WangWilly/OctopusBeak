<script lang="ts">
  import Modal from "$lib/shared-shell/components/Modal.svelte";
  import type { OctopusBeakApi } from "$lib/desktop/api.ts";
  import { t } from "$lib/i18n/i18n.ts";
  import type { StructureReport, StructureReportNotice } from "./structure-report-state.ts";

  export let report: StructureReport;
  export let port: Pick<OctopusBeakApi["automation"], "openPreviewStructureReportIssue">;
  export let onClose: () => void;
  /** What the last copy or Open issue did; empty when the dialog opens. */
  export let notice: StructureReportNotice | null = null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(report.text);
      notice = "copied";
    } catch {
      notice = "copyFailed";
    }
  }

  async function openIssue() {
    try {
      await port.openPreviewStructureReportIssue(report.taskId);
    } catch {
      notice = "openIssueFailed";
    }
  }
</script>

<Modal
  titleId="structure-report-title"
  title={$t.automation.structureReport.title}
  subtitleGap="loose"
  subtitle={$t.automation.structureReport.intro}
  width="min(760px, 100%)"
  {onClose}
>
  <div class="modal-body report-body">
    <ul class="report-scope">
      <li>{$t.automation.structureReport.contains}</li>
      <li>{$t.automation.structureReport.neverContains}</li>
      <li>{$t.automation.structureReport.sending}</li>
    </ul>
    <pre class="report-text">{report.text}</pre>
    <div class="report-actions">
      {#if notice}
        <span class="report-notice" role="status">{$t.automation.structureReport[notice]}</span>
      {/if}
      <button class="button secondary" type="button" onclick={() => void copy()}>{$t.automation.structureReport.copy}</button>
      <button class="button" type="button" onclick={() => void openIssue()}>{$t.automation.structureReport.openIssue}</button>
    </div>
  </div>
</Modal>

<style>
  .report-body {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-5);
  }

  .report-scope {
    display: grid;
    gap: var(--space-2);
    margin: 0;
    padding-left: var(--space-5);
    font-size: 13px;
  }

  .report-text {
    max-height: 360px;
    margin: 0;
    padding: var(--space-3);
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    font-family: var(--font-mono);
    font-size: 12px;
    white-space: pre;
    user-select: text;
  }

  .report-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .report-notice {
    margin-right: auto;
    color: var(--muted);
    font-size: 13px;
  }
</style>
