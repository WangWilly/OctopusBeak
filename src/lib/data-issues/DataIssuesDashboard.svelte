<script lang="ts">
  import { AlertTriangle, Check, ChevronRight, History, X } from "@lucide/svelte";
  import { onMount, tick } from "svelte";
  import { slide } from "svelte/transition";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import { formatUtcDateTime } from "$lib/time/timezone.ts";
  import type {
    DataIssueDetailDto,
    DataIssueEventDto,
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
  let stageError: { stage: string; message: string; details: string; at: string } | null = null;
  let liveStatus = "";
  let historyOpen = false;
  let historyDialog: HTMLDialogElement | null = null;
  let historyTrigger: HTMLButtonElement | null = null;

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
    liveStatus = "";
    busy = false;
    historyOpen = false;
  }

  function openHistory() {
    historyOpen = true;
    void tick().then(() => {
      if (historyDialog && !historyDialog.open) historyDialog.showModal();
    });
  }

  function closeHistory() {
    if (historyDialog?.open) historyDialog.close();
    else historyOpen = false;
  }

  function cancelHistory(event: Event) {
    event.preventDefault();
    closeHistory();
  }

  function closeHistoryFromBackdrop(event: MouseEvent) {
    if (event.target === historyDialog) closeHistory();
  }

  function historyClosed() {
    historyOpen = false;
    void tick().then(() => historyTrigger?.focus());
  }

  function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  function formatAmounts(amounts: Array<{ currency: string; value: number }>) {
    return amounts.map((amount) => `${amount.value.toLocaleString()} ${amount.currency}`).join(" · ") || "--";
  }

  function formatAccountState(accountState: ExclusionPreviewDto["affectedAccounts"][number]["before"]) {
    return accountState.availability === "unavailable"
      ? $t.accounts.noAvailableData
      : formatAmounts(accountState.amounts);
  }

  function statusLabel(status: DataIssueListItemDto["status"]) {
    return {
      pending: $t.dataIssues.open,
      investigating: $t.dataIssues.investigating,
      resolved: $t.dataIssues.resolved,
      restored: $t.dataIssues.restored,
    }[status];
  }

  function eventSummary(event: DataIssueEventDto) {
    const summary = {
      created: $t.dataIssues.eventCreated,
      diagnosis: $t.dataIssues.eventDiagnosis,
      "exclusion-preview": $t.dataIssues.eventExclusionPreview,
      exclusion: $t.dataIssues.eventExclusion,
      "restore-preview": $t.dataIssues.eventRestorePreview,
      restore: $t.dataIssues.eventRestore,
    }[event.eventType] ?? event.summary;
    if (event.outcome === "failed") return `${summary} · ${$t.dataIssues.eventFailed}`;
    if (event.outcome === "blocked") return `${summary} · ${$t.dataIssues.eventBlocked}`;
    return summary;
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
      announceCreatedIssue(requestedIssueId);
    } catch (error) {
      if (requestedIssueId !== issueId) return;
      state = { status: "error", message: errorMessage(error), at: new Date().toLocaleString() };
    }
  }

  function openIssue(id: string) {
    location.hash = `/data-issues/${id}`;
  }

  function announceCreatedIssue(dataIssueId: string | null) {
    if (!dataIssueId || history.state?.createdDataIssueId !== dataIssueId) return;
    const nextState = { ...history.state };
    delete nextState.createdDataIssueId;
    history.replaceState(nextState, "");
    liveStatus = $t.dataIssues.issueCreatedReady;
  }

  function accountReturnHref(account: DataIssueDetailDto["account"]) {
    const route = account.group === "liability" ? "liabilities" : "assets";
    return `#/${route}/${encodeURIComponent(account.id)}`;
  }

  function showStageError(stage: string, error: unknown) {
    stageError = {
      stage,
      message: $t.dataIssues.operationFailed,
      details: errorMessage(error),
      at: new Date().toLocaleString(),
    };
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
    const operationCaseId = state.issue.dataIssueId;
    busy = true;
    stageError = null;
    liveStatus = $t.common.loading;
    try {
      const issue = await window.octopusBeak.dataIssues.startDiagnosis(state.issue.dataIssueId);
      if (operationCaseId !== issueId) return;
      state = { status: "detail", issue, preview: null };
      liveStatus = $t.dataIssues.eventDiagnosis;
      await refreshDetail(issue.dataIssueId, null);
    } catch (error) {
      if (operationCaseId !== issueId) return;
      showStageError("diagnosis", error);
      liveStatus = "";
      if (issueId) await refreshDetail(issueId, null);
    } finally {
      if (operationCaseId === issueId) busy = false;
    }
  }

  async function previewExclusion() {
    if (state.status !== "detail" || !selectedSource || busy) return;
    const operationCaseId = state.issue.dataIssueId;
    busy = true;
    stageError = null;
    liveStatus = $t.common.loading;
    try {
      const preview = await window.octopusBeak.dataIssues.previewExclusion({
        dataIssueId: state.issue.dataIssueId,
        sourceVersion: selectedSource,
      });
      if (operationCaseId !== issueId) return;
      state = { ...state, preview };
      liveStatus = $t.dataIssues.eventExclusionPreview;
      await refreshDetail(state.issue.dataIssueId, preview);
    } catch (error) {
      if (operationCaseId !== issueId) return;
      showStageError("preview", error);
      liveStatus = "";
      if (issueId) await refreshDetail(issueId, state.status === "detail" ? state.preview : null);
    } finally {
      if (operationCaseId === issueId) busy = false;
    }
  }

  async function confirmExclusion() {
    if (state.status !== "detail" || !selectedSource || !state.preview || !acknowledged || !reason.trim() || busy) return;
    const operationCaseId = state.issue.dataIssueId;
    busy = true;
    stageError = null;
    liveStatus = $t.common.loading;
    try {
      const issue = await window.octopusBeak.dataIssues.confirmExclusion({
        dataIssueId: state.issue.dataIssueId,
        sourceVersion: selectedSource,
        reason,
        acknowledged: true,
        previewToken: state.preview.previewToken,
      });
      if (operationCaseId !== issueId) return;
      state = {
        status: "detail",
        issue,
        preview: state.preview,
      };
      liveStatus = $t.dataIssues.eventExclusion;
      await refreshDetail(issue.dataIssueId, state.preview);
    } catch (error) {
      if (operationCaseId !== issueId) return;
      showStageError("confirmation", error);
      liveStatus = "";
      if (issueId) await refreshDetail(issueId, state.status === "detail" ? state.preview : null);
    } finally {
      if (operationCaseId === issueId) busy = false;
    }
  }

  function backToSourceSelection() {
    if (state.status !== "detail") return;
    state = { ...state, preview: null };
    stageError = null;
  }

  async function previewRestore() {
    if (state.status !== "detail" || busy) return;
    const operationCaseId = state.issue.dataIssueId;
    busy = true;
    stageError = null;
    liveStatus = $t.common.loading;
    try {
      const preview = await window.octopusBeak.dataIssues.previewRestore(state.issue.dataIssueId);
      if (operationCaseId !== issueId) return;
      restorePreview = preview;
      liveStatus = $t.dataIssues.eventRestorePreview;
      await refreshDetail(state.issue.dataIssueId, state.preview);
    } catch (error) {
      if (operationCaseId !== issueId) return;
      showStageError("restore", error);
      liveStatus = "";
      if (issueId) await refreshDetail(issueId, state.status === "detail" ? state.preview : null);
    } finally {
      if (operationCaseId === issueId) busy = false;
    }
  }

  async function confirmRestore() {
    if (state.status !== "detail" || !restorePreview?.allowed || busy) return;
    const operationCaseId = state.issue.dataIssueId;
    busy = true;
    stageError = null;
    liveStatus = $t.common.loading;
    try {
      const issue = await window.octopusBeak.dataIssues.confirmRestore({
        dataIssueId: state.issue.dataIssueId,
        previewToken: restorePreview.previewToken,
      });
      if (operationCaseId !== issueId) return;
      state = {
        status: "detail",
        issue,
        preview: state.preview,
      };
      restorePreview = null;
      liveStatus = $t.dataIssues.eventRestore;
      await refreshDetail(issue.dataIssueId, state.preview);
    } catch (error) {
      if (operationCaseId !== issueId) return;
      showStageError("restore", error);
      liveStatus = "";
      if (issueId) await refreshDetail(issueId, state.status === "detail" ? state.preview : null);
    } finally {
      if (operationCaseId === issueId) busy = false;
    }
  }
</script>

<DashboardShell
  active="data-issues"
  eyebrow={$t.dataIssues.eyebrow}
  title={$t.dataIssues.title}
  sideLabel={$t.dataIssues.sideLabel}
  sideValue={state.status === "detail" ? statusLabel(state.issue.status) : $t.dataIssues.handleIncorrectImports}
>
  <div class="content data-issues-content">
    <span class="visually-hidden" aria-live="polite" aria-atomic="true">{liveStatus}</span>
    {#if state.status === "loading"}
      <div class="status loading-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>{$t.common.loading}</span></div>
    {:else if state.status === "error"}
      <section class="workflow-card card">
        <div class="stage-error" role="alert"><AlertTriangle size={20} aria-hidden="true" /><span>{state.message}<small>{state.at}</small></span><details><summary>{$t.dataIssues.technicalDetails}</summary>{state.message}</details></div>
        <div class="card-actions"><button class="button secondary" onclick={load}>{$t.common.retry}</button></div>
      </section>
    {:else if state.status === "list"}
      <section class="workflow-card card">
        <div class="panel-title list-panel-title"><h2>{$t.dataIssues.statusTracking}</h2></div>
        <div class="status-filter" aria-label={$t.dataIssues.statusFilter}>
          {#each ["all", "pending", "investigating", "resolved", "restored"] as filter}
            <button class:active={statusFilter === filter} type="button" aria-pressed={statusFilter === filter} onclick={() => (statusFilter = filter as typeof statusFilter)}>
              {filter === "all" ? $t.common.all : statusLabel(filter as DataIssueListItemDto["status"])}
            </button>
          {/each}
        </div>
        <div class="issue-list">
          {#each filteredIssues as issue}
            <button type="button" class="issue-row" onclick={() => openIssue(issue.dataIssueId)}>
              <span>
                <span class="issue-heading"><strong>{issue.accountLabel}</strong><span class="issue-status">{statusLabel(issue.status)}</span></span>
                <small>{formatAmounts([issue.reportedValue])}</small>
              </span>
              <span><small>{formatUtcDateTime(issue.updatedAt, $systemTimezone, $locale)}</small><ChevronRight size={18} aria-hidden="true" /></span>
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
          <div class="account-title-row">
            <h2>
              <span class="account-link-wrap">
                <a
                  class="account-return-link"
                  href={accountReturnHref(issue.account)}
                  aria-describedby="account-return-tooltip"
                >{issue.account.label}</a>
                <span id="account-return-tooltip" class="header-tooltip" role="tooltip">{$t.dataIssues.backToAccountHint}</span>
              </span>
            </h2>
            <span class="header-action">
              <button
                bind:this={historyTrigger}
                class="history-trigger"
                type="button"
                aria-label={$t.dataIssues.operationHistory}
                aria-describedby="operation-history-tooltip"
                onclick={openHistory}
              ><History size={18} aria-hidden="true" /></button>
              <span id="operation-history-tooltip" class="header-tooltip" role="tooltip">{$t.dataIssues.operationHistory}</span>
            </span>
          </div>
          <div class="panel-actions">
            <button class="button secondary" type="button" onclick={() => (location.hash = "/data-issues")}>{$t.dataIssues.back}</button>
          </div>
        </div>

        {#if issue.status === "pending"}
          <dl class="issue-facts">
            <div><dt>{$t.dataIssues.reportedValue}</dt><dd>{formatAmounts([issue.reportedValue])}</dd></div>
            <div><dt>{$t.dataIssues.dataDate}</dt><dd>{issue.dataDate ?? "--"}</dd></div>
            <div><dt>{$t.dataIssues.note}</dt><dd>{issue.note || "--"}</dd></div>
          </dl>
          <div class="card-actions"><button class="button primary" disabled={busy} onclick={startDiagnosis}>{$t.dataIssues.excludeInvalidImport}</button></div>
          {#if stageError?.stage === "diagnosis"}<div class="stage-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><span>{stageError.message}<small>{stageError.at}</small></span><details><summary>{$t.dataIssues.technicalDetails}</summary>{stageError.details}</details></div>{/if}
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
              {#if stageError?.stage === "diagnosis" || stageError?.stage === "preview"}<div class="stage-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><span>{stageError.message}<small>{stageError.at}</small></span><details><summary>{$t.dataIssues.technicalDetails}</summary>{stageError.details}</details></div>{/if}
              <div class="source-list">
                {#each issue.candidates as source}
                  <label class="source-option">
                    <input type="radio" name="source" checked={selectedSource?.sourceFileId === source.sourceFileId && selectedSource?.importRunId === source.importRunId} onchange={() => (selectedSource = { sourceFileId: source.sourceFileId, importRunId: source.importRunId })} />
                    <span><strong>{source.fileName}</strong><small>{source.csvRows} {$t.dataIssues.fileRows} · {source.insertedRows} {$t.dataIssues.inserted} · {source.duplicateRows} {$t.dataIssues.duplicates}</small><small>{$t.dataIssues.importedAt} {formatUtcDateTime(source.importedAt, $systemTimezone, $locale)} · {source.affectedAccounts} {$t.dataIssues.affectedAccounts}</small></span>
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
              {#if stageError?.stage === "preview" || stageError?.stage === "confirmation"}<div class="stage-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><span>{stageError.message}<small>{stageError.at}</small></span><details><summary>{$t.dataIssues.technicalDetails}</summary>{stageError.details}</details></div>{/if}
              <dl class="impact-counts">
                <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-focusable tooltip trigger) -->
                <div class="impact-metric" tabindex="0" role="group" aria-describedby="impact-excluded-tooltip"><dt>{$t.dataIssues.excludedRows}</dt><dd>{state.preview.excludedRows}<span id="impact-excluded-tooltip" class="impact-tooltip" role="tooltip">{$t.dataIssues.excludedRowsExplanation(state.preview.excludedRows)}</span></dd></div>
                <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-focusable tooltip trigger) -->
                <div class="impact-metric" tabindex="0" role="group" aria-describedby="impact-retained-tooltip"><dt>{$t.dataIssues.retainedRows}</dt><dd>{state.preview.duplicateRows}<span id="impact-retained-tooltip" class="impact-tooltip" role="tooltip">{$t.dataIssues.retainedRowsExplanation(state.preview.duplicateRows)}</span></dd></div>
                <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard-focusable tooltip trigger) -->
                <div class="impact-metric" tabindex="0" role="group" aria-describedby="impact-accounts-tooltip"><dt>{$t.dataIssues.affectedAccounts}</dt><dd>{state.preview.affectedAccounts.length}<span id="impact-accounts-tooltip" class="impact-tooltip" role="tooltip">{$t.dataIssues.affectedAccountsExplanation(state.preview.affectedAccounts.length)}</span></dd></div>
              </dl>
              <div class="affected-list">{#each state.preview.affectedAccounts as account}<p><span class="affected-account"><strong>{account.accountLabel}</strong><small>{account.accountId}</small></span><span>{formatAccountState(account.before)} → {formatAccountState(account.after)}</span></p>{/each}</div>
              {#if issue.status !== "resolved"}
                <div class="confirmation-form"><label><span>{$t.dataIssues.reason}</span><textarea rows="3" bind:value={reason}></textarea></label><label class="acknowledgement"><input type="checkbox" bind:checked={acknowledged} /><span>{$t.dataIssues.acknowledgement}</span></label></div>
                <div class="step-actions"><button class="button secondary" disabled={busy} onclick={backToSourceSelection}>{$t.dataIssues.back}</button><button class="button primary" disabled={!reason.trim() || !acknowledged || busy} onclick={confirmExclusion}>{$t.dataIssues.confirmExclusion}</button></div>
              {/if}
            </div>
          </div>
        {/if}

        {#if issue.status === "resolved"}
          <div class="restore-actions"><button class="button secondary" disabled={busy} onclick={previewRestore}>{$t.dataIssues.restoreImport}</button></div>
          {#if restorePreview || stageError?.stage === "restore"}
            <div class="stage-reveal" transition:slide={stageTransition}>
              <div class="workflow-step active restore-step"><span class="step-mark">4</span><strong>{$t.dataIssues.restoreImport}</strong>
                {#if stageError?.stage === "restore"}
                  <div class="stage-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><span>{stageError.message}<small>{stageError.at}</small></span><details><summary>{$t.dataIssues.technicalDetails}</summary>{stageError.details}</details></div>
                {:else if restorePreview}
                  <div class="affected-list restore-impact">{#each restorePreview.affectedAccounts as account}<p><span class="affected-account"><strong>{account.accountLabel}</strong><small>{account.accountId}</small></span><span>{$t.dataIssues.before}: {formatAccountState(account.before)} → {$t.dataIssues.afterRestore}: {formatAccountState(account.after)}</span></p>{/each}</div>
                  {#if !restorePreview.allowed}<div class="stage-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><span>{$t.dataIssues.restoreBlocked}<small>{restorePreview.blockedBy.map((item) => item.updatedAt).join(" · ")}</small></span><details><summary>{$t.dataIssues.technicalDetails}</summary>{restorePreview.blockedBy.map((item) => item.updatedAt).join(" · ")}</details></div>{:else}<div class="step-actions"><button class="button primary" disabled={busy} onclick={confirmRestore}>{$t.dataIssues.confirmRestore}</button></div>{/if}
                {/if}
              </div>
            </div>
          {/if}
        {/if}

        {#if historyOpen}
          <dialog
            bind:this={historyDialog}
            class="modal-panel operation-history-modal"
            aria-labelledby="operation-history-title"
            onclose={historyClosed}
            oncancel={cancelHistory}
            onclick={closeHistoryFromBackdrop}
          >
            <div class="modal-head">
              <h2 id="operation-history-title">{$t.dataIssues.operationHistory}</h2>
              <button class="modal-close" type="button" aria-label={$t.common.close} onclick={closeHistory}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <div class="modal-body event-list">
              {#each issue.events as event}
                <article>
                  <strong>{eventSummary(event)}</strong>
                  <span>{formatUtcDateTime(event.createdAt, $systemTimezone, $locale)}</span>
                  {#if Object.keys(event.details).length}
                    <details><summary>{$t.dataIssues.technicalDetails}</summary><pre>{JSON.stringify(event.details, null, 2)}</pre></details>
                  {/if}
                </article>
              {:else}
                <p class="empty-state">{$t.dataIssues.noOperations}</p>
              {/each}
            </div>
          </dialog>
        {/if}
      </section>
    {/if}
  </div>
</DashboardShell>

<style>
  .data-issues-content { display: grid; gap: var(--space-4); }
  .workflow-card { overflow: hidden; }
  .panel-actions { display: flex; gap: var(--space-3); }
  .account-title-row { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
  .account-title-row h2 { margin: 0; min-width: 0; }
  .account-link-wrap, .header-action { position: relative; }
  .account-return-link { color: inherit; text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 3px; }
  .account-return-link:hover, .account-return-link:focus-visible { text-decoration-color: currentColor; }
  .history-trigger { display: grid; width: 34px; height: 34px; place-items: center; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--muted); cursor: pointer; }
  .history-trigger:hover, .history-trigger:focus-visible { background: var(--surface-soft); color: var(--fg); }
  .header-tooltip { position: absolute; top: calc(100% + 7px); left: 50%; z-index: 8; width: max-content; max-width: min(220px, 80vw); padding: 7px 9px; border-radius: var(--radius-sm); background: color-mix(in oklch, var(--fg) 94%, transparent); color: white; font-size: 11px; font-weight: 600; opacity: 0; pointer-events: none; transform: translate(-50%, -3px); transition: opacity 120ms ease, transform 120ms ease; }
  .account-link-wrap:hover .header-tooltip,
  .account-link-wrap:focus-within .header-tooltip,
  .header-action:hover .header-tooltip,
  .header-action:focus-within .header-tooltip { opacity: 1; transform: translate(-50%, 0); }
  .issue-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-4); padding: var(--space-5); margin: 0; }
  .issue-facts div { display: grid; gap: var(--space-1); }
  .issue-facts dt, small { color: var(--muted); font-size: 12px; }
  .issue-facts dd { margin: 0; font-weight: 700; }
  .list-panel-title { min-height: 0; border-bottom: 0; }
  .status-filter { display: flex; align-items: center; gap: 4px; margin: 0 var(--space-5) var(--space-4); padding: 4px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
  .status-filter button { padding: var(--space-2) var(--space-3); border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--muted); font: inherit; white-space: nowrap; }
  .status-filter button.active { border-color: var(--border); background: var(--surface); color: var(--fg); box-shadow: 0 1px 3px rgb(15 23 42 / 0.06); }
  .issue-list { border-top: 0; }
  .issue-row { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: var(--space-4); padding: var(--space-4) var(--space-5); border: 0; border-bottom: 1px solid var(--border); background: var(--surface); color: var(--fg); text-align: left; font: inherit; }
  .issue-row:hover { background: var(--surface-soft); }
  .issue-row > span { display: grid; gap: var(--space-1); }
  .issue-row > span:last-child { display: flex; align-items: center; }
  .issue-heading { display: flex; align-items: center; gap: var(--space-2); }
  .issue-status { padding: 2px 7px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-soft); color: var(--muted); font-size: 11px; font-weight: 700; }
  .empty-state { padding: 0 var(--space-5) var(--space-5); margin: 0; color: var(--muted); }
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
  .source-option { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: var(--space-4); padding: var(--space-3) 0; border: 0; border-radius: 0; cursor: pointer; }
  .source-option + .source-option { border-top: 1px solid var(--border); }
  .source-option span { display: grid; gap: var(--space-1); }
  .impact-counts { display: grid; grid-template-columns: repeat(3, 1fr); margin: 0; padding: var(--space-4) 0; border-bottom: 1px solid var(--border); }
  .impact-counts div { display: flex; justify-content: center; gap: var(--space-2); }
  .impact-counts div + div { border-left: 1px solid var(--border); }
  .impact-counts dt { color: var(--muted); }
  .impact-counts dd { margin: 0; font-weight: 800; }
  .impact-metric { position: relative; outline-offset: var(--space-1); }
  .impact-tooltip { position: absolute; bottom: calc(100% + 7px); left: 50%; z-index: 4; width: max-content; max-width: min(280px, 80vw); padding: 7px 9px; border-radius: var(--radius-sm); background: color-mix(in oklch, var(--fg) 94%, transparent); color: white; font-size: 11px; font-weight: 600; text-align: left; opacity: 0; pointer-events: none; transform: translate(-50%, 3px); transition: opacity 120ms ease, transform 120ms ease; }
  .impact-metric:hover .impact-tooltip,
  .impact-metric:focus-within .impact-tooltip { opacity: 1; transform: translate(-50%, 0); }
  .affected-list { display: grid; gap: var(--space-2); padding: var(--space-4) 0; }
  .affected-list p { display: flex; justify-content: space-between; gap: var(--space-3); margin: 0; }
  .affected-list > p > span:last-child { color: var(--muted); text-align: right; }
  .affected-account { display: grid; gap: var(--space-1); }
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
  .operation-history-modal { width: min(720px, calc(100vw - 40px)); max-height: min(760px, calc(100vh - 40px)); padding: 0; }
  .operation-history-modal::backdrop { background: rgba(14, 18, 28, 0.44); backdrop-filter: blur(10px) saturate(0.84); }
  .operation-history-modal .event-list { max-height: min(640px, calc(100vh - 140px)); overflow: auto; }
  .event-list { display: grid; }
  .event-list article { display: grid; gap: var(--space-1); padding: var(--space-4) var(--space-5); border-top: 1px solid var(--border); }
  .event-list span { color: var(--muted); font-size: 12px; }
  pre { overflow: auto; margin: var(--space-2) 0 0; white-space: pre-wrap; }
  .status { color: var(--muted); }
  .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
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
  @media (prefers-reduced-motion: reduce) { .loading-spinner { animation: none; } .impact-tooltip, .header-tooltip { transition: none; } }
</style>
