<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "$lib/i18n/i18n.ts";

  /** ADR 0078: asked once per install; only an explicit answer closes it. */
  export let onAnswer: (enabled: boolean) => void;

  let declineButton: HTMLButtonElement | undefined;

  // Neither answer is preselected by focus on the yes button.
  onMount(() => declineButton?.focus());
</script>

<div class="modal open usage-prompt" data-usage-statistics-prompt>
  <div class="modal-backdrop" aria-hidden="true"></div>
  <div
    class="modal-panel usage-prompt-panel"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="usage-prompt-title"
    aria-describedby="usage-prompt-body"
  >
    <div class="usage-prompt-content">
      <h2 id="usage-prompt-title">{$t.usageStatisticsPrompt.title}</h2>
      <div id="usage-prompt-body">
        <p>{$t.usageStatisticsPrompt.body}</p>
        <dl>
          <dt>{$t.usageStatisticsPrompt.sentLabel}</dt>
          <dd>{$t.usageStatisticsPrompt.sent}</dd>
          <dt>{$t.usageStatisticsPrompt.neverSentLabel}</dt>
          <dd>{$t.usageStatisticsPrompt.neverSent}</dd>
        </dl>
        <p class="usage-prompt-note">{$t.usageStatisticsPrompt.note}</p>
      </div>
    </div>
    <div class="usage-prompt-actions">
      <button
        bind:this={declineButton}
        id="usage-prompt-decline"
        class="button"
        type="button"
        on:click={() => onAnswer(false)}
      >
        {$t.usageStatisticsPrompt.decline}
      </button>
      <button id="usage-prompt-accept" class="button primary" type="button" on:click={() => onAnswer(true)}>
        {$t.usageStatisticsPrompt.accept}
      </button>
    </div>
  </div>
</div>

<style>
  .usage-prompt {
    z-index: 60;
  }

  .usage-prompt-panel {
    width: min(520px, 100%);
  }

  .usage-prompt-content {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-5);
    overflow: auto;
    line-height: 1.6;
  }

  .usage-prompt-content h2 {
    margin: 0;
    font-size: 20px;
  }

  .usage-prompt-content p,
  .usage-prompt-content dl {
    margin: 0;
  }

  .usage-prompt-content dl {
    display: grid;
    gap: var(--space-1);
    margin-top: var(--space-3);
  }

  .usage-prompt-content dt {
    font-weight: 700;
  }

  .usage-prompt-content dd {
    margin: 0 0 var(--space-2);
    color: var(--muted);
  }

  .usage-prompt-note {
    color: var(--muted);
    font-size: 13px;
  }

  .usage-prompt-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--border);
  }
</style>
