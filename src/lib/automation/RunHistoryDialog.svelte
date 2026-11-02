<script lang="ts">
  import { onMount } from "svelte";
  import { Search } from "@lucide/svelte";
  import InstitutionLogo from "$lib/institutions/InstitutionLogo.svelte";
  import Modal from "$lib/shared-shell/components/Modal.svelte";
  import type { OctopusBeakApi } from "$lib/desktop/api.ts";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import {
    filterHistoryToCurrentTasks,
    formatDuration,
    historyCounts,
    historyTaskLabel,
    historyTaskLogo,
    visibleHistoryRows,
    type RunHistoryFilter,
    type RunHistoryLoad,
  } from "./run-history.ts";
  import { formatRunTime, statusClass } from "./task-display.ts";
  import type { AutomationTaskRow } from "./types.ts";
  import { workflowFailureShortExplanation } from "./workflow-failures.ts";

  export let tasks: readonly AutomationTaskRow[];
  export let port: Pick<OctopusBeakApi["automation"], "runHistory">;
  export let onClose: () => void;
  /** The history shown; while it is still loading, the dialog loads it on open. */
  export let history: RunHistoryLoad = { status: "loading" };

  let search = "";
  let filter: RunHistoryFilter = "all";

  onMount(() => {
    if (history.status !== "loading") return;
    port.runHistory().then(
      (rows) => (history = { status: "ready", rows }),
      () => (history = { status: "failed" }),
    );
  });

  $: catalogRows = filterHistoryToCurrentTasks(history.status === "ready" ? history.rows : [], tasks);
  $: visibleRows = visibleHistoryRows(catalogRows, tasks, filter, search, $locale);
  $: counts = historyCounts(catalogRows);
  $: filters = [
    { id: "all", label: $t.automation.historyAll, count: catalogRows.length },
    { id: "running", label: $t.automation.historyRunning, count: counts.running },
    { id: "completed", label: $t.automation.historyCompleted, count: counts.completed },
    { id: "failed", label: $t.automation.historyFailed, count: counts.failed },
  ] satisfies { id: RunHistoryFilter; label: string; count: number }[];
</script>

<Modal
  titleId="history-title"
  title={$t.automation.runHistory}
  subtitle={$t.automation.historyTaskCount(catalogRows.length)}
  closeLabel={$t.automation.closeRunHistory}
  width="min(1180px, 100%)"
  height="min(760px, calc(100vh - 40px))"
  {onClose}
>
  <label slot="actions" class="history-search">
    <Search size={18} />
    <input bind:value={search} placeholder={$t.automation.historySearch} />
  </label>
  <div class="modal-body history-layout">
    <aside class="history-filters">
      {#each filters as option (option.id)}
        <button class:selected={filter === option.id} type="button" onclick={() => (filter = option.id)}><span>{option.label}</span><strong>{option.count}</strong></button>
      {/each}
    </aside>
    <div class="history-body">
      <table class="table history-table">
        <thead>
          <tr>
            <th>{$t.automation.task}</th>
            <th>{$t.automation.status}</th>
            <th>{$t.automation.historyStartedTime($systemTimezone)}</th>
            <th>{$t.automation.historyDuration}</th>
            <th>{$t.automation.historyError}</th>
          </tr>
        </thead>
        <tbody>
          {#if history.status === "loading"}
            <tr><td colspan="5">{$t.common.loading}</td></tr>
          {:else if history.status === "failed"}
            <tr><td colspan="5"><span class="history-load-failed" role="alert">{$t.automation.historyLoadFailed}</span></td></tr>
          {/if}
          {#each visibleRows as run (run.taskRunId)}
            <tr>
              <td><div class="task-name"><span class="task-logo"><InstitutionLogo institution={historyTaskLogo(tasks, run.taskId)} /></span><strong>{historyTaskLabel(tasks, run.taskId, $locale)}</strong></div></td>
              <td><span class={`chip ${statusClass(run.status)}`}>{$t.automation.statusLabels[run.status]}</span></td>
              <td class="mono">{formatRunTime(run.startedAt, $systemTimezone, $locale)}</td>
              <td class="mono">{formatDuration(run)}</td>
              <td class="history-error">
                {#if run.appWorkflowOutcome?.errorCode}
                  {@const explanation = workflowFailureShortExplanation(run.appWorkflowOutcome.errorCode, $locale)}
                  <code>{run.appWorkflowOutcome.errorCode}</code>
                  {#if explanation}
                    <small>{explanation}</small>
                  {/if}
                {:else}--{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
</Modal>

<style>
  .history-search {
    width: min(320px, 34vw);
    min-height: 40px;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--muted);
    background: var(--surface);
  }

  .history-search:focus-within {
    border-color: var(--fg);
    box-shadow: 0 0 0 3px var(--surface-soft);
  }

  .history-search input {
    min-width: 0;
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--fg);
  }

  .history-layout {
    min-height: 0;
    flex: 1;
    display: grid;
    grid-template-columns: 190px minmax(0, 1fr);
    overflow: hidden;
  }

  .history-filters {
    padding: var(--space-3);
    border-right: 1px solid var(--border);
  }

  .history-filters button {
    width: 100%;
    min-height: 46px;
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: var(--space-3);
    padding: 0 var(--space-3);
    border: 0;
    background: transparent;
    color: var(--muted);
    text-align: left;
    cursor: pointer;
  }

  .history-filters button:hover {
    color: var(--fg);
  }

  .history-filters button.selected {
    color: var(--fg);
    font-weight: 760;
  }

  .history-filters button.selected span {
    text-decoration: underline;
    text-decoration-color: var(--muted);
    text-underline-offset: 6px;
  }

  .history-body {
    min-width: 0;
    overflow: auto;
    padding: 0;
  }

  .history-table {
    table-layout: fixed;
    min-width: 820px;
  }

  .history-table th:nth-child(1) { width: 31%; }
  .history-table th:nth-child(2) { width: 13%; }
  .history-table th:nth-child(3) { width: 21%; }
  .history-table th:nth-child(4) { width: 10%; }
  .history-table th:nth-child(5) { width: 25%; }

  .history-table td {
    vertical-align: middle;
  }

  .history-error {
    max-width: 0;
    color: var(--muted);
    font-size: 12px;
  }

  .history-load-failed {
    color: var(--danger);
  }

  /* The run list in AutomationDashboard.svelte styles the same task cell and chips. */
  .task-name {
    min-width: 150px;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .task-logo {
    width: 20px;
    height: 20px;
    flex: none;
    display: grid;
    place-items: center;
  }

  .task-name strong {
    font-weight: 720;
  }

  .mono {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .chip.warn {
    color: var(--warn);
    background: color-mix(in oklch, var(--warn) 6%, white);
  }

  .chip.bad {
    color: var(--danger);
    background: color-mix(in oklch, var(--danger) 6%, white);
  }
</style>
