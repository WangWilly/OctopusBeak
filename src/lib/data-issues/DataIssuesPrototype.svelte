<script lang="ts">
  import { Check, ChevronRight } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { slide } from "svelte/transition";
  import { t } from "$lib/i18n/i18n.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import {
    canConfirmQuarantine,
    reportDataIssue,
    seedDataIssuePrototype,
    transitionDataIssuePrototype,
    type DataIssueReportContext,
    type DataIssueStatus,
    type PrototypeEvent,
  } from "./prototype-model.ts";

  let state = seedDataIssuePrototype();
  let liveMessage = "";
  let reduceMotion = false;

  onMount(() => {
    reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const raw = sessionStorage.getItem("octopusbeak-data-issue-report");
    if (!raw) return;
    try {
      state = reportDataIssue(state, JSON.parse(raw) as DataIssueReportContext);
    } finally {
      sessionStorage.removeItem("octopusbeak-data-issue-report");
    }
  });

  function send(event: PrototypeEvent, announcement = "") {
    state = transitionDataIssuePrototype(state, event);
    liveMessage = announcement;
  }

  async function confirmQuarantine() {
    send({ type: "start-quarantine" }, $t.dataIssues.quarantineWorking);
    await new Promise((resolve) => setTimeout(resolve, 650));
    send({ type: "complete-quarantine" }, $t.dataIssues.quarantineComplete);
  }

  function formatAmount(value: number, currency = state.issue.currency) {
    return `${new Intl.NumberFormat().format(value)} ${currency}`;
  }

  function labelForStatus(status: DataIssueStatus) {
    return {
      open: $t.dataIssues.open,
      investigating: $t.dataIssues.investigating,
      resolved: $t.dataIssues.resolved,
      restored: $t.dataIssues.restored,
    }[status];
  }

  $: selectedImport = state.imports.find((item) => item.id === state.selectedSourceId) ?? null;
  $: statusLabel = labelForStatus(state.issue.status);
  $: stageTransition = { duration: reduceMotion ? 0 : 220 };
</script>

<DashboardShell
  active="data-issues"
  eyebrow={$t.dataIssues.eyebrow}
  title={$t.dataIssues.title}
  sideLabel={$t.dataIssues.sideLabel}
  sideValue={statusLabel}
  sideSub={$t.dataIssues.prototypeNotice}
>
  <div class="content data-issues-content">
    <p class="sr-only" aria-live="polite">{liveMessage}</p>

    {#if state.screen === "list" || state.screen === "diagnosis" || state.screen === "preview"}
      <section class="workflow-card card">
        <div class="panel-title">
          <div>
            <h2>{state.issue.accountLabel}</h2>
            <p class="lead">{state.issue.createdAt}</p>
          </div>
        </div>

        {#if state.screen === "list"}
          <dl class="issue-facts">
            <div><dt>{$t.dataIssues.reportedValue}</dt><dd>{formatAmount(state.issue.displayedValue)}</dd></div>
            <div><dt>{$t.dataIssues.dataDate}</dt><dd>{state.issue.dataDate}</dd></div>
            <div><dt>{$t.dataIssues.note}</dt><dd>{state.issue.note || "--"}</dd></div>
          </dl>
          <div class="card-actions">
            <button class="button primary" onclick={() => send({ type: "open-diagnosis" })}>{$t.dataIssues.excludeInvalidImport}</button>
          </div>
        {/if}

        {#if state.screen === "diagnosis" || state.screen === "preview"}
          <div class="workflow-step completed">
            <span class="step-mark"><Check size={18} strokeWidth={2.4} aria-hidden="true" /></span>
            <strong>1&nbsp; {$t.dataIssues.reportDetails}</strong>
            <span class="step-summary">{formatAmount(state.issue.displayedValue)} · {state.issue.dataDate} · {state.issue.note || "--"}</span>
          </div>

        {/if}

        {#if state.screen === "diagnosis"}
            <div class="stage-reveal" transition:slide={stageTransition}>
              <div class="workflow-step active source-step">
                <span class="step-mark">2</span>
                <strong>{$t.dataIssues.confirmSource}</strong>
                <div class="source-list">
                  {#each state.imports as source}
                    <label class="source-option">
                      <input
                        type="radio"
                        name="source"
                        value={source.id}
                        checked={state.selectedSourceId === source.id}
                        onchange={() => send({ type: "select-source", sourceId: source.id })}
                      />
                      <span>
                        <strong>{source.fileName}</strong>
                        <small>{source.csvRows} {$t.dataIssues.fileRows} · {source.insertedRows} {$t.dataIssues.inserted} · {source.duplicateRows} {$t.dataIssues.duplicates}</small>
                        <small>{$t.dataIssues.importedAt} {source.importedAt} · {source.affectedAccounts} {$t.dataIssues.affectedAccounts}</small>
                      </span>
                    </label>
                  {/each}
                </div>
                <details class="source-raw">
                  <summary>{$t.dataIssues.viewRawData}</summary>
                  <div class="table-wrap">
                    <table class="table">
                      <thead><tr><th>{$t.dataIssues.transactionDate}</th><th>{$t.dataIssues.paymentItem}</th><th class="right">{$t.dataIssues.transactionAmount}</th><th class="right">{$t.dataIssues.balanceAfter}</th></tr></thead>
                      <tbody>
                        <tr><td>2026/07/13</td><td>{$t.dataIssues.principal}</td><td class="right">11,874</td><td class="right">520,524</td></tr>
                        <tr><td>2026/07/13</td><td>{$t.dataIssues.interest}</td><td class="right">1,072</td><td class="right">520,524</td></tr>
                      </tbody>
                    </table>
                  </div>
                </details>
                <div class="step-actions">
                  <button class="button secondary" onclick={() => send({ type: "back-to-list" })}>{$t.dataIssues.back}</button>
                  <button class="button primary" disabled={!selectedImport} onclick={() => send({ type: "preview", scenario: "safe" })}>{$t.dataIssues.previewImpact}</button>
                </div>
              </div>
              <div class="workflow-step upcoming">
                <span class="step-mark">3</span>
                <strong>{$t.dataIssues.impactPreview}</strong>
                <ChevronRight size={18} aria-hidden="true" />
              </div>
            </div>
        {/if}

        {#if state.screen === "preview" && state.preview}
            <div class="workflow-step completed">
              <span class="step-mark"><Check size={18} strokeWidth={2.4} aria-hidden="true" /></span>
              <strong>2&nbsp; {$t.dataIssues.confirmSource}</strong>
              <span class="step-summary">{selectedImport?.fileName} · {selectedImport?.csvRows} {$t.dataIssues.fileRows} · {selectedImport?.insertedRows} {$t.dataIssues.inserted} · {selectedImport?.duplicateRows} {$t.dataIssues.duplicates}</span>
            </div>
            <div class="stage-reveal" transition:slide={stageTransition}>
              <div class="workflow-step active preview-step">
                <span class="step-mark">3</span>
                <strong>{$t.dataIssues.impactPreview}</strong>
                <div class="value-comparison">
                  <div><span>{$t.dataIssues.before}</span><strong>{formatAmount(state.preview.beforeValue)}</strong></div>
                  <span class="preview-arrow" aria-hidden="true">→</span>
                  <div><span>{$t.dataIssues.after}</span><strong>{formatAmount(state.preview.afterValue)}</strong></div>
                </div>
                <dl class="impact-counts">
                  <div><dt>{$t.dataIssues.excludedRows}</dt><dd>{state.preview.excludedRows}</dd></div>
                  <div><dt>{$t.dataIssues.retainedRows}</dt><dd>{state.preview.retainedRows}</dd></div>
                  <div><dt>{$t.dataIssues.unresolvedRows}</dt><dd>{state.preview.unresolvedRows}</dd></div>
                </dl>
                <div class="confirmation-form">
                  <label>
                    <span>{$t.dataIssues.reason}</span>
                    <textarea rows="3" value={state.reason} oninput={(event) => send({ type: "set-reason", reason: event.currentTarget.value })}></textarea>
                  </label>
                  <label class="acknowledgement">
                    <input type="checkbox" checked={state.acknowledged} onchange={(event) => send({ type: "acknowledge", acknowledged: event.currentTarget.checked })} />
                    <span>{$t.dataIssues.acknowledgement}</span>
                  </label>
                </div>
                <div class="step-actions">
                  <button class="button secondary" onclick={() => send({ type: "back-to-diagnosis" })}>{$t.dataIssues.back}</button>
                  <button class="button primary" disabled={!canConfirmQuarantine(state)} onclick={confirmQuarantine}>{$t.dataIssues.confirmQuarantine}</button>
                </div>
              </div>
            </div>
        {/if}
      </section>
    {:else if state.screen === "blocked" && state.preview}
      <section class="card result-card blocked-card" role="alert">
        <span class="result-mark">!</span>
        <h2>{$t.dataIssues.scenarioBlocked}</h2>
        <p>{$t.dataIssues.blockedReason}</p>
        <strong>{$t.dataIssues.unresolvedRows}: {state.preview.unresolvedRows}</strong>
        <div class="card-actions"><button class="button secondary" onclick={() => send({ type: "back-to-diagnosis" })}>{$t.dataIssues.back}</button></div>
      </section>
    {:else if state.screen === "failure"}
      <section class="card result-card blocked-card" role="alert">
        <span class="result-mark">×</span>
        <h2>{$t.dataIssues.scenarioFailure}</h2>
        <p>{$t.dataIssues.failureMessage}</p>
        <strong>{formatAmount(state.currentValue)}</strong>
        <div class="card-actions"><button class="button secondary" onclick={() => send({ type: "back-to-diagnosis" })}>{$t.dataIssues.back}</button></div>
      </section>
    {:else if state.screen === "working"}
      <section class="card result-card" role="status">
        <span class="loading-spinner" aria-hidden="true"></span>
        <h2>{$t.dataIssues.quarantineWorking}</h2>
      </section>
    {:else if state.screen === "success" && state.preview}
      <section class="card result-card success-card" role="status">
        <span class="result-mark">✓</span>
        <h2>{$t.dataIssues.quarantineSuccessTitle}</h2>
        <p>{formatAmount(state.preview.beforeValue)} → <strong>{formatAmount(state.currentValue)}</strong></p>
        <p>{$t.dataIssues.excludedRows}: {state.preview.excludedRows} · {$t.dataIssues.retainedRows}: {state.preview.retainedRows}</p>
        <div class="card-actions">
          <button class="button secondary" onclick={() => (location.hash = "/liabilities")}>{$t.dataIssues.backToAccount}</button>
          <button class="button secondary" onclick={() => send({ type: "show-audit" })}>{$t.dataIssues.viewAudit}</button>
          <button class="button primary" onclick={() => send({ type: "preview-restore" })}>{$t.dataIssues.restoreImport}</button>
        </div>
      </section>
    {:else if state.screen === "audit"}
      <section class="card">
        <div class="panel-title"><h2>{$t.dataIssues.audit}</h2></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>{$t.dataIssues.auditAction}</th><th>{$t.dataIssues.auditReason}</th><th>{$t.dataIssues.auditTime}</th></tr></thead>
            <tbody>
              {#each state.audit as event}
                <tr><td>{event.action === "invalidated" ? $t.dataIssues.invalidated : $t.dataIssues.restored}</td><td>{event.reason}</td><td>{event.at}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="card-actions">
          <button class="button secondary" onclick={() => send({ type: "back-to-list" })}>{$t.dataIssues.back}</button>
          {#if state.issue.status === "resolved"}
            <button class="button primary" onclick={() => send({ type: "preview-restore" })}>{$t.dataIssues.restoreImport}</button>
          {/if}
        </div>
      </section>
    {:else if state.screen === "restore-preview" && state.preview}
      <section class="card">
        <div class="panel-title"><h2>{$t.dataIssues.restoreImport}</h2></div>
        <div class="preview-grid">
          <div class="preview-cell"><span class="preview-label">{$t.dataIssues.before}</span><strong>{formatAmount(state.preview.afterValue)}</strong></div>
          <div class="preview-arrow" aria-hidden="true">→</div>
          <div class="preview-cell"><span class="preview-label">{$t.dataIssues.restored}</span><strong>{formatAmount(state.preview.beforeValue)}</strong></div>
        </div>
        <div class="card-actions">
          <button class="button secondary" onclick={() => send({ type: "show-audit" })}>{$t.dataIssues.back}</button>
          <button class="button primary" onclick={() => send({ type: "confirm-restore" }, $t.dataIssues.restoreComplete)}>{$t.dataIssues.confirmRestore}</button>
        </div>
      </section>
    {:else if state.screen === "restored"}
      <section class="card result-card success-card" role="status">
        <span class="result-mark">↺</span>
        <h2>{$t.dataIssues.restoreSuccessTitle}</h2>
        <strong>{formatAmount(state.currentValue)}</strong>
        <div class="card-actions">
          <button class="button secondary" onclick={() => (location.hash = "/liabilities")}>{$t.dataIssues.backToAccount}</button>
          <button class="button secondary" onclick={() => send({ type: "show-audit" })}>{$t.dataIssues.viewAudit}</button>
        </div>
      </section>
    {/if}
  </div>
</DashboardShell>

<style>
  .data-issues-content { display: grid; gap: var(--space-4); }
  .issue-facts, .preview-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-4); padding: var(--space-5); }
  .issue-facts div, .preview-cell { display: grid; gap: var(--space-1); }
  .issue-facts dt, .preview-label, .source-option small { color: var(--muted); font-size: 12px; }
  .issue-facts dd { margin: 0; font-weight: 700; }
  .workflow-card { overflow: hidden; }
  .stage-reveal { overflow: hidden; border-top: 1px solid var(--border); }
  .workflow-step { display: grid; grid-template-columns: 32px auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); min-height: 72px; padding: 0 var(--space-5); }
  .workflow-step + .workflow-step { border-top: 1px solid var(--border); }
  .workflow-step.active { background: color-mix(in srgb, var(--accent) 3%, var(--surface)); }
  .step-mark { width: 28px; height: 28px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 50%; color: var(--muted); font-weight: 800; }
  .completed .step-mark, .active .step-mark { border-color: var(--accent); background: var(--accent); color: white; }
  .step-summary { overflow: hidden; color: var(--muted); text-align: right; text-overflow: ellipsis; white-space: nowrap; }
  .source-step, .preview-step { grid-template-rows: auto auto auto auto; padding-block: var(--space-4); }
  .source-list, .source-raw, .value-comparison, .impact-counts, .confirmation-form, .step-actions { grid-column: 2 / -1; width: 100%; }
  .source-list { display: grid; gap: var(--space-3); padding-top: var(--space-3); }
  .source-option { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: var(--space-4); padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
  .source-option:has(input:checked) { border-color: var(--accent); background: var(--surface-soft); }
  .source-option span { display: grid; gap: var(--space-1); }
  .source-raw { margin-top: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .source-raw summary { padding: var(--space-3) var(--space-4); cursor: pointer; font-weight: 700; }
  textarea { width: 100%; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--fg); font: inherit; resize: vertical; }
  .value-comparison { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: var(--space-5); margin-top: var(--space-4); padding: var(--space-5) 0; border-bottom: 1px solid var(--border); }
  .value-comparison div { display: grid; gap: var(--space-2); }
  .value-comparison div:last-child { text-align: right; }
  .value-comparison span, .confirmation-form > label:first-child { color: var(--muted); font-size: 12px; }
  .value-comparison strong { font-size: clamp(22px, 2vw, 30px); }
  .preview-arrow { color: var(--muted); font-size: 28px; }
  .impact-counts { display: grid; grid-template-columns: repeat(3, 1fr); margin: 0; padding: var(--space-4) 0; border-bottom: 1px solid var(--border); }
  .impact-counts div { display: flex; justify-content: center; gap: var(--space-2); }
  .impact-counts div + div { border-left: 1px solid var(--border); }
  .impact-counts dt { color: var(--muted); }
  .impact-counts dd { margin: 0; font-weight: 800; }
  .confirmation-form { display: grid; gap: var(--space-4); padding-top: var(--space-4); }
  .confirmation-form > label:first-child { display: grid; gap: var(--space-2); font-weight: 700; }
  .acknowledgement { display: flex; align-items: center; gap: var(--space-3); color: var(--fg); font-size: 14px; font-weight: 400; }
  .step-actions, .card-actions { display: flex; justify-content: flex-end; gap: var(--space-3); padding-top: var(--space-4); }
  .card-actions { padding: var(--space-4) var(--space-5); border-top: 1px solid var(--border); }
  .preview-grid { align-items: center; }
  .preview-cell { min-height: 92px; align-content: center; padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-soft); }
  .preview-cell strong { font-size: 24px; }
  .result-card { min-height: 360px; display: grid; place-items: center; align-content: center; gap: var(--space-3); padding: var(--space-6); text-align: center; }
  .result-card .card-actions { width: 100%; margin-top: var(--space-5); justify-content: center; }
  .result-mark { width: 56px; height: 56px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 50%; font-size: 28px; }
  .success-card .result-mark { border-color: var(--accent); color: var(--accent); }
  .blocked-card .result-mark { border-color: var(--danger, #b42318); color: var(--danger, #b42318); }
  .loading-spinner { width: 28px; height: 28px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 700ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 900px) {
    .workflow-step { grid-template-columns: 32px minmax(0, 1fr) auto; }
    .step-summary { grid-column: 2 / -1; width: 100%; text-align: left; }
    .source-list, .source-raw, .value-comparison, .impact-counts, .confirmation-form, .step-actions { grid-column: 1 / -1; }
  }
  @media (max-width: 760px) {
    .issue-facts, .preview-grid { grid-template-columns: 1fr; }
    .value-comparison { grid-template-columns: 1fr; }
    .value-comparison div:last-child { text-align: left; }
    .preview-arrow { transform: rotate(90deg); text-align: center; }
    .impact-counts { grid-template-columns: 1fr; gap: var(--space-3); }
    .impact-counts div + div { border-left: 0; }
    .card-actions, .step-actions { flex-wrap: wrap; }
  }
  @media (prefers-reduced-motion: reduce) { .loading-spinner { animation: none; } }
</style>
