<script lang="ts">
  import { tick } from "svelte";
  import { t } from "$lib/i18n/i18n.ts";
  import type { AccountRowDto } from "$lib/shared-ledger/types.ts";
  import type { DataIssueCreateInput } from "./types.ts";

  export let open = false;
  export let account: AccountRowDto | null = null;
  export let onSubmit: (input: DataIssueCreateInput) => Promise<void>;

  let note = "";
  let submitting = false;
  let errorMessage = "";
  let dialog: HTMLDialogElement | null = null;

  $: primaryAmount = account?.amountLines[0] ?? { currency: "TWD", value: 0 };
  $: if (open) {
    void tick().then(() => {
      if (dialog && !dialog.open) dialog.showModal();
    });
  } else if (dialog?.open) {
    dialog.close();
  }

  function close() {
    if (submitting) return;
    open = false;
    if (dialog?.open) dialog.close();
  }

  function closeFromBackdrop(event: MouseEvent) {
    if (event.target === dialog) close();
  }

  async function submit() {
    if (!account || submitting) return;
    submitting = true;
    errorMessage = "";
    try {
      await onSubmit({ account, fieldKey: "balance", note });
      note = "";
      close();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      submitting = false;
    }
  }
</script>

{#if account}
  <dialog
    bind:this={dialog}
    class="modal-panel report-modal"
    aria-labelledby="report-title"
    onclose={() => (open = false)}
    oncancel={(event) => { if (submitting) event.preventDefault(); else open = false; }}
    onclick={closeFromBackdrop}
  >
    <div class="modal-head">
      <div>
        <h2 id="report-title">{$t.dataIssues.reportProblem}</h2>
        <p class="lead">{$t.dataIssues.reportProblemHint}</p>
      </div>
      <button class="modal-close" type="button" aria-label={$t.common.close} disabled={submitting} onclick={close}>×</button>
    </div>
    <form class="modal-body report-form" onsubmit={(event) => { event.preventDefault(); submit(); }}>
      <dl class="report-context">
        <div><dt>{$t.dataIssues.account}</dt><dd>{account.label}</dd></div>
        <div><dt>{$t.dataIssues.field}</dt><dd>{$t.accounts.balance}</dd></div>
        <div>
          <dt>{$t.dataIssues.currentValue}</dt>
          <dd>{primaryAmount.value.toLocaleString()} {primaryAmount.currency}</dd>
        </div>
        <div><dt>{$t.dataIssues.dataDate}</dt><dd>{account.lastUpdated ?? "--"}</dd></div>
      </dl>
      <label class="note-field">
        <span>{$t.dataIssues.note}</span>
        <textarea bind:value={note} rows="3"></textarea>
      </label>
      {#if errorMessage}<p class="submit-error" role="alert">{errorMessage}</p>{/if}
      <div class="modal-footer">
        <button class="button secondary" type="button" disabled={submitting} onclick={close}>{$t.common.cancel}</button>
        <button class="button primary" type="submit" disabled={submitting}>{$t.dataIssues.createIssue}</button>
      </div>
    </form>
  </dialog>
{/if}

<style>
  .report-modal {
    width: min(680px, calc(100vw - 40px));
    padding: 0;
  }

  .report-modal::backdrop {
    background: rgba(14, 18, 28, 0.44);
    backdrop-filter: blur(10px) saturate(0.84);
  }

  .report-form {
    display: grid;
    gap: var(--space-5);
    padding: var(--space-5);
  }

  .report-context {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4);
    margin: 0;
  }

  .report-context div,
  .note-field {
    display: grid;
    gap: var(--space-2);
  }

  .report-context dt,
  .note-field span {
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
  }

  .report-context dd {
    margin: 0;
    font-weight: 700;
  }

  textarea {
    width: 100%;
    min-height: 96px;
    padding: var(--space-3);
    resize: vertical;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--fg);
    font: inherit;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .submit-error { margin: 0; color: var(--danger, #b42318); }

  @media (max-width: 620px) {
    .report-context { grid-template-columns: 1fr; }
  }
</style>
