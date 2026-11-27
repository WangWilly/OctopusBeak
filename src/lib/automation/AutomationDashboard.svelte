<script lang="ts">
  import InstitutionLogo from "$lib/institutions/InstitutionLogo.svelte";
  import RunHistoryDialog from "$lib/automation/RunHistoryDialog.svelte";
  import ErrorReportDialog from "$lib/automation/ErrorReportDialog.svelte";
  import StructureReportDialog from "$lib/automation/StructureReportDialog.svelte";
  import CredentialsUnreadableNotice from "$lib/automation/CredentialsUnreadableNotice.svelte";
  import SignInDetailsSheet from "$lib/automation/SignInDetailsSheet.svelte";
  import { credentialsUnreadable } from "$lib/automation/credentials-unreadable.ts";
  import { onDestroy, onMount, tick } from "svelte";
  import { slide } from "svelte/transition";
  import {
    ArrowLeftRight,
    Check,
    ChevronRight,
    ChevronUp,
    CircleAlert,
    CircleEllipsis,
    CloudDownload,
    Landmark,
    Minus,
    X,
  } from "@lucide/svelte";
  import type { CredentialGroupDto } from "$lib/desktop/api.ts";
  import type { AutomationCredentialStatus } from "$lib/desktop/api.ts";
  import { errorReportTarget, type ErrorReportTarget } from "$lib/automation/error-report-form.ts";
  import {
    NO_STRUCTURE_REPORT,
    closeStructureReport,
    openStructureReport,
    selectStructureReportRun,
    structureReportKey,
    structureReportLoaded,
  } from "$lib/automation/structure-report-state.ts";
  import type { AutomationPageState } from "$lib/automation/automation-page-state.ts";
  import { createRunActions } from "$lib/automation/run-actions.ts";
  import {
    deviceRegistrationSource,
    type DeviceRegistrationSource,
  } from "$lib/automation/types.ts";
  import { locale, t, type Translation } from "$lib/i18n/i18n.ts";
import { onboardingTaskDisclosure } from "$lib/onboarding/state.ts";
  import {
    credentialSheetView,
    type CredentialSheetAction,
    type CredentialSheetContext,
  } from "$lib/automation/credential-sheet.ts";
  import { createCredentialEditor } from "$lib/automation/credential-editor.ts";
  import {
    countsOutsideTdccExclusions,
    presentTaskRow,
    tdccExclusionLines,
    workflowEventFailureLabel,
    type TaskRowViewContext,
  } from "$lib/automation/task-row-view.ts";
import type { OnboardingWorkflowToken } from "$lib/onboarding/controller.ts";
import type {
  OnboardingNodeId,
  OnboardingPresentation,
  OnboardingStoryEvent,
} from "$lib/onboarding/story.ts";
  import {
    createOnboardingTargetRegistry,
    registerOnboardingTarget,
    type OnboardingTargetRegistry,
  } from "$lib/onboarding/target-observer.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import ProgressiveBlock from "$lib/shared-shell/components/ProgressiveBlock.svelte";
  import type { BlockState } from "$lib/shared-shell/block-load-state.ts";
  import type {
    DashboardBlockPayload,
    DashboardBlockValueMap,
  } from "$lib/shared-shell/dashboard-blocks.ts";
  import { formatRunTime, statusClass, taskLabel, taskLabelParts, taskLogo } from "./task-display.ts";
  import { lastSyncSummary } from "./sync-summary.ts";
  import type {
    AutomationPageModel,
    AutomationTaskPrerequisiteNotice,
    AutomationTaskRow,
  } from "./types.ts";
  import { selectAutomationBlockModel } from "./runtime-sync.ts";
  import { workflowFailureExplanation, workflowFailureShortExplanation } from "./workflow-failures.ts";
  import { unvaluedAccountLabels } from "./unvalued-accounts.ts";
  import { productFailures, runStageTrack } from "./run-stage-track.ts";
  import type { Readable } from "svelte/store";
  import type { ViewState } from "$lib/data-views/client/view-stores.ts";
  import type { OverviewPageDto } from "$lib/overview/types.ts";

  export let state: AutomationPageState;
  export let credentialGroups: CredentialGroupDto[];
  export let blocks: Readonly<Record<string, BlockState<DashboardBlockPayload>>> = {};
  export let retryBlock: (key: string) => void = () => {};
  /** The current overview, read only while run details are open to list accounts without a current value. */
  export let overviewLive: Readable<ViewState<OverviewPageDto>> | null = null;
  export let onboardingSourceSelection = false;
  export let onboardingSingleSource = false;
  export let onboardingNodeId: OnboardingNodeId | null = null;
  export let onboardingSelectedCredentialGroupId: string | null = null;
  export let onboardingTrackedTaskId: string | null = null;
  export let onboardingTargets: OnboardingTargetRegistry = createOnboardingTargetRegistry();
  export let onOnboardingStoryEvent: (event: OnboardingStoryEvent) => void = () => {};
  export let signInSettingsGroupId: string | null = null;
  export let onSignInSettingsOpened: () => void = () => {};
  export let onOpenFinancialDataSettings: () => void = () => {};
  export let onOpenSignInDataSettings: () => void = () => {};
  export let onOnboardingWorkflowStarting: (
    taskId: string,
    credentialGroupId: string | null,
  ) => OnboardingWorkflowToken | null = () => null;
  export let onOnboardingWorkflowStarted: (
    token: OnboardingWorkflowToken | null,
    run: { taskId: string; runId: string | null },
  ) => void = () => {};
  export let onOnboardingWorkflowStartFailed: (
    token: OnboardingWorkflowToken | null,
    message: string,
  ) => void = () => {};

  function loaded(model: AutomationPageModel | null): AutomationPageModel {
    if (!model) throw new Error("The Automation page renders only after its model loads.");
    return model;
  }

  $: pageModel = loaded($state.model);
  $: live = loaded($state.live);

  function blockState(
    source: Readonly<Record<string, BlockState<DashboardBlockPayload>>>,
    key: string,
  ): BlockState<DashboardBlockPayload> {
    return source[key] ?? { status: "loading" };
  }

  function automationBlockData<Key extends "summary" | "list" | "details">(
    key: Key,
    payload: DashboardBlockPayload | undefined,
  ): DashboardBlockValueMap["automation"][Key] | undefined {
    return payload?.route === "automation" && payload.block === key
      ? payload.data as DashboardBlockValueMap["automation"][Key]
      : undefined;
  }

  const runActions = createRunActions<AutomationTaskRow>({
    state,
    onboarding: {
      starting: (taskId, credentialGroupId) => onOnboardingWorkflowStarting(taskId, credentialGroupId),
      started: (token, run) => onOnboardingWorkflowStarted(token, run),
      startFailed: (token, message) => onOnboardingWorkflowStartFailed(token, message),
    },
    registering: (task) => registrationBlocksRun(task),
    messages: {
      registrationBlocksSync: () => $t.automation.deviceRegistrationBlocksSync,
      taskLabel: (task) => taskLabel(task, $locale),
    },
  });
  const actionError = runActions.actionError;

  const credentialEditor = createCredentialEditor({
    bridge: () => window.octopusBeak.automation,
    page: { reload: () => state.reload(), tasks: () => live.tasks },
    onboarding: { story: (event) => onOnboardingStoryEvent(event) },
    runTask: (task) => runTask(task),
    now: () => new Date().toISOString(),
  });
  const credentialEditorState = credentialEditor.state;
  $: sheet = $credentialEditorState;
  let credentialForm: HTMLFormElement;
  let syncOpen = false;
  let syncTasks: AutomationTaskRow[] = [];
  let expandedRunDetailsTaskId: string | null = null;
  let copiedErrorTaskId: string | null = null;
  let copiedErrorTimer: ReturnType<typeof setTimeout> | undefined;
  let runDetailsOverview: OverviewPageDto | null = null;
  let watchedOverview: Readable<ViewState<OverviewPageDto>> | null = null;
  let stopRunDetailsOverview: (() => void) | null = null;
  $: watchRunDetailsOverview(expandedRunDetailsTaskId === null ? null : overviewLive);
  let structureReport = NO_STRUCTURE_REPORT;
  $: expandedFailedTask = live.tasks.find((task) => task.id === expandedRunDetailsTaskId && task.status === "failed") ?? null;
  $: void loadStructureReport(expandedFailedTask);

  async function loadStructureReport(task: AutomationTaskRow | null) {
    const key = structureReportKey(task);
    const selected = selectStructureReportRun(structureReport, key);
    if (selected === structureReport) return;
    structureReport = selected;
    if (!task || !key) return;
    const text = await window.octopusBeak.automation.previewStructureReport(task.id).catch(() => null);
    structureReport = structureReportLoaded(structureReport, key, text ? { taskId: task.id, text } : null);
  }
  // ADR 0081: an Error report the person sends by hand. Hidden in builds without a receiver.
  let errorReportsAvailable = false;
  let errorReport: ErrorReportTarget | null = null;
  onMount(() => {
    void window.octopusBeak.errorReports?.available()
      .then((available) => (errorReportsAvailable = available))
      .catch(() => (errorReportsAvailable = false));
  });
  onDestroy(() => stopRunDetailsOverview?.());
  onDestroy(() => clearTimeout(copiedErrorTimer));

  function watchRunDetailsOverview(store: Readable<ViewState<OverviewPageDto>> | null) {
    if (store === watchedOverview) return;
    stopRunDetailsOverview?.();
    stopRunDetailsOverview = null;
    watchedOverview = store;
    runDetailsOverview = null;
    if (store) stopRunDetailsOverview = store.subscribe((state) => {
      if (state.status === "ready") runDetailsOverview = state.data;
    });
  }
  let jumpHighlightTaskId: string | null = null;
  let jumpHighlightTimer: ReturnType<typeof setTimeout> | null = null;
  let historyOpen = false;
  let hoveredTask: AutomationTaskRow | null = null;
  let taskTooltipPosition = { left: 0, top: 0 };
  let deviceRegistering: Record<DeviceRegistrationSource, boolean> = { tdcc: false, cathay: false };
  let stageOpen: Record<string, boolean> = { sync: true };

  $: sideValue = live.active
    ? $t.common.runningCount(live.activeTaskCount)
    : $t.common.ready;
  $: sideSub = $t.common.businessDay(live.businessDate);
  $: parallelTaskIds = new Set(live.parallelRunnableTaskIds);
  $: activeTasks = live.tasks.filter((task) => task.isActive);
  $: iconTasks = live.tasks.filter((task) =>
    task.isActive
    || task.status === "failed"
  );
  $: credentialReadyCount = syncTasks.filter((task) =>
    task.credentialKeys.every((key) => live.credentials[key]),
  ).length;
  $: prerequisiteNoticeGroups = prerequisiteNoticeGroupsFor(live);
  $: collectionGroupIds = new Set(
    live.tasks
      .filter((task) => task.credentialGroupId)
      .map((task) => task.credentialGroupId as string),
  );
  $: onboardingDisclosure = onboardingTaskDisclosure(
    onboardingNodeId ?? "source-entry",
    onboardingSelectedCredentialGroupId,
    live.tasks,
  );
  $: revealOnboardingTask(onboardingDisclosure);
  $: sheetContext = {
    dictionary: $t,
    locale: $locale,
    credentialGroups,
    collectionGroupIds,
    onboardingSourceSelection,
    onboardingSingleSource,
    onboardingNodeId,
    onboardingSelectedCredentialGroupId,
    credentialState: (key: string) => credentialState(key, live),
  } satisfies CredentialSheetContext;
  $: sheetView = credentialSheetView(sheet, sheetContext);

  onDestroy(() => {
    if (jumpHighlightTimer) clearTimeout(jumpHighlightTimer);
  });

  function disclosureSlide(node: Element) {
    return slide(node, {
      duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220,
    });
  }

  function toggleStage(stageId: string) {
    stageOpen = { ...stageOpen, [stageId]: !stageOpen[stageId] };
  }

  function revealOnboardingTask(
    disclosure: ReturnType<typeof onboardingTaskDisclosure>,
  ) {
    if (!disclosure) return;
    if (!stageOpen[disclosure.stageId]) {
      stageOpen = { ...stageOpen, [disclosure.stageId]: true };
    }
  }

  function prerequisiteNoticeGroupsFor(sourceAutomation: AutomationPageModel) {
    return [...sourceAutomation.externalPrerequisiteNotices.reduce(
      (groups, notice) => {
        const notices = groups.get(notice.prerequisiteId) ?? [];
        notices.push(notice);
        groups.set(notice.prerequisiteId, notices);
        return groups;
      },
      new Map<string, AutomationTaskPrerequisiteNotice[]>(),
    )].map(([prerequisiteId, notices]) => ({
      prerequisiteId,
      prerequisite: notices[0].prerequisite,
      notices,
    }));
  }

  function stageRunnableTasks(tasks: AutomationTaskRow[], runnableTaskIds = parallelTaskIds) {
    return tasks.filter((task) => runnableTaskIds.has(task.id));
  }

  function openSyncSheet(tasks: AutomationTaskRow[], runnableTaskIds = parallelTaskIds) {
    syncTasks = stageRunnableTasks(tasks, runnableTaskIds);
    if (syncTasks.length) syncOpen = true;
  }

  function formatTime(value: string | null) {
    return formatRunTime(value, $systemTimezone, $locale);
  }

  function formatClock(value: string) {
    return new Intl.DateTimeFormat($locale, {
      timeZone: $systemTimezone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(new Date(value));
  }

  function runDurationSeconds(task: AutomationTaskRow) {
    if (!task.latestStartedAt || !task.latestFinishedAt) return null;
    const milliseconds = Date.parse(task.latestFinishedAt) - Date.parse(task.latestStartedAt);
    return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.round(milliseconds / 1000) : null;
  }

  async function copyErrorCode(taskId: string, code: string) {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }
    copiedErrorTaskId = taskId;
    clearTimeout(copiedErrorTimer);
    copiedErrorTimer = setTimeout(() => (copiedErrorTaskId = null), 2000);
  }

  function latestTaskTime(task: AutomationTaskRow) {
    return formatTime(task.latestFinishedAt ?? task.latestStartedAt);
  }

  function taskCredentialsReady(task: AutomationTaskRow, sourceAutomation = live) {
    return task.status !== "needs_setup" && task.credentialKeys.every((key) =>
      (sourceAutomation.credentialStates?.[key] ?? (sourceAutomation.credentials[key] ? "ready" : "missing")) === "ready",
    );
  }

  function credentialState(key: string, sourceAutomation = live): AutomationCredentialStatus {
    return sourceAutomation.credentialStates?.[key]
      ?? (sourceAutomation.credentials[key] ? "ready" : "missing");
  }

  function allCredentialsLoading(task: AutomationTaskRow, sourceAutomation = live) {
    const states = task.credentialKeys.map((key) => credentialState(key, sourceAutomation));
    return states.length > 0 && states.every((state) => state === "loading");
  }

  function anyCredentialReadFailed(task: AutomationTaskRow, sourceAutomation = live) {
    return task.credentialKeys.some((key) => credentialState(key, sourceAutomation) === "read_failed");
  }

  function dispatchSheet(action: CredentialSheetAction) {
    credentialEditor.dispatch(action, sheetContext);
  }

  function openCredentials() {
    dispatchSheet({ type: "open" });
  }

  function openCredentialsFromStoryEntry() {
    credentialEditor.openFromStoryEntry(sheetContext);
  }

  export async function openCredentialsForOnboarding() {
    if (!sheet.open) openCredentials();
    await tick();
  }

  export async function applyOnboardingCredentialPresentation(
    presentation: OnboardingPresentation,
    credentialGroupId: string | null,
  ) {
    if (presentation === "none") return;
    if (presentation === "close-credentials") {
      dispatchSheet({ type: "close" });
      await tick();
      return;
    }
    dispatchSheet({
      type: "present-onboarding",
      presentation: presentation === "show-picker" ? "picker" : "details",
      groupId: credentialGroupId,
    });
    await tick();
  }

  export async function retryOnboardingWorkflow() {
    const task = live.tasks.find(
      (candidate) => candidate.credentialGroupId === onboardingSelectedCredentialGroupId,
    );
    if (task) await runTask(task);
  }

  type CredentialDestination = "source" | "statements" | "device";

  async function showCredentialSource(groupId: string | null, destination: CredentialDestination) {
    dispatchSheet({ type: "show-source", groupId });
    const { generation, selectedGroupId } = credentialEditor.sheet();
    await tick();
    if (!sheet.open || sheet.generation !== generation || sheet.selectedGroupId !== selectedGroupId) return;
    const target = credentialForm?.querySelector<HTMLElement>(`[data-credential-focus="${destination}"]`)
      ?? credentialForm?.querySelector<HTMLElement>('[data-credential-focus="source"]');
    target?.focus();
  }

  async function openRequestedSignInSettings(groupId: string) {
    // Let a just-completed save finish rendering its close before opening another source.
    await tick();
    if (signInSettingsGroupId !== groupId || credentialEditor.sheet().saving) return;
    onSignInSettingsOpened();
    await showCredentialSource(groupId, "source");
  }

  $: if (signInSettingsGroupId && !sheet.saving && credentialGroups.some((group) => group.id === signInSettingsGroupId)) {
    void openRequestedSignInSettings(signInSettingsGroupId);
  }

  function registrationBlocksRun(task: Pick<AutomationTaskRow, "credentialGroupId">) {
    const source = deviceRegistrationSource(task.credentialGroupId);
    return source !== null && deviceRegistering[source];
  }

  async function openDeviceRegistration(groupId: string | null | undefined) {
    const source = deviceRegistrationSource(groupId);
    if (!source) return;
    await showCredentialSource(source, "device");
  }

  function closeCredentials() {
    if (onboardingSourceSelection) return;
    if (sheetView.dirty && !confirm($t.automation.discardCredentialChanges)) return;
    dispatchSheet({ type: "close" });
  }

  function closeCredentialsOnEscape(event: KeyboardEvent) {
    if (!sheet.open || event.key !== "Escape") return;
    if (sheet.changes.editor) {
      event.preventDefault();
      dispatchSheet({ type: "editor-cancel" });
      return;
    }
    if (onboardingSourceSelection) return;
    event.preventDefault();
    closeCredentials();
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    if (syncOpen && !sheet.open) {
      event.preventDefault();
      syncOpen = false;
      return;
    }
    closeCredentialsOnEscape(event);
  }

  async function runTask(task: AutomationTaskRow) {
    await runActions.runTask(task);
  }

  async function openExternalPrerequisite(prerequisiteId: string) {
    try {
      runActions.setError("");
      await window.octopusBeak.automation.openExternalPrerequisite(prerequisiteId);
    } catch (error) {
      runActions.setError(error instanceof Error ? error.message : String(error));
    }
  }

  async function runParallelTasks() {
    const tasks = syncTasks;
    if (!tasks.length) return;
    syncOpen = false;
    await runActions.runAll(tasks);
  }

  async function stopAllTasks() {
    if (!activeTasks.length || !confirm($t.automation.confirmStopAll)) return;
    await runActions.stopAll(activeTasks);
  }

  async function forceTerminateTask(task: AutomationTaskRow) {
    if (!confirm($t.automation.confirmForceQuit)) return;
    await runActions.forceTerminate(task);
  }

  async function revealTaskDetails(task: AutomationTaskRow) {
    const stageId = "sync";
    stageOpen = { ...stageOpen, [stageId]: true };
    expandedRunDetailsTaskId = task.id;
    jumpHighlightTaskId = task.id;
    if (jumpHighlightTimer) clearTimeout(jumpHighlightTimer);

    await tick();
    const target = document.getElementById(`${task.id}-task-row`);
    const detailsRow = document.getElementById(`${task.id}-run-details`);
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    target?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    detailsRow?.querySelector<HTMLElement>(".inline-run-details")?.focus({ preventScroll: true });
    jumpHighlightTimer = setTimeout(() => {
      jumpHighlightTaskId = null;
      jumpHighlightTimer = null;
    }, 1_400);
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
    return dictionary.automation.syncStage;
  }

  /**
   * Cancel warns. A row blocked until the person acts (missing sign-in, or a
   * reset "Sync all" never runs) keeps the ink action; a routine run defers to "Sync all".
   */
  function taskControlTone(task: AutomationTaskRow) {
    if (task.primaryAction === "Cancel") return "danger";
    return task.primaryAction === "Configure" || task.primaryAction === "Delete financial data" ? "primary" : "default";
  }

  async function primaryTaskAction(task: AutomationTaskRow) {
    if (task.primaryAction === "Delete financial data") {
      onOpenFinancialDataSettings();
      return;
    }
    if (task.primaryAction === "Configure") {
      await showCredentialSource(task.credentialGroupId ?? null, "statements");
      return;
    }
    if (task.primaryAction !== "Cancel") {
      await runTask(task);
      return;
    }
    if (!confirm($t.automation.confirmCancel(taskLabel(task, $locale)))) return;
    await runActions.cancel(task);
  }

  async function saveCredentials(event: SubmitEvent) {
    event.preventDefault();
    const submission = credentialEditor.submit(sheetContext);
    if (submission.kind === "blocked") return;
    runActions.setError("");
    if (submission.kind === "focus-statement-selection") {
      await showCredentialSource(submission.groupId, "statements");
      return;
    }
    if ((await submission.settled) === "failed") {
      // Saving over details that cannot be read fails every time; say how to recover instead of "Try again".
      runActions.setError(credentialsUnreadable(live.credentialStates)
        ? $t.automation.credentialsUnreadableBody
        : $t.automation.saveCredentialsFailed);
    }
  }



  const ONBOARDING_PROGRESS_NODES: readonly string[] = [
    "collection-progress",
    "collection-failed",
    "workflow-review",
    "overview-preparing",
    "overview-preparation-failed",
  ];

  $: taskRowViewContext = {
    dictionary: $t,
    locale: $locale,
    timeZone: $systemTimezone,
    onboardingProgressTaskId: ONBOARDING_PROGRESS_NODES.includes(onboardingNodeId ?? "") ? onboardingTrackedTaskId : null,
    credentialState: (key: string) => credentialState(key, live),
  } satisfies TaskRowViewContext;
  $: present = (task: AutomationTaskRow) => presentTaskRow(task, taskRowViewContext);
</script>

<svelte:window onkeydowncapture={handleWindowKeydown} />

<DashboardShell
  active="automation"
  eyebrow={$t.automation.eyebrow}
  title={$t.automation.title}
  sideLabel={$t.automation.sideLabel}
  {sideValue}
  sideValueSensitive={false}
  {sideSub}
>
  <svelte:fragment slot="topbar-actions">
    <button
      class="button secondary topbar-action"
      type="button"
      use:registerOnboardingTarget={{
        registry: onboardingTargets,
        id: onboardingSourceSelection
        && onboardingNodeId === "source-entry"
        && !sheet.open
          ? "automation.credentials"
          : null,
      }}
      onclick={openCredentialsFromStoryEntry}
    >
      {$t.automation.credentials}
    </button>
    <button class="button secondary topbar-action" type="button" onclick={() => (historyOpen = true)}>
      {$t.automation.runHistory}
    </button>
  </svelte:fragment>

  <div class="content automation-content">
    <ProgressiveBlock label="summary" state={blockState(blocks, "summary")} retry={() => retryBlock("summary")} let:data>
    {@const summaryAutomation = selectAutomationBlockModel(pageModel, automationBlockData("summary", data)?.automation, $state.runtime, $state.pendingActions)}
    {@const lastSync = summaryAutomation.active ? null : lastSyncSummary(summaryAutomation.tasks)}
    <section class:active={summaryAutomation.active} class="card sync-hero" aria-label={$t.automation.commandCenter}>
      <div class="sync-hero-copy">
        {#if summaryAutomation.active}
          <span class="running-kicker"><CloudDownload size={16} strokeWidth={2.2} aria-hidden="true" />{$t.automation.syncInProgress}</span>
        {/if}
        <h2>
          {summaryAutomation.active
            ? $t.automation.runningTaskHeading(summaryAutomation.activeTaskCount)
            : !lastSync
              ? $t.automation.startSyncHeading
              : lastSync.completed > 0
                ? $t.automation.lastSyncHeading(lastSync.completed)
                : $t.automation.lastSyncNoneCompleted}
        </h2>
        {#if !summaryAutomation.active}
          <p class="sync-hero-meta" data-last-sync>
            {#if lastSync}
              {#if lastSync.unfinished > 0}<span class="unfinished">{$t.automation.lastSyncUnfinished(lastSync.unfinished)}</span><span aria-hidden="true">·</span>{/if}
              <span>{$t.automation.lastSyncAt(formatTime(lastSync.finishedAt))}</span>
            {:else}
              {$t.automation.startSyncHint($t.automation.syncAll)}
            {/if}
          </p>
        {/if}
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
                  class:sync-task={task.kind === "sync"}
                  type="button"
                  aria-label={`${$t.automation.runDetails} · ${taskLabel(task, $locale)}`}
                  aria-describedby={hoveredTask?.id === task.id ? "active-task-tooltip" : undefined}
                  title={taskLabel(task, $locale)}
                  onpointerenter={(event) => showTaskTooltip(task, event)}
                  onpointerleave={hideTaskTooltip}
                  onfocus={(event) => showTaskTooltip(task, event)}
                  onblur={hideTaskTooltip}
                  onclick={() => void revealTaskDetails(task)}
                >
                  {#if task.status === "waiting_for_human"}
                    <CircleEllipsis size={22} strokeWidth={2.2} aria-hidden="true" />
                  {:else if taskLogo(task)}
                    <InstitutionLogo institution={taskLogo(task)} size={22} />
                  {:else if task.kind === "crawler"}
                    <Landmark size={22} strokeWidth={2.2} aria-hidden="true" />
                  {:else}
                    <ArrowLeftRight size={22} strokeWidth={2.2} aria-hidden="true" />
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
      {#if live.active}
        <div class="sync-hero-actions">
          <button class="button danger hero-action" type="button" onclick={() => void stopAllTasks()}>
            {$t.automation.stopAll}
          </button>
        </div>
      {:else if summaryAutomation.tasks.some((task) => task.status === "completed")}
        <div class="sync-hero-actions">
          <a class="button secondary hero-action" href="#/overview">{$t.automation.viewOverview}</a>
        </div>
      {/if}
    </section>
    </ProgressiveBlock>

    <ProgressiveBlock label="details" state={blockState(blocks, "details")} showSpinner={false} retry={() => retryBlock("details")} let:data>
    {@const detailsAutomation = selectAutomationBlockModel(pageModel, automationBlockData("details", data)?.automation, $state.runtime, $state.pendingActions)}
    {@const detailsNoticeGroups = prerequisiteNoticeGroupsFor(detailsAutomation)}
    {#if detailsNoticeGroups.length}
      <section class="card prerequisite-notices" aria-labelledby="prerequisite-notices-title">
        <div class="prerequisite-notices-head">
          <div>
            <p class="section-eyebrow">{$t.automation.prerequisiteNoticesTitle}</p>
            <h2 id="prerequisite-notices-title">{$t.automation.prerequisiteNoticesTitle}</h2>
            <p>{$t.automation.prerequisiteNoticeDescription}</p>
          </div>
        </div>
        <div class="prerequisite-notice-list">
          {#each detailsNoticeGroups as group (group.prerequisiteId)}
            <article class="prerequisite-notice" role="alert">
              <div class="prerequisite-notice-copy">
                <span class="prerequisite-provider">{group.prerequisite.provider}</span>
                <h3>{group.prerequisite.component}</h3>
                <p>{group.prerequisite.instructions[$locale]}</p>
              </div>
              <div class="prerequisite-notice-actions">
                <button class="button secondary" type="button" onclick={() => void openExternalPrerequisite(group.prerequisiteId)}>
                  {$t.automation.prerequisiteDownload}
                </button>
              </div>
              <div class="prerequisite-affected-tasks">
                <strong>{$t.automation.prerequisiteAffectedTasks}</strong>
                {#each group.notices as notice (notice.noticeId)}
                  {@const task = detailsAutomation.tasks.find((candidate) => candidate.id === notice.taskId)}
                  <div class="prerequisite-task-row">
                    <span>{task ? taskLabel(task, $locale) : notice.taskId}</span>
                    {#if task}
                      <button class="button primary task-control" type="button" onclick={() => void runTask(task)}>
                        {$t.automation.prerequisiteRunAgain}
                      </button>
                    {/if}
                  </div>
                {/each}
              </div>
              <details class="prerequisite-technical-details">
                <summary>{$t.automation.prerequisiteTechnicalDetails}</summary>
                {#each group.notices as notice (notice.noticeId)}
                  <div class="prerequisite-technical-item">
                    <span class="mono">{notice.prerequisiteId} · {notice.latestTaskRunId}</span>
                    {#if notice.latestErrorMessage}<pre class="mono">{notice.latestErrorMessage}</pre>{/if}
                  </div>
                {/each}
              </details>
            </article>
          {/each}
        </div>
      </section>
    {/if}
    </ProgressiveBlock>

    <ProgressiveBlock label="list" state={blockState(blocks, "list")} showSpinner={false} retry={() => retryBlock("list")} let:data>
    {@const listAutomation = selectAutomationBlockModel(pageModel, automationBlockData("list", data)?.automation, $state.runtime, $state.pendingActions)}
    {@const listTaskStages = [{ id: "sync", title: $t.automation.syncStage, tasks: listAutomation.tasks }]}
    {@const listParallelTaskIds = new Set(listAutomation.parallelRunnableTaskIds)}
    {@const multiStage = listTaskStages.length > 1}
    {#if credentialsUnreadable(listAutomation.credentialStates)}
      <CredentialsUnreadableNotice onOpenSettings={onOpenSignInDataSettings} />
    {/if}
    <section class="card workflow-card" class:single-stage={!multiStage} aria-label={$t.automation.taskQueue}>
      {#each listTaskStages as stage, stageIndex}
        <section class="stage-section">
          <div class="stage-head">
            <div class="stage-head-content">
              {#if multiStage}
                <span class:muted={!stageRunnableTasks(stage.tasks, listParallelTaskIds).length} class="stage-number" aria-hidden="true">{stageIndex + 1}</span>
              {/if}
              <span class="stage-copy">
                <span class="stage-title-row">
                  <h2 id={`${stage.id}-stage-title`}>{stage.title}</h2>
                </span>
              </span>
              <div class="stage-head-actions">
                <button
                  class="button primary stage-sync-action"
                  type="button"
                  disabled={!stageRunnableTasks(stage.tasks, listParallelTaskIds).length}
                  onclick={() => openSyncSheet(listAutomation.tasks, listParallelTaskIds)}
                >
                  {$t.automation.syncAll}
                </button>
                {#if multiStage}
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
                {/if}
              </div>
            </div>
          </div>

          {#if !multiStage || stageOpen[stage.id]}
          <div class="stage-body" id={`${stage.id}-stage-body`} transition:disclosureSlide>
            <div class="table-reveal">
              <div class="table-wrap task-table-wrap">
              <table class="table automation-table">
          <colgroup>
            <col style="width: 22%" />
            <col style="width: 16%" />
            <col style="width: 17%" />
            <col style="width: 16%" />
            <col style="width: 29%" />
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
            {#each stage.tasks as task (task.id)}
              {@const label = taskLabelParts(taskLabel(task, $locale))}
              <tr class="task-row" class:task-active={task.isActive} class:task-attention={statusClass(task.status) === "bad"} id={`${task.id}-task-row`}>
                <td>
                  <div class="task-name">
                    <span class="task-logo">
                      {#if taskLogo(task)}
                        <InstitutionLogo institution={taskLogo(task)} />
                      {:else if task.kind === "crawler"}
                        <Landmark size={16} strokeWidth={2.2} aria-hidden="true" />
                      {:else}
                        <ArrowLeftRight size={16} strokeWidth={2.2} aria-hidden="true" />
                      {/if}
                    </span>
                    <span class="task-label">
                      <strong>{label.name}</strong>
                      {#if label.aside}<span class="task-aside">{label.aside}</span>{/if}
                    </span>
                  </div>
                </td>
                <td class="credential-state">
                  <span class="card-label">{$t.automation.credentialStatus}</span>
                  {#if allCredentialsLoading(task, listAutomation)}
                    <span class="spinner" aria-label={$t.common.loading}></span>
                  {:else if anyCredentialReadFailed(task, listAutomation)}
                    <span class="chip bad">{$t.automation.credentialReadFailed}</span>
                  {:else if taskCredentialsReady(task, listAutomation)}
                    <span class="chip good">{$t.common.ready}</span>
                  {:else}
                    <span class="chip warn">{$t.common.missing}</span>
                  {/if}
                </td>
                <td class="mono latest-time"><span class="card-label">{$t.automation.latestTime($systemTimezone)}</span>{latestTaskTime(task)}</td>
                <td>
                  {#if present(task).showProgress}
                  <div
                    class="progress-cell"
                    use:registerOnboardingTarget={{
                      registry: onboardingTargets,
                      id: present(task).isOnboardingProgress ? "automation.progress" : null,
                    }}
                  >
                    {#if present(task).showProgressBar}
                    <div
                      class="progress-bar"
                      class:working={present(task).progressWorking}
                      role="progressbar"
                      aria-valuemin="0"
                      aria-valuemax="100"
                      aria-valuenow={task.progressPercent ?? undefined}
                      aria-valuetext={present(task).progressLabel}
                      aria-label={taskLabel(task, $locale)}
                      aria-busy={present(task).progressWorking}
                    >
                      <span style={`width: ${task.progressPercent ?? 0}%`}></span>
                    </div>
                    <div class="progress-description">
                      <span class="progress-copy" data-status={task.status}>{present(task).progressLabel}</span>
                      {#if present(task).showProgressStatus}
                        <span class={`chip ${statusClass(task.status)}`}>{present(task).statusLabel}</span>
                      {/if}
                    </div>
                    {:else}
                    <span class={`chip outcome-chip ${statusClass(task.status)}`} data-status={task.status}>{present(task).statusLabel}</span>
                    {/if}
                    {#if ["failed", "cancelled"].includes(task.status) && present(task).failure}
                      {@const failure = present(task).failure!}
                      <div class="workflow-failure-summary" role="status">
                        <code>{failure.code}</code>
                        {#if failure.explanation}
                          <span>{failure.explanation}</span>
                        {/if}
                        {#if failure.userAction === "register-device" && deviceRegistrationSource(task.credentialGroupId)}
                          <button class="button secondary device-registration-action" type="button" onclick={() => void openDeviceRegistration(task.credentialGroupId)}>
                            {$t.automation.deviceRegistrationOpenSettings}
                          </button>
                        {/if}
                      </div>
                    {/if}
                  </div>
                  {:else}
                  <span class={`chip ${statusClass(task.status)}`}>
                    {present(task).statusLabel}
                  </span>
                  {/if}
                </td>
                <td class="right">
                  <div class="task-actions">
                    <button
                      class={`button task-control ${taskControlTone(task)}`}
                      type="button"
                      disabled={!task.canRun}
                      aria-busy={task.isActive}
                      use:registerOnboardingTarget={{
                        registry: onboardingTargets,
                        id: task.credentialGroupId === onboardingSelectedCredentialGroupId
                          && onboardingNodeId === "collection"
                          ? "automation.run"
                          : null,
                        action: "run-workflow",
                      }}
                      onclick={() => void primaryTaskAction(task)}
                    >
                      {#if task.isActive}<span class="spinner" aria-hidden="true"></span>{/if}
                      <span>{$t.automation.actionLabels[task.primaryAction]}</span>
                    </button>
                    {#if task.status === "cancelling" && task.forceTerminateAvailable}
                      <button
                        class="button danger task-control"
                        type="button"
                        onclick={() => void forceTerminateTask(task)}
                      >
                        {$t.automation.forceQuit}
                      </button>
                    {/if}
                    <button
                      class="button secondary task-control"
                      class:active-details={expandedRunDetailsTaskId === task.id}
                      type="button"
                      aria-label={`${$t.automation.runDetails} · ${taskLabel(task, $locale)}`}
                      title={$t.automation.runDetails}
                      aria-expanded={expandedRunDetailsTaskId === task.id}
                      aria-controls={`${task.id}-run-details`}
                      onclick={() => (expandedRunDetailsTaskId = expandedRunDetailsTaskId === task.id ? null : task.id)}
                    >
                      <CircleEllipsis size={16} strokeWidth={2.2} aria-hidden="true" />
                      <span class="visually-hidden">{$t.automation.runDetails}</span>
                    </button>
                  </div>
                </td>
              </tr>
              {#if expandedRunDetailsTaskId === task.id}
                {@const duration = runDurationSeconds(task)}
                <tr class="inline-run-details-row" class:jump-highlight={jumpHighlightTaskId === task.id} id={`${task.id}-run-details`}>
                  <td colspan="5">
                    <div class="inline-run-details" tabindex="-1" transition:disclosureSlide>
                      <div class="inline-run-details-head">
                        <div class="inline-run-details-title">
                          <strong>{$t.automation.workflowEventTitle(taskLabel(task, $locale))}</strong>
                          <span class={`chip ${statusClass(task.status)}`}>{present(task).progressLabel}</span>
                          {#if task.runId || duration !== null}
                            <span class="run-meta">
                              {[task.runId, duration === null ? null : $t.automation.runDuration(duration)].filter(Boolean).join(" · ")}
                            </span>
                          {/if}
                        </div>
                        <button
                          class="button secondary run-details-collapse"
                          type="button"
                          aria-label={$t.automation.collapseRunDetails}
                          title={$t.automation.collapseRunDetails}
                          onclick={() => (expandedRunDetailsTaskId = null)}
                        >
                          <ChevronUp size={16} strokeWidth={2.2} aria-hidden="true" />
                        </button>
                      </div>
                      {#if present(task).failure}
                        {@const failure = present(task).failure!}
                        {@const errorCode = failure.code}
                        <div class="workflow-outcome-error">
                          <CircleAlert size={16} strokeWidth={2.2} aria-hidden="true" />
                          <code>{errorCode}</code>
                          {#if failure.explanation}
                            <span>{failure.explanation}</span>
                          {/if}
                          {#if failure.userAction === "register-device" && deviceRegistrationSource(task.credentialGroupId)}
                            <button class="button secondary device-registration-action" type="button" onclick={() => void openDeviceRegistration(task.credentialGroupId)}>
                              {$t.automation.deviceRegistrationOpenSettings}
                            </button>
                          {/if}
                          {#if structureReport.report?.taskId === task.id}
                            <button class="button secondary structure-report-action" type="button" onclick={() => (structureReport = openStructureReport(structureReport))}>
                              {$t.automation.structureReport.share}
                            </button>
                          {/if}
                          {#if errorReportsAvailable}
                            <button class="button secondary structure-report-action" type="button" onclick={() => (errorReport = errorReportTarget(task, errorCode))}>
                              {$t.automation.errorReport.open}
                            </button>
                          {/if}
                          <button class="copy-error-code" type="button" onclick={() => void copyErrorCode(task.id, errorCode)}>
                            {copiedErrorTaskId === task.id ? $t.automation.errorCodeCopied : $t.automation.copyErrorCode}
                          </button>
                        </div>
                      {/if}
                      {#if task.events.length}
                        <section class="run-stage-track" aria-label={$t.automation.runStages}>
                          <span class="run-details-label">{$t.automation.runStages}</span>
                          <ol class="run-stages">
                            {#each runStageTrack(task.events, task.status, task.appWorkflowOutcome) as stage (stage.stage)}
                              {@const failureLabel = stage.lastEvent ? workflowEventFailureLabel(stage.lastEvent, $t) : null}
                              {@const stageFailures = productFailures(task.appWorkflowOutcome, stage.stage)}
                              <li class="run-stage" data-state={stage.state}>
                                <span class="run-stage-node-row">
                                  <span class="run-stage-node" title={$t.automation.runStageStates[stage.state]}>
                                    {#if stage.state === "done"}
                                      <Check size={12} strokeWidth={3} aria-hidden="true" />
                                    {:else if stage.state === "failed"}
                                      <X size={12} strokeWidth={3} aria-hidden="true" />
                                    {:else if stage.state === "warning"}
                                      <Minus size={12} strokeWidth={3} aria-hidden="true" />
                                    {/if}
                                    <span class="visually-hidden">{$t.automation.runStageStates[stage.state]}</span>
                                  </span>
                                  <span class="run-stage-connector"></span>
                                </span>
                                <span class="run-stage-label">{$t.automation.workflowStages[stage.stage]}</span>
                                {#if stage.lastEvent}
                                  <time class="run-stage-time" datetime={stage.lastEvent.occurredAt}>{formatClock(stage.lastEvent.occurredAt)}</time>
                                  {#if failureLabel}
                                    <span class="run-stage-note">{failureLabel}</span>
                                  {:else if stageFailures}
                                    <span class="run-stage-note">{$t.automation.productFailures(
                                      stageFailures.typeIds.map((typeId) => $t.automation.statementTypeLabels[typeId] ?? typeId).join($t.automation.changeListSeparator),
                                      stageFailures.typeIds.length,
                                      stageFailures.attempted,
                                    )}</span>
                                  {:else if stage.lastEvent.completed !== undefined || stage.lastEvent.total !== undefined}
                                    <span class="run-stage-note">{$t.automation.workflowEventCounts(stage.lastEvent.completed, stage.lastEvent.total)}</span>
                                  {:else}
                                    <code class="run-stage-note">{stage.lastEvent.code}</code>
                                  {/if}
                                {/if}
                              </li>
                            {/each}
                          </ol>
                        </section>
                      {/if}
                      {#if task.appWorkflowOutcome?.summary}
                        {@const summaryCounts = task.id === "sync-tdcc"
                          ? countsOutsideTdccExclusions(task.appWorkflowOutcome.summary.counts)
                          : Object.entries(task.appWorkflowOutcome.summary.counts)}
                        {#if summaryCounts.length}
                          <div class="workflow-outcome-summary" aria-label={$t.automation.workflowOutcomeSummary}>
                            {#if task.appWorkflowOutcome.summary.status}
                              <span>{task.appWorkflowOutcome.summary.status}</span>
                            {/if}
                            {#each summaryCounts as count}
                              <span>{count[0]}: {count[1]}</span>
                            {/each}
                          </div>
                        {/if}
                      {/if}
                      {#if task.id === "sync-tdcc" && task.appWorkflowOutcome?.summary}
                        {@const exclusions = tdccExclusionLines(task.appWorkflowOutcome.summary.counts, $t)}
                        {#if exclusions.length}
                          <div class="tdcc-exclusions" aria-label={$t.automation.tdccExclusions.title}>
                            <strong>{$t.automation.tdccExclusions.title}</strong>
                            <ul>
                              {#each exclusions as line}<li>{line}</li>{/each}
                            </ul>
                          </div>
                        {/if}
                      {/if}
                      {#if task.appWorkflowOutcome?.summary?.products?.length}
                        <section class="workflow-products" aria-label={$t.automation.productResults}>
                          <span class="run-details-label">{$t.automation.productResults}</span>
                          <table class="workflow-product-results">
                            <thead>
                              <tr>
                                <th scope="col">{$t.automation.productColumns.product}</th>
                                <th scope="col">{$t.automation.productColumns.result}</th>
                                <th scope="col">{$t.automation.productColumns.note}</th>
                                <th scope="col">{$t.automation.productColumns.errorCode}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {#each task.appWorkflowOutcome.summary.products as product (product.typeId)}
                                {@const productFailure = product.errorCode ? workflowFailureExplanation(product.errorCode, $locale) : null}
                                {@const notes = [
                                  product.status === "skipped" && product.skipReason ? $t.automation.productSkipReasons[product.skipReason] : null,
                                  task.id === "sync-tdcc" && product.collection ? $t.automation.tdccCollectionStatuses[product.collection.status] : null,
                                  product.status === "failed" && product.committedCount > 0 ? $t.automation.productRetainedCount(product.committedCount) : null,
                                  productFailure,
                                ].filter(Boolean)}
                                <tr class="workflow-product-row" data-status={product.status}>
                                  <th scope="row" class="workflow-product-name">
                                    {$t.automation.statementTypeLabels[product.typeId] ?? product.typeId}
                                  </th>
                                  <td class="workflow-product-status">{$t.automation.productOutcomeStatuses[product.status]}</td>
                                  <td class="workflow-product-note" class:empty={!notes.length}>{notes.length ? notes.join(" ") : "—"}</td>
                                  <td class="workflow-product-code" class:empty={!product.errorCode}>{#if product.errorCode}<code>{product.errorCode}</code>{:else}—{/if}</td>
                                </tr>
                              {/each}
                            </tbody>
                          </table>
                        </section>
                      {/if}
                      {#if runDetailsOverview}
                        {@const unvalued = unvaluedAccountLabels(task.integrationNamespaces, runDetailsOverview, $t)}
                        {#if unvalued.length}
                          <div class="unvalued-accounts" aria-label={$t.automation.unvaluedAccounts.title}>
                            <strong>{$t.automation.unvaluedAccounts.title}</strong>
                            <span>{$t.automation.unvaluedAccounts.body}</span>
                            <ul>
                              {#each unvalued as label}<li>{label}</li>{/each}
                            </ul>
                          </div>
                        {/if}
                      {/if}
                      {#if task.events.length}
                        {@const latest = task.events[task.events.length - 1]}
                        <details class="workflow-events">
                          <summary>
                            <ChevronRight class="workflow-events-chevron" size={16} strokeWidth={2.2} aria-hidden="true" />
                            <span class="workflow-events-label">{$t.automation.workflowEventsDisclosure(task.events.length)}</span>
                            <span class="workflow-events-latest">
                              <span>{$t.automation.latestEvent}</span>
                              <time datetime={latest.occurredAt}>{formatClock(latest.occurredAt)}</time>
                              <span>{$t.automation.workflowStages[latest.stage]}</span>
                              <code>{latest.code}</code>
                            </span>
                          </summary>
                          <ol class="workflow-event-list" aria-label={$t.automation.workflowEventTitle(taskLabel(task, $locale))}>
                            {#each task.events as event, index (index)}
                              {@const failureLabel = workflowEventFailureLabel(event, $t)}
                              <li class="workflow-event-row">
                                <div class="workflow-event-main">
                                  <span class="workflow-event-stage">{$t.automation.workflowStages[event.stage]}</span>
                                  {#if failureLabel}
                                    <span>{failureLabel}</span>
                                  {:else}
                                    <code>{event.code}</code>
                                  {/if}
                                </div>
                                <div class="workflow-event-meta">
                                  <time datetime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
                                  {#if event.completed !== undefined || event.total !== undefined}
                                    <span>{$t.automation.workflowEventCounts(event.completed, event.total)}</span>
                                  {/if}
                                </div>
                              </li>
                            {/each}
                          </ol>
                        </details>
                      {:else}
                        <p class="workflow-event-empty">{$t.automation.workflowEventEmpty}</p>
                      {/if}
                    </div>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
              </table>
              </div>
            </div>
          </div>
          {/if}
        </section>
      {/each}
    </section>
    </ProgressiveBlock>

    {#if $actionError}<p class="viewer-error">{$actionError}</p>{/if}
  </div>
</DashboardShell>

{#if hoveredTask}
  <div
    id="active-task-tooltip"
    class="active-task-tooltip"
    role="tooltip"
    style={`left: ${taskTooltipPosition.left}px; top: ${taskTooltipPosition.top}px;`}
  >
    <strong>{taskLabel(hoveredTask, $locale)}</strong>
    <span>{taskStageTitle(hoveredTask, $t)} · {present(hoveredTask).statusLabel}</span>
    <span>{latestTaskTime(hoveredTask)}</span>
  </div>
{/if}

{#if syncOpen}
  <button class="sync-sheet-backdrop" type="button" aria-label={$t.common.close} onclick={() => (syncOpen = false)}></button>
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
              <span>{taskLabel(task, $locale)}</span>
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

<SignInDetailsSheet
  {credentialEditor}
  {sheetContext}
  {sheetView}
  tasks={live.tasks}
  {present}
  pendingTaskIds={$state.pendingTaskIds}
  {registrationBlocksRun}
  {runActions}
  {onboardingTargets}
  bind:credentialForm
  bind:deviceRegistering
  onClose={closeCredentials}
  onSave={saveCredentials}
/>

{#if structureReport.open && structureReport.report}
  <StructureReportDialog
    report={structureReport.report}
    port={window.octopusBeak.automation}
    onClose={() => (structureReport = closeStructureReport(structureReport))}
  />
{/if}

{#if errorReport}
  <ErrorReportDialog target={errorReport} port={window.octopusBeak.errorReports} onClose={() => (errorReport = null)} />
{/if}

{#if historyOpen}
  <RunHistoryDialog tasks={live.tasks} port={window.octopusBeak.automation} onClose={() => (historyOpen = false)} />
{/if}

<style>
  :global(html) {
    overflow-y: scroll;
    scrollbar-gutter: stable;
  }

  .automation-content {
    display: grid;
    gap: 22px;
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
  }

  .sync-hero.active {
    min-height: 132px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    border-color: color-mix(in oklch, var(--accent) 28%, var(--border));
    background: color-mix(in oklch, var(--accent-soft) 24%, var(--surface));
  }

  .prerequisite-notices {
    display: grid;
    gap: 18px;
    padding: 24px 30px;
    border-color: color-mix(in oklch, var(--warn) 34%, var(--border));
    background: color-mix(in oklch, var(--warn) 6%, var(--surface));
  }

  .prerequisite-notices-head h2,
  .prerequisite-notices-head p {
    margin: 0;
  }

  .prerequisite-notices-head {
    display: grid;
    gap: 5px;
  }

  .prerequisite-notices-head p:last-child {
    color: var(--muted);
  }

  .section-eyebrow,
  .prerequisite-provider {
    color: var(--warn);
    font-size: 12px;
    font-weight: 780;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .prerequisite-notice-list {
    display: grid;
    gap: 12px;
  }

  .prerequisite-notice {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 14px 22px;
    padding: 18px;
    border: 1px solid color-mix(in oklch, var(--warn) 28%, var(--border));
    border-radius: var(--radius);
    background: var(--surface);
  }

  .prerequisite-notice-copy {
    display: grid;
    gap: 5px;
  }

  .prerequisite-notice-copy h3,
  .prerequisite-notice-copy p {
    margin: 0;
  }

  .prerequisite-notice-copy p {
    color: var(--muted);
  }

  .prerequisite-notice-actions {
    align-self: start;
  }

  .prerequisite-affected-tasks {
    grid-column: 1 / -1;
    display: grid;
    gap: 8px;
  }

  .prerequisite-task-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 0 0;
    border-top: 1px solid var(--border);
  }

  .prerequisite-task-row .task-control {
    min-width: 104px;
  }

  .prerequisite-technical-details {
    grid-column: 1 / -1;
    color: var(--muted);
    font-size: 12px;
  }

  .prerequisite-technical-item {
    display: grid;
    gap: 5px;
    margin-top: 8px;
  }

  .prerequisite-technical-item pre {
    margin: 0;
    white-space: pre-wrap;
  }

  .sync-hero-copy {
    min-width: 0;
    display: grid;
    gap: 6px;
  }

  .sync-hero h2 {
    margin: 0;
    font-size: 22px;
    line-height: 1.25;
    letter-spacing: -0.01em;
  }

  .sync-hero-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }

  .sync-hero-meta .unfinished {
    color: var(--warn);
    font-weight: 650;
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
    padding: 4px;
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
    padding: 2px;
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
    transition: border-color 150ms ease, background 150ms ease;
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
    border-color: var(--accent);
    background: var(--surface);
    animation: active-task-settle 280ms cubic-bezier(0.2, 0.9, 0.25, 1) both;
  }

  @keyframes active-task-settle {
    42% {
      transform: scale(0.94);
    }

    100% {
      transform: scale(1.06);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .active-task-jump:hover {
      animation: none;
    }
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

  .active-task-jump.sync-task {
    border-color: color-mix(in oklch, var(--success) 34%, var(--border));
    background: color-mix(in oklch, var(--success) 8%, var(--surface));
    color: var(--success);
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

  .hero-action {
    min-width: 132px;
    min-height: 48px;
    font-size: 15px;
  }

  .workflow-card {
    overflow: hidden;
  }

  .workflow-card.single-stage .stage-head-content {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .workflow-card.single-stage .stage-body {
    padding-left: 20px;
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
    min-width: 720px;
  }

  .automation-table th,
  .automation-table td {
    padding-inline: 8px;
  }

  .automation-table th {
    font-size: 11px;
    line-height: 1.35;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .automation-table tr.task-active td {
    background: color-mix(in oklch, var(--accent) 5%, var(--surface));
  }

  .task-row {
    scroll-margin-top: 88px;
  }

  .automation-table tr.task-attention td {
    background: color-mix(in oklch, var(--danger) 6%, var(--surface));
  }

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
    color: var(--muted);
    display: grid;
    place-items: center;
  }

  .task-name strong {
    font-weight: 720;
  }

  .task-label {
    min-width: 0;
    display: grid;
  }

  .task-aside {
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
  }

  .mono {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .latest-time {
    white-space: nowrap;
  }

  .automation-table td > .chip {
    white-space: nowrap;
  }

  .progress-cell {
    min-width: 96px;
    display: grid;
    gap: 6px;
    align-items: center;
  }

  /* An outcome tag sizes to its words, like the settled tags in other rows. */
  .outcome-chip {
    justify-self: start;
  }

  .progress-bar {
    position: relative;
    width: 100%;
    min-width: 40px;
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

  .progress-bar.working::after {
    position: absolute;
    inset: 0 auto 0 0;
    width: 22%;
    border-radius: inherit;
    background: linear-gradient(90deg, transparent, color-mix(in oklch, var(--surface) 88%, transparent), transparent);
    content: "";
    animation: workflow-progress-sweep 1.4s linear infinite;
    pointer-events: none;
  }

  .progress-description {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
  }

  .workflow-failure-summary {
    display: grid;
    gap: 3px;
    color: var(--danger);
    font-size: 12px;
  }

  .workflow-failure-summary code {
    width: fit-content;
    font-size: 11px;
  }

  .progress-copy {
    min-width: 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .progress-copy[data-status="failed"],
  .progress-copy[data-status="cancelled"],
  .progress-copy[data-status="interrupted"] {
    color: var(--danger);
    font-weight: 700;
  }

  .progress-copy[data-status="completed"] {
    color: var(--success);
    font-weight: 700;
  }

  .progress-copy[data-status="partial"] {
    color: var(--warn);
    font-weight: 700;
  }

  @keyframes workflow-progress-sweep {
    from {
      transform: translateX(-120%);
    }

    to {
      transform: translateX(560%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .progress-bar.working::after {
      transform: translateX(300%);
      animation: none;
    }
  }

  .task-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    flex-wrap: wrap;
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
    white-space: nowrap;
  }

  .task-control.active-details {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-soft);
  }

  /* "Sync all" is the page's one primary action; a row's own run stays quiet. */
  .task-control.default {
    padding: 0 12px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--fg);
    transition: background-color 160ms ease, border-color 160ms ease;
  }

  .task-control.default:not(:disabled):hover {
    border-color: color-mix(in oklch, var(--fg) 22%, var(--border));
    background: var(--surface-soft);
  }

  .task-control.primary,
  .task-control.danger {
    padding: 0 12px;
    border: 1px solid var(--fg);
    background: var(--fg);
    color: white;
  }

  .task-control.danger {
    border-color: color-mix(in oklch, var(--danger) 28%, var(--border));
    background: color-mix(in oklch, var(--danger) 9%, white);
    color: var(--danger);
  }

  .inline-run-details-row > td {
    padding: 0;
    background: color-mix(in oklch, var(--accent-soft) 38%, var(--surface));
    scroll-margin-top: 88px;
  }

  /* The task table scrolls sideways when narrow; its details stay pinned to the visible width. */
  .task-table-wrap {
    container-type: inline-size;
  }

  /* Narrower than the table's 720px floor, each task becomes a card instead of scrolling sideways. */
  .card-label {
    display: none;
  }

  @container (width < 720px) {
    .automation-table {
      display: block;
      min-width: 0;
    }

    .automation-table colgroup,
    .automation-table thead {
      display: none;
    }

    .automation-table tbody,
    .automation-table tr.inline-run-details-row,
    .automation-table tr.inline-run-details-row > td {
      display: block;
    }

    .automation-table tr.task-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      grid-template-areas:
        "name name actions"
        "credential time time"
        "status status status";
      align-items: center;
      gap: var(--space-2) var(--space-3);
      padding: var(--space-4) 8px;
      border-top: 1px solid var(--border);
    }

    .automation-table tbody > tr.task-row:first-child,
    .automation-table tr.inline-run-details-row + tr.task-row {
      border-top: 0;
    }

    .card-label {
      display: block;
      color: var(--muted);
      font-family: var(--font-body);
      font-size: 10px;
      font-weight: 650;
    }

    .automation-table tr.task-row > td {
      display: block;
      padding: 0;
      border-top: 0;
      background: none;
    }

    .automation-table tr.task-row > td:nth-child(1) { grid-area: name; }
    .automation-table tr.task-row > td:nth-child(2) { grid-area: credential; }
    .automation-table tr.task-row > td:nth-child(3) { grid-area: time; }
    .automation-table tr.task-row > td:nth-child(4) { grid-area: status; }
    .automation-table tr.task-row > td:nth-child(5) { grid-area: actions; }

    .automation-table tr.task-row.task-active {
      background: color-mix(in oklch, var(--accent) 5%, var(--surface));
    }

    .automation-table tr.task-row.task-attention {
      background: color-mix(in oklch, var(--danger) 6%, var(--surface));
    }

    .task-name {
      min-width: 0;
    }
  }

  .inline-run-details {
    position: sticky;
    left: 0;
    box-sizing: border-box;
    width: 100cqi;
    display: grid;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-5) var(--space-5);
    border-top: 1px solid color-mix(in oklch, var(--accent) 24%, var(--border));
    border-bottom: 1px solid color-mix(in oklch, var(--accent) 24%, var(--border));
    outline: none;
    transition: background 240ms ease, box-shadow 240ms ease;
  }

  .inline-run-details-row.jump-highlight .inline-run-details {
    background: color-mix(in oklch, var(--accent-soft) 76%, var(--surface));
    box-shadow: inset 4px 0 0 var(--accent);
  }

  .inline-run-details-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .inline-run-details-title {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2) 10px;
    min-width: 0;
  }

  .inline-run-details-title strong {
    font-size: 15px;
  }

  .run-meta {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .run-details-collapse {
    flex: 0 0 auto;
    min-height: 32px;
    padding: 0 9px;
  }

  .run-details-label {
    color: var(--muted);
    font-size: 11px;
    letter-spacing: 0.8px;
  }

  .workflow-outcome-error {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    margin: 0;
    padding: 10px 14px;
    border: 1px solid color-mix(in oklch, var(--danger) 22%, var(--border));
    border-radius: var(--radius);
    background: color-mix(in oklch, var(--danger) 5%, var(--surface));
    color: var(--danger);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .workflow-outcome-error > span {
    flex: 1 1 240px;
  }

  .workflow-outcome-error code {
    font-family: var(--font-mono);
    font-weight: 700;
  }

  .copy-error-code {
    margin-left: auto;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }

  .copy-error-code:hover {
    text-decoration: underline;
  }

  .device-registration-action {
    min-height: 32px;
  }

  .workflow-failure-summary .device-registration-action {
    width: fit-content;
    margin-top: var(--space-1);
  }

  .run-stage-track,
  .workflow-products {
    display: grid;
    gap: 10px;
    min-width: 0;
  }

  .run-stages {
    display: flex;
    margin: 0;
    padding: 0 0 var(--space-1);
    overflow-x: auto;
    list-style: none;
  }

  .run-stage {
    --stage-color: var(--success);
    display: grid;
    flex: 1 1 0;
    align-content: start;
    gap: 2px;
    min-width: 112px;
    font-size: 11px;
  }

  .run-stage[data-state="failed"] {
    --stage-color: var(--danger);
  }

  .run-stage[data-state="warning"] {
    --stage-color: var(--warn);
  }

  .run-stage[data-state="active"] {
    --stage-color: var(--accent);
  }

  .run-stage[data-state="pending"] {
    --stage-color: var(--border);
  }

  .run-stage-node-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }

  .run-stage-node {
    display: grid;
    flex: 0 0 22px;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--stage-color);
    color: white;
  }

  .run-stage[data-state="pending"] .run-stage-node {
    border: 2px solid var(--border);
    background: var(--surface);
  }

  .run-stage[data-state="active"] .run-stage-node::after {
    content: "";
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: white;
  }

  .run-stage-connector {
    flex: 1 1 auto;
    height: 2px;
    background: var(--stage-color);
  }

  .run-stage:last-child .run-stage-connector {
    display: none;
  }

  .run-stage-label {
    color: var(--fg);
    font-size: 12px;
  }

  .run-stage-time {
    color: var(--muted);
    font-family: var(--font-mono);
  }

  .run-stage-note {
    padding-right: var(--space-2);
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  code.run-stage-note {
    font-family: var(--font-mono);
  }

  .run-stage:is([data-state="failed"], [data-state="warning"]) :is(.run-stage-label, .run-stage-note) {
    color: var(--stage-color);
  }

  .run-stage[data-state="pending"] .run-stage-label {
    color: var(--muted);
  }

  .tdcc-exclusions,
  .unvalued-accounts {
    display: grid;
    gap: var(--space-1);
    color: var(--muted);
    font-size: 12px;
  }

  .tdcc-exclusions strong,
  .unvalued-accounts strong {
    color: var(--fg);
    font-weight: 680;
  }

  .tdcc-exclusions ul,
  .unvalued-accounts ul {
    margin: 0;
    padding-left: var(--space-4);
  }

  .workflow-outcome-summary {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    color: var(--muted);
    font-size: 12px;
  }

  .workflow-product-results {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    border-collapse: separate;
    border-spacing: 0;
    overflow: hidden;
    background: var(--surface);
    table-layout: fixed;
  }

  .workflow-product-results th,
  .workflow-product-results td {
    padding: 10px 12px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
    font-weight: 400;
    letter-spacing: 0;
    text-align: left;
    text-transform: none;
    vertical-align: middle;
    overflow-wrap: anywhere;
  }

  .workflow-product-results thead th {
    padding-block: var(--space-2);
    border-top: 0;
    background: var(--surface-soft);
    font-size: 11px;
    letter-spacing: 0.6px;
  }

  .workflow-product-results thead th:first-child {
    width: 28%;
  }

  .workflow-product-results thead th:nth-child(2) {
    width: 14%;
  }

  .workflow-product-results thead th:last-child {
    width: 28%;
  }

  .workflow-product-results .workflow-product-name {
    color: var(--fg);
    font-size: 13px;
  }

  .workflow-product-results .workflow-product-status {
    color: var(--accent);
  }

  .workflow-product-row[data-status="failed"] .workflow-product-status {
    color: var(--danger);
  }

  .workflow-product-row:is([data-status="no_data"], [data-status="not_held"], [data-status="skipped"]) .workflow-product-status {
    color: var(--muted);
  }

  .workflow-product-row[data-status="failed"] :is(.workflow-product-note, .workflow-product-code) {
    color: var(--fg);
  }

  .workflow-product-code {
    font-family: var(--font-mono);
  }

  .workflow-product-code code {
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .workflow-events {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .workflow-events summary {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    padding: 10px 14px;
    cursor: pointer;
    list-style: none;
  }

  .workflow-events summary::-webkit-details-marker {
    display: none;
  }

  .workflow-events :global(.workflow-events-chevron) {
    color: var(--muted);
    transition: transform 160ms ease;
  }

  .workflow-events[open] :global(.workflow-events-chevron) {
    transform: rotate(90deg);
  }

  .workflow-events-label {
    font-size: 13px;
  }

  .workflow-events-latest {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: var(--space-2);
    color: var(--muted);
    font-size: 12px;
  }

  .workflow-events-latest time {
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .workflow-events-latest code {
    color: var(--fg);
    font-family: var(--font-mono);
  }

  .workflow-event-list {
    max-height: 280px;
    margin: 0;
    padding: 0;
    overflow: auto;
    border-top: 1px solid var(--border);
    background: var(--surface-soft);
    list-style: none;
  }

  .workflow-event-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    min-height: 42px;
    padding: var(--space-2) 14px;
    border-bottom: 1px solid var(--border);
  }

  .workflow-event-row:last-child {
    border-bottom: 0;
  }

  .workflow-event-main,
  .workflow-event-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-3);
    min-width: 0;
  }

  .workflow-event-stage,
  .workflow-event-meta {
    color: var(--muted);
    font-size: 12px;
  }

  .workflow-event-row code {
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .workflow-event-meta {
    justify-content: flex-end;
    text-align: right;
    white-space: nowrap;
  }

  .workflow-event-empty {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
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

  .sync-sheet-backdrop {
    position: fixed;
    z-index: 24;
    inset: var(--topbar-height, 60px) 0 0 0;
    border: 0;
    background: rgb(14 18 28 / 0.18);
    animation: sync-sheet-backdrop-in 160ms ease-out both;
  }

  @keyframes sync-sheet-backdrop-in {
    from {
      opacity: 0;
    }
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

  .structure-report-action {
    min-height: 32px;
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

  /* Every status tone tints at the same 10% as a settled chip, so the tags read as one set. */
  .chip.warn {
    color: var(--warn);
    background: color-mix(in oklch, var(--warn) 10%, white);
  }

  .chip.bad {
    color: var(--danger);
    background: color-mix(in oklch, var(--danger) 10%, white);
  }

  .viewer-error {
    margin: 0;
    color: var(--danger);
    font-size: 13px;
  }

  @media (max-width: 1100px) {
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

    .workflow-card.single-stage .stage-body {
      padding-left: var(--space-4);
    }

    .stage-number {
      width: 36px;
      height: 36px;
      flex-basis: 36px;
    }

    .inline-run-details-head {
      align-items: flex-start;
    }

    .workflow-event-row {
      align-items: flex-start;
      flex-direction: column;
      gap: var(--space-1);
    }

    .workflow-event-meta {
      justify-content: flex-start;
      text-align: left;
    }

    .workflow-product-results thead {
      display: none;
    }

    .workflow-product-results,
    .workflow-product-results tbody,
    .workflow-product-row,
    .workflow-product-results th,
    .workflow-product-results td {
      display: block;
      width: auto;
    }

    .workflow-product-row {
      padding: var(--space-2) 0;
      border-top: 1px solid var(--border);
    }

    .workflow-product-row:first-child {
      border-top: 0;
    }

    .workflow-product-results .workflow-product-row > * {
      padding: 2px 12px;
      border-top: 0;
    }

    .workflow-product-results .empty {
      display: none;
    }

    .workflow-events-latest {
      justify-content: flex-start;
    }

    .task-actions {
      justify-content: flex-start;
    }

    .sync-sheet {
      width: min(455px, 100vw);
    }
  }
</style>
