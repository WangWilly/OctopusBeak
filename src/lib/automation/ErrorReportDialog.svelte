<script lang="ts">
  import { onDestroy } from "svelte";
  import Modal from "$lib/shared-shell/components/Modal.svelte";
  import type { OctopusBeakApi } from "$lib/desktop/api.ts";
  import { t } from "$lib/i18n/i18n.ts";
  import { MAX_NOTE_LENGTH, type ErrorReportPayload } from "./error-report-contract.ts";
  import {
    closeAllowed,
    createPreviewRefresher,
    sendAllowed,
    sendErrorReport,
    type ErrorReportStatus,
    type ErrorReportTarget,
  } from "./error-report-form.ts";

  export let target: ErrorReportTarget;
  export let port: Pick<OctopusBeakApi["errorReports"], "preview" | "send">;
  export let onClose: () => void;
  /** Where the send stands; the dialog opens for editing. */
  export let status: ErrorReportStatus = { kind: "editing" };

  let note = "";
  let email = "";
  let preview: ErrorReportPayload | null = null;
  const refresher = createPreviewRefresher((input) => port.preview(input), (payload) => (preview = payload));
  $: refresher.schedule({ ...target, note, email });
  onDestroy(() => refresher.cancel());

  async function send() {
    if (!sendAllowed(status)) return;
    status = { kind: "sending" };
    status = await sendErrorReport((input) => port.send(input), { ...target, note, email });
  }
</script>

<Modal
  titleId="error-report-title"
  title={$t.automation.errorReport.title}
  subtitleGap="loose"
  subtitle={$t.automation.errorReport.intro}
  width="min(760px, 100%)"
  closable={closeAllowed(status)}
  {onClose}
>
  <div class="modal-body report-body">
    {#if status.kind === "sent"}
      <p role="status">{$t.automation.errorReport.sent(status.id)}</p>
      <div class="report-actions">
        <button class="button" type="button" onclick={onClose}>{$t.common.close}</button>
      </div>
    {:else}
      <ul class="report-scope">
        <li>{$t.automation.errorReport.contains}</li>
        <li>{$t.automation.errorReport.neverContains}</li>
        <li>{$t.automation.errorReport.kept}</li>
      </ul>
      <label class="report-field">
        <span>{$t.automation.errorReport.noteLabel}</span>
        <textarea bind:value={note} maxlength={MAX_NOTE_LENGTH} rows="4" placeholder={$t.automation.errorReport.notePlaceholder}></textarea>
        <small>{$t.automation.errorReport.noteHint}</small>
      </label>
      <label class="report-field">
        <span>{$t.automation.errorReport.emailLabel}</span>
        <input type="email" bind:value={email} autocomplete="email" maxlength="254" />
        <small>{$t.automation.errorReport.emailHint}</small>
      </label>
      <details class="report-preview">
        <summary>{$t.automation.errorReport.preview}</summary>
        <pre class="report-text">{preview ? JSON.stringify(preview, null, 2) : ""}</pre>
      </details>
      <div class="report-actions">
        {#if status.kind === "failed"}
          <span class="report-notice" role="alert">{$t.automation.errorReport.failed[status.reason]}</span>
        {/if}
        <button class="button secondary" type="button" onclick={onClose} disabled={!closeAllowed(status)}>{$t.automation.errorReport.cancel}</button>
        <button class="button" type="button" onclick={() => void send()} disabled={!sendAllowed(status)} aria-busy={status.kind === "sending"}>
          {status.kind === "sending" ? $t.automation.errorReport.sending : $t.automation.errorReport.send}
        </button>
      </div>
    {/if}
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
    margin: var(--space-2) 0 0;
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

  .report-field {
    display: grid;
    gap: var(--space-1);
    font-size: 13px;
  }

  .report-field textarea,
  .report-field input {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
    font: inherit;
  }

  .report-field small,
  .report-preview summary {
    color: var(--muted);
    font-size: 12px;
  }

  .report-preview summary {
    cursor: pointer;
  }
</style>
