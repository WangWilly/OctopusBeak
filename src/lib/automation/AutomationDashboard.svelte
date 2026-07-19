<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { slide } from "svelte/transition";
  import { ArrowLeftRight, CircleEllipsis, CloudDownload, Import as ImportIcon, Landmark } from "@lucide/svelte";
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
  let syncOpen = false;
  let syncTasks: AutomationTaskRow[] = [];
  let showAllCollectTasks = false;
  let expandedLogTaskId: string | null = null;
  let jumpHighlightTaskId: string | null = null;
  let jumpHighlightTimer: ReturnType<typeof setTimeout> | null = null;
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
  let hoveredTask: AutomationTaskRow | null = null;
  let taskTooltipPosition = { left: 0, top: 0 };
  let groupEnabled: Record<string, boolean> = {};
  let credentialDrafts: Record<string, string> = {};
  let stageOpen: Record<string, boolean> = { collect: true, import: false, sync: false };

  $: sideValue = automation.active
    ? $t.common.runningCount(automation.activeTaskCount)
    : automation.importGate.locked
      ? $t.common.importLocked
      : $t.common.ready;
  $: sideSub = $t.common.businessDay(automation.businessDate);
  $: parallelTaskIds = new Set(automation.parallelRunnableTaskIds);
  $: parallelTasks = automation.tasks.filter((task) => parallelTaskIds.has(task.id));
  $: activeTasks = automation.tasks.filter((task) => task.isActive || task.status === "waiting_for_human");
  $: iconTasks = automation.tasks.filter((task) =>
    task.isActive || task.status === "waiting_for_human" || task.status === "failed"
  );
  $: credentialReadyCount = syncTasks.filter((task) =>
    task.credentialKeys.every((key) => automation.credentials[key]),
  ).length;
  $: taskStages = [
    {
      id: "collect",
      title: $t.automation.collectStage,
      tasks: automation.tasks.filter((task) => task.kind === "crawler"),
    },
    {
      id: "import",
      title: $t.automation.importStage,
      tasks: automation.tasks.filter((task) => task.kind === "import"),
    },
    {
      id: "sync",
      title: $t.automation.syncStage,
      tasks: automation.tasks.filter((task) => task.kind === "sync"),
    },
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
    if (jumpHighlightTimer) clearTimeout(jumpHighlightTimer);
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

  function disclosureSlide(node: Element) {
    return slide(node, {
      duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220,
    });
  }

  function toggleStage(stageId: string) {
    stageOpen = { ...stageOpen, [stageId]: !stageOpen[stageId] };
  }

  async function toggleCollectTasks(event: MouseEvent) {
    const container = (event.currentTarget as HTMLElement)
      .closest(".stage-body")
      ?.querySelector<HTMLElement>(".table-reveal");
    if (!container) {
      showAllCollectTasks = !showAllCollectTasks;
      return;
    }

    const startHeight = container.offsetHeight;
    showAllCollectTasks = !showAllCollectTasks;
    await tick();
    const endHeight = container.offsetHeight;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    container.style.height = `${startHeight}px`;
    const animation = container.animate(
      [{ height: `${startHeight}px` }, { height: `${endHeight}px` }],
      { duration: 220, easing: "ease", fill: "both" },
    );
    await animation.finished;
    container.style.height = "";
    animation.cancel();
  }

  function stageRunnableTasks(tasks: AutomationTaskRow[]) {
    return tasks.filter((task) => parallelTaskIds.has(task.id));
  }

  function openSyncSheet(tasks: AutomationTaskRow[]) {
    syncTasks = stageRunnableTasks(tasks);
    if (syncTasks.length) syncOpen = true;
  }

  function formatTime(value: string | null) {
    return formatUtcDateTime(value, $systemTimezone, $locale) || "--";
  }

  function latestTaskTime(task: AutomationTaskRow) {
    return formatTime(task.latestFinishedAt ?? task.latestStartedAt);
  }

  function taskCredentialsReady(task: AutomationTaskRow) {
    return task.credentialKeys.every((key) => automation.credentials[key]);
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

  async function runParallelTasks() {
    const tasks = syncTasks;
    if (!tasks.length) return;
    syncOpen = false;
    const results = await Promise.allSettled(tasks.map((task) => window.octopusBeak.automation.run(task.id)));
    actionError = results
      .flatMap((result) => result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : [])
      .join("\n");
    await reload();
  }

  async function stopAllTasks() {
    if (!activeTasks.length || !confirm($t.automation.confirmStopAll)) return;
    const results = await Promise.allSettled(activeTasks.map((task) => window.octopusBeak.automation.cancel(task.id)));
    actionError = results
      .flatMap((result) => result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : [])
      .join("\n");
    await reload();
  }

  async function revealTaskLog(task: AutomationTaskRow) {
    const stageId = task.kind === "crawler" ? "collect" : task.kind;
    stageOpen = { ...stageOpen, [stageId]: true };
    if (stageId === "collect") showAllCollectTasks = true;
    expandedLogTaskId = task.id;
    jumpHighlightTaskId = task.id;
    if (jumpHighlightTimer) clearTimeout(jumpHighlightTimer);

    await tick();
    const target = document.getElementById(`${task.id}-task-row`);
    const inlineLog = document.getElementById(`${task.id}-inline-log`);
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    target?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    inlineLog?.querySelector<HTMLElement>(".inline-log-panel")?.focus({ preventScroll: true });
    jumpHighlightTimer = setTimeout(() => {
      jumpHighlightTaskId = null;
      jumpHighlightTimer = null;
    }, 1_400);
  }

  function handleActiveTaskClick(task: AutomationTaskRow) {
    if (task.status === "waiting_for_human" && task.humanSession) {
      openHumanViewer(task);
      return;
    }
    void revealTaskLog(task);
  }

  function scrollActiveTasks(event: WheelEvent) {
    const list = event.currentTarget as HTMLElement;
    if (list.scrollWidth <= list.clientWidth) return;
    event.preventDefault();
    list.scrollLeft += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    hideTaskTooltip();
  }

  function showTaskTooltip(task: AutomationTaskRow, event: Event) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    hoveredTask = task;
    taskTooltipPosition = {
      left: Math.min(Math.max(rect.left + rect.width / 2, 150), window.innerWidth - 150),
      top: rect.bottom + 10,
    };
  }

  function hideTaskTooltip() {
    hoveredTask = null;
  }

  function taskStageTitle(task: AutomationTaskRow, dictionary: Translation) {
    if (task.kind === "crawler") return dictionary.automation.collectStage;
    if (task.kind === "import") return dictionary.automation.importStage;
    return dictionary.automation.syncStage;
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

  async function resumeHumanViewer() {
    if (!humanTask) return;
    const task = humanTask;
    closeHumanViewer();
    try {
      actionError = "";
      await window.octopusBeak.automation.resume(task.id);
      await reload();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    }
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
    <button class="button secondary topbar-action" type="button" onclick={openCredentials}>{$t.automation.credentials}</button>
    <button class="button secondary topbar-action" type="button" onclick={() => void openRunHistory()}>
      {$t.automation.runHistory}
    </button>
  </svelte:fragment>

  <div class:sync-sheet-open={syncOpen} class="content automation-content">
    <section class:active={automation.active} class="card sync-hero" aria-label={$t.automation.commandCenter}>
      <div class="sync-hero-copy">
        {#if automation.active}
          <span class="running-kicker"><CloudDownload size={16} strokeWidth={2.2} aria-hidden="true" />{$t.automation.syncInProgress}</span>
        {/if}
        <h2>
          {automation.active
            ? $t.automation.runningTaskHeading(automation.activeTaskCount)
            : $t.automation.startImportHeading}
        </h2>
        {#if iconTasks.length}
          <div class="active-task-filter">
            <div
              class="active-task-jump-list"
              aria-label={$t.automation.taskQueue}
              onwheel={scrollActiveTasks}
            >
              {#each iconTasks as task (task.id)}
                <button
                  class="active-task-jump"
                  class:waiting={task.status === "waiting_for_human"}
                  class:failed={task.status === "failed"}
                  class:import-task={task.kind === "import"}
                  class:sync-task={task.kind === "sync"}
                  type="button"
                  aria-label={taskLabel(task, $t)}
                  aria-describedby={hoveredTask?.id === task.id ? "active-task-tooltip" : undefined}
                  title={taskLabel(task, $t)}
                  onpointerenter={(event) => showTaskTooltip(task, event)}
                  onpointerleave={hideTaskTooltip}
                  onfocus={(event) => showTaskTooltip(task, event)}
                  onblur={hideTaskTooltip}
                  onclick={() => handleActiveTaskClick(task)}
                >
                  {#if task.status === "waiting_for_human"}
                    <CircleEllipsis size={22} strokeWidth={2.2} aria-hidden="true" />
                  {:else if task.kind === "crawler"}
                    <Landmark size={22} strokeWidth={2.2} aria-hidden="true" />
                  {:else if task.kind === "import"}
                    <ImportIcon size={22} strokeWidth={2.2} aria-hidden="true" />
                  {:else if task.kind === "sync"}
                    <ArrowLeftRight size={22} strokeWidth={2.2} aria-hidden="true" />
                  {:else}
                    <CloudDownload size={22} strokeWidth={2.2} aria-hidden="true" />
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
      {#if automation.active}
        <div class="sync-hero-actions">
          <button class="button danger hero-action" type="button" onclick={() => void stopAllTasks()}>
            {$t.automation.stopAll}
          </button>
        </div>
      {/if}
    </section>

    <section class="card workflow-card" aria-label={$t.automation.taskQueue}>
      {#each taskStages as stage, stageIndex}
        <section class="stage-section">
          <div class="stage-head">
            <div class="stage-head-content">
              <span class:muted={!stageRunnableTasks(stage.tasks).length} class="stage-number" aria-hidden="true">{stageIndex + 1}</span>
              <span class="stage-copy">
                <span class="stage-title-row">
                  <h2 id={`${stage.id}-stage-title`}>{stage.title}</h2>
                  {#if stage.id !== "collect" && stage.tasks.some((task) => task.status === "locked")}
                    <span class="chip bad">{$t.common.importLocked}</span>
                  {/if}
                </span>
              </span>
              <div class="stage-head-actions">
                <button
                  class="button primary stage-sync-action"
                  type="button"
                  disabled={!stageRunnableTasks(stage.tasks).length}
                  onclick={() => openSyncSheet(stage.tasks)}
                >
                  {$t.automation.syncAll}
                </button>
                <button
                  class="stage-toggle-action"
                  type="button"
                  aria-label={stageOpen[stage.id] ? $t.automation.collapseStage(stage.title) : $t.automation.expandStage(stage.title)}
                  aria-expanded={stageOpen[stage.id]}
                  aria-controls={`${stage.id}-stage-body`}
                  onclick={() => toggleStage(stage.id)}
                >
                  <span class="stage-caret" aria-hidden="true"></span>
                </button>
              </div>
            </div>
          </div>

          {#if stageOpen[stage.id]}
          <div class="stage-body" id={`${stage.id}-stage-body`} transition:disclosureSlide>
            <div class="table-reveal">
              <div class="table-wrap">
              <table class="table automation-table">
          <colgroup>
            <col style="width: 32%" />
            <col style="width: 14%" />
            <col style="width: 22%" />
            <col style="width: 12%" />
            <col style="width: 20%" />
          </colgroup>
          <thead>
            <tr>
              <th>{$t.automation.task}</th>
              <th>{$t.automation.credentialStatus}</th>
              <th>{$t.automation.latestTime($systemTimezone)}</th>
              <th>{$t.automation.status}</th>
              <th class="right">{$t.automation.controls}</th>
            </tr>
          </thead>
          <tbody>
            {#each (stage.id === "collect" && !showAllCollectTasks ? stage.tasks.slice(0, 5) : stage.tasks) as task (task.id)}
              <tr class="task-row" class:task-active={task.isActive} class:task-attention={statusClass(task.status) === "bad" || task.status === "waiting_for_human"} id={`${task.id}-task-row`}>
                <td>
                  <div class="task-name">
                    <strong>{taskLabel(task, $t)}</strong>
                  </div>
                </td>
                <td>
                  <span class={`credential-state ${taskCredentialsReady(task) ? "good" : "bad"}`}>
                    {taskCredentialsReady(task) ? $t.common.ready : $t.common.missing}
                  </span>
                </td>
                <td class="mono latest-time">{latestTaskTime(task)}</td>
                <td>
                  {#if task.isActive}
                  <div class="progress-cell">
                    <div class="progress-bar" aria-hidden="true">
                      <span style={`width: ${task.progressPercent ?? 0}%`}></span>
                    </div>
                    <span class="mono">{progressLabel(task, $t)}</span>
                  </div>
                  {:else}
                  <span class={`chip ${statusClass(task.status)}`} title={importLockTitle(task, $t)}>
                    {$t.automation.statusLabels[task.status]}
                  </span>
                  {/if}
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
                    <button
                      class="button secondary task-control"
                      class:active-log={expandedLogTaskId === task.id}
                      type="button"
                      aria-expanded={expandedLogTaskId === task.id}
                      aria-controls={`${task.id}-inline-log`}
                      onclick={() => (expandedLogTaskId = expandedLogTaskId === task.id ? null : task.id)}
                    >
                      {$t.automation.logs}
                    </button>
                  </div>
                </td>
              </tr>
              {#if expandedLogTaskId === task.id}
                <tr class="inline-task-log" class:jump-highlight={jumpHighlightTaskId === task.id} id={`${task.id}-inline-log`}>
                  <td colspan="5">
                    <div class="inline-log-panel" tabindex="-1" transition:disclosureSlide>
                      <div class="inline-log-head">
                        <strong>{$t.automation.inlineLogTitle(taskLabel(task, $t))}</strong>
                        <span class={`chip ${statusClass(task.status)}`}>{progressLabel(task, $t)}</span>
                      </div>
                      <p class="mono inline-log-path">{task.logPath ?? $t.automation.noLogFile}</p>
                      <pre class="log-output">{task.errorMessage ?? (task.logTail || $t.automation.noLogs)}</pre>
                    </div>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
              </table>
              </div>
            </div>
            {#if stage.id === "collect" && stage.tasks.length > 5}
              <button class="show-all-tasks" type="button" onclick={(event) => void toggleCollectTasks(event)}>
                {showAllCollectTasks ? $t.automation.collapseTasks : $t.automation.showAllTasks(stage.tasks.length)}
              </button>
            {/if}
          </div>
          {/if}
        </section>
      {/each}
    </section>

    {#if actionError}<p class="viewer-error">{actionError}</p>{/if}
  </div>
</DashboardShell>

{#if hoveredTask}
  <div
    id="active-task-tooltip"
    class="active-task-tooltip"
    role="tooltip"
    style={`left: ${taskTooltipPosition.left}px; top: ${taskTooltipPosition.top}px;`}
  >
    <strong>{taskLabel(hoveredTask, $t)}</strong>
    <span>{taskStageTitle(hoveredTask, $t)} · {$t.automation.statusLabels[hoveredTask.status]}</span>
    <span>{latestTaskTime(hoveredTask)}</span>
  </div>
{/if}

{#if syncOpen}
  <aside class="sync-sheet" aria-labelledby="sync-title">
      <div class="modal-head sync-sheet-head">
        <div>
          <h2 id="sync-title">{$t.automation.syncDialogTitle}</h2>
          <p>{$t.automation.syncDialogDescription(syncTasks.length)}</p>
        </div>
        <button class="button sync-sheet-close" type="button" onclick={() => (syncOpen = false)}>{$t.common.close}</button>
      </div>
      <div class="sync-modal-body">
        <div class="sync-readiness">
          <strong>{$t.automation.credentialsReady(credentialReadyCount, syncTasks.length)}</strong>
        </div>
        <ul class="sync-task-list">
          {#each syncTasks as task}
            <li>
              <span>{taskLabel(task, $t)}</span>
              <code>{task.script}</code>
            </li>
          {/each}
        </ul>
      </div>
      <div class="sync-modal-actions">
        <button class="button" type="button" onclick={() => (syncOpen = false)}>{$t.common.cancel}</button>
        <button class="button primary" type="button" onclick={() => void runParallelTasks()}>{$t.automation.startSync}</button>
      </div>
  </aside>
{/if}

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
              <th>{$t.automation.historyStartedTime($systemTimezone)}</th>
              <th>{$t.automation.historyFinishedTime($systemTimezone)}</th>
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
  :global(html) {
    overflow-y: scroll;
    scrollbar-gutter: stable;
  }

  .automation-content {
    display: grid;
    gap: 22px;
    transition: margin-right 0.2s ease;
  }

  .automation-content.sync-sheet-open {
    margin-right: 455px;
  }

  :global(.topbar-title) {
    display: none;
  }

  :global(.topbar-actions) {
    grid-column: 3;
  }

  .topbar-action {
    width: auto;
    min-width: 112px;
    border-color: var(--border);
    background: var(--surface);
  }

  .sync-hero {
    min-height: 116px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 28px;
    padding: 24px 30px;
    border-radius: 8px;
  }

  .sync-hero.active {
    min-height: 132px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    border-color: color-mix(in oklch, var(--accent) 28%, var(--border));
    background: color-mix(in oklch, var(--accent-soft) 24%, var(--surface));
  }

  .sync-hero-copy {
    min-width: 0;
    display: grid;
    gap: 6px;
  }

  .sync-hero h2 {
    margin: 0;
    font-size: clamp(25px, 2vw, 31px);
    line-height: 1.25;
    letter-spacing: -0.035em;
  }

  .running-kicker {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--accent);
    font-size: 14px;
    font-weight: 780;
  }

  .active-task-filter {
    width: fit-content;
    max-width: min(100%, 540px);
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    box-shadow: 0 1px 3px rgb(30 48 66 / 0.06);
    overflow: hidden;
  }

  .active-task-jump-list {
    display: flex;
    flex-wrap: nowrap;
    gap: 6px;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    scroll-behavior: smooth;
    scroll-snap-type: x proximity;
    scrollbar-width: none;
  }

  .active-task-jump-list::-webkit-scrollbar {
    display: none;
  }

  .active-task-jump {
    flex: 0 0 46px;
    width: 46px;
    height: 46px;
    display: inline-grid;
    place-items: center;
    padding: 0;
    border: 1px solid color-mix(in oklch, var(--accent) 34%, var(--border));
    border-radius: 50%;
    background: color-mix(in oklch, var(--accent-soft) 74%, var(--surface));
    color: var(--accent);
    cursor: pointer;
    scroll-snap-align: start;
    transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
  }

  .active-task-tooltip {
    position: fixed;
    z-index: 40;
    width: max-content;
    max-width: 280px;
    display: grid;
    gap: 3px;
    padding: 10px 12px;
    border: 1px solid color-mix(in oklch, var(--border) 72%, transparent);
    border-radius: var(--radius);
    background: var(--fg);
    color: var(--surface);
    box-shadow: 0 14px 32px rgb(15 23 42 / 0.18);
    pointer-events: none;
    transform: translateX(-50%);
  }

  .active-task-tooltip strong {
    font-size: 13px;
  }

  .active-task-tooltip span {
    color: color-mix(in oklch, var(--surface) 74%, transparent);
    font-size: 11px;
  }

  .active-task-jump:hover {
    transform: translateY(-2px);
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .active-task-jump:focus-visible {
    outline: 3px solid color-mix(in oklch, var(--accent) 24%, transparent);
    outline-offset: 2px;
  }

  .active-task-jump.waiting {
    border-color: color-mix(in oklch, var(--warn) 34%, var(--border));
    background: color-mix(in oklch, var(--warn) 8%, var(--surface));
    color: var(--warn);
  }

  .active-task-jump.import-task {
    border-color: color-mix(in oklch, #7367c8 34%, var(--border));
    background: color-mix(in oklch, #7367c8 8%, var(--surface));
    color: #6559b5;
  }

  .active-task-jump.sync-task {
    border-color: color-mix(in oklch, #158276 34%, var(--border));
    background: color-mix(in oklch, #158276 8%, var(--surface));
    color: #11756a;
  }

  .active-task-jump.failed {
    border-color: color-mix(in oklch, var(--danger) 34%, var(--border));
    background: color-mix(in oklch, var(--danger) 8%, var(--surface));
    color: var(--danger);
  }

  .sync-hero-actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .stage-sync-action,
  .sync-modal-actions .button.primary {
    border-color: var(--accent);
    background: var(--accent);
    color: white;
  }

  .hero-action {
    min-width: 132px;
    min-height: 48px;
    font-size: 15px;
  }

  .workflow-card {
    overflow: hidden;
    border-radius: 8px;
  }

  .stage-section {
    border-bottom: 1px solid var(--border);
  }

  .stage-section:last-child {
    border-bottom: 0;
  }

  .stage-head {
    min-height: 82px;
    padding: 10px 20px;
  }

  .stage-head:hover {
    background: var(--surface-soft);
  }

  .stage-head-content {
    min-height: 62px;
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
  }

  .stage-head-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .stage-sync-action {
    min-width: 112px;
    min-height: 42px;
  }

  .stage-toggle-action {
    width: 48px;
    height: 48px;
    display: inline-grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: var(--radius);
    background: transparent;
    color: var(--fg);
  }

  .stage-toggle-action:hover,
  .stage-toggle-action:focus-visible {
    background: var(--surface-soft);
  }

  .stage-caret {
    width: 10px;
    height: 10px;
    border-right: 2px solid currentColor;
    border-bottom: 2px solid currentColor;
    transform: rotate(45deg) translate(-1px, -1px);
    transition: transform 180ms ease;
  }

  .stage-toggle-action[aria-expanded="true"] .stage-caret {
    transform: rotate(225deg) translate(-1px, -1px);
  }

  .stage-number {
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: var(--accent);
    color: white;
    font-family: var(--font-mono);
    font-weight: 760;
    box-shadow: 0 2px 5px color-mix(in oklch, var(--accent) 16%, transparent);
  }

  .stage-number.muted {
    background: var(--muted);
    box-shadow: none;
  }

  .stage-copy {
    min-width: 0;
    display: grid;
    gap: 5px;
  }

  .stage-title-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .stage-title-row h2 {
    margin: 0;
  }

  .stage-title-row h2 {
    font-size: 20px;
  }

  .stage-body {
    padding: 0 20px 18px 74px;
  }

  .table-reveal {
    overflow: clip;
  }

  .show-all-tasks {
    width: 100%;
    min-height: 44px;
    border: 0;
    background: var(--surface);
    color: var(--accent);
    font-size: 13px;
    font-weight: 760;
  }

  .show-all-tasks:hover {
    background: var(--surface-soft);
  }

  .modal-head p {
    margin: var(--space-1) 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .automation-table td {
    vertical-align: middle;
  }

  .automation-table {
    table-layout: fixed;
    min-width: 760px;
  }

  .automation-table th,
  .automation-table td {
    padding-inline: 8px;
  }

  .automation-table th {
    font-size: 11px;
  }

  .automation-table tr.task-active td {
    background: color-mix(in oklch, var(--warn) 2%, white);
  }

  .task-row {
    scroll-margin-top: 88px;
  }

  .automation-table tr.task-attention td {
    background: color-mix(in oklch, var(--danger) 2%, white);
  }

  .task-name {
    min-width: 150px;
  }

  .task-name strong {
    font-weight: 720;
  }

  .mono {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .latest-time {
    white-space: nowrap;
  }

  .credential-state {
    font-size: 12px;
    font-weight: 760;
  }

  .credential-state.good {
    color: var(--success);
  }

  .credential-state.bad {
    color: var(--danger);
  }

  .progress-cell {
    min-width: 96px;
    display: flex;
    align-items: center;
    gap: 8px;
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
    gap: 10px;
    flex-wrap: wrap;
  }

  .fixed-action {
    width: 112px;
    min-width: 112px;
  }

  .task-control {
    width: auto;
    min-width: 0;
    min-height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 8px;
    border: 0;
    background: transparent;
    color: var(--accent);
    font-size: 12px;
  }

  .task-control.active-log {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-soft);
  }

  .task-control.primary,
  .task-control.danger {
    border: 0;
    background: transparent;
    box-shadow: none;
  }

  .task-control.primary {
    color: var(--accent);
  }

  .task-control.danger {
    color: var(--danger);
  }

  .inline-task-log td {
    padding: 0;
    background: color-mix(in oklch, var(--accent-soft) 38%, var(--surface));
    scroll-margin-top: 88px;
  }

  .inline-log-panel {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-5);
    border-top: 1px solid color-mix(in oklch, var(--accent) 24%, var(--border));
    border-bottom: 1px solid color-mix(in oklch, var(--accent) 24%, var(--border));
    outline: none;
    transition: background 240ms ease, box-shadow 240ms ease;
  }

  .inline-task-log.jump-highlight .inline-log-panel {
    background: color-mix(in oklch, var(--accent-soft) 76%, var(--surface));
    box-shadow: inset 4px 0 0 var(--accent);
  }

  .inline-log-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .inline-log-path {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .inline-log-panel .log-output {
    min-height: 120px;
    max-height: 280px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .sync-sheet {
    position: fixed;
    z-index: 25;
    inset: var(--topbar-height, 60px) 0 0 auto;
    width: 455px;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    border-left: 1px solid var(--border);
    background: var(--surface);
    box-shadow: -7px 0 22px rgb(30 48 66 / 0.05);
  }

  .sync-sheet-head {
    align-items: flex-start;
    padding: 28px 28px 18px;
    border-bottom: 0;
  }

  .sync-sheet-head h2 {
    font-size: 24px;
  }

  .sync-sheet-close {
    width: auto;
    min-height: 34px;
    padding-inline: 12px;
  }

  .sync-modal-body {
    display: grid;
    gap: 12px;
    padding: 0 28px 18px;
  }

  .sync-readiness {
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-soft);
    color: var(--success);
    font-size: 13px;
  }

  .sync-task-list {
    max-height: 360px;
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .sync-task-list li {
    display: grid;
    gap: 2px;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .sync-task-list li:last-child {
    border-bottom: 0;
  }

  .sync-task-list code {
    color: var(--muted);
    font-size: 12px;
  }

  .sync-modal-actions {
    position: sticky;
    bottom: 0;
    margin-top: auto;
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding: 18px 28px 28px;
    border-top: 1px solid var(--border);
    background: var(--surface);
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

  @media (max-width: 1100px) {
    .automation-content.sync-sheet-open {
      margin-right: 0;
    }

    .sync-sheet {
      box-shadow: -18px 0 46px rgb(30 48 66 / 0.14);
    }

  }

  @media (max-width: 820px) {
    .sync-hero {
      align-items: stretch;
      flex-direction: column;
    }

    .sync-hero.active {
      display: flex;
    }

    .sync-hero-actions,
    .sync-hero-actions .button {
      width: 100%;
    }

    .active-task-jump-list {
      max-width: 100%;
    }

    .stage-head {
      padding: var(--space-4);
    }

    .stage-head-content {
      grid-template-columns: 42px minmax(0, 1fr);
    }

    .stage-head-actions {
      grid-column: 1 / -1;
      justify-content: flex-end;
    }

    .stage-body {
      padding: 0 var(--space-4) var(--space-4);
    }

    .stage-number {
      width: 36px;
      height: 36px;
      flex-basis: 36px;
    }

    .inline-log-head {
      align-items: flex-start;
      flex-direction: column;
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

    .sync-sheet {
      width: min(455px, 100vw);
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
