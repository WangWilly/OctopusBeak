<script lang="ts">
  import { AlertTriangle, Check, ChevronRight } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { slide } from "svelte/transition";
  import { t } from "$lib/i18n/i18n.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import type {
    DataIssueDetailDto,
    DataIssueListItemDto,
    ExclusionPreviewDto,
    RestorePreviewDto,
    SourceVersionId,
  } from "./types.ts";

  type ViewState =
    | { status: "loading" }
    | { status: "error"; message: string; at: string }
    | { status: "list"; issues: DataIssueListItemDto[] }
    | { status: "detail"; issue: DataIssueDetailDto; preview: ExclusionPreviewDto | null };

  export let issueId: string | null = null;

  let state: ViewState = { status: "loading" };
  let selectedSource: SourceVersionId | null = null;
  let restorePreview: RestorePreviewDto | null = null;
  let reason = "";
  let acknowledged = false;
  let busy = false;
  let reduceMotion = false;
  let initialized = false;
  let loadedIssueId: string | null = null;
  let statusFilter: DataIssueListItemDto["status"] | "all" = "all";
  let stageError: { stage: string; message: string; at: string } | null = null;

  $: stageTransition = { duration: reduceMotion ? 0 : 220 };
  $: filteredIssues = state.status === "list"
    ? state.issues.filter((issue) => statusFilter === "all" || issue.status === statusFilter)
    : [];
  $: if (initialized && issueId !== loadedIssueId) {
    loadedIssueId = issueId;
    resetWorkflow();
    void load();
  }

  onMount(() => {
    reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    initialized = true;
    loadedIssueId = issueId;
    void load();
  });

  function resetWorkflow() {
    selectedSource = null;
    restorePreview = null;
    reason = "";
    acknowledged = false;
    stageError = null;
  }

  function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  function formatAmounts(amounts: Array<{ currency: string; value: number }>) {
    return amounts.map((amount) => `${amount.value.toLocaleString()} ${amount.currency}`).join(" · ") || "--";
  }

  function statusLabel(status: DataIssueListItemDto["status"]) {
    return {
      pending: $t.dataIssues.open,
      investigating: $t.dataIssues.investigating,
      resolved: $t.dataIssues.resolved,
      restored: $t.dataIssues.restored,
    }[status];
  }

  async function load() {
    const requestedIssueId = issueId;
    state = { status: "loading" };
    try {
      const next = requestedIssueId
        ? { status: "detail" as const, issue: await window.octopusBeak.dataIssues.load(requestedIssueId), preview: null }
        : { status: "list" as const, issues: await window.octopusBeak.dataIssues.list() };
      if (requestedIssueId !== issueId) return;
      state = next;
    } catch (error) {
      if (requestedIssueId !== issueId) return;
      state = { status: "error", message: errorMessage(error), at: new Date().toLocaleString() };
    }
  }

  function openIssue(id: string) {
    location.hash = `/data-issues/${id}`;
  }

  function showStageError(stage: string, error: unknown) {
    stageError = { stage, message: errorMessage(error), at: new Date().toLocaleString() };
  }

  async function refreshDetail(dataIssueId: string, preview: ExclusionPreviewDto | null) {
    try {
      const issue = await window.octopusBeak.dataIssues.load(dataIssueId);
      if (dataIssueId !== issueId) return;
      state = { status: "detail", issue, preview };
    } catch {
      // Keep the current view and the user's form input if the follow-up read fails.
    }
  }

  async function startDiagnosis() {
    if (state.status !== "detail" || busy) return;
    busy = true;
    stageError = null;
    try {
      const issue = await window.octopusBeak.dataIssues.startDiagnosis(state.issue.dataIssueId);
      state = { status: "detail", issue, preview: null };
      await refreshDetail(issue.dataIssueId, null);
    } catch (error) {
      showStageError("diagnosis", error);
      if (issueId) await refreshDetail(issueId, null);
    } finally {
      busy = false;
    }
  }

  async function previewExclusion() {
    if (state.status !== "detail" || !selectedSource || busy) return;
    busy = true;
    stageError = null;
    try {
      const preview = await window.octopusBeak.dataIssues.previewExclusion({
        dataIssueId: state.issue.dataIssueId,
        sourceVersion: selectedSource,
      });
      state = { ...state, preview };
      await refreshDetail(state.issue.dataIssueId, preview);
    } catch (error) {
      showStageError("preview", error);
      if (issueId) await refreshDetail(issueId, state.status === "detail" ? state.preview : null);
    } finally {
      busy = false;
    }
  }

  async function confirmExclusion() {
    if (state.status !== "detail" || !selectedSource || !state.preview || !acknowledged || !reason.trim() || busy) return;
    busy = true;
    stageError = null;
    try {
      const issue = await window.octopusBeak.dataIssues.confirmExclusion({
        dataIssueId: state.issue.dataIssueId,
        sourceVersion: selectedSource,
        reason,
        acknowledged: true,
        previewToken: state.preview.previewToken,
      });
      state = {
        status: "detail",
        issue,
        preview: state.preview,
      };
      await refreshDetail(issue.dataIssueId, state.preview);
    } catch (error) {
      showStageError("confirmation", error);
      if (issueId) await refreshDetail(issueId, state.status === "detail" ? state.preview : null);
    } finally {
      busy = false;
    }
  }

  async function previewRestore() {
    if (state.status !== "detail" || busy) return;
    busy = true;
    stageError = null;
    try {
      restorePreview = await window.octopusBeak.dataIssues.previewRestore(state.issue.dataIssueId);
      await refreshDetail(state.issue.dataIssueId, state.preview);
    } catch (error) {
      showStageError("restore", error);
      if (issueId) await refreshDetail(issueId, state.status === "detail" ? state.preview : null);
    } finally {
      busy = false;
    }
  }

  async function confirmRestore() {
    if (state.status !== "detail" || !restorePreview?.allowed || busy) return;
    busy = true;
    stageError = null;
    try {
      const issue = await window.octopusBeak.dataIssues.confirmRestore({
        dataIssueId: state.issue.dataIssueId,
        previewToken: restorePreview.previewToken,
      });
      state = {
        status: "detail",
        issue,
        preview: state.preview,
      };
      restorePreview = null;
      await refreshDetail(issue.dataIssueId, state.preview);
    } catch (error) {
      showStageError("restore", error);
      if (issueId) await refreshDetail(issueId, state.status === "detail" ? state.preview : null);
    } finally {
      busy = false;
    }
  }
</script>

<DashboardShell
  active="data-issues"
  eyebrow={$t.dataIssues.eyebrow}
  title={$t.dataIssues.title}
  sideLabel={$t.dataIssues.sideLabel}
  sideValue={state.status === "detail" ? statusLabel(state.issue.status) : ""}
>
  <div class="content data-issues-content">
    {#if state.status === "loading"}
      <div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>
    {:else if state.status === "error"}
      <section class="workflow-card card">
        <div class="stage-error" role="alert"><AlertTriangle size={20} aria-hidden="true" /><span>{state.message}<small>{state.at}</small></span><details><summary>{$t.dataIssues.technicalDetails}</summary>{state.message}</details></div>
        <div class="card-actions"><button class="button secondary" onclick={load}>{$t.common.retry}</button></div>
      </section>
    {:else if state.status === "list"}
      <section class="workflow-card card">
        <div class="panel-title"><h2>{$t.dataIssues.reportedIssues}</h2></div>
        <div class="status-filter" aria-label={$t.dataIssues.statusFilter}>
          {#each ["all", "pending", "investigating", "resolved", "restored"] as filter}
            <button class:active={statusFilter === filter} type="button" onclick={() => (statusFilter = filter as typeof statusFilter)}>
              {filter === "all" ? $t.common.all : statusLabel(filter as DataIssueListItemDto["status"])}
            </button>
          {/each}
        </div>
        <div class="issue-list">
          {#each filteredIssues as issue}
            <button type="button" class="issue-row" onclick={() => openIssue(issue.dataIssueId)}>
              <span><strong>{issue.accountLabel}</strong><small>{formatAmounts([issue.reportedValue])}</small></span>
              <span><small>{issue.updatedAt}</small><ChevronRight size={18} aria-hidden="true" /></span>
            </button>
          {:else}
            <p class="empty-state">{$t.dataIssues.noIssues}</p>
          {/each}
        </div>
      </section>
    {:else}
      {@const issue = state.issue}
      {@const diagnosing = issue.status === "investigating" && !state.preview}
      <section class="workflow-card card">
        <div class="panel-title">
          <div><h2>{issue.account.label}</h2></div>
          <button class="button secondary" type="button" onclick={() => (location.hash = "/data-issues")}>{$t.dataIssues.back}</button>
        </div>

        {#if issue.status === "pending"}
          <dl class="issue-facts">
            <div><dt>{$t.dataIssues.reportedValue}</dt><dd>{formatAmounts([issue.reportedValue])}</dd></div>
            <div><dt>{$t.dataIssues.dataDate}</dt><dd>{issue.dataDate ?? "--"}</dd></div>
            <div><dt>{$t.dataIssues.note}</dt><dd>{issue.note || "--"}</dd></div>
          </dl>
          <div class="card-actions"><button class="button primary" disabled={busy} onclick={startDiagnosis}>{$t.dataIssues.excludeInvalidImport}</button></div>
          {#if stageError?.stage === "diagnosis"}<div class="stage-error"><AlertTriangle size={18} aria-hidden="true" /><span>{stageError.message}<small>{stageError.at}</small></span><details><summary>{$t.dataIssues.technicalDetails}</summary>{stageError.message}</details></div>{/if}
        {:else}
          <div class="workflow-step completed">
            <span class="step-mark"><Check size={18} strokeWidth={2.4} aria-hidden="true" /></span>
            <strong>1&nbsp; {$t.dataIssues.reportDetails}</strong>
            <span class="step-summary">{formatAmounts([issue.reportedValue])} · {issue.dataDate ?? "--"} · {issue.note || "--"}</span>
          </div>
        {/if}

        {#if diagnosing}
          <div class="stage-reveal" transition:slide={stageTransition}>
            <div class="workflow-step active source-step">
              <span class="step-mark">2</span><strong>{$t.dataIssues.confirmSource}</strong>
              {#if stageError?.stage === "diagnosis" || stageError?.stage === "preview"}<div class="stage-error"><AlertTriangle size={18} aria-hidden="true" /><span>{stageError.message}<small>{stageError.at}</small></span><details><summary>{$t.dataIssues.technicalDetails}</summary>{stageError.message}</details></div>{/if}
              <div class="source-list">
                {#each issue.candidates as source}
                  <label class="source-option">
                    <input type="radio" name="source" checked={selectedSource?.sourceFileId === source.sourceFileId && selectedSource?.importRunId === source.importRunId} onchange={() => (selectedSource = { sourceFileId: source.sourceFileId, importRunId: source.importRunId })} />
                    <span><strong>{source.fileName}</strong><small>{source.csvRows} {$t.dataIssues.fileRows} · {source.insertedRows} {$t.dataIssues.inserted} · {source.duplicateRows} {$t.dataIssues.duplicates}</small><small>{$t.dataIssues.importedAt} {source.importedAt} · {source.affectedAccounts} {$t.dataIssues.affectedAccounts}</small></span>
                  </label>
                {:else}<p class="empty-state">{$t.dataIssues.noSources}</p>{/each}
              </div>
              <div class="step-actions"><button class="button primary" disabled={!selectedSource || busy} onclick={previewExclusion}>{$t.dataIssues.previewImpact}</button></div>
            </div>
            <div class="workflow-step upcoming"><span class="step-mark">3</span><strong>{$t.dataIssues.impactPreview}</strong><ChevronRight size={18} aria-hidden="true" /></div>
          </div>
        {/if}

        {#if state.preview}
          <div class="workflow-step completed"><span class="step-mark"><Check size={18} strokeWidth={2.4} aria-hidden="true" /></span><strong>2&nbsp; {$t.dataIssues.confirmSource}</strong></div>
          <div class="stage-reveal" transition:slide={stageTransition}>
            <div class="workflow-step active preview-step">
              <span class="step-mark">3</span><strong>{$t.dataIssues.impactPreview}</strong>
              {#if stageError?.stage === "preview" || stageError?.stage === "confirmation"}<div class="stage-error"><AlertTriangle size={18} aria-hidden="true" /><span>{stageError.message}<small>{stageError.at}</small></span><details><summary>{$t.dataIssues.technicalDetails}</summary>{stageError.message}</details></div>{/if}
              <dl class="impact-counts"><div><dt>{$t.dataIssues.excludedRows}</dt><dd>{state.preview.excludedRows}</dd></div><div><dt>{$t.dataIssues.retainedRows}</dt><dd>{state.preview.duplicateRows}</dd></div><div><dt>{$t.dataIssues.affectedAccounts}</dt><dd>{state.preview.affectedAccounts.length}</dd></div></dl>
              <div class="affected-list">{#each state.preview.affectedAccounts as account}<p><strong>{account.accountId}</strong><span>{formatAmounts(account.before.amounts)} → {account.after.availability === "unavailable" ? $t.accounts.noAvailableData : formatAmounts(account.after.amounts)}</span></p>{/each}</div>
              {#if issue.status !== "resolved"}
                <div class="confirmation-form"><label><span>{$t.dataIssues.reason}</span><textarea rows="3" bind:value={reason}></textarea></label><label class="acknowledgement"><input type="checkbox" bind:checked={acknowledged} /><span>{$t.dataIssues.acknowledgement}</span></label></div>
                <div class="step-actions"><button class="button primary" disabled={!reason.trim() || !acknowledged || busy} onclick={confirmExclusion}>{$t.dataIssues.confirmExclusion}</button></div>
              {/if}
            </div>
          </div>
        {/if}

        {#if issue.status === "resolved"}
          <div class="restore-actions"><button class="button secondary" disabled={busy} onclick={previewRestore}>{$t.dataIssues.restoreImport}</button></div>
          {#if restorePreview || stageError?.stage === "restore"}
            <div class="stage-reveal" transition:slide={stageTransition}>
              <div class="workflow-step active restore-step"><span class="step-mark">4</span><strong>{$t.dataIssues.restoreImport}</strong>
                {#if stageError?.stage === "restore"}<div class="stage-error"><AlertTriangle size={18} aria-hidden="true" /><span>{stageError.message}<small>{stageError.at}</small></span><details><summary>{$t.dataIssues.technicalDetails}</summary>{stageError.message}</details></div>{:else if restorePreview && !restorePreview.allowed}<div class="stage-error"><AlertTriangle size={18} aria-hidden="true" /><span>{$t.dataIssues.restoreBlocked}<small>{restorePreview.blockedBy.map((item) => item.updatedAt).join(" · ")}</small></span></div>{:else if restorePreview}<div class="step-actions"><button class="button primary" disabled={busy} onclick={confirmRestore}>{$t.dataIssues.confirmRestore}</button></div>{/if}
              </div>
            </div>
          {/if}
        {/if}

        <details class="operation-history">
          <summary>{$t.dataIssues.operationHistory}</summary>
          <div class="event-list">{#each issue.events as event}<article><strong>{event.summary}</strong><span>{event.createdAt}</span>{#if Object.keys(event.details).length}<details><summary>{$t.dataIssues.technicalDetails}</summary><pre>{JSON.stringify(event.details, null, 2)}</pre></details>{/if}</article>{:else}<p class="empty-state">{$t.dataIssues.noOperations}</p>{/each}</div>
        </details>
      </section>
    {/if}
  </div>
</DashboardShell>

<style>
  .data-issues-content { display: grid; gap: var(--space-4); }
  .workflow-card { overflow: hidden; }
  .issue-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-4); padding: var(--space-5); margin: 0; }
  .issue-facts div { display: grid; gap: var(--space-1); }
  .issue-facts dt, small { color: var(--muted); font-size: 12px; }
  .issue-facts dd { margin: 0; font-weight: 700; }
  .status-filter { display: flex; gap: var(--space-2); padding: 0 var(--space-5) var(--space-4); overflow: auto; }
  .status-filter button { padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--muted); font: inherit; white-space: nowrap; }
  .status-filter button.active { border-color: var(--accent); color: var(--accent); }
  .issue-list { border-top: 1px solid var(--border); }
  .issue-row { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: var(--space-4); padding: var(--space-4) var(--space-5); border: 0; border-bottom: 1px solid var(--border); background: var(--surface); color: var(--fg); text-align: left; font: inherit; }
  .issue-row:hover { background: var(--surface-soft); }
  .issue-row span { display: grid; gap: var(--space-1); }
  .issue-row > span:last-child { display: flex; align-items: center; }
  .empty-state { padding: var(--space-5); margin: 0; color: var(--muted); }
  .stage-reveal { overflow: hidden; border-top: 1px solid var(--border); }
  .workflow-step { display: grid; grid-template-columns: 32px auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); min-height: 72px; padding: 0 var(--space-5); }
  .workflow-step + .workflow-step { border-top: 1px solid var(--border); }
  .workflow-step.active { background: color-mix(in srgb, var(--accent) 3%, var(--surface)); }
  .step-mark { width: 28px; height: 28px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 50%; color: var(--muted); font-weight: 800; }
  .completed .step-mark, .active .step-mark { border-color: var(--accent); background: var(--accent); color: white; }
  .step-summary { overflow: hidden; color: var(--muted); text-align: right; text-overflow: ellipsis; white-space: nowrap; }
  .source-step, .preview-step, .restore-step { grid-template-rows: auto auto auto auto; padding-block: var(--space-4); }
  .source-list, .impact-counts, .affected-list, .confirmation-form, .step-actions, .stage-error { grid-column: 2 / -1; width: 100%; }
  .source-list { display: grid; gap: var(--space-3); padding-top: var(--space-3); }
  .source-option { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: var(--space-4); padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
  .source-option:has(input:checked) { border-color: var(--accent); background: var(--surface-soft); }
  .source-option span { display: grid; gap: var(--space-1); }
  .impact-counts { display: grid; grid-template-columns: repeat(3, 1fr); margin: 0; padding: var(--space-4) 0; border-bottom: 1px solid var(--border); }
  .impact-counts div { display: flex; justify-content: center; gap: var(--space-2); }
  .impact-counts div + div { border-left: 1px solid var(--border); }
  .impact-counts dt { color: var(--muted); }
  .impact-counts dd { margin: 0; font-weight: 800; }
  .affected-list { display: grid; gap: var(--space-2); padding: var(--space-4) 0; }
  .affected-list p { display: flex; justify-content: space-between; gap: var(--space-3); margin: 0; }
  .affected-list span { color: var(--muted); text-align: right; }
  .confirmation-form { display: grid; gap: var(--space-4); padding-top: var(--space-4); }
  .confirmation-form > label:first-child { display: grid; gap: var(--space-2); color: var(--muted); font-size: 12px; font-weight: 700; }
  textarea { width: 100%; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--fg); font: inherit; resize: vertical; }
  .acknowledgement { display: flex; align-items: center; gap: var(--space-3); color: var(--fg); font-size: 14px; font-weight: 400; }
  .step-actions, .card-actions, .restore-actions { display: flex; justify-content: flex-end; gap: var(--space-3); padding: var(--space-4) var(--space-5); }
  .step-actions { grid-column: 2 / -1; padding-inline: 0; }
  .card-actions { border-top: 1px solid var(--border); }
  .restore-actions { border-top: 1px solid var(--border); }
  .stage-error { display: flex; align-items: flex-start; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--danger, #b42318); border-radius: var(--radius-sm); color: var(--danger, #b42318); }
  .stage-error span { display: grid; gap: var(--space-1); }
  .stage-error details { margin-left: auto; color: var(--fg); }
  .operation-history { border-top: 1px solid var(--border); }
  .operation-history > summary { padding: var(--space-4) var(--space-5); cursor: pointer; font-weight: 700; }
  .event-list { display: grid; border-top: 1px solid var(--border); }
  .event-list article { display: grid; gap: var(--space-1); padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--border); }
  .event-list span { color: var(--muted); font-size: 12px; }
  pre { overflow: auto; margin: var(--space-2) 0 0; white-space: pre-wrap; }
  .status { color: var(--muted); }
  .loading-status { min-height: 240px; display: flex; align-items: center; justify-content: center; gap: var(--space-3); }
  .loading-spinner { width: 18px; height: 18px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 700ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 760px) {
    .issue-facts, .impact-counts { grid-template-columns: 1fr; }
    .impact-counts div + div { border-left: 0; }
    .workflow-step { grid-template-columns: 32px minmax(0, 1fr) auto; }
    .step-summary, .source-list, .impact-counts, .affected-list, .confirmation-form, .step-actions, .stage-error { grid-column: 1 / -1; width: 100%; text-align: left; }
    .affected-list p { display: grid; }
    .affected-list span { text-align: left; }
    .card-actions, .step-actions, .restore-actions { flex-wrap: wrap; }
  }
  @media (prefers-reduced-motion: reduce) { .loading-spinner { animation: none; } }
</style>
