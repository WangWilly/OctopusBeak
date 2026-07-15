<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { locale, t, type Translation } from "$lib/i18n/i18n.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import { formatUtcDateTime } from "$lib/time/timezone.ts";
  import type { AutomationPageModel, AutomationTaskHistoryRow, AutomationTaskRow } from "./types.ts";

  type CredentialGroup = {
    id: string;
    label: string;
    enabledKey: string;
    enabled: boolean;
    credentialKeys: readonly string[];
  };

  export let automation: AutomationPageModel;
  export let credentialGroups: CredentialGroup[];
  export let reload: () => Promise<void>;

  let credentialsOpen = false;
  let logTask: AutomationTaskRow | null = null;
  let historyOpen = false;
  let historyLoading = false;
  let historyRows: AutomationTaskHistoryRow[] = [];
  let humanTask: AutomationTaskRow | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let viewerTimer: ReturnType<typeof setInterval> | null = null;
  let viewerRequestId = 0;
  let viewerImageUrl = "";
  let viewerError = "";
  let actionError = "";
  let dragStart: { x: number; y: number; pointerId: number } | null = null;
  let floatingInput: { left: number; top: number; value: string } | null = null;
  let floatingInputEl: HTMLInputElement | null = null;
  let viewerExpanded = false;
  let groupEnabled: Record<string, boolean> = {};
  let credentialDrafts: Record<string, string> = {};

  $: sideValue = automation.active
    ? $t.common.runningCount(automation.activeTaskCount)
    : automation.importGate.locked
      ? $t.common.importLocked
      : $t.common.ready;
  $: sideSub = $t.common.businessDay(automation.businessDate);
  $: topStatus = automation.active
    ? $t.common.runningCount(automation.activeTaskCount)
    : automation.importGate.locked
      ? $t.common.importLocked
      : $t.common.ready;
  $: topStatusClass = automation.active
    ? "warn"
    : automation.importGate.locked
      ? "bad"
      : "good";
  $: readyTaskCount = automation.tasks.filter((task) => task.canRun && !task.isActive).length;
  $: attentionTaskCount = automation.tasks.filter((task) =>
    task.status === "failed" || task.status === "waiting_for_human" || task.status === "locked",
  ).length;
  $: automationStats = [
    { label: $t.automation.activeNow, value: automation.activeTaskCount, detail: topStatus, tone: topStatusClass },
    { label: $t.automation.readyToRun, value: readyTaskCount, detail: $t.automation.readyTasks, tone: readyTaskCount ? "good" : "" },
    { label: $t.automation.needsAttention, value: attentionTaskCount, detail: $t.automation.attentionTasks, tone: attentionTaskCount ? "bad" : "good" },
  ];
  $: credentialInputDirty = Object.values(credentialDrafts).some((value) => value.trim().length > 0);
  $: credentialToggleDirty = credentialGroups.some((group) => (groupEnabled[group.id] !== false) !== group.enabled);
  $: credentialsDirty = credentialInputDirty || credentialToggleDirty;

  $: if (automation.active && !pollTimer) {
    pollTimer = setInterval(() => {
      void reload();
    }, 2_000);
  } else if (!automation.active && pollTimer) {
    stopPolling();
  }

  onDestroy(() => {
    stopPolling();
    if (viewerTimer) clearInterval(viewerTimer);
    if (viewerImageUrl) URL.revokeObjectURL(viewerImageUrl);
  });

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function statusClass(status: string) {
    if (status === "completed") return "good";
    if (status === "failed" || status === "locked") return "bad";
    if (status === "running" || status === "waiting_for_human") return "warn";
    return "";
  }

  function formatTime(value: string | null) {
    return formatUtcDateTime(value, $systemTimezone, $locale) || "--";
  }

  function latestTaskTime(task: AutomationTaskRow) {
    return formatTime(task.latestFinishedAt ?? task.latestStartedAt);
  }

  function credentialLabel(key: string, dictionary: Translation) {
    const words = dictionary.automation.credentialWords as Record<string, string>;
    return key
      .replace(/^LIBRETTO_CLOUD_/, "")
      .replace(/_/g, " ")
      .toLowerCase()
      .split(" ")
      .map((word) => words[word] ?? word)
      .join(" ");
  }

  function resetCredentialChanges() {
    credentialDrafts = {};
    groupEnabled = Object.fromEntries(credentialGroups.map((group) => [group.id, group.enabled]));
  }

  function openCredentials() {
    resetCredentialChanges();
    credentialsOpen = true;
  }

  function closeCredentials() {
    if (credentialsDirty && !confirm($t.automation.discardCredentialChanges)) return;
    resetCredentialChanges();
    credentialsOpen = false;
  }

  function closeCredentialsOnEscape(event: KeyboardEvent) {
    if (!credentialsOpen || event.key !== "Escape") return;
    event.preventDefault();
    closeCredentials();
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    if (floatingInput) {
      event.preventDefault();
      floatingInput = null;
      return;
    }
    closeCredentialsOnEscape(event);
  }

  function toggleGroup(groupId: string) {
    groupEnabled = {
      ...groupEnabled,
      [groupId]: !(groupEnabled[groupId] !== false),
    };
  }

  function updateCredentialDraft(key: string, event: Event) {
    credentialDrafts = {
      ...credentialDrafts,
      [key]: (event.currentTarget as HTMLInputElement).value,
    };
  }

  async function runTask(task: AutomationTaskRow) {
    try {
      actionError = "";
      if (task.primaryAction === "Resume") await window.octopusBeak.automation.resume(task.id);
      else await window.octopusBeak.automation.run(task.id);
      await reload();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    }
  }

  async function primaryTaskAction(task: AutomationTaskRow) {
    if (task.primaryAction !== "Cancel") {
      await runTask(task);
      return;
    }
    if (!confirm($t.automation.confirmCancel(taskLabel(task, $t)))) return;
    try {
      actionError = "";
      await window.octopusBeak.automation.cancel(task.id);
      await reload();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    }
  }

  async function openRunHistory() {
    historyOpen = true;
    historyLoading = true;
    try {
      actionError = "";
      historyRows = await window.octopusBeak.automation.runHistory();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      historyLoading = false;
    }
  }

  async function saveCredentials(event: SubmitEvent) {
    event.preventDefault();
    const updates: Record<string, string> = {};
    for (const group of credentialGroups) {
      updates[group.enabledKey] = groupEnabled[group.id] !== false ? "true" : "false";
    }
    for (const [key, value] of Object.entries(credentialDrafts)) {
      if (value.trim()) updates[key] = value.trim();
    }
    try {
      actionError = "";
      await window.octopusBeak.automation.saveCredentials(updates);
      resetCredentialChanges();
      credentialsOpen = false;
      await reload();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    }
  }

  async function refreshViewerImage() {
    const taskId = humanTask?.id;
    if (!taskId) return;
    const requestId = ++viewerRequestId;
    try {
      const bytes = await window.octopusBeak.automation.viewerScreenshot(taskId);
      if (humanTask?.id !== taskId || requestId !== viewerRequestId) return;
      if (!bytes) return;
      if (viewerImageUrl) URL.revokeObjectURL(viewerImageUrl);
      viewerImageUrl = URL.createObjectURL(new Blob([bytes.slice()], { type: "image/jpeg" }));
      viewerError = "";
    } catch (error) {
      if (humanTask?.id === taskId && requestId === viewerRequestId) viewerError = error instanceof Error ? error.message : String(error);
    }
  }

  function openHumanViewer(task: AutomationTaskRow) {
    humanTask = task;
    viewerError = "";
    dragStart = null;
    void refreshViewerImage();
    if (viewerTimer) clearInterval(viewerTimer);
    viewerTimer = setInterval(() => {
      void refreshViewerImage();
    }, 750);
  }

  function closeHumanViewer() {
    viewerRequestId += 1;
    if (viewerTimer) clearInterval(viewerTimer);
    viewerTimer = null;
    humanTask = null;
    if (viewerImageUrl) URL.revokeObjectURL(viewerImageUrl);
    viewerImageUrl = "";
    viewerError = "";
    dragStart = null;
    floatingInput = null;
    viewerExpanded = false;
  }

  async function sendViewerInput(input: unknown) {
    if (!humanTask) return;
    try {
      await window.octopusBeak.automation.viewerInput(humanTask.id, input);
      viewerError = "";
      await refreshViewerImage();
    } catch (error) {
      viewerError = error instanceof Error ? error.message : String(error);
    }
  }

  async function inspectViewerPoint(point: { x: number; y: number }) {
    if (!humanTask) return null;
    try {
      const result = await window.octopusBeak.automation.viewerInspect(humanTask.id, point);
      viewerError = "";
      return result;
    } catch (error) {
      viewerError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  async function forceQuitHumanViewer() {
    if (!humanTask) return;
    if (!confirm($t.automation.confirmForceQuit)) return;
    try {
      await window.octopusBeak.automation.forceQuit(humanTask.id);
      closeHumanViewer();
      await reload();
    } catch (error) {
      viewerError = error instanceof Error ? error.message : String(error);
    }
  }

  function resumeHumanViewer() {
    if (!humanTask) return;
    const task = humanTask;
    closeHumanViewer();
    void runTask(task);
  }

  function pointerPoint(event: PointerEvent) {
    const image = event.currentTarget as HTMLImageElement;
    const rect = image.getBoundingClientRect();
    if (!image.naturalWidth || !image.naturalHeight || !rect.width || !rect.height) return null;
    const frameRect = image.parentElement?.getBoundingClientRect() ?? rect;
    return {
      x: (event.clientX - rect.left) * (image.naturalWidth / rect.width),
      y: (event.clientY - rect.top) * (image.naturalHeight / rect.height),
      left: event.clientX - frameRect.left,
      top: event.clientY - frameRect.top,
      frameWidth: frameRect.width,
      frameHeight: frameRect.height,
    };
  }

  function floatingInputAnchor(point: NonNullable<ReturnType<typeof pointerPoint>>) {
    return {
      left: Math.min(Math.max(point.left + 12, 12), Math.max(12, point.frameWidth - 300)),
      top: Math.min(Math.max(point.top, 36), Math.max(36, point.frameHeight - 36)),
    };
  }

  function handleViewerPointerDown(event: PointerEvent) {
    const point = pointerPoint(event);
    if (!point) return;
    dragStart = { ...point, pointerId: event.pointerId };
    (event.currentTarget as HTMLImageElement).setPointerCapture(event.pointerId);
  }

  function handleViewerPointerUp(event: PointerEvent) {
    if (!dragStart || dragStart.pointerId !== event.pointerId) return;
    const image = event.currentTarget as HTMLImageElement;
    const point = pointerPoint(event);
    const start = dragStart;
    dragStart = null;
    if (image.hasPointerCapture(event.pointerId)) image.releasePointerCapture(event.pointerId);
    if (!point) return;

    const moved = Math.hypot(point.x - start.x, point.y - start.y);
    if (moved <= 8) {
      void handleViewerClick(point);
    } else {
      floatingInput = null;
      void sendViewerInput({ type: "drag", x: start.x, y: start.y, toX: point.x, toY: point.y });
    }
  }

  function handleViewerPointerCancel(event: PointerEvent) {
    if (dragStart?.pointerId !== event.pointerId) return;
    const image = event.currentTarget as HTMLImageElement;
    dragStart = null;
    if (image.hasPointerCapture(event.pointerId)) image.releasePointerCapture(event.pointerId);
  }

  async function handleViewerClick(point: NonNullable<ReturnType<typeof pointerPoint>>) {
    floatingInput = null;
    await sendViewerInput({ type: "click", x: point.x, y: point.y });
    const inspected = await inspectViewerPoint({ x: point.x, y: point.y });
    if (!inspected?.editable) return;
    floatingInput = { ...floatingInputAnchor(point), value: "" };
    await tick();
    floatingInputEl?.focus();
  }

  function updateFloatingInput(event: Event) {
    if (!floatingInput) return;
    floatingInput = { ...floatingInput, value: (event.currentTarget as HTMLInputElement).value };
  }

  function submitFloatingInput(event: SubmitEvent) {
    event.preventDefault();
    if (!floatingInput?.value) return;
    const text = floatingInput.value;
    floatingInput = null;
    void sendViewerInput({ type: "type", text });
  }

  function taskIdLabel(taskId: string, dictionary: Translation) {
    return (dictionary.automation.taskLabels as Record<string, string>)[taskId] ?? taskId;
  }

  function taskLabel(task: AutomationTaskRow, dictionary: Translation) {
    return (dictionary.automation.taskLabels as Record<string, string>)[task.id] ?? task.label;
  }

  function importLockTitle(task: AutomationTaskRow, dictionary: Translation) {
    if (task.id !== "import-downloads-csv" || task.status !== "locked") return undefined;
    const missing = automation.importGate.missingTaskIds.map((taskId) => taskIdLabel(taskId, dictionary));
    return missing.length > 0 ? dictionary.automation.importLockedBy(missing.join(", ")) : dictionary.automation.progressLocked;
  }

  function progressLabel(task: AutomationTaskRow, dictionary: Translation) {
    if (task.progressPercent !== null) return `${task.progressPercent}%`;
    if (task.status === "running") return dictionary.automation.progressRunning(task.attempt || 1, task.maxAttempts);
    if (task.status === "retrying") return dictionary.automation.progressRetrying(task.attempt || 1, task.maxAttempts);
    if (task.status === "waiting_for_human") return dictionary.automation.progressWaiting;
    if (task.status === "completed") return dictionary.automation.progressCompleted;
    if (task.status === "failed") return dictionary.automation.progressFailed;
    if (task.status === "locked") return dictionary.automation.progressLocked;
    return dictionary.automation.progressQueued;
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<DashboardShell
  active="automation"
  eyebrow={$t.automation.eyebrow}
  title={$t.automation.title}
  sideLabel={$t.automation.sideLabel}
  {sideValue}
  {sideSub}
>
  <svelte:fragment slot="topbar-actions">
    <span class={`chip ${topStatusClass}`}>{topStatus}</span>
  </svelte:fragment>

  <div class="content automation-content">
    <section class="automation-command-grid" aria-label={$t.automation.commandCenter}>
      <article class="card command-card command-primary">
        <div class="command-topline">
          <span class="label">{$t.automation.commandCenter}</span>
          <span class={`chip ${topStatusClass}`}>{topStatus}</span>
        </div>
        <h2>{sideValue}</h2>
      </article>

      <article class="card command-card">
        <div>
          <span class="label">{$t.automation.controls}</span>
          <h2>{$t.automation.taskQueue}</h2>
        </div>
        <div class="command-actions">
          <button class="button secondary fixed-action" type="button" onclick={openCredentials}>{$t.automation.credentials}</button>
          <button class="button secondary fixed-action" type="button" onclick={() => void openRunHistory()}>
            {$t.automation.runHistory}
          </button>
        </div>
      </article>
    </section>

    <section class="automation-stats" aria-label={$t.automation.statusSummary}>
      {#each automationStats as stat}
        <article class="card automation-stat">
          <span class="label">{stat.label}</span>
          <strong>{stat.value}</strong>
          <span class={`chip ${stat.tone}`}>{stat.detail}</span>
        </article>
      {/each}
    </section>

    <section class="card task-board">
      <div class="panel-title automation-title">
        <div>
          <h2>{$t.automation.taskQueue}</h2>
        </div>
      </div>

      <div class="table-wrap">
        <table class="table automation-table">
          <thead>
            <tr>
              <th>{$t.automation.task}</th>
              <th>{$t.automation.status}</th>
              <th>{$t.automation.progress}</th>
              <th>{$t.automation.ranToday}</th>
              <th class="right">{$t.automation.controls}</th>
            </tr>
          </thead>
          <tbody>
            {#each automation.tasks as task}
              <tr class:task-active={task.isActive} class:task-attention={statusClass(task.status) === "bad" || task.status === "waiting_for_human"}>
                <td>
                  <div class="task-name">
                    <strong>{taskLabel(task, $t)}</strong>
                    <span>{task.script}</span>
                    <span>{$t.automation.latestUtc}: {latestTaskTime(task)}</span>
                  </div>
                </td>
                <td>
                  <span class={`chip ${statusClass(task.status)}`} title={importLockTitle(task, $t)}>
                    {$t.automation.statusLabels[task.status]}
                  </span>
                </td>
                <td>
                  <div class="progress-cell">
                    <div class="progress-bar" aria-hidden="true">
                      <span style={`width: ${task.progressPercent ?? 0}%`}></span>
                    </div>
                    <span class="mono">{progressLabel(task, $t)}</span>
                  </div>
                </td>
                <td>
                  <span class={`chip ${task.ranToday ? "good" : ""}`}>
                    {task.ranToday ? $t.automation.ran : $t.automation.notRun}
                  </span>
                </td>
                <td class="right">
                  <div class="task-actions">
                    <button
                      class={`button task-control ${task.primaryAction === "Cancel" ? "danger" : "primary"}`}
                      type="button"
                      disabled={!task.canRun}
                      aria-busy={task.isActive}
                      title={importLockTitle(task, $t)}
                      onclick={() => void primaryTaskAction(task)}
                    >
                      {#if task.isActive}<span class="spinner" aria-hidden="true"></span>{/if}
                      <span>{$t.automation.actionLabels[task.primaryAction]}</span>
                    </button>
                    {#if task.status === "waiting_for_human" && task.humanSession}
                      <button class="button secondary task-control" type="button" onclick={() => openHumanViewer(task)}>
                        {$t.automation.assist}
                      </button>
                    {/if}
                    <button class="button secondary task-control" type="button" onclick={() => (logTask = task)}>
                      {$t.automation.logs}
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if actionError}<p class="viewer-error">{actionError}</p>{/if}
    </section>
  </div>
</DashboardShell>

{#if credentialsOpen}
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="credentials-title">
    <button class="modal-backdrop" type="button" aria-label={$t.automation.closeCredentials} onclick={closeCredentials}></button>
    <form class="modal-panel credential-modal" onsubmit={saveCredentials}>
      <div class="modal-head">
        <div>
          <h2 id="credentials-title">{$t.automation.credentialsTitle}</h2>
          <p>{$t.automation.credentialsDescription}</p>
        </div>
        <div class="credential-head-actions">
          <button class="button fixed-action" type="button" onclick={closeCredentials}>{$t.common.cancel}</button>
          <button class="button primary fixed-action" type="submit">{$t.common.save}</button>
        </div>
      </div>
      <div class="modal-body credential-body">
        <div class="credential-sections">
          {#each credentialGroups as group}
            <section class="credential-section" aria-labelledby={`${group.id}-credentials-title`}>
              <div class="credential-section-head">
                <h3 id={`${group.id}-credentials-title`}>{group.label}</h3>
                <button
                  class="switch credential-switch"
                  class:dirty={(groupEnabled[group.id] !== false) !== group.enabled}
                  type="button"
                  aria-pressed={groupEnabled[group.id] !== false}
                  onclick={() => toggleGroup(group.id)}
                >
                  <span>{$t.common.enabled}</span>
                  <span class="switch-track" aria-hidden="true"></span>
                </button>
              </div>
              <div class="credential-grid">
                {#each group.credentialKeys as key}
                  <label class="credential-field">
                    <span>{credentialLabel(key, $t)}</span>
                    <input
                      name={key}
                      type={key.includes("PASSWORD") || key.includes("SECRET") || key.includes("KEY") ? "password" : "text"}
                      value={credentialDrafts[key] ?? ""}
                      class:dirty={Boolean(credentialDrafts[key]?.trim())}
                      oninput={(event) => updateCredentialDraft(key, event)}
                      placeholder={automation.credentials[key] ? $t.common.saved : $t.common.missing}
                      autocomplete="off"
                    />
                  </label>
                {/each}
              </div>
            </section>
          {/each}
        </div>
      </div>
    </form>
  </div>
{/if}

{#if historyOpen}
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="history-title">
    <button class="modal-backdrop" type="button" aria-label={$t.automation.closeRunHistory} onclick={() => (historyOpen = false)}></button>
    <div class="modal-panel history-modal">
      <div class="modal-head">
        <div>
          <h2 id="history-title">{$t.automation.runHistory}</h2>
          <p>{historyRows.length} / 100</p>
        </div>
        <button class="modal-close" type="button" aria-label={$t.common.close} onclick={() => (historyOpen = false)}>x</button>
      </div>
      <div class="modal-body history-body">
        <table class="table history-table">
          <thead>
            <tr>
              <th>{$t.automation.task}</th>
              <th>{$t.automation.status}</th>
              <th>{$t.automation.historyStartedUtc}</th>
              <th>{$t.automation.historyFinishedUtc}</th>
              <th>{$t.automation.historyError}</th>
            </tr>
          </thead>
          <tbody>
            {#if historyLoading}
              <tr>
                <td colspan="5">{$t.common.loading}</td>
              </tr>
            {/if}
            {#each historyRows as run}
              <tr>
                <td>
                  <div class="task-name">
                    <strong>{taskIdLabel(run.taskId, $t)}</strong>
                    <span>{run.script}</span>
                  </div>
                </td>
                <td><span class={`chip ${statusClass(run.status)}`}>{$t.automation.statusLabels[run.status]}</span></td>
                <td class="mono">{formatTime(run.startedAt)}</td>
                <td class="mono">{formatTime(run.finishedAt)}</td>
                <td class="history-error">{run.errorMessage ?? "--"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>
{/if}

{#if logTask}
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="logs-title">
    <button class="modal-backdrop" type="button" aria-label={$t.automation.closeLogs} onclick={() => (logTask = null)}></button>
    <div class="modal-panel">
      <div class="modal-head">
        <div>
          <h2 id="logs-title">{$t.automation.logsTitle(taskLabel(logTask, $t))}</h2>
          <p>{logTask.logPath ?? $t.automation.noLogFile}</p>
        </div>
        <button class="modal-close" type="button" aria-label={$t.common.close} onclick={() => (logTask = null)}>x</button>
      </div>
      <div class="modal-body">
        <pre class="log-output">{logTask.errorMessage ?? (logTask.logTail || $t.automation.noLogs)}</pre>
      </div>
    </div>
  </div>
{/if}

{#if humanTask}
  <div class="modal" class:viewer-modal-expanded={viewerExpanded} role="dialog" aria-modal="true" aria-labelledby="human-viewer-title">
    <button class="modal-backdrop" type="button" aria-label={$t.automation.closeAssist} onclick={closeHumanViewer}></button>
    <div class="modal-panel human-viewer-modal" class:expanded={viewerExpanded}>
      <div class="modal-head viewer-head">
        <div class="viewer-title">
          <h2 id="human-viewer-title">{$t.automation.assistTitle(taskLabel(humanTask, $t))}</h2>
          <p>{humanTask.humanSession ?? $t.automation.noSession}</p>
        </div>
        <div class="viewer-actions">
          <button class="button danger fixed-action force-quit-action" type="button" onclick={forceQuitHumanViewer}>
            {$t.automation.forceQuit}
          </button>
          <button class="button primary fixed-action" type="button" onclick={resumeHumanViewer}>
            {$t.automation.resume}
          </button>
          <button class="modal-close" type="button" aria-label={$t.common.close} onclick={closeHumanViewer}>x</button>
        </div>
      </div>
      <div class="modal-body viewer-body">
        <div class="viewer-frame">
          <img
            class="viewer-image"
            src={viewerImageUrl}
            alt={$t.automation.pausedBrowser}
            draggable="false"
            onload={() => (viewerError = "")}
            onerror={() => (viewerError = $t.automation.screenshotUnavailable)}
            onpointerdown={handleViewerPointerDown}
            onpointerup={handleViewerPointerUp}
            onpointercancel={handleViewerPointerCancel}
          />
          <button
            class="viewer-expand-action"
            type="button"
            aria-label={viewerExpanded ? $t.automation.exitFullscreen : $t.automation.fullscreen}
            aria-pressed={viewerExpanded}
            onclick={() => (viewerExpanded = !viewerExpanded)}
          >
            <span aria-hidden="true"></span>
          </button>
          {#if floatingInput}
            <form
              class="viewer-floating-input"
              style={`left: ${floatingInput.left}px; top: ${floatingInput.top}px;`}
              onsubmit={submitFloatingInput}
            >
              <input
                bind:this={floatingInputEl}
                type="text"
                maxlength="128"
                aria-label={$t.automation.textToTypeAria}
                placeholder={$t.automation.typeText}
                autocomplete="off"
                value={floatingInput.value}
                oninput={updateFloatingInput}
              />
              <button class="viewer-floating-submit" type="submit" aria-label={$t.automation.sendText}>
                <span aria-hidden="true"></span>
              </button>
            </form>
          {/if}
        </div>
        {#if viewerError}<p class="viewer-error">{viewerError}</p>{/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .automation-content {
    display: grid;
    gap: var(--space-6);
  }

  .automation-command-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
    gap: var(--space-4);
  }

  .command-card {
    min-height: 132px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-5);
  }

  .command-card h2 {
    margin: var(--space-2) 0 0;
    font-size: clamp(24px, 3vw, 34px);
    line-height: 1.05;
  }

  .command-primary {
    border-color: color-mix(in oklch, var(--accent) 12%, var(--border));
    background: var(--surface);
  }

  .command-topline,
  .command-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .command-topline {
    justify-content: space-between;
  }

  .automation-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-4);
  }

  .automation-stat {
    min-height: 132px;
    display: grid;
    align-content: space-between;
    gap: var(--space-4);
    padding: var(--space-5);
  }

  .automation-stat strong {
    font-family: var(--font-mono);
    font-size: 30px;
    line-height: 1;
  }

  .task-board {
    overflow: hidden;
  }

  .automation-title {
    align-items: flex-start;
  }

  .modal-head p {
    margin: var(--space-1) 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .automation-table td {
    vertical-align: middle;
  }

  .automation-table tr.task-active td {
    background: color-mix(in oklch, var(--warn) 2%, white);
  }

  .automation-table tr.task-attention td {
    background: color-mix(in oklch, var(--danger) 2%, white);
  }

  .task-name {
    min-width: 220px;
    display: grid;
    gap: 2px;
  }

  .task-name strong {
    font-weight: 720;
  }

  .task-name span,
  .mono {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .progress-cell {
    min-width: 150px;
    display: grid;
    gap: var(--space-1);
  }

  .progress-bar {
    width: 100%;
    height: 6px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface-soft);
  }

  .progress-bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
  }

  .task-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .task-control,
  .fixed-action {
    width: 112px;
    min-width: 112px;
  }

  .task-control {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
  }

  .history-modal {
    width: min(1040px, 100%);
  }

  .history-body {
    max-height: min(68vh, 720px);
    overflow: auto;
    padding: 0;
  }

  .history-table td {
    vertical-align: middle;
  }

  .history-error {
    max-width: 320px;
    color: var(--muted);
    font-size: 12px;
  }

  .spinner {
    box-sizing: border-box;
    flex: 0 0 14px;
    width: 14px;
    height: 14px;
    border: 2px solid rgb(255 255 255 / 0.35);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .chip.warn {
    color: var(--warn);
    background: color-mix(in oklch, var(--warn) 6%, white);
  }

  .chip.bad {
    color: var(--danger);
    background: color-mix(in oklch, var(--danger) 6%, white);
  }

  .credential-modal {
    width: min(820px, 100%);
  }

  .credential-body {
    padding: var(--space-5);
  }

  .credential-head-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .credential-sections {
    display: grid;
    gap: var(--space-4);
  }

  .credential-section {
    display: grid;
    gap: var(--space-4);
    padding-bottom: var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .credential-section:last-child {
    padding-bottom: 0;
    border-bottom: 0;
  }

  .credential-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .credential-section h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 760;
  }

  .credential-switch {
    min-width: 132px;
  }

  .credential-switch.dirty {
    border-color: color-mix(in oklch, var(--accent) 44%, var(--border));
    background: var(--accent-soft);
  }

  .credential-switch .switch-track {
    background: var(--border);
  }

  .credential-switch .switch-track::after {
    right: auto;
    left: 3px;
  }

  .credential-switch[aria-pressed="true"] .switch-track {
    background: var(--fg);
  }

  .credential-switch[aria-pressed="true"] .switch-track::after {
    transform: translateX(16px);
  }

  .credential-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4);
  }

  .credential-field {
    display: grid;
    gap: var(--space-2);
  }

  .credential-field span {
    color: var(--muted);
    font-size: 11px;
    font-weight: 720;
    letter-spacing: 0.075em;
    text-transform: uppercase;
  }

  .credential-field input {
    min-height: 44px;
    padding: 0 var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
    outline: none;
  }

  .credential-field input:focus {
    border-color: var(--fg);
    box-shadow: 0 0 0 3px var(--surface-soft);
  }

  .credential-field input.dirty {
    border-color: color-mix(in oklch, var(--accent) 44%, var(--border));
    background: var(--accent-soft);
  }

  .human-viewer-modal {
    width: min(1080px, calc(100vw - 48px));
    display: flex;
    flex-direction: column;
    border-radius: 20px;
  }

  .human-viewer-modal.expanded {
    width: calc(100vw - 48px);
    height: calc(100vh - 144px);
    max-height: calc(100vh - 144px);
  }

  .viewer-modal-expanded {
    padding-block: calc(var(--space-6) * 3);
  }

  .viewer-head {
    align-items: center;
    padding: var(--space-4);
    border-bottom: 0;
    background: linear-gradient(180deg, var(--surface), color-mix(in oklch, var(--surface-soft) 44%, var(--surface)));
  }

  .viewer-title {
    min-width: 0;
    display: grid;
    gap: var(--space-2);
  }

  .viewer-title h2 {
    font-size: 19px;
    line-height: 1.15;
  }

  .viewer-title p {
    width: fit-content;
    max-width: 100%;
    margin: 0;
    padding: 4px 9px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .viewer-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .human-viewer-modal .fixed-action {
    width: auto;
    min-width: 96px;
    min-height: 36px;
    padding: 0 var(--space-4);
    border-radius: 10px;
  }

  .human-viewer-modal .modal-close {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    font-size: 18px;
  }

  .viewer-body {
    min-height: 0;
    display: grid;
    gap: var(--space-3);
    padding: 0 var(--space-4) var(--space-4);
    background: color-mix(in oklch, var(--surface-soft) 44%, var(--surface));
  }

  .human-viewer-modal.expanded .viewer-body {
    flex: 1;
    grid-template-rows: minmax(0, 1fr) auto;
    padding: 0;
  }

  .viewer-frame {
    position: relative;
    min-width: 0;
    min-height: 0;
    width: 100%;
    overflow: hidden;
    display: grid;
    justify-self: center;
    place-items: center;
    max-width: 100%;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: oklch(18% 0.025 250);
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.04);
  }

  .human-viewer-modal.expanded .viewer-frame {
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: 0;
  }

  .viewer-image {
    display: block;
    width: 100%;
    max-width: 100%;
    max-height: min(72vh, 720px);
    object-fit: contain;
    border: 0;
    border-radius: 0;
    background: transparent;
    touch-action: none;
    user-select: none;
  }

  .human-viewer-modal.expanded .viewer-image {
    max-height: 100%;
  }

  .viewer-expand-action {
    position: absolute;
    top: var(--space-3);
    right: var(--space-3);
    width: 44px;
    height: 44px;
    border: 1px solid color-mix(in oklch, var(--fg) 16%, transparent);
    border-radius: 12px;
    background: color-mix(in oklch, var(--surface) 92%, transparent);
    box-shadow: var(--shadow);
    cursor: pointer;
  }

  .viewer-expand-action span,
  .viewer-expand-action span::before,
  .viewer-floating-submit span,
  .viewer-floating-submit span::before {
    position: absolute;
    display: block;
    content: "";
  }

  .viewer-expand-action span {
    inset: 12px;
    border: 2px solid var(--fg);
    border-radius: 3px;
  }

  .viewer-expand-action[aria-pressed="true"] span {
    inset: 14px;
  }

  .viewer-expand-action:focus-visible,
  .viewer-floating-submit:focus-visible,
  .viewer-floating-input input:focus {
    outline: none;
    box-shadow: 0 0 0 3px var(--surface-soft);
  }

  .viewer-floating-input {
    position: absolute;
    z-index: 2;
    width: min(288px, calc(100% - 24px));
    min-height: 44px;
    padding: 5px;
    display: flex;
    gap: var(--space-2);
    align-items: center;
    overflow: hidden;
    border: 1px solid rgb(255 255 255 / 0.28);
    border-radius: calc(var(--radius) + 6px);
    background: rgb(255 255 255 / 0.16);
    box-shadow: var(--shadow);
    transform: translateY(-50%);
    backdrop-filter: blur(3px);
    transition: background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, backdrop-filter 0.18s ease;
  }

  .viewer-floating-input::before {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 74%;
    height: 160%;
    display: block;
    content: "";
    pointer-events: none;
    background: linear-gradient(90deg, transparent, rgb(99 102 241 / 0.2), rgb(14 165 233 / 0.16), transparent);
    opacity: 0.9;
    transform: translate(-50%, -50%);
    animation: floating-gradient 2.6s ease-in-out infinite alternate;
  }

  .viewer-floating-input:hover {
    border-color: rgb(255 255 255 / 0.78);
    background: rgb(255 255 255 / 0.88);
    box-shadow: 0 16px 40px rgb(15 23 42 / 0.18);
    backdrop-filter: blur(18px) saturate(1.35);
  }

  .viewer-floating-input:hover::before {
    opacity: 0.42;
  }

  @keyframes floating-gradient {
    from {
      transform: translate(-68%, -50%);
    }

    to {
      transform: translate(-32%, -50%);
    }
  }

  .viewer-floating-input input {
    position: relative;
    z-index: 1;
    min-width: 0;
    min-height: 38px;
    flex: 1;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: rgb(255 255 255 / 0.36);
    color: var(--fg);
    backdrop-filter: none;
    transition: background 0.18s ease;
  }

  .viewer-floating-input:hover input {
    background: rgb(255 255 255 / 0.96);
    backdrop-filter: blur(8px);
  }

  .viewer-floating-submit {
    position: relative;
    z-index: 1;
    flex: 0 0 38px;
    width: 38px;
    height: 38px;
    border: 1px solid rgb(15 23 42 / 0.14);
    border-radius: 12px;
    background: rgb(255 255 255 / 0.7);
    color: var(--fg);
    box-shadow: 0 8px 18px rgb(15 23 42 / 0.12), inset 0 1px 0 rgb(255 255 255 / 0.72);
    cursor: pointer;
    transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
  }

  .viewer-floating-submit:hover {
    border-color: rgb(15 23 42 / 0.22);
    background: var(--fg);
    color: var(--surface);
    transform: translateY(-1px);
  }

  .viewer-floating-submit span {
    left: 50%;
    top: 50%;
    width: 2px;
    height: 16px;
    border-radius: 999px;
    background: currentColor;
    transform: translate(-50%, -50%);
  }

  .viewer-floating-submit span::before {
    left: 50%;
    top: 0;
    width: 9px;
    height: 9px;
    border-top: 2px solid currentColor;
    border-left: 2px solid currentColor;
    transform: translate(-50%, -1px) rotate(45deg);
  }

  .viewer-error {
    margin: 0;
    color: var(--danger);
    font-size: 13px;
  }

  .force-quit-action {
    color: var(--danger);
    background: color-mix(in oklch, var(--danger) 5%, var(--surface));
  }

  .log-output {
    min-height: 240px;
    margin: 0;
    padding: var(--space-5);
    overflow: auto;
    color: var(--fg);
    background: var(--surface-soft);
    font-family: var(--font-mono);
    font-size: 12px;
    white-space: pre-wrap;
  }

  @media (max-width: 820px) {
    .automation-command-grid,
    .automation-stats {
      grid-template-columns: 1fr;
    }

    .command-actions,
    .command-actions .button,
    .automation-stat .chip {
      width: 100%;
    }

    .credential-section-head {
      align-items: flex-start;
      flex-direction: column;
    }

    .credential-grid {
      grid-template-columns: 1fr;
    }

    .task-actions {
      justify-content: flex-start;
    }

    .human-viewer-modal .modal-head {
      flex-direction: column;
    }

    .viewer-actions {
      width: 100%;
      justify-content: flex-start;
    }
  }
</style>
