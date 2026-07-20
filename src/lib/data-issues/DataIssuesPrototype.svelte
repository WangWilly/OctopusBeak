<script lang="ts">
  import { onMount } from "svelte";
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
    type PrototypeScenario,
  } from "./prototype-model.ts";

  let state = seedDataIssuePrototype();
  let scenario: PrototypeScenario = "safe";
  let liveMessage = "";

  onMount(() => {
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
    <div class="prototype-banner" role="note">{$t.dataIssues.prototypeNotice}</div>
    <p class="sr-only" aria-live="polite">{liveMessage}</p>

    {#if state.screen === "list"}
      <section class="card">
        <div class="panel-title">
          <div>
            <span class="chip">{statusLabel}</span>
            <h2>{state.issue.accountLabel}</h2>
            <p class="lead">{state.issue.createdAt}</p>
          </div>
        </div>
        <dl class="issue-facts">
          <div><dt>{$t.dataIssues.reportedValue}</dt><dd>{formatAmount(state.issue.displayedValue)}</dd></div>
          <div><dt>{$t.dataIssues.dataDate}</dt><dd>{state.issue.dataDate}</dd></div>
          <div><dt>{$t.dataIssues.note}</dt><dd>{state.issue.note || "--"}</dd></div>
        </dl>
        <div class="card-actions">
          <button class="button primary" onclick={() => send({ type: "open-diagnosis" })}>{$t.dataIssues.startDiagnosis}</button>
        </div>
      </section>
    {:else if state.screen === "diagnosis"}
      <section class="card issue-summary">
        <div class="panel-title">
          <div><span class="chip">{statusLabel}</span><h2>{state.issue.accountLabel}</h2></div>
        </div>
        <dl class="issue-facts">
          <div><dt>{$t.dataIssues.reportedValue}</dt><dd>{formatAmount(state.issue.displayedValue)}</dd></div>
          <div><dt>{$t.dataIssues.dataDate}</dt><dd>{state.issue.dataDate}</dd></div>
          <div><dt>{$t.dataIssues.note}</dt><dd>{state.issue.note || "--"}</dd></div>
        </dl>
      </section>

      <section class="card">
        <div class="panel-title"><h2>{$t.dataIssues.valueTimeline}</h2></div>
        <ol class="timeline">
          <li><time>2026/07/07</time><strong>{formatAmount(354_107)}</strong></li>
          <li class="reported"><time>2026/07/13</time><strong>{formatAmount(state.issue.displayedValue)}</strong><span class="chip">{$t.dataIssues.reportedPoint}</span></li>
        </ol>
      </section>

      <section class="card">
        <div class="panel-title"><h2>{$t.dataIssues.sources}</h2></div>
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
              <thead>
                <tr>
                  <th>{$t.dataIssues.transactionDate}</th>
                  <th>{$t.dataIssues.paymentItem}</th>
                  <th class="right">{$t.dataIssues.transactionAmount}</th>
                  <th class="right">{$t.dataIssues.balanceAfter}</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>2026/07/13</td><td>{$t.dataIssues.principal}</td><td class="right">11,874</td><td class="right">520,524</td></tr>
                <tr><td>2026/07/13</td><td>{$t.dataIssues.interest}</td><td class="right">1,072</td><td class="right">520,524</td></tr>
              </tbody>
            </table>
          </div>
        </details>
        <div class="prototype-scenario">
          <label>
            <span>{$t.dataIssues.prototypeScenario}</span>
            <select bind:value={scenario}>
              <option value="safe">{$t.dataIssues.scenarioSafe}</option>
              <option value="blocked">{$t.dataIssues.scenarioBlocked}</option>
              <option value="failure">{$t.dataIssues.scenarioFailure}</option>
            </select>
          </label>
        </div>
        <div class="card-actions">
          <button class="button secondary" onclick={() => send({ type: "back-to-list" })}>{$t.dataIssues.back}</button>
          <button class="button primary" disabled={!selectedImport} onclick={() => send({ type: "preview", scenario })}>{$t.dataIssues.previewImpact}</button>
        </div>
      </section>
    {:else if state.screen === "preview" && state.preview}
      <section class="card">
        <div class="panel-title">
          <div><span class="chip">{$t.dataIssues.scenarioSafe}</span><h2>{selectedImport?.fileName}</h2></div>
        </div>
        <div class="preview-grid">
          <div class="preview-cell"><span class="preview-label">{$t.dataIssues.before}</span><strong>{formatAmount(state.preview.beforeValue)}</strong></div>
          <div class="preview-arrow" aria-hidden="true">→</div>
          <div class="preview-cell"><span class="preview-label">{$t.dataIssues.after}</span><strong>{formatAmount(state.preview.afterValue)}</strong></div>
          <div class="preview-cell"><span class="preview-label">{$t.dataIssues.excludedRows}</span><strong>{state.preview.excludedRows}</strong></div>
          <div class="preview-cell"><span class="preview-label">{$t.dataIssues.retainedRows}</span><strong>{state.preview.retainedRows}</strong></div>
          <div class="preview-cell"><span class="preview-label">{$t.dataIssues.unresolvedRows}</span><strong>{state.preview.unresolvedRows}</strong></div>
        </div>
        <div class="confirmation-form">
          <label>
            <span>{$t.dataIssues.reason}</span>
            <textarea
              rows="3"
              value={state.reason}
              oninput={(event) => send({ type: "set-reason", reason: event.currentTarget.value })}
            ></textarea>
          </label>
          <label class="acknowledgement">
            <input
              type="checkbox"
              checked={state.acknowledged}
              onchange={(event) => send({ type: "acknowledge", acknowledged: event.currentTarget.checked })}
            />
            <span>{$t.dataIssues.acknowledgement}</span>
          </label>
        </div>
        <div class="card-actions">
          <button class="button secondary" onclick={() => send({ type: "back-to-diagnosis" })}>{$t.dataIssues.back}</button>
          <button class="button primary" disabled={!canConfirmQuarantine(state)} onclick={confirmQuarantine}>{$t.dataIssues.confirmQuarantine}</button>
        </div>
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
  .data-issues-content { display: grid; gap: var(--space-5); }
  .prototype-banner { padding: var(--space-3) var(--space-4); border: 1px solid var(--accent); border-radius: var(--radius-sm); background: var(--surface-soft); font-weight: 700; }
  .issue-facts, .preview-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-4); padding: var(--space-5); }
  .issue-facts div, .preview-cell { display: grid; gap: var(--space-1); }
  .issue-facts dt, .preview-label, .source-option small { color: var(--muted); font-size: 12px; }
  .issue-facts dd { margin: 0; font-weight: 700; }
  .timeline { list-style: none; margin: 0; padding: var(--space-5); display: grid; gap: var(--space-3); }
  .timeline li { display: grid; grid-template-columns: minmax(120px, 1fr) 1fr auto; align-items: center; gap: var(--space-4); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .timeline .reported { border-color: var(--danger, #b42318); }
  .source-list { display: grid; gap: var(--space-3); padding: var(--space-5); }
  .source-option { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: var(--space-4); padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
  .source-option:has(input:checked) { border-color: var(--accent); background: var(--surface-soft); }
  .source-option span { display: grid; gap: var(--space-1); }
  .source-raw { margin: 0 var(--space-5) var(--space-5); border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .source-raw summary { padding: var(--space-3) var(--space-4); cursor: pointer; font-weight: 700; }
  .prototype-scenario { padding: 0 var(--space-5) var(--space-5); }
  .prototype-scenario label { display: grid; grid-template-columns: auto minmax(220px, 320px); align-items: center; gap: var(--space-3); }
  select, textarea { width: 100%; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--fg); font: inherit; }
  textarea { resize: vertical; }
  .preview-grid { align-items: center; }
  .preview-cell { min-height: 92px; align-content: center; padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-soft); }
  .preview-cell strong { font-size: 24px; }
  .preview-arrow { text-align: center; color: var(--muted); font-size: 28px; }
  .confirmation-form { display: grid; gap: var(--space-4); padding: 0 var(--space-5) var(--space-5); }
  .confirmation-form > label:first-child { display: grid; gap: var(--space-2); color: var(--muted); font-size: 12px; font-weight: 700; }
  .acknowledgement { display: flex; align-items: center; gap: var(--space-3); }
  .card-actions { display: flex; justify-content: flex-end; gap: var(--space-3); padding: var(--space-4) var(--space-5); border-top: 1px solid var(--border); }
  .result-card { min-height: 360px; display: grid; place-items: center; align-content: center; gap: var(--space-3); padding: var(--space-6); text-align: center; }
  .result-card .card-actions { width: 100%; margin-top: var(--space-5); justify-content: center; }
  .result-mark { width: 56px; height: 56px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 50%; font-size: 28px; }
  .success-card .result-mark { border-color: var(--accent); color: var(--accent); }
  .blocked-card .result-mark { border-color: var(--danger, #b42318); color: var(--danger, #b42318); }
  .loading-spinner { width: 28px; height: 28px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 700ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 760px) {
    .issue-facts, .preview-grid { grid-template-columns: 1fr; }
    .preview-arrow { transform: rotate(90deg); }
    .prototype-scenario label { grid-template-columns: 1fr; }
    .card-actions { flex-wrap: wrap; }
  }
  @media (prefers-reduced-motion: reduce) { .loading-spinner { animation: none; } }
</style>
