<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { invalidateAll } from "$app/navigation";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import type { AutomationPageModel, AutomationTaskRow } from "./server/page-model.ts";

  type CredentialGroup = {
    id: string;
    label: string;
    enabledKey: string;
    enabled: boolean;
    credentialKeys: readonly string[];
  };

  export let automation: AutomationPageModel;
  export let credentialGroups: CredentialGroup[];

  let credentialsOpen = false;
  let logTask: AutomationTaskRow | null = null;
  let humanTask: AutomationTaskRow | null = null;
  let valuesVisible = true;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let viewerTimer: ReturnType<typeof setInterval> | null = null;
  let viewerImageUrl = "";
  let viewerError = "";
  let dragStart: { x: number; y: number; pointerId: number } | null = null;
  let groupEnabled: Record<string, boolean> = {};
  let credentialDrafts: Record<string, string> = {};

  $: sideValue = automation.active ? `${automation.activeTaskCount} running` : automation.importGate.locked ? "Import locked" : "Ready";
  $: sideSub = `Business day ${automation.businessDate}`;
  $: topStatus = automation.active
    ? `${automation.activeTaskCount} running`
    : automation.importGate.locked
      ? "Import locked"
      : "Ready";
  $: topStatusClass = automation.active
    ? "warn"
    : automation.importGate.locked
      ? "bad"
      : "good";
  $: credentialInputDirty = Object.values(credentialDrafts).some((value) => value.trim().length > 0);
  $: credentialToggleDirty = credentialGroups.some((group) => (groupEnabled[group.id] !== false) !== group.enabled);
  $: credentialsDirty = credentialInputDirty || credentialToggleDirty;

  onMount(() => {
    if (automation.active) {
      pollTimer = setInterval(() => {
        void invalidateAll();
      }, 2_000);
    }
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (viewerTimer) clearInterval(viewerTimer);
  });

  function statusClass(status: string) {
    if (status === "completed") return "good";
    if (status === "failed" || status === "locked") return "bad";
    if (status === "running" || status === "retrying" || status === "waiting_for_human") return "warn";
    return "";
  }

  function formatTime(value: string | null) {
    return value?.slice(0, 19).replace("T", " ") ?? "--";
  }

  function credentialLabel(key: string) {
    return key
      .replace(/^LIBRETTO_CLOUD_/, "")
      .replace(/_/g, " ")
      .toLowerCase();
  }

  function actionName(task: AutomationTaskRow) {
    if (task.primaryAction === "Retry") return "retry";
    if (task.primaryAction === "Resume") return "resume";
    return "run";
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
    if (credentialsDirty && !confirm("Discard unsaved credential changes?")) return;
    resetCredentialChanges();
    credentialsOpen = false;
  }

  function closeCredentialsOnEscape(event: KeyboardEvent) {
    if (!credentialsOpen || event.key !== "Escape") return;
    event.preventDefault();
    closeCredentials();
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

  function refreshViewerImage() {
    if (!humanTask) return;
    viewerImageUrl = `/automation/viewer/screenshot?taskId=${encodeURIComponent(humanTask.id)}&t=${Date.now()}`;
  }

  function openHumanViewer(task: AutomationTaskRow) {
    humanTask = task;
    viewerError = "";
    dragStart = null;
    refreshViewerImage();
    if (viewerTimer) clearInterval(viewerTimer);
    viewerTimer = setInterval(refreshViewerImage, 750);
  }

  function closeHumanViewer() {
    if (viewerTimer) clearInterval(viewerTimer);
    viewerTimer = null;
    humanTask = null;
    viewerImageUrl = "";
    viewerError = "";
    dragStart = null;
  }

  async function sendViewerInput(input: unknown) {
    if (!humanTask) return;
    const response = await fetch("/automation/viewer/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: humanTask.id, input }),
    });

    if (!response.ok) {
      viewerError = await response.text();
      return;
    }

    viewerError = "";
    refreshViewerImage();
  }

  function pointerPoint(event: PointerEvent) {
    const image = event.currentTarget as HTMLImageElement;
    const rect = image.getBoundingClientRect();
    if (!image.naturalWidth || !image.naturalHeight || !rect.width || !rect.height) return null;
    return {
      x: (event.clientX - rect.left) * (image.naturalWidth / rect.width),
      y: (event.clientY - rect.top) * (image.naturalHeight / rect.height),
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
    void sendViewerInput(
      moved <= 8
        ? { type: "click", x: point.x, y: point.y }
        : { type: "drag", x: start.x, y: start.y, toX: point.x, toY: point.y },
    );
  }

  function handleViewerPointerCancel(event: PointerEvent) {
    if (dragStart?.pointerId === event.pointerId) dragStart = null;
  }

  function handleViewerType(event: KeyboardEvent) {
    const input = event.currentTarget as HTMLInputElement;
    if (event.key !== "Enter" || !input.value) return;
    event.preventDefault();
    void sendViewerInput({ type: "type", text: input.value });
    input.value = "";
  }
</script>

<svelte:window onkeydown={closeCredentialsOnEscape} />

<DashboardShell
  active="automation"
  eyebrow="Automation"
  title="Statement Update"
  sideLabel="Automation"
  {sideValue}
  {sideSub}
  bind:valuesVisible
>
  <svelte:fragment slot="topbar-actions">
    <span class={`chip ${topStatusClass}`}>{topStatus}</span>
    <button class="button secondary fixed-action" type="button" onclick={openCredentials}>Credentials</button>
  </svelte:fragment>

  <div class="content">
    <section class="card">
      <div class="panel-title automation-title">
        <div>
          <h2>Task queue</h2>
          <p>Tasks can run in parallel. CSV import unlocks from today's persisted crawler history, not page state.</p>
        </div>
      </div>

      <div class="table-wrap">
        <table class="table automation-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Attempt</th>
              <th>Latest UTC</th>
              <th class="right">Controls</th>
            </tr>
          </thead>
          <tbody>
            {#each automation.tasks as task}
              <tr>
                <td>
                  <div class="task-name">
                    <strong>{task.label}</strong>
                    <span>{task.script}</span>
                  </div>
                </td>
                <td><span class={`chip ${statusClass(task.status)}`}>{task.status.replaceAll("_", " ")}</span></td>
                <td>
                  <div class="progress-cell">
                    <div class="progress-bar" aria-hidden="true">
                      <span style={`width: ${task.progressPercent ?? 0}%`}></span>
                    </div>
                    <span class="mono">{task.progressText}</span>
                  </div>
                </td>
                <td class="mono">{task.attempt}/{task.maxAttempts}</td>
                <td class="mono">{formatTime(task.latestFinishedAt ?? task.latestStartedAt)}</td>
                <td class="right">
                  <div class="task-actions">
                    <form method="POST" action={`?/${actionName(task)}`}>
                      <input type="hidden" name="taskId" value={task.id} />
                      <button class="button primary task-control" type="submit" disabled={!task.canRun} aria-busy={task.isActive}>
                        {#if task.isActive}<span class="spinner" aria-hidden="true"></span>{/if}
                        <span>{task.primaryAction}</span>
                      </button>
                    </form>
                    {#if task.status === "waiting_for_human" && task.humanSession}
                      <button class="button secondary task-control" type="button" onclick={() => openHumanViewer(task)}>
                        Assist
                      </button>
                    {/if}
                    <button class="button secondary task-control" type="button" onclick={() => (logTask = task)}>
                      Logs
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  </div>
</DashboardShell>

{#if credentialsOpen}
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="credentials-title">
    <button class="modal-backdrop" type="button" aria-label="Close credentials" onclick={closeCredentials}></button>
    <form class="modal-panel credential-modal" method="POST" action="?/saveCredentials">
      <div class="modal-head">
        <div>
          <h2 id="credentials-title">Credentials</h2>
          <p>Saved to local .env. Existing secret values are shown only as saved or missing.</p>
        </div>
        <div class="credential-head-actions">
          <button class="button fixed-action" type="button" onclick={closeCredentials}>Cancel</button>
          <button class="button primary fixed-action" type="submit">Save .env</button>
        </div>
      </div>
      <div class="modal-body credential-body">
        <div class="credential-sections">
          {#each credentialGroups as group}
            <section class="credential-section" aria-labelledby={`${group.id}-credentials-title`}>
              <div class="credential-section-head">
                <h3 id={`${group.id}-credentials-title`}>{group.label}</h3>
                <input type="hidden" name={group.enabledKey} value={groupEnabled[group.id] !== false ? "true" : "false"} />
                <button
                  class="switch credential-switch"
                  class:dirty={(groupEnabled[group.id] !== false) !== group.enabled}
                  type="button"
                  aria-pressed={groupEnabled[group.id] !== false}
                  onclick={() => toggleGroup(group.id)}
                >
                  <span>Enabled</span>
                  <span class="switch-track" aria-hidden="true"></span>
                </button>
              </div>
              <div class="credential-grid">
                {#each group.credentialKeys as key}
                  <label class="credential-field">
                    <span>{credentialLabel(key)}</span>
                    <input
                      name={key}
                      type={key.includes("PASSWORD") || key.includes("SECRET") || key.includes("KEY") ? "password" : "text"}
                      value={credentialDrafts[key] ?? ""}
                      class:dirty={Boolean(credentialDrafts[key]?.trim())}
                      oninput={(event) => updateCredentialDraft(key, event)}
                      placeholder={automation.credentials[key] ? "saved" : "missing"}
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

{#if logTask}
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="logs-title">
    <button class="modal-backdrop" type="button" aria-label="Close logs" onclick={() => (logTask = null)}></button>
    <div class="modal-panel">
      <div class="modal-head">
        <div>
          <h2 id="logs-title">{logTask.label} Logs</h2>
          <p>{logTask.logPath ?? "No log file yet."}</p>
        </div>
        <button class="modal-close" type="button" aria-label="Close" onclick={() => (logTask = null)}>x</button>
      </div>
      <div class="modal-body">
        <pre class="log-output">{logTask.errorMessage ?? (logTask.logTail || "No logs yet.")}</pre>
      </div>
    </div>
  </div>
{/if}

{#if humanTask}
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="human-viewer-title">
    <button class="modal-backdrop" type="button" aria-label="Close assist" onclick={closeHumanViewer}></button>
    <div class="modal-panel human-viewer-modal">
      <div class="modal-head">
        <div>
          <h2 id="human-viewer-title">{humanTask.label} Assist</h2>
          <p>{humanTask.humanSession ?? "No session"}</p>
        </div>
        <div class="viewer-actions">
          <form method="POST" action="?/resume">
            <input type="hidden" name="taskId" value={humanTask.id} />
            <button class="button primary fixed-action" type="submit">Resume</button>
          </form>
          <button class="modal-close" type="button" aria-label="Close" onclick={closeHumanViewer}>x</button>
        </div>
      </div>
      <div class="modal-body viewer-body">
        <img
          class="viewer-image"
          src={viewerImageUrl}
          alt="Paused browser"
          draggable="false"
          onload={() => (viewerError = "")}
          onerror={() => (viewerError = "Viewer screenshot is not available yet.")}
          onpointerdown={handleViewerPointerDown}
          onpointerup={handleViewerPointerUp}
          onpointercancel={handleViewerPointerCancel}
        />
        <div class="viewer-keyboard">
          <input
            class="viewer-text-input"
            type="text"
            maxlength="128"
            autocomplete="off"
            onkeydown={handleViewerType}
          />
          <button class="button secondary fixed-action" type="button" onclick={() => void sendViewerInput({ type: "press", key: "Enter" })}>
            Enter
          </button>
        </div>
        {#if viewerError}<p class="viewer-error">{viewerError}</p>{/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .automation-title {
    align-items: flex-start;
  }

  .automation-title p,
  .modal-head p {
    margin: var(--space-1) 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .automation-table td {
    vertical-align: middle;
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
    background: color-mix(in oklch, var(--warn) 10%, white);
  }

  .chip.bad {
    color: var(--danger);
    background: color-mix(in oklch, var(--danger) 10%, white);
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
    width: min(1040px, 100%);
  }

  .viewer-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .viewer-body {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-5);
  }

  .viewer-image {
    display: block;
    width: 100%;
    max-height: min(68vh, 720px);
    object-fit: contain;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-soft);
    touch-action: none;
    user-select: none;
  }

  .viewer-keyboard {
    display: flex;
    gap: var(--space-3);
  }

  .viewer-text-input {
    min-width: 0;
    min-height: 44px;
    flex: 1;
    padding: 0 var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
    outline: none;
  }

  .viewer-text-input:focus {
    border-color: var(--fg);
    box-shadow: 0 0 0 3px var(--surface-soft);
  }

  .viewer-error {
    margin: 0;
    color: var(--danger);
    font-size: 13px;
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
  }
</style>
