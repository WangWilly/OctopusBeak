<script lang="ts">
  import InstitutionLogo from "$lib/institutions/InstitutionLogo.svelte";
  import TdccDeviceRegistration from "$lib/automation/TdccDeviceRegistration.svelte";
  import { countsOutsideTdccExclusions, tdccExclusionLines } from "$lib/automation/tdcc-run-outcome.ts";
  import { sourceLogo, sourceLogoForTask } from "$lib/institutions/institutions.ts";
  import { onDestroy, tick } from "svelte";
  import { slide } from "svelte/transition";
  import {
    ArrowLeftRight,
    BookOpen,
    ChevronDown,
    ChevronRight,
    CircleAlert,
    CircleEllipsis,
    CloudDownload,
    Info,
    KeyRound,
    Landmark,
    Lock,
    Plus,
    RefreshCw,
    Search,
    X,
  } from "@lucide/svelte";
  import type { CertificateFileValidationReason, CredentialGroupDto } from "$lib/desktop/api.ts";
  import type { AutomationCredentialStatus, AutomationRuntimeSnapshot } from "$lib/desktop/api.ts";
  import { isActiveAutomationRuntimeStatus } from "$lib/automation/runtime-status.ts";
  import type {
    AutomationActionKind,
    AutomationActionToken,
    createAutomationRuntimeController,
  } from "$lib/automation/runtime-controller.ts";
  import type {
    CathayGmailOtpConnectionError,
    CathayGmailOtpStatus,
  } from "$lib/automation/types.ts";
  import { locale, t, type Translation } from "$lib/i18n/i18n.ts";
import {
  canSubmitCredentials,
  onboardingTaskDisclosure,
} from "$lib/onboarding/state.ts";
  import {
    buildCredentialSetupPlan,
    firstInvalidCredentialGroup,
  } from "$lib/automation/credential-setup.ts";
  import { credentialInputValue } from "$lib/automation/credential-redaction.ts";
  import {
    NO_CREDENTIAL_CHANGES,
    closeCredentialEditor,
    confirmCredentialEditor,
    credentialSetupInput,
    effectiveGroupEnabled,
    effectiveStatementSelection,
    openCredentialEditor,
    pendingCredentialChanges,
    revertCredential,
    selectAllStatementTypes as selectAllStatementTypeChanges,
    setGroupEnabled,
    stageCredentialFile,
    stageCredentialValue,
    toggleStatementType as toggleStatementTypeChange,
    updateCredentialEditor,
    type CredentialChanges,
    type PendingCredentialChange,
  } from "$lib/automation/credential-changes.ts";
  import {
    cathayEmailOtpFailureReason,
    cathayOtpReasonNeedsGmailSettings,
    verificationFailureEventReason,
    verificationSolverExhausted,
  } from "$lib/automation/verification-actor-ui.ts";
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
  import { resolveAutomationBlock } from "$lib/shared-shell/progressive-dashboard-data.ts";
  import { formatUtcDateTime } from "$lib/time/timezone.ts";
  import type {
    AutomationPageModel,
    AutomationCredentialRedaction,
    AutomationTaskHistoryRow,
    AutomationTaskPrerequisiteNotice,
    AutomationTaskRow,
  } from "./types.ts";
  import { mergeAutomationRuntime } from "./runtime-sync.ts";
  import { workflowFailureExplanation } from "./workflow-failures.ts";
  import {
    automationStageTasks,
    dispatchAutomationStageSync,
  } from "./progressive-automation-actions.ts";

  export let automation: AutomationPageModel;
  export let credentialGroups: CredentialGroupDto[];
  export let blocks: Readonly<Record<string, BlockState<DashboardBlockPayload>>> = {};
  export let runtimeSnapshot: AutomationRuntimeSnapshot | null = null;
  export let runtimeController: ReturnType<typeof createAutomationRuntimeController> | null = null;
  export let appPendingTaskIds: ReadonlySet<string> = new Set<string>();
  export let appPendingActions: readonly AutomationActionToken[] = [];
  export let retryBlock: (key: string) => void = () => {};
  export let reload: () => Promise<void>;
  export let onboardingSourceSelection = false;
  export let onboardingSingleSource = false;
  export let onboardingNodeId: OnboardingNodeId | null = null;
  export let onboardingSelectedCredentialGroupId: string | null = null;
  export let onboardingTrackedTaskId: string | null = null;
  export let onboardingTargets: OnboardingTargetRegistry = createOnboardingTargetRegistry();
  export let onOnboardingStoryEvent: (event: OnboardingStoryEvent) => void = () => {};
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

  let credentialsOpen = false;
  let credentialPresentation: "picker" | "details" = "details";
  let syncOpen = false;
  let syncTasks: AutomationTaskRow[] = [];
  let expandedRunDetailsTaskId: string | null = null;
  let jumpHighlightTaskId: string | null = null;
  let jumpHighlightTimer: ReturnType<typeof setTimeout> | null = null;
  let historyOpen = false;
  let historyLoading = false;
  let historyRows: AutomationTaskHistoryRow[] = [];
  let historySearch = "";
  let historyFilter: "all" | "running" | "completed" | "failed" = "all";
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let appliedRuntimeSnapshot: AutomationRuntimeSnapshot | null = null;
  let pendingTaskIds = new Set<string>();
  let localPendingActions: AutomationActionToken[] = [];
  let preparingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  let actionError = "";
  let statementSelectionError = "";
  let hoveredTask: AutomationTaskRow | null = null;
  let taskTooltipPosition = { left: 0, top: 0 };
  let credentialChanges: CredentialChanges = NO_CREDENTIAL_CHANGES;
  let credentialFileErrors: Record<string, string> = {};
  let focusedCredentialKey: string | null = null;
  let cathayGmailOtpBusy = false;
  let tdccRegistering = false;
  let cathayGmailOtpError = "";
  let statementSelectionConfirmed = false;
  let selectedCredentialGroupId = "";
  let credentialSearch = "";
  let setupGuideOpen = false;
  let stageOpen: Record<string, boolean> = { sync: true };
  const defaultCathayGmailOtpStatus: CathayGmailOtpStatus = {
    enabled: true,
    connectedEmail: null,
    needsAuthorization: true,
  };
  let cathayGmailOtpStatus: CathayGmailOtpStatus = defaultCathayGmailOtpStatus;

  $: sideValue = automation.active
    ? $t.common.runningCount(automation.activeTaskCount)
    : $t.common.ready;
  $: sideSub = $t.common.businessDay(automation.businessDate);
  $: parallelTaskIds = new Set(automation.parallelRunnableTaskIds);
  $: activeTasks = automation.tasks.filter((task) => task.isActive);
  $: iconTasks = automation.tasks.filter((task) =>
    task.isActive
    || task.status === "failed"
  );
  $: credentialReadyCount = syncTasks.filter((task) =>
    task.credentialKeys.every((key) => automation.credentials[key]),
  ).length;
  $: taskStages = taskStagesFor(automation);
  $: renderedPendingActions = mergePendingActions(appPendingActions, localPendingActions);
  $: prerequisiteNoticeGroups = prerequisiteNoticeGroupsFor(automation);
  $: cathayGmailOtpStatus = automation.cathayGmailOtp ?? defaultCathayGmailOtpStatus;
  $: pendingChanges = pendingCredentialChanges(credentialGroups, credentialChanges);
  $: credentialsDirty = pendingChanges.length > 0 || Boolean(credentialChanges.editor?.draft.trim());
  $: savedEnabledGroupCount = credentialGroups.filter((group) => group.enabled).length;
  $: railEnabledGroups = visibleCredentialGroups.filter((group) =>
    effectiveGroupEnabled(credentialGroups, credentialChanges, group.id));
  $: railAvailableGroups = visibleCredentialGroups.filter((group) =>
    !effectiveGroupEnabled(credentialGroups, credentialChanges, group.id));
  $: selectedGroupTask = selectedCredentialGroup
    ? credentialGroupTask(selectedCredentialGroup.id, automation)
    : undefined;
  $: collectionGroupIds = new Set(
    automation.tasks
      .filter((task) => task.credentialGroupId)
      .map((task) => task.credentialGroupId as string),
  );
  $: onboardingDisclosure = onboardingTaskDisclosure(
    onboardingNodeId ?? "source-entry",
    onboardingSelectedCredentialGroupId,
    automation.tasks,
  );
  $: revealOnboardingTask(onboardingDisclosure);
  $: visibleCredentialGroups = credentialGroups.filter((group) => {
    const term = credentialSearch.trim().toLowerCase();
    if (!term) return true;
    return [
      group.label,
      group.displayName.en,
      group.displayName["zh-TW"],
      ...group.searchAliases,
    ].join(" ").toLowerCase().includes(term);
  });
  $: selectedCredentialGroup =
    visibleCredentialGroups.find((group) => group.id === selectedCredentialGroupId)
    ?? (!onboardingSourceSelection ? visibleCredentialGroups[0] : undefined);
  $: onboardingMissingCredentialKey = onboardingSourceSelection && selectedCredentialGroup
    ? selectedCredentialGroup.credentialKeys.find(
        (key) => !(key in credentialChanges.credentials) && credentialState(key) !== "ready",
      ) ?? null
    : null;
  $: onboardingSourceEnabled = Boolean(
    selectedCredentialGroup
    && effectiveGroupEnabled(credentialGroups, credentialChanges, selectedCredentialGroup.id),
  );
  $: onboardingNeedsStatements = Boolean(
    onboardingSourceSelection
    && selectedCredentialGroup?.statementTypes?.length
    && (
      !effectiveStatementSelection(credentialGroups, credentialChanges, selectedCredentialGroup.id).length
      || !statementSelectionConfirmed
    ),
  );
  $: onboardingCredentialsReady = Boolean(
    onboardingSourceSelection
    && selectedCredentialGroup
    && onboardingSourceEnabled
    && !onboardingMissingCredentialKey
    && !onboardingNeedsStatements,
  );
  $: catalogHistoryRows = filterHistoryToCurrentTasks(historyRows, automation.tasks);
  $: visibleHistoryRows = catalogHistoryRows.filter((run) => {
    const term = historySearch.trim().toLowerCase();
    return (historyFilter === "all" || historyStatusGroup(run.status) === historyFilter)
      && (!term || taskIdLabel(run.taskId, $t).toLowerCase().includes(term));
  });
  $: historyCounts = catalogHistoryRows.reduce(
    (counts, run) => {
      counts[historyStatusGroup(run.status)] += 1;
      return counts;
    },
    { running: 0, completed: 0, failed: 0 },
  );

  $: if ((automation.active || pendingTaskIds.size > 0 || appPendingTaskIds.size > 0) && !pollTimer) {
    pollTimer = setInterval(() => {
      void reload();
    }, 2_000);
  } else if (!automation.active && pollTimer) {
    stopPolling();
  }

  $: if (runtimeSnapshot && runtimeSnapshot !== appliedRuntimeSnapshot) {
    appliedRuntimeSnapshot = runtimeSnapshot;
    applyRuntimeSnapshot(runtimeSnapshot);
  }

  onDestroy(() => {
    stopPolling();
    for (const timeout of preparingTimeouts.values()) clearTimeout(timeout);
    preparingTimeouts.clear();
    if (jumpHighlightTimer) clearTimeout(jumpHighlightTimer);
  });

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function statusClass(status: string) {
    if (status === "completed") return "good";
    if (status === "failed" || status === "locked") return "bad";
    if (status === "running" || status === "waiting_for_human" || status === "partial" || status === "needs_setup") return "warn";
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

  function revealOnboardingTask(
    disclosure: ReturnType<typeof onboardingTaskDisclosure>,
  ) {
    if (!disclosure) return;
    if (!stageOpen[disclosure.stageId]) {
      stageOpen = { ...stageOpen, [disclosure.stageId]: true };
    }
  }

  function taskStagesFor(
    sourceAutomation: AutomationPageModel,
    block?: Parameters<typeof automationStageTasks>[1],
    liveRuntime?: AutomationRuntimeSnapshot | null,
    liveActions: readonly AutomationActionToken[] = appPendingActions,
  ) {
    return [{
      id: "sync",
      title: $t.automation.syncStage,
      tasks: automationStageTasks(sourceAutomation, block, liveRuntime, liveActions),
    }];
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
    return formatUtcDateTime(value, $systemTimezone, $locale) || "--";
  }

  function latestTaskTime(task: AutomationTaskRow) {
    return formatTime(task.latestFinishedAt ?? task.latestStartedAt);
  }

  function taskCredentialsReady(task: AutomationTaskRow, sourceAutomation = automation) {
    return task.status !== "needs_setup" && task.credentialKeys.every((key) =>
      (sourceAutomation.credentialStates?.[key] ?? (sourceAutomation.credentials[key] ? "ready" : "missing")) === "ready",
    );
  }

  function credentialState(key: string, sourceAutomation = automation): AutomationCredentialStatus {
    return sourceAutomation.credentialStates?.[key]
      ?? (sourceAutomation.credentials[key] ? "ready" : "missing");
  }

  function allCredentialsLoading(task: AutomationTaskRow, sourceAutomation = automation) {
    const states = task.credentialKeys.map((key) => credentialState(key, sourceAutomation));
    return states.length > 0 && states.every((state) => state === "loading");
  }

  function anyCredentialReadFailed(task: AutomationTaskRow, sourceAutomation = automation) {
    return task.credentialKeys.some((key) => credentialState(key, sourceAutomation) === "read_failed");
  }

  function schedulePreparingTimeout(taskId: string) {
    const timeout = setTimeout(() => {
      void window.octopusBeak.automation.runtimeSnapshot()
        .then((snapshot) => applyAuthoritativeRuntimeSnapshot(snapshot))
        .catch((error) => {
          console.error("automation-runtime-preparing-timeout", error);
          void window.octopusBeak.automation.fatalRuntimeSnapshot();
        });
    }, 5_000);
    preparingTimeouts.set(taskId, timeout);
  }

  /** Component IPC responses must pass the shell's session/revision gate. */
  function applyAuthoritativeRuntimeSnapshot(snapshot: AutomationRuntimeSnapshot) {
    const accepted = runtimeController
      ? runtimeController.acceptSnapshot(snapshot)
      : { accepted: true, sessionChanged: false, hadGap: false, snapshot };
    if (!accepted.accepted) return false;
    runtimeSnapshot = accepted.snapshot;
    appliedRuntimeSnapshot = accepted.snapshot;
    applyRuntimeSnapshot(accepted.snapshot);
    if (accepted.hadGap || accepted.sessionChanged) void reload();
    return true;
  }

  function applyRuntimeSnapshot(snapshot: AutomationRuntimeSnapshot) {
    const byTaskId = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
    // Keep the component on the same pure merge contract as list/details and
    // let the authoritative runtime status derive terminal actions and
    // partial summaries. This also means every task row receives the exact
    // progress belonging to the current runId in the snapshot.
    automation = mergeAutomationRuntime(automation, snapshot);
    for (const taskId of [...pendingTaskIds]) {
      if (byTaskId.has(taskId)) {
        pendingTaskIds.delete(taskId);
        const timeout = preparingTimeouts.get(taskId);
        if (timeout) clearTimeout(timeout);
        preparingTimeouts.delete(taskId);
      }
    }
    localPendingActions = localPendingActions.filter((action) => !byTaskId.has(action.taskId));
  }

  function mergePendingActions(
    appActions: readonly AutomationActionToken[],
    localActions: readonly AutomationActionToken[],
  ) {
    const actions = new Map(appActions.map((action) => [action.taskId, action]));
    for (const action of localActions) actions.set(action.taskId, action);
    return [...actions.values()];
  }

  function beginActionToken(taskId: string, kind: AutomationActionKind) {
    const token = runtimeController
      ? runtimeController.beginAction(taskId, kind)
      : {
        token: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        taskId,
        kind,
        runId: null,
        startedAt: performance.now(),
      } satisfies AutomationActionToken;
    if (!token) return null;
    pendingTaskIds = new Set([...pendingTaskIds, taskId]);
    localPendingActions = [...localPendingActions.filter((action) => action.taskId !== taskId), token];
    return token;
  }

  function failActionToken(token: AutomationActionToken) {
    runtimeController?.failAction(token);
    pendingTaskIds = new Set([...pendingTaskIds].filter((taskId) => taskId !== token.taskId));
    localPendingActions = localPendingActions.filter((action) => action.token !== token.token);
  }

  function localizedText(value: { en: string; "zh-TW": string }) {
    return value[$locale];
  }

  function credentialGroupShortName(group: CredentialGroupDto, language: "en" | "zh-TW") {
    const name = group.displayName[language];
    const suffix = `（${group.displayName.en}）`;
    return language === "zh-TW" && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
  }

  function credentialGroupName(group: CredentialGroupDto) {
    return credentialGroupShortName(group, $locale);
  }

  function credentialGroupAltName(group: CredentialGroupDto) {
    const other = credentialGroupShortName(group, $locale === "zh-TW" ? "en" : "zh-TW");
    return other === credentialGroupName(group) ? "" : other;
  }

  function credentialGroupTask(groupId: string, sourceAutomation: AutomationPageModel) {
    return sourceAutomation.tasks.find((task) => task.credentialGroupId === groupId);
  }

  function formatShortTime(value: string | null) {
    if (!value) return "";
    return new Intl.DateTimeFormat($locale, {
      timeZone: $systemTimezone,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(value)).replace(",", "");
  }

  type CredentialSyncTone = "good" | "warn" | "bad" | "muted" | "active";

  function credentialGroupSyncStatus(
    group: CredentialGroupDto,
    sourceAutomation: AutomationPageModel,
    dictionary: Translation,
  ): { tone: CredentialSyncTone; label: string; time: string } | null {
    const task = credentialGroupTask(group.id, sourceAutomation);
    if (!task) return null;
    const labels = dictionary.automation.credentialSyncStatuses;
    if (task.isActive) return { tone: "active", label: labels.running, time: "" };
    if (group.credentialKeys.some((key) => credentialState(key, sourceAutomation) === "missing")) {
      return { tone: "warn", label: labels.missingCredentials, time: "" };
    }
    if (task.status === "needs_setup") return { tone: "warn", label: dictionary.automation.needsSetup, time: "" };
    return taskRunStatus(task, dictionary);
  }

  function taskRunStatus(
    task: AutomationTaskRow,
    dictionary: Translation,
  ): { tone: CredentialSyncTone; label: string; time: string } {
    const labels = dictionary.automation.credentialSyncStatuses;
    const time = formatShortTime(task.latestFinishedAt ?? task.latestStartedAt);
    if (!time) return { tone: "muted", label: labels.never, time: "" };
    if (task.status === "completed") return { tone: "good", label: labels.completed, time };
    if (task.status === "partial") return { tone: "warn", label: labels.partial, time };
    if (task.status === "failed" || task.status === "locked") return { tone: "bad", label: labels.failed, time };
    if (task.status === "cancelled") return { tone: "muted", label: labels.cancelled, time };
    if (task.status === "interrupted") return { tone: "muted", label: labels.interrupted, time };
    return { tone: "muted", label: dictionary.automation.statusLabels[task.status], time };
  }

  function lastSyncSummary(task: AutomationTaskRow, dictionary: Translation) {
    const outcome = task.appWorkflowOutcome;
    const products = (outcome?.summary?.products ?? []).filter((product) => product.status !== "skipped");
    if (products.length) {
      return products.map((product) => {
        const label = dictionary.automation.statementTypeLabels[product.typeId] ?? product.typeId;
        return product.status === "success"
          ? dictionary.automation.productCommittedSummary(label, product.committedCount)
          : dictionary.automation.productStatusSummary(label, dictionary.automation.productOutcomeStatuses[product.status]);
      }).join(dictionary.automation.summarySeparator);
    }
    if (outcome?.errorCode) return workflowFailureExplanation(outcome.errorCode, $locale) ?? outcome.errorCode;
    return "";
  }

  function statementLastResult(task: AutomationTaskRow | undefined, typeId: string, dictionary: Translation) {
    const product = task?.appWorkflowOutcome?.summary?.products?.find((candidate) => candidate.typeId === typeId);
    if (!product || product.status === "skipped") return null;
    if (product.status === "success") {
      return { tone: "good", text: dictionary.automation.statementLastSuccess(product.committedCount) };
    }
    if (product.status === "failed") return { tone: "bad", text: dictionary.automation.statementLastFailed };
    return { tone: "muted", text: dictionary.automation.productOutcomeStatuses[product.status] };
  }

  function pendingChangeLabel(change: PendingCredentialChange, dictionary: Translation) {
    const group = credentialGroups.find((candidate) => candidate.id === change.groupId);
    const groupName = group ? credentialGroupName(group) : change.groupId;
    if (change.kind === "credential") {
      const field = group?.credentialFields.find((candidate) => candidate.key === change.key);
      const label = field ? localizedText(field.label) : change.key;
      return change.groupId === selectedCredentialGroupId ? label : `${groupName} · ${label}`;
    }
    if (change.kind === "enabled") {
      return `${groupName} · ${change.enabled ? dictionary.automation.changeEnableSync : dictionary.automation.changeDisableSync}`;
    }
    return `${groupName} · ${dictionary.automation.statementsToCollect}`;
  }

  function editorFieldLabel(dictionary: Translation) {
    const editor = credentialChanges.editor;
    const field = editor
      ? credentialGroups.find((group) => group.id === editor.groupId)?.credentialFields.find((candidate) => candidate.key === editor.key)
      : undefined;
    return field ? localizedText(field.label) : (editor?.key ?? "");
  }

  function certificateFileValidationMessage(
    reason: CertificateFileValidationReason,
    storedFile: boolean,
  ) {
    if (reason === "invalid-extension") return $t.automation.invalidCertificateExtension;
    return storedFile
      ? $t.automation.missingCertificateFile
      : $t.automation.unreadableCertificateFile;
  }

  function cathayGmailOtpConnectionErrorMessage(
    error: CathayGmailOtpConnectionError | undefined,
  ) {
    if (error === "authorization-cancelled")
      return $t.automation.cathayGmailOtpAuthorizationCancelled;
    if (error === "token-exchange-failed")
      return $t.automation.cathayGmailOtpTokenExchangeFailed;
    if (error === "gmail-profile-failed")
      return $t.automation.cathayGmailOtpProfileFailed;
    if (error === "credential-storage-failed")
      return $t.automation.cathayGmailOtpStorageFailed;
    return $t.automation.cathayGmailOtpActionFailed;
  }

  function resetCredentialChanges() {
    credentialChanges = NO_CREDENTIAL_CHANGES;
    credentialFileErrors = {};
    focusedCredentialKey = null;
    cathayGmailOtpError = "";
    statementSelectionConfirmed = false;
    statementSelectionError = "";
  }

  function openCredentials() {
    resetCredentialChanges();
    const remembered = onboardingSelectedCredentialGroupId;
    selectCredentialGroup(
      onboardingSourceSelection
        ? remembered && collectionGroupIds.has(remembered) ? remembered : ""
        : selectedCredentialGroupId || credentialGroups[0]?.id || "",
    );
    credentialSearch = "";
    credentialPresentation = onboardingSourceSelection
      && ["source-entry", "source-selection"].includes(onboardingNodeId ?? "")
      ? "picker"
      : "details";
    credentialsOpen = true;
  }

  function openCredentialsFromStoryEntry() {
    openCredentials();
    if (onboardingSourceSelection && onboardingNodeId === "source-entry") {
      onOnboardingStoryEvent({ type: "open-picker" });
      credentialPresentation = "picker";
    }
  }

  function chooseCredentialGroup(groupId: string) {
    selectCredentialGroup(groupId);
    if (onboardingSourceSelection && onboardingNodeId === "source-selection") {
      credentialPresentation = "details";
      onOnboardingStoryEvent({ type: "choose-source", credentialGroupId: groupId });
    }
  }

  export async function openCredentialsForOnboarding() {
    if (!credentialsOpen) openCredentials();
    await tick();
  }

  export async function applyOnboardingCredentialPresentation(
    presentation: OnboardingPresentation,
    credentialGroupId: string | null,
  ) {
    if (presentation === "none") return;
    if (presentation === "close-credentials") {
      credentialsOpen = false;
      await tick();
      return;
    }
    if (!credentialsOpen) openCredentials();
    if (credentialGroupId && credentialGroups.some((group) => group.id === credentialGroupId)) {
      if (selectedCredentialGroupId !== credentialGroupId) selectCredentialGroup(credentialGroupId);
    }
    credentialPresentation = presentation === "show-picker" ? "picker" : "details";
    await tick();
  }

  export async function retryOnboardingWorkflow() {
    const task = automation.tasks.find(
      (candidate) => candidate.credentialGroupId === onboardingSelectedCredentialGroupId,
    );
    if (task) await runTask(task);
  }

  async function openTdccDeviceRegistration() {
    openCredentials();
    selectCredentialGroup("tdcc");
    await tick();
    document.getElementById("tdcc-device-title")?.focus();
  }

  function runStartErrorMessage(message: string) {
    return message.includes("TDCC device registration is in progress")
      ? $t.automation.tdccSyncBlockedByRegistration
      : message;
  }

  async function openCathayGmailOtpSettings() {
    openCredentials();
    selectCredentialGroup("cathay");
    await tick();
    document.getElementById("cathay-gmail-otp-title")?.focus();
  }

  function closeCredentials() {
    if (onboardingSourceSelection) return;
    if (credentialsDirty && !confirm($t.automation.discardCredentialChanges)) return;
    resetCredentialChanges();
    credentialsOpen = false;
  }

  function discardCredentialChanges() {
    if (onboardingSourceSelection) return;
    resetCredentialChanges();
    credentialsOpen = false;
  }

  function closeCredentialsOnEscape(event: KeyboardEvent) {
    if (!credentialsOpen || event.key !== "Escape") return;
    if (credentialChanges.editor) {
      event.preventDefault();
      credentialChanges = closeCredentialEditor(credentialChanges);
      return;
    }
    if (onboardingSourceSelection) return;
    event.preventDefault();
    closeCredentials();
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    closeCredentialsOnEscape(event);
  }

  function toggleGroup(groupId: string) {
    statementSelectionError = "";
    credentialChanges = setGroupEnabled(
      credentialGroups,
      credentialChanges,
      groupId,
      !effectiveGroupEnabled(credentialGroups, credentialChanges, groupId),
    );
  }

  async function enableCathayGmailOtp() {
    if (cathayGmailOtpBusy) return;
    cathayGmailOtpBusy = true;
    cathayGmailOtpError = "";
    try {
      const result = await window.octopusBeak.automation.enableCathayGmailOtp();
      await reload();
      if (result.connectionError)
        cathayGmailOtpError = cathayGmailOtpConnectionErrorMessage(result.connectionError);
    } catch {
      cathayGmailOtpError = $t.automation.cathayGmailOtpActionFailed;
    } finally {
      cathayGmailOtpBusy = false;
    }
  }

  async function disconnectCathayGmailOtp() {
    if (cathayGmailOtpBusy) return;
    if (!confirm($t.automation.confirmCathayGmailOtpDisconnect)) return;
    cathayGmailOtpBusy = true;
    cathayGmailOtpError = "";
    try {
      await window.octopusBeak.automation.disconnectCathayGmailOtp();
      await reload();
    } catch {
      cathayGmailOtpError = $t.automation.cathayGmailOtpActionFailed;
    } finally {
      cathayGmailOtpBusy = false;
    }
  }

  function toggleStatementType(groupId: string, typeId: string) {
    statementSelectionError = "";
    statementSelectionConfirmed = true;
    credentialChanges = toggleStatementTypeChange(credentialGroups, credentialChanges, groupId, typeId);
  }

  function selectAllStatementTypes(group: CredentialGroupDto) {
    statementSelectionError = "";
    statementSelectionConfirmed = true;
    credentialChanges = selectAllStatementTypeChanges(credentialGroups, credentialChanges, group.id);
  }

  function enableAndSelectGroup(groupId: string) {
    chooseCredentialGroup(groupId);
    credentialChanges = setGroupEnabled(credentialGroups, credentialChanges, groupId, true);
  }

  function updateCredentialDraft(key: string, event: Event) {
    credentialChanges = stageCredentialValue(
      credentialChanges,
      key,
      (event.currentTarget as HTMLInputElement).value,
    );
  }

  function updateEditorDraft(event: Event) {
    credentialChanges = updateCredentialEditor(
      credentialChanges,
      (event.currentTarget as HTMLInputElement).value,
    );
  }

  function credentialFieldText(key: string) {
    if (credentialChanges.editor?.key === key) return credentialChanges.editor.draft;
    const staged = credentialChanges.credentials[key];
    return staged?.kind === "value" ? staged.value : "";
  }

  function startCredentialEdit(groupId: string, key: string) {
    credentialChanges = openCredentialEditor(credentialChanges, groupId, key);
  }

  function confirmCredentialEdit() {
    credentialChanges = confirmCredentialEditor(credentialChanges);
  }

  function cancelCredentialEdit() {
    credentialChanges = closeCredentialEditor(credentialChanges);
  }

  function confirmCredentialEditOnEnter(event: KeyboardEvent) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    confirmCredentialEdit();
  }

  function focusOnMount(node: HTMLInputElement) {
    node.focus();
  }

  function focusCredentialInput(
    key: string,
    redaction: AutomationCredentialRedaction,
    event: FocusEvent,
  ) {
    focusedCredentialKey = key;
    const input = event.currentTarget as HTMLInputElement;
    input.value = credentialInputValue(credentialFieldText(key), redaction, true);
  }

  function blurCredentialInput(
    key: string,
    redaction: AutomationCredentialRedaction,
    event: FocusEvent,
  ) {
    if (focusedCredentialKey !== key) return;
    focusedCredentialKey = null;
    const input = event.currentTarget as HTMLInputElement;
    input.value = credentialInputValue(credentialFieldText(key), redaction, false);
  }

  async function selectCertificateFile(key: string) {
    try {
      actionError = "";
      credentialFileErrors = { ...credentialFileErrors, [key]: "" };
      const result = await window.octopusBeak.automation.selectCertificateFile($locale);
      if (result.cancelled) return;
      if ("error" in result) {
        credentialFileErrors = {
          ...credentialFileErrors,
          [key]: certificateFileValidationMessage(result.error, false),
        };
        return;
      }
      credentialChanges = stageCredentialFile(credentialChanges, key, result.path, result.filename);
    } catch (error) {
      credentialFileErrors = {
        ...credentialFileErrors,
        [key]: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function updateCredentialSearch(event: Event) {
    statementSelectionError = "";
    credentialSearch = (event.currentTarget as HTMLInputElement).value;
    await tick();
    if (!visibleCredentialGroups.some((group) => group.id === selectedCredentialGroupId)) {
      if (onboardingSourceSelection) selectCredentialGroup("");
      else selectedCredentialGroupId = visibleCredentialGroups[0]?.id ?? "";
    }
  }

  function selectCredentialGroup(groupId: string) {
    statementSelectionError = "";
    const group = credentialGroups.find((candidate) => candidate.id === groupId);
    statementSelectionConfirmed = Boolean(group?.selectedStatementTypeIds.length);
    if (selectedCredentialGroupId !== groupId) setupGuideOpen = false;
    selectedCredentialGroupId = groupId;
    if (onboardingSourceSelection && onboardingSingleSource && groupId) {
      for (const group of credentialGroups) {
        if (group.id === groupId || !collectionGroupIds.has(group.id)) continue;
        credentialChanges = setGroupEnabled(credentialGroups, credentialChanges, group.id, false);
      }
    }
  }

  async function runTask(task: AutomationTaskRow) {
    if (pendingTaskIds.has(task.id) || appPendingTaskIds.has(task.id) || task.isActive || !task.canRun) return;
    if (task.id === "sync-tdcc" && tdccRegistering) {
      actionError = $t.automation.tdccSyncBlockedByRegistration;
      return;
    }
    const token = beginActionToken(task.id, "run");
    if (!token) return;
    const onboardingToken = onOnboardingWorkflowStarting(task.id, task.credentialGroupId ?? null);
    applyLocalPreparing(task.id);
    schedulePreparingTimeout(task.id);
    try {
      actionError = "";
      const result = await window.octopusBeak.automation.run(task.id);
      runtimeController?.bindRun(token, result.runId);
      onOnboardingWorkflowStarted(onboardingToken, { taskId: task.id, runId: result.runId ?? null });
      if (result.runtime) applyAuthoritativeRuntimeSnapshot(result.runtime);
      await reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onOnboardingWorkflowStartFailed(onboardingToken, message);
      failActionToken(token);
      const pending = preparingTimeouts.get(task.id);
      if (pending) clearTimeout(pending);
      preparingTimeouts.delete(task.id);
      actionError = runStartErrorMessage(message);
    }
  }

  function applyLocalPreparing(taskId: string) {
    automation = {
      ...automation,
      active: true,
      activeTaskCount: Math.max(automation.activeTaskCount, 1),
      tasks: automation.tasks.map((task) => task.id === taskId
        ? {
          ...task,
          runId: null,
          status: "preparing",
          isActive: true,
          primaryAction: "Cancel",
          canRun: true,
          attempt: 1,
          latestStartedAt: null,
          latestFinishedAt: null,
          appWorkflowOutcome: null,
          events: [],
          progressPercent: 0,
          progressText: "Preparing",
          workflowProgress: null,
          humanSession: null,
          humanAssistanceContract: null,
        }
        : task),
    };
  }

  async function openExternalPrerequisite(prerequisiteId: string) {
    try {
      actionError = "";
      await window.octopusBeak.automation.openExternalPrerequisite(prerequisiteId);
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    }
  }

  async function openSetupGuideLink(groupId: string, linkId: string) {
    try {
      actionError = "";
      await window.octopusBeak.automation.openSetupGuideLink(groupId, linkId, $locale);
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    }
  }

  async function runParallelTasks() {
    const tasks = syncTasks;
    if (!tasks.length) return;
    syncOpen = false;
    const actionTokens: AutomationActionToken[] = [];
    for (const task of tasks) {
      const token = beginActionToken(task.id, "run");
      if (!token) continue;
      actionTokens.push(token);
      applyLocalPreparing(task.id);
      schedulePreparingTimeout(task.id);
    }
    if (!actionTokens.length) return;
    try {
      actionError = "";
      const result = await window.octopusBeak.automation.runMany(actionTokens.map((token) => token.taskId));
      if (result.errors && Object.keys(result.errors).length) {
        actionError = Object.entries(result.errors)
          .map(([taskId, message]) => `${taskLabel(tasks.find((task) => task.id === taskId) ?? tasks[0]!, $t)}: ${runStartErrorMessage(message)}`)
          .join("\n");
      }
      for (const task of tasks) {
        if (result.results[task.id]?.status !== "error") continue;
        const token = actionTokens.find((candidate) => candidate.taskId === task.id);
        if (token) failActionToken(token);
        const timeout = preparingTimeouts.get(task.id);
        if (timeout) clearTimeout(timeout);
        preparingTimeouts.delete(task.id);
      }
      for (const token of actionTokens) {
        const resultTask = result.results[token.taskId];
        if (resultTask?.runId) runtimeController?.bindRun(token, resultTask.runId);
      }
      if (result.runtime) applyAuthoritativeRuntimeSnapshot(result.runtime);
      await reload();
    } catch (error) {
      for (const token of actionTokens) {
        failActionToken(token);
        const task = tasks.find((candidate) => candidate.id === token.taskId);
        if (!task) continue;
        const timeout = preparingTimeouts.get(task.id);
        if (timeout) clearTimeout(timeout);
        preparingTimeouts.delete(task.id);
      }
      actionError = error instanceof Error ? error.message : String(error);
    }
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

  async function forceTerminateTask(task: AutomationTaskRow) {
    if (!confirm($t.automation.confirmForceQuit)) return;
    const token = beginActionToken(task.id, "force-terminate");
    if (!token) return;
    try {
      actionError = "";
      await window.octopusBeak.automation.forceTerminate(task.id);
      await reload();
    } catch (error) {
      failActionToken(token);
      actionError = error instanceof Error ? error.message : String(error);
    }
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

  async function primaryTaskAction(task: AutomationTaskRow) {
    if (task.primaryAction === "Configure") {
      openCredentials();
      selectCredentialGroup(task.credentialGroupId ?? "");
      await tick();
      document.getElementById(`${selectedCredentialGroupId}-statement-selection`)?.focus();
      return;
    }
    if (task.primaryAction !== "Cancel") {
      await runTask(task);
      return;
    }
    if (!confirm($t.automation.confirmCancel(taskLabel(task, $t)))) return;
    const token = beginActionToken(task.id, "cancel");
    if (!token) return;
    try {
      actionError = "";
      if (task.status === "waiting_for_human") await window.octopusBeak.automation.forceTerminate(task.id);
      else await window.octopusBeak.automation.cancel(task.id);
      await reload();
    } catch (error) {
      failActionToken(token);
      actionError = error instanceof Error ? error.message : String(error);
    }
  }

  async function openRunHistory() {
    historyOpen = true;
    historyLoading = true;
    historySearch = "";
    historyFilter = "all";
    try {
      actionError = "";
      historyRows = await window.octopusBeak.automation.runHistory();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      historyLoading = false;
    }
  }

  function historyStatusGroup(status: AutomationTaskHistoryRow["status"]): "running" | "completed" | "failed" {
    if (status === "completed" || status === "partial") return "completed";
    if (status === "failed" || status === "locked") return "failed";
    return "running";
  }

  function formatDuration(run: AutomationTaskHistoryRow) {
    const start = Date.parse(run.startedAt);
    const end = Date.parse(run.finishedAt ?? new Date().toISOString());
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "--";
    const seconds = Math.max(0, Math.floor((end - start) / 1_000));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function filterHistoryToCurrentTasks(
    rows: readonly AutomationTaskHistoryRow[],
    tasks: readonly AutomationTaskRow[],
  ) {
    const catalogTaskIds = new Set(tasks.map((task) => task.id));
    return rows.filter((run) => catalogTaskIds.has(run.taskId));
  }

  async function saveCredentials(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmitCredentials(onboardingSourceSelection, onboardingCredentialsReady)) return;
    if (credentialChanges.editor) return;
    const setupInput = credentialSetupInput(credentialGroups, credentialChanges);
    const invalid = firstInvalidCredentialGroup(
      credentialGroups,
      setupInput.enabled,
      setupInput.statementSelections,
    );
    if (invalid) {
      credentialSearch = "";
      selectedCredentialGroupId = invalid.id;
      actionError = "";
      const invalidDisplayGroup = credentialGroups.find((group) => group.id === invalid.id);
      statementSelectionError = $t.automation.selectOneStatementType(
        invalidDisplayGroup ? credentialGroupName(invalidDisplayGroup) : invalid.label,
      );
      await tick();
      document.getElementById(`${invalid.id}-statement-selection`)?.focus();
      return;
    }
    statementSelectionError = "";
    const plan = buildCredentialSetupPlan({
      groups: credentialGroups,
      enabled: setupInput.enabled,
      statementSelections: setupInput.statementSelections,
      credentialDrafts: setupInput.credentialDrafts,
      selectedCredentialGroupId,
      onboardingSingleSource,
      collectionGroupIds,
    });
    try {
      actionError = "";
      const savedGroupId = plan.selectedCredentialGroupId;
      const result = await window.octopusBeak.automation.saveCredentials(plan.updates);
      if (!result.saved) {
        credentialFileErrors = {
          ...credentialFileErrors,
          [result.credentialKey]: certificateFileValidationMessage(result.reason, false),
        };
        return;
      }
      resetCredentialChanges();
      await reload();
      if (onboardingSourceSelection && savedGroupId) {
        onOnboardingStoryEvent({
          type: "source-saved",
          credentialGroupId: savedGroupId,
          configuredAt: new Date().toISOString(),
        });
        credentialsOpen = false;
        const selectedTask = automation.tasks.find(
          (task) => task.credentialGroupId === savedGroupId,
        );
        if (selectedTask?.canRun) {
          await runTask(selectedTask);
        }
      } else {
        credentialsOpen = false;
      }
    } catch {
      actionError = $t.automation.saveCredentialsFailed;
    }
  }

  function taskIdLabel(taskId: string, dictionary: Translation) {
    return (dictionary.automation.taskLabels as Record<string, string>)[taskId] ?? taskId;
  }

  function taskLabel(task: AutomationTaskRow, dictionary: Translation) {
    return (dictionary.automation.taskLabels as Record<string, string>)[task.id] ?? task.label;
  }

  function taskStatusLabel(task: AutomationTaskRow, dictionary: Translation) {
    if (task.status === "waiting_for_human") {
      return dictionary.automation.progressAutomaticVerification;
    }
    return dictionary.automation.statusLabels[task.status];
  }

  function workflowProgressStageLabel(
    task: AutomationTaskRow,
    dictionary: Translation,
  ): string | null {
    const phaseCode = task.workflowProgress?.phaseCode;
    if (!phaseCode?.startsWith("workflow-")) return null;
    const stage = phaseCode.slice("workflow-".length);
    if (![
      "preparation",
      "authentication",
      "collection",
      "decoding",
      "validation",
      "commit",
      "finalization",
    ].includes(stage)) return null;

    if (stage === "collection") {
      const activity = task.workflowProgress?.params?.activity;
      const statementType = task.workflowProgress?.params?.statementType;
      const product = typeof statementType === "string"
        ? dictionary.automation.statementTypeLabels[statementType] ?? statementType
        : null;
      if (activity === "query") {
        return product
          ? dictionary.automation.progressQueryingProduct(product)
          : dictionary.automation.progressQuerying;
      }
      if (activity === "download") {
        return product
          ? dictionary.automation.progressDownloadingProduct(product)
          : dictionary.automation.progressDownloading;
      }
      return product
        ? dictionary.automation.progressStageProduct(dictionary.automation.progressStages[stage], product)
        : dictionary.automation.progressStages[stage] ?? null;
    }

    const stageLabel = dictionary.automation.progressStages[stage];
    const statementType = task.workflowProgress?.params?.statementType;
    const product = typeof statementType === "string"
      ? dictionary.automation.statementTypeLabels[statementType] ?? statementType
      : null;
    return product && stageLabel
      ? dictionary.automation.progressStageProduct(stageLabel, product)
      : stageLabel ?? null;
  }

  function workflowProgressIsWorking(task: AutomationTaskRow) {
    if (task.status === "waiting_for_human") {
      return task.isActive;
    }
    return task.isActive && ["preparing", "running", "retrying", "cancelling"].includes(task.status);
  }

  function isOnboardingProgressTask(task: AutomationTaskRow) {
    return task.id === onboardingTrackedTaskId
      && [
        "collection-progress",
        "collection-failed",
        "workflow-review",
        "overview-preparing",
        "overview-preparation-failed",
      ].includes(onboardingNodeId ?? "");
  }

  function shouldShowWorkflowProgress(task: AutomationTaskRow) {
    const terminal = ["completed", "partial", "failed", "cancelled", "interrupted"].includes(task.status);
    return workflowProgressIsWorking(task)
      || (task.isActive && task.status === "waiting_for_human")
      || (terminal && (task.status !== "completed" || isOnboardingProgressTask(task)));
  }

  function shouldShowProgressStatus(task: AutomationTaskRow) {
    return ["waiting_for_human", "cancelling"].includes(task.status);
  }

  function workflowEventFailureLabel(event: AutomationTaskRow["events"][number]): string | null {
    const reason = verificationFailureEventReason(event);
    if (reason === "verification-solver-exhausted") {
      return $t.automation.verificationSolverExhausted;
    }
    return reason ? $t.automation.cathayOtpFailureReasons[reason] : null;
  }

  function progressLabel(task: AutomationTaskRow, dictionary: Translation) {
    if (task.status === "waiting_for_human") {
      const waiting = dictionary.automation.progressAutomaticVerification;
      return task.progressPercent === null
        ? waiting
        : dictionary.automation.progressWaitingWithPercent(waiting, task.progressPercent);
    }
    if (["completed", "partial", "failed", "cancelled", "interrupted"].includes(task.status)) {
      return task.progressPercent === null
        ? taskStatusLabel(task, dictionary)
        : dictionary.automation.progressTerminalWithPercent(
            taskStatusLabel(task, dictionary),
            task.progressPercent,
          );
    }
    const stage = workflowProgressStageLabel(task, dictionary);
    if (stage) {
      const stageWithProgress = task.progressPercent === null
        ? stage
        : dictionary.automation.progressStagePercent(stage, task.progressPercent);
      const retrying = task.status === "retrying" || task.workflowProgress?.params?.retrying === true;
      return retrying
        ? dictionary.automation.progressRetryingStage(
          stageWithProgress,
          task.attempt || 1,
          task.maxAttempts,
        )
        : stageWithProgress;
    }
    if (task.status === "preparing") {
      return dictionary.automation.progressStagePercent(
        dictionary.automation.progressStages.preparation,
        task.progressPercent ?? 0,
      );
    }
    if (task.progressPercent !== null) return `${task.progressPercent}%`;
    if (task.status === "running") return dictionary.automation.progressRunning(task.attempt || 1, task.maxAttempts);
    if (task.status === "retrying") return dictionary.automation.progressRetrying(task.attempt || 1, task.maxAttempts);
    if (task.status === "completed") return dictionary.automation.progressCompleted;
    if (task.status === "partial") return dictionary.automation.progressPartial;
    if (task.status === "failed") return dictionary.automation.progressFailed;
    if (task.status === "needs_setup") return dictionary.automation.progressNeedsSetup;
    return dictionary.automation.progressQueued;
  }
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
  titleHidden
>
  <svelte:fragment slot="topbar-actions">
    <button
      class="button secondary topbar-action"
      type="button"
      use:registerOnboardingTarget={{
        registry: onboardingTargets,
        id: onboardingSourceSelection
        && onboardingNodeId === "source-entry"
        && !credentialsOpen
          ? "automation.credentials"
          : null,
      }}
      onclick={openCredentialsFromStoryEntry}
    >
      {$t.automation.credentials}
    </button>
    <button class="button secondary topbar-action" type="button" onclick={() => void openRunHistory()}>
      {$t.automation.runHistory}
    </button>
  </svelte:fragment>

  <div class:sync-sheet-open={syncOpen} class="content automation-content">
    <ProgressiveBlock label="summary" state={blockState(blocks, "summary")} retry={() => retryBlock("summary")} let:data>
    {@const summaryAutomation = resolveAutomationBlock(automation, automationBlockData("summary", data), runtimeSnapshot, renderedPendingActions)}
    <section class:active={summaryAutomation.active} class="card sync-hero" aria-label={$t.automation.commandCenter}>
      <div class="sync-hero-copy">
        {#if summaryAutomation.active}
          <span class="running-kicker"><CloudDownload size={16} strokeWidth={2.2} aria-hidden="true" />{$t.automation.syncInProgress}</span>
        {/if}
        <h2>
          {summaryAutomation.active
            ? $t.automation.runningTaskHeading(summaryAutomation.activeTaskCount)
            : $t.automation.startSyncHeading}
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
                  class:sync-task={task.kind === "sync"}
                  type="button"
                  aria-label={`${$t.automation.runDetails} · ${taskLabel(task, $t)}`}
                  aria-describedby={hoveredTask?.id === task.id ? "active-task-tooltip" : undefined}
                  title={taskLabel(task, $t)}
                  onpointerenter={(event) => showTaskTooltip(task, event)}
                  onpointerleave={hideTaskTooltip}
                  onfocus={(event) => showTaskTooltip(task, event)}
                  onblur={hideTaskTooltip}
                  onclick={() => void revealTaskDetails(task)}
                >
                  {#if task.status === "waiting_for_human"}
                    <CircleEllipsis size={22} strokeWidth={2.2} aria-hidden="true" />
                  {:else if sourceLogoForTask(task.id)}
                    <InstitutionLogo institution={sourceLogoForTask(task.id)} size={22} />
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
      {#if automation.active}
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
    {@const detailsAutomation = resolveAutomationBlock(automation, automationBlockData("details", data), runtimeSnapshot, renderedPendingActions)}
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
                    <span>{task ? taskLabel(task, $t) : notice.taskId}</span>
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
    {@const listAutomation = resolveAutomationBlock(automation, automationBlockData("list", data), runtimeSnapshot, renderedPendingActions)}
    {@const listTaskStages = taskStagesFor(automation, automationBlockData("list", data), runtimeSnapshot, renderedPendingActions)}
    {@const listParallelTaskIds = new Set(listAutomation.parallelRunnableTaskIds)}
    {@const multiStage = listTaskStages.length > 1}
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
                  onclick={() => dispatchAutomationStageSync(
                    stage.tasks,
                    (tasks) => openSyncSheet(tasks, listParallelTaskIds),
                  )}
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
              <div class="table-wrap">
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
              <tr class="task-row" class:task-active={task.isActive} class:task-attention={statusClass(task.status) === "bad"} id={`${task.id}-task-row`}>
                <td>
                  <div class="task-name">
                    <span class="task-logo"><InstitutionLogo institution={sourceLogoForTask(task.id)} /></span>
                    <strong>{taskLabel(task, $t)}</strong>
                  </div>
                </td>
                <td class="credential-state">
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
                <td class="mono latest-time">{latestTaskTime(task)}</td>
                <td>
                  {#if shouldShowWorkflowProgress(task)}
                  <div
                    class="progress-cell"
                    use:registerOnboardingTarget={{
                      registry: onboardingTargets,
                      id: isOnboardingProgressTask(task) ? "automation.progress" : null,
                    }}
                  >
                    <div
                      class="progress-bar"
                      class:working={workflowProgressIsWorking(task)}
                      role="progressbar"
                      aria-valuemin="0"
                      aria-valuemax="100"
                      aria-valuenow={task.progressPercent ?? undefined}
                      aria-valuetext={progressLabel(task, $t)}
                      aria-label={taskLabel(task, $t)}
                      aria-busy={workflowProgressIsWorking(task)}
                    >
                      <span style={`width: ${task.progressPercent ?? 0}%`}></span>
                    </div>
                    <div class="progress-description">
                      <span class="progress-copy" data-status={task.status}>{progressLabel(task, $t)}</span>
                      {#if shouldShowProgressStatus(task)}
                        <span class={`chip ${statusClass(task.status)}`}>{taskStatusLabel(task, $t)}</span>
                      {/if}
                    </div>
                    {#if ["failed", "cancelled"].includes(task.status) && task.appWorkflowOutcome?.errorCode}
                      <div class="workflow-failure-summary" role="status">
                        <code>{task.appWorkflowOutcome.errorCode}</code>
                        {#if workflowFailureExplanation(task.appWorkflowOutcome.errorCode, $locale)}
                          <span>{workflowFailureExplanation(task.appWorkflowOutcome.errorCode, $locale)}</span>
                        {/if}
                        {#if task.appWorkflowOutcome.errorCode === "device-registration-required"}
                          <button class="button secondary tdcc-registration-action" type="button" onclick={() => void openTdccDeviceRegistration()}>
                            {$t.automation.tdccDevice.openSettings}
                          </button>
                        {/if}
                      </div>
                    {/if}
                  </div>
                  {:else}
                  <span class={`chip ${statusClass(task.status)}`}>
                    {taskStatusLabel(task, $t)}
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
                      aria-label={`${$t.automation.runDetails} · ${taskLabel(task, $t)}`}
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
                <tr class="inline-run-details-row" class:jump-highlight={jumpHighlightTaskId === task.id} id={`${task.id}-run-details`}>
                  <td colspan="5">
                    <div class="inline-run-details" tabindex="-1" transition:disclosureSlide>
                      <div class="inline-run-details-head">
                        <strong>{$t.automation.workflowEventTitle(taskLabel(task, $t))}</strong>
                        <span class={`chip ${statusClass(task.status)}`}>{progressLabel(task, $t)}</span>
                      </div>
                      {#if task.appWorkflowOutcome?.errorCode}
                        {@const cathayOtpFailure = cathayEmailOtpFailureReason(task.events)}
                        {@const solverExhausted = verificationSolverExhausted(task.events)}
                        <div class="workflow-outcome-error">
                          <code>{task.appWorkflowOutcome.errorCode}</code>
                          {#if cathayOtpFailure}
                            <span>{$t.automation.cathayOtpFailureReasons[cathayOtpFailure]}</span>
                            {#if cathayOtpReasonNeedsGmailSettings(cathayOtpFailure)}
                              <button
                                class="button secondary cathay-gmail-settings-action"
                                type="button"
                                onclick={() => void openCathayGmailOtpSettings()}
                              >
                                {$t.automation.cathayGmailOtpSettingsAction}
                              </button>
                            {/if}
                          {:else if task.appWorkflowOutcome.errorCode === "device-registration-required"}
                            <span>{workflowFailureExplanation(task.appWorkflowOutcome.errorCode, $locale)}</span>
                            <button class="button secondary tdcc-registration-action" type="button" onclick={() => void openTdccDeviceRegistration()}>
                              {$t.automation.tdccDevice.openSettings}
                            </button>
                          {:else if solverExhausted}
                            <span>{$t.automation.verificationSolverExhausted}</span>
                          {:else if task.appWorkflowOutcome.errorCode === "source-access-challenged"}
                            <span>{$locale === "zh-TW"
                              ? "來源網站以安全驗證或 HTTP 403 阻擋登入，未取得登入表單。請確認網站可正常開啟後再重試。"
                              : "The provider blocked sign-in with a security challenge or HTTP 403. The login form was unavailable; check the site before retrying."}</span>
                          {:else if task.appWorkflowOutcome.errorCode === "source-unavailable"}
                            <span>{$locale === "zh-TW"
                              ? "來源網站未提供可用的登入表單（系統忙碌或空白回應）。請稍後重試。"
                              : "The provider did not return a usable login form (busy or blank response). Try again later."}</span>
                          {:else if workflowFailureExplanation(task.appWorkflowOutcome.errorCode, $locale)}
                            <span>{workflowFailureExplanation(task.appWorkflowOutcome.errorCode, $locale)}</span>
                          {/if}
                        </div>
                      {/if}
                      {#if task.appWorkflowOutcome?.summary}
                        <div class="workflow-outcome-summary" aria-label={$t.automation.workflowOutcomeSummary}>
                          {#if task.appWorkflowOutcome.summary.status}
                            <span>{task.appWorkflowOutcome.summary.status}</span>
                          {/if}
                          {#each task.id === "sync-tdcc" ? countsOutsideTdccExclusions(task.appWorkflowOutcome.summary.counts) : Object.entries(task.appWorkflowOutcome.summary.counts) as count}
                            <span>{count[0]}: {count[1]}</span>
                          {/each}
                        </div>
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
                        <ul class="workflow-product-results" aria-label={$t.automation.productResults}>
                          {#each task.appWorkflowOutcome.summary.products as product (product.typeId)}
                            <li class="workflow-product-row">
                              <strong class="workflow-product-name">
                                {$t.automation.statementTypeLabels[product.typeId] ?? product.typeId}
                              </strong>
                              <div class="workflow-product-details">
                                <span class="workflow-product-status" data-status={product.status}>
                                  {$t.automation.productOutcomeStatuses[product.status]}
                                </span>
                                {#if product.status === "skipped" && product.skipReason}
                                  <span class="workflow-product-note">
                                    {$t.automation.productSkipReasons[product.skipReason]}
                                  </span>
                                {/if}
                                {#if product.status === "failed" && product.committedCount > 0}
                                  <span class="workflow-product-retained">
                                    {$t.automation.productRetainedCount(product.committedCount)}
                                  </span>
                                {/if}
                                {#if product.errorCode}
                                  {@const productFailure = workflowFailureExplanation(product.errorCode, $locale)}
                                  {#if productFailure}
                                    <span class="workflow-product-note">{productFailure}</span>
                                  {/if}
                                  <code>{product.errorCode}</code>
                                {/if}
                              </div>
                            </li>
                          {/each}
                        </ul>
                      {/if}
                      {#if task.events.length}
                        <ol class="workflow-event-list" aria-label={$t.automation.workflowEventTitle(taskLabel(task, $t))}>
                          {#each task.events as event, index (index)}
                            {@const failureLabel = workflowEventFailureLabel(event)}
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
    <span>{taskStageTitle(hoveredTask, $t)} · {taskStatusLabel(hoveredTask, $t)}</span>
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
    <button class="modal-backdrop" type="button" aria-label={$t.automation.closeCredentials} disabled={onboardingSourceSelection} onclick={closeCredentials}></button>
    <form
      class="modal-panel credential-modal"
      onsubmit={saveCredentials}
      use:registerOnboardingTarget={{
        registry: onboardingTargets,
        id: onboardingSourceSelection && onboardingNodeId === "credentials"
          ? "automation.credentials"
          : null,
      }}
    >
      <div class="modal-head credential-modal-head">
        <span class="credential-head-icon" aria-hidden="true"><KeyRound size={20} /></span>
        <div class="credential-head-copy">
          <h2 id="credentials-title">{$t.automation.credentialsTitle}</h2>
          <p>{$t.automation.credentialsSummary(savedEnabledGroupCount)}</p>
        </div>
        {#if !onboardingSourceSelection}
          <button class="modal-close" type="button" aria-label={$t.common.close} onclick={closeCredentials}><X size={20} /></button>
        {/if}
      </div>
      <div class="modal-body credential-layout">
        <aside
          class="credential-provider-list"
          use:registerOnboardingTarget={{
            registry: onboardingTargets,
            id: onboardingSourceSelection && onboardingNodeId === "source-selection"
              ? "automation.credentials"
              : null,
          }}
        >
          <label class="modal-search">
            <Search size={16} />
            <input value={credentialSearch} oninput={updateCredentialSearch} placeholder={$t.automation.credentialSearch} />
          </label>
          <nav aria-label={$t.automation.credentialsTitle} tabindex="-1">
            {#if railEnabledGroups.length}
              <h3 class="rail-heading"><span>{$t.automation.credentialGroupsEnabled}</span><span class="tabular">{railEnabledGroups.length}</span></h3>
              <ul class="rail-list">
                {#each railEnabledGroups as group (group.id)}
                  {@const syncStatus = credentialGroupSyncStatus(group, automation, $t)}
                  <li>
                    <button
                      type="button"
                      class="rail-row"
                      class:selected={group.id === selectedCredentialGroupId}
                      aria-current={group.id === selectedCredentialGroupId ? "true" : undefined}
                      onclick={() => chooseCredentialGroup(group.id)}
                    >
                      <InstitutionLogo institution={sourceLogo(group.id)} size={24} />
                      <span class="rail-row-copy">
                        <strong>{credentialGroupName(group)}</strong>
                        {#if syncStatus}
                          <span class="rail-status" data-tone={syncStatus.tone}>
                            <span class="status-dot" aria-hidden="true"></span>
                            {syncStatus.label}{#if syncStatus.time}<span class="tabular"> · {syncStatus.time}</span>{/if}
                          </span>
                        {/if}
                      </span>
                      {#if group.id === selectedCredentialGroupId}<ChevronRight size={16} aria-hidden="true" />{/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if railAvailableGroups.length}
              <h3 class="rail-heading"><span>{$t.automation.credentialGroupsAvailable}</span><span class="tabular">{railAvailableGroups.length}</span></h3>
              <ul class="rail-list">
                {#each railAvailableGroups as group (group.id)}
                  <li class="rail-available">
                    <button
                      type="button"
                      class="rail-row"
                      class:selected={group.id === selectedCredentialGroupId}
                      aria-current={group.id === selectedCredentialGroupId ? "true" : undefined}
                      onclick={() => chooseCredentialGroup(group.id)}
                    >
                      <InstitutionLogo institution={sourceLogo(group.id)} size={24} />
                      <span class="rail-row-copy"><strong>{credentialGroupName(group)}</strong></span>
                    </button>
                    <button
                      type="button"
                      class="rail-add"
                      aria-label={$t.automation.enableCredentialGroup(credentialGroupName(group))}
                      title={$t.automation.enableCredentialGroup(credentialGroupName(group))}
                      onclick={() => enableAndSelectGroup(group.id)}
                    ><Plus size={14} /></button>
                  </li>
                {/each}
              </ul>
            {/if}
          </nav>
        </aside>
        {#if selectedCredentialGroup && (!onboardingSourceSelection || credentialPresentation === "details")}
          {@const group = selectedCredentialGroup}
          {@const groupOn = effectiveGroupEnabled(credentialGroups, credentialChanges, group.id)}
          {@const selectedTypes = effectiveStatementSelection(credentialGroups, credentialChanges, group.id)}
          <section class="credential-body" aria-labelledby={`${group.id}-credentials-title`}>
            <div class="credential-section-head">
              <InstitutionLogo institution={sourceLogo(group.id)} size={40} />
              <div class="credential-title">
                <h3 id={`${group.id}-credentials-title`}>{credentialGroupName(group)}</h3>
                {#if credentialGroupAltName(group)}<p>{credentialGroupAltName(group)}</p>{/if}
              </div>
              <button
                class="switch credential-switch"
                class:dirty={group.id in credentialChanges.enabled}
                type="button"
                aria-pressed={groupOn}
                onclick={() => toggleGroup(group.id)}
              >
                <span>{$t.automation.credentialSyncToggle}</span>
                <span class="switch-track" aria-hidden="true"></span>
              </button>
            </div>

            {#if groupOn && selectedGroupTask && (selectedGroupTask.isActive || selectedGroupTask.latestStartedAt || selectedGroupTask.latestFinishedAt)}
              {@const syncTask = selectedGroupTask}
              {@const syncStatus = taskRunStatus(syncTask, $t)}
              {@const summary = lastSyncSummary(syncTask, $t)}
              <div class="last-sync" data-tone={syncTask.isActive ? "active" : syncStatus.tone} aria-live="polite">
                <span class="last-sync-icon" aria-hidden="true">
                  {#if syncTask.isActive}<span class="spinner"></span>{:else}<CircleAlert size={16} />{/if}
                </span>
                <div class="last-sync-copy">
                  <strong>
                    {#if syncTask.isActive}
                      {$t.automation.credentialSyncStatuses.running}
                    {:else}
                      {$t.automation.lastSync(syncStatus.time, syncStatus.label)}
                    {/if}
                  </strong>
                  {#if syncTask.isActive && syncTask.progressText}
                    <span>{syncTask.progressText}</span>
                  {:else if !syncTask.isActive && summary}
                    <span>{summary}</span>
                  {/if}
                </div>
                {#if !syncTask.isActive}
                  <button
                    class="button"
                    type="button"
                    disabled={!syncTask.canRun || pendingTaskIds.has(syncTask.id) || appPendingTaskIds.has(syncTask.id) || (syncTask.id === "sync-tdcc" && tdccRegistering)}
                    onclick={() => void runTask(syncTask)}
                  ><RefreshCw size={14} />{$t.automation.resync}</button>
                {/if}
              </div>
            {/if}

            <section class="credential-block" aria-labelledby={`${group.id}-fields-title`}>
              <h4 id={`${group.id}-fields-title`}>{$t.automation.credentialsTitle}</h4>
              <ul class="credential-fields">
                {#each group.credentialFields as credentialField (credentialField.key)}
                  {@const key = credentialField.key}
                  {@const fieldLabel = localizedText(credentialField.label)}
                  {@const staged = credentialChanges.credentials[key]}
                  {@const storedState = credentialState(key)}
                  {#if credentialField.input === "certificate-file"}
                    {@const selectedFileName = staged?.kind === "file" ? staged.filename : group.storedCredentialFileNames[key]}
                    {@const storedFileError = group.invalidCredentialFileReasons?.[key]
                      ?? (group.invalidCredentialFileKeys.includes(key) ? "missing-or-unreadable" : undefined)}
                    <li class="credential-row" class:dirty={Boolean(staged)}>
                      <span class="credential-label">{fieldLabel}</span>
                      <span class="credential-value file-name">{selectedFileName ?? $t.automation.credentialNotSet}</span>
                      <span class="credential-row-meta">
                        {#if staged}
                          <span class="credential-badge staged">{$t.automation.credentialStaged}</span>
                          <button class="text-action" type="button" onclick={() => (credentialChanges = revertCredential(credentialChanges, key))}>{$t.automation.credentialRevert}</button>
                        {:else}
                          <button
                            id={`credential-input-${key}`}
                            class="text-action"
                            type="button"
                            onclick={() => void selectCertificateFile(key)}
                          >{selectedFileName ? $t.automation.chooseAnotherCertificateFile : $t.automation.chooseCertificateFile}</button>
                        {/if}
                      </span>
                      {#if !staged && storedFileError}
                        <p class="credential-error file-error">{certificateFileValidationMessage(storedFileError, true)}</p>
                      {/if}
                      {#if credentialFileErrors[key]}
                        <p class="credential-error file-error" aria-live="polite">{credentialFileErrors[key]}</p>
                      {/if}
                    </li>
                  {:else if credentialChanges.editor?.key === key}
                    <li class="credential-row editing">
                      <label class="credential-label" for={`credential-input-${key}`}>{fieldLabel}</label>
                      <span class="credential-editor-input">
                        <KeyRound size={16} aria-hidden="true" />
                        <input
                          id={`credential-input-${key}`}
                          name={key}
                          type={credentialField.input}
                          value={credentialInputValue(
                            credentialChanges.editor.draft,
                            credentialField.redaction,
                            focusedCredentialKey === key,
                          )}
                          use:focusOnMount
                          onfocus={(event) => focusCredentialInput(key, credentialField.redaction, event)}
                          onblur={(event) => blurCredentialInput(key, credentialField.redaction, event)}
                          oninput={updateEditorDraft}
                          onkeydown={confirmCredentialEditOnEnter}
                          aria-describedby={`credential-help-${key}`}
                          autocomplete="off"
                        />
                      </span>
                      <div class="credential-editor-foot">
                        <p id={`credential-help-${key}`}><Info size={14} aria-hidden="true" />{$t.automation.credentialEditorHelp(fieldLabel)}</p>
                        <button class="button" type="button" onclick={cancelCredentialEdit}>{$t.common.cancel}</button>
                        <button
                          class="button primary"
                          type="button"
                          disabled={!credentialChanges.editor.draft.trim()}
                          onclick={confirmCredentialEdit}
                        >{$t.automation.confirmCredentialUpdate}</button>
                      </div>
                    </li>
                  {:else if storedState === "missing"}
                    <li class="credential-row" class:dirty={Boolean(staged)}>
                      <label class="credential-label" for={`credential-input-${key}`}>{fieldLabel}</label>
                      <input
                        id={`credential-input-${key}`}
                        class="credential-inline-input"
                        name={key}
                        type={credentialField.input}
                        value={credentialInputValue(
                          credentialFieldText(key),
                          credentialField.redaction,
                          focusedCredentialKey === key,
                        )}
                        onfocus={(event) => focusCredentialInput(key, credentialField.redaction, event)}
                        onblur={(event) => blurCredentialInput(key, credentialField.redaction, event)}
                        oninput={(event) => updateCredentialDraft(key, event)}
                        placeholder={$t.automation.credentialNotSet}
                        autocomplete="off"
                      />
                      <span class="credential-row-meta">
                        {#if staged}<span class="credential-badge staged">{$t.automation.credentialTyped}</span>{/if}
                      </span>
                    </li>
                  {:else}
                    <li class="credential-row" class:dirty={Boolean(staged)}>
                      <span class="credential-label">{fieldLabel}</span>
                      <span class="credential-value">
                        {#if storedState === "loading"}
                          <span class="muted-text">{$t.common.loading}</span>
                        {:else}
                          <span class="mask" aria-hidden="true">••••••••</span>
                          <span class="visually-hidden">{$t.automation.credentialHiddenValue}</span>
                        {/if}
                      </span>
                      <span class="credential-row-meta">
                        {#if staged}
                          <span class="credential-badge staged">{$t.automation.credentialStaged}</span>
                          <button class="text-action" type="button" onclick={() => (credentialChanges = revertCredential(credentialChanges, key))}>{$t.automation.credentialRevert}</button>
                        {:else}
                          {#if storedState === "read_failed"}
                            <span class="credential-badge bad">{$t.automation.credentialReadFailed}</span>
                          {:else if storedState === "ready"}
                            <span class="credential-badge good"><Lock size={12} aria-hidden="true" />{$t.automation.credentialSaved}</span>
                          {/if}
                          <button
                            id={`credential-input-${key}`}
                            class="text-action"
                            type="button"
                            disabled={storedState === "loading"}
                            onclick={() => startCredentialEdit(group.id, key)}
                          >{$t.automation.credentialUpdate}</button>
                        {/if}
                      </span>
                    </li>
                  {/if}
                {/each}
              </ul>
            </section>

            {#if group.id === "cathay"}
              <section class="gmail-otp-settings" aria-labelledby="cathay-gmail-otp-title">
                <div class="gmail-otp-head">
                  <div>
                    <h4 id="cathay-gmail-otp-title" tabindex="-1">{$t.automation.cathayGmailOtpTitle}</h4>
                    <p>{$t.automation.cathayGmailOtpDescription}</p>
                  </div>
                  <span class="chip good">{$t.automation.cathayGmailOtpAlwaysAutomatic}</span>
                </div>
                <p class="gmail-otp-status" aria-live="polite">
                  {#if cathayGmailOtpStatus.needsAuthorization}
                    {$t.automation.cathayGmailOtpNeedsAuthorization}
                  {:else if cathayGmailOtpStatus.connectedEmail}
                    {$t.automation.cathayGmailOtpConnected(cathayGmailOtpStatus.connectedEmail)}
                  {:else}
                    {$t.automation.cathayGmailOtpNotConnected}
                  {/if}
                </p>
                <div class="gmail-otp-actions">
                  {#if !cathayGmailOtpStatus.connectedEmail}
                    <button
                      class="button secondary"
                      type="button"
                      disabled={cathayGmailOtpBusy}
                      onclick={() => void enableCathayGmailOtp()}
                    >
                      {#if cathayGmailOtpBusy}<span class="spinner" aria-hidden="true"></span>{/if}
                      {$t.automation.cathayGmailOtpConnect}
                    </button>
                  {:else if cathayGmailOtpStatus.needsAuthorization}
                    <button
                      class="button secondary"
                      type="button"
                      disabled={cathayGmailOtpBusy}
                      onclick={() => void enableCathayGmailOtp()}
                    >
                      {#if cathayGmailOtpBusy}<span class="spinner" aria-hidden="true"></span>{/if}
                      {$t.automation.cathayGmailOtpReconnect}
                    </button>
                  {/if}
                  {#if cathayGmailOtpStatus.connectedEmail}
                    <button
                      class="button secondary"
                      type="button"
                      disabled={cathayGmailOtpBusy}
                      onclick={() => void disconnectCathayGmailOtp()}
                    >
                      {$t.automation.cathayGmailOtpDisconnect}
                    </button>
                  {/if}
                </div>
                {#if cathayGmailOtpError}
                  <p class="credential-error" aria-live="polite">{cathayGmailOtpError}</p>
                {/if}
              </section>
            {/if}

            {#if group.id === "tdcc"}
              <TdccDeviceRegistration
                signInDetailsSaved={group.credentialFields.every((credentialField) =>
                  credentialState(credentialField.key) === "ready" && !credentialChanges.credentials[credentialField.key])}
                syncActive={Boolean(selectedGroupTask?.isActive)}
                sourceEnabled={groupOn}
                bind:registering={tdccRegistering}
              />
            {/if}

            {#if group.statementTypes?.length}
              <fieldset
                class="statement-selection"
                id={`${group.id}-statement-selection`}
                tabindex="-1"
                aria-describedby={statementSelectionError ? `${group.id}-statement-error` : undefined}
              >
                <legend class="visually-hidden">{$t.automation.statementsToCollect}</legend>
                <div class="statement-selection-head" aria-hidden="true">
                  <h4>{$t.automation.statementsToCollect}</h4>
                  <span class="statement-count tabular">{$t.automation.selectedStatementCount(selectedTypes.length, group.statementTypes.length)}</span>
                </div>
                <ul class="statement-type-list">
                  {#each group.statementTypes as type (type.id)}
                    {@const checked = selectedTypes.includes(type.id)}
                    {@const lastResult = statementLastResult(selectedGroupTask, type.id, $t)}
                    <li>
                      <label class="statement-type-option">
                        <input
                          type="checkbox"
                          {checked}
                          aria-describedby={statementSelectionError ? `${group.id}-statement-error` : undefined}
                          aria-invalid={statementSelectionError ? "true" : undefined}
                          onchange={() => toggleStatementType(group.id, type.id)}
                        />
                        <span class="statement-type-name">{$t.automation.statementTypeLabels[type.id] ?? type.id}</span>
                        {#if !checked}
                          <span class="statement-result" data-tone="muted">{$t.automation.productSkipReasons.not_selected}</span>
                        {:else if lastResult}
                          <span class="statement-result" data-tone={lastResult.tone}>{lastResult.text}</span>
                        {/if}
                      </label>
                    </li>
                  {/each}
                </ul>
                <div class="statement-selection-foot">
                  <p
                    id={`${group.id}-statement-error`}
                    class="credential-error statement-selection-error"
                    aria-live="polite"
                  >{statementSelectionError}</p>
                  {#if selectedTypes.length < group.statementTypes.length}
                    <button type="button" class="text-action" onclick={() => selectAllStatementTypes(group)}>
                      {$t.automation.selectAllStatements}
                    </button>
                  {/if}
                </div>
              </fieldset>
            {/if}

            <section class="setup-guide" class:open={setupGuideOpen} aria-labelledby={`${group.id}-setup-guide-title`}>
              <div class="setup-guide-head">
                <button
                  class="setup-guide-toggle"
                  type="button"
                  aria-expanded={setupGuideOpen}
                  aria-controls={`${group.id}-setup-guide-body`}
                  onclick={() => (setupGuideOpen = !setupGuideOpen)}
                >
                  <BookOpen size={16} aria-hidden="true" />
                  <span>
                    <strong id={`${group.id}-setup-guide-title`}>{$t.automation.setupGuide}</strong>
                    <span>{localizedText(group.setupGuide.summary)}</span>
                  </span>
                  <ChevronDown size={16} aria-hidden="true" />
                </button>
                {#if group.setupGuide.links[0]}
                  {@const primaryLink = group.setupGuide.links[0]}
                  <button class="text-action" type="button" onclick={() => void openSetupGuideLink(group.id, primaryLink.id)}>
                    {localizedText(primaryLink.label)}
                  </button>
                {/if}
              </div>
              {#if setupGuideOpen}
                <div class="setup-guide-body" id={`${group.id}-setup-guide-body`} transition:disclosureSlide>
                  <h5>{$t.automation.whatYouNeed}</h5>
                  <ul>
                    {#each group.setupGuide.requirements as requirement}
                      <li>{localizedText(requirement)}</li>
                    {/each}
                  </ul>
                  <h5>{$t.automation.setupSteps}</h5>
                  <ol>
                    {#each group.setupGuide.steps as step}
                      <li>{localizedText(step)}</li>
                    {/each}
                  </ol>
                  {#if group.setupGuide.links.length > 1}
                    <div class="setup-guide-links" aria-label={$t.automation.officialServices}>
                      {#each group.setupGuide.links.slice(1) as guideLink}
                        <button class="button secondary" type="button" onclick={() => void openSetupGuideLink(group.id, guideLink.id)}>
                          {localizedText(guideLink.label)}
                        </button>
                      {/each}
                    </div>
                  {/if}
                  {#if group.setupGuide.extra}
                    <div class="setup-guide-extra">
                      <h5>{localizedText(group.setupGuide.extra.title)}</h5>
                      <ol>
                        {#each group.setupGuide.extra.steps as step}
                          <li>{localizedText(step)}</li>
                        {/each}
                      </ol>
                    </div>
                  {/if}
                </div>
              {/if}
            </section>
          </section>
        {/if}
      </div>
      <div class="credential-footer" aria-live="polite">
        <p class="credential-footer-summary">
          {#if actionError}
            <span class="credential-error">{actionError}</span>
          {:else if credentialChanges.editor}
            {$t.automation.editingCredential(editorFieldLabel($t))}
          {:else if pendingChanges.length}
            <strong>{$t.automation.pendingChangeSummary(pendingChanges.length, pendingChanges.map((change) => pendingChangeLabel(change, $t)).join($t.automation.changeListSeparator))}</strong>
            {#if pendingChanges.some((change) => change.kind === "credential")}
              <span> · {$t.automation.pendingCredentialNote}</span>
            {/if}
          {:else}
            {$t.automation.noPendingChanges}
          {/if}
        </p>
        {#if !onboardingSourceSelection && !credentialChanges.editor}
          <button class="button" type="button" onclick={discardCredentialChanges}>{$t.common.cancel}</button>
        {/if}
        <button
          class="button primary"
          type="submit"
          disabled={Boolean(credentialChanges.editor)
            || !canSubmitCredentials(onboardingSourceSelection, onboardingCredentialsReady)
            || (!onboardingSourceSelection && !pendingChanges.length)}
        >{$t.automation.saveChanges}</button>
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
          <p>{$t.automation.historyTaskCount(catalogHistoryRows.length)}</p>
        </div>
        <div class="history-head-actions">
          <label class="modal-search history-search">
            <Search size={18} />
            <input bind:value={historySearch} placeholder={$t.automation.historySearch} />
          </label>
          <button class="modal-close" type="button" aria-label={$t.common.close} onclick={() => (historyOpen = false)}><X size={20} /></button>
        </div>
      </div>
      <div class="modal-body history-layout">
        <aside class="history-filters">
          <button class:selected={historyFilter === "all"} type="button" onclick={() => (historyFilter = "all")}><span>{$t.automation.historyAll}</span><strong>{catalogHistoryRows.length}</strong></button>
          <button class:selected={historyFilter === "running"} type="button" onclick={() => (historyFilter = "running")}><span>{$t.automation.historyRunning}</span><strong>{historyCounts.running}</strong></button>
          <button class:selected={historyFilter === "completed"} type="button" onclick={() => (historyFilter = "completed")}><span>{$t.automation.historyCompleted}</span><strong>{historyCounts.completed}</strong></button>
          <button class:selected={historyFilter === "failed"} type="button" onclick={() => (historyFilter = "failed")}><span>{$t.automation.historyFailed}</span><strong>{historyCounts.failed}</strong></button>
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
              {#if historyLoading}
                <tr><td colspan="5">{$t.common.loading}</td></tr>
              {/if}
              {#each visibleHistoryRows as run}
                <tr>
                  <td><div class="task-name"><span class="task-logo"><InstitutionLogo institution={sourceLogoForTask(run.taskId)} /></span><strong>{taskIdLabel(run.taskId, $t)}</strong></div></td>
                  <td><span class={`chip ${statusClass(run.status)}`}>{$t.automation.statusLabels[run.status]}</span></td>
                  <td class="mono">{formatTime(run.startedAt)}</td>
                  <td class="mono">{formatDuration(run)}</td>
                  <td class="history-error">
                    {#if run.appWorkflowOutcome?.errorCode}
                      <code>{run.appWorkflowOutcome.errorCode}</code>
                      {#if run.appWorkflowOutcome.errorCode === "source-access-challenged"}
                        <small>{$locale === "zh-TW"
                          ? "網站安全驗證阻擋登入"
                          : "Site verification blocked sign-in"}</small>
                      {:else if run.appWorkflowOutcome.errorCode === "source-unavailable"}
                        <small>{$locale === "zh-TW"
                          ? "來源網站登入頁不可用"
                          : "Provider login unavailable"}</small>
                      {:else if workflowFailureExplanation(run.appWorkflowOutcome.errorCode, $locale)}
                        <small>{workflowFailureExplanation(run.appWorkflowOutcome.errorCode, $locale)}</small>
                      {/if}
                    {:else}--{/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
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

  .inline-run-details-row td {
    padding: 0;
    background: color-mix(in oklch, var(--accent-soft) 38%, var(--surface));
    scroll-margin-top: 88px;
  }

  .inline-run-details {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-5);
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

  .workflow-event-list {
    max-height: 280px;
    margin: 0;
    padding: 0;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-soft);
    list-style: none;
  }

  .workflow-event-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    min-height: 42px;
    padding: var(--space-2) var(--space-3);
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

  .workflow-outcome-error {
    display: grid;
    justify-items: start;
    gap: var(--space-2);
    margin: 0;
    color: var(--danger);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .workflow-outcome-error code {
    font-family: var(--font-mono);
  }

  .cathay-gmail-settings-action,
  .tdcc-registration-action {
    min-height: 32px;
  }

  .workflow-failure-summary .tdcc-registration-action {
    width: fit-content;
    margin-top: var(--space-1);
  }

  .tdcc-exclusions {
    display: grid;
    gap: var(--space-1);
    color: var(--muted);
    font-size: 12px;
  }

  .tdcc-exclusions strong {
    color: var(--fg);
    font-weight: 680;
  }

  .tdcc-exclusions ul {
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
    display: grid;
    gap: 0;
    margin: 0;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-soft);
    list-style: none;
  }

  .workflow-product-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  .workflow-product-row:last-child {
    border-bottom: 0;
  }

  .workflow-product-name {
    flex: 0 0 auto;
    font-size: 13px;
  }

  .workflow-product-details {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    min-width: 0;
    color: var(--muted);
    font-size: 12px;
    text-align: right;
  }

  .workflow-product-status {
    color: var(--accent);
    font-weight: 650;
  }

  .workflow-product-status[data-status="failed"] {
    color: var(--danger);
  }

  .workflow-product-status[data-status="no_data"],
  .workflow-product-status[data-status="not_held"],
  .workflow-product-status[data-status="skipped"] {
    color: var(--muted);
  }

  .workflow-product-details code {
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .workflow-product-retained {
    color: var(--fg);
    font-weight: 550;
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
    width: min(1180px, 100%);
    height: min(760px, calc(100vh - 40px));
  }

  .history-head-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .modal-search {
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

  .modal-search:focus-within {
    border-color: var(--fg);
    box-shadow: 0 0 0 3px var(--surface-soft);
  }

  .modal-search input {
    min-width: 0;
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--fg);
  }

  .history-search {
    width: min(320px, 34vw);
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
    width: min(1040px, 100%);
    height: min(800px, calc(100vh - 40px));
    max-height: min(800px, calc(100vh - 40px));
  }

  .credential-modal-head {
    align-items: center;
    gap: var(--space-3);
  }

  .credential-head-icon {
    width: 40px;
    height: 40px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: var(--radius);
    background: var(--accent-soft);
    color: var(--accent);
  }

  .credential-head-copy {
    min-width: 0;
    flex: 1;
  }

  .credential-head-copy p {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .credential-layout {
    min-height: 0;
    flex: 1;
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr);
    overflow: hidden;
  }

  .credential-provider-list {
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-3) 0;
    border-right: 1px solid var(--border);
    background: var(--surface-soft);
  }

  .credential-provider-list .modal-search {
    margin: 0 var(--space-1);
  }

  .credential-provider-list nav {
    min-height: 0;
    padding-bottom: var(--space-4);
    overflow-y: scroll;
    scrollbar-gutter: stable;
  }

  .credential-provider-list nav::-webkit-scrollbar {
    width: 12px;
  }

  .credential-provider-list nav::-webkit-scrollbar-track {
    background: var(--surface-soft);
  }

  .credential-provider-list nav::-webkit-scrollbar-thumb {
    border: 3px solid var(--surface-soft);
    border-radius: 999px;
    background: color-mix(in oklch, var(--muted) 45%, var(--surface-soft));
  }

  .tabular {
    font-variant-numeric: tabular-nums;
  }

  .rail-heading {
    display: flex;
    justify-content: space-between;
    margin: var(--space-3) var(--space-2) var(--space-2);
    color: var(--muted);
    font-size: 11px;
    font-weight: 720;
    letter-spacing: 0.075em;
  }

  .rail-list {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .rail-row {
    width: 100%;
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid transparent;
    border-radius: var(--radius);
    background: transparent;
    color: var(--fg);
    text-align: left;
    cursor: pointer;
    transition: background 160ms ease, border-color 160ms ease;
  }

  .rail-row:hover {
    background: color-mix(in oklch, var(--surface) 70%, transparent);
  }

  .rail-row.selected {
    border-color: var(--border);
    background: var(--surface);
  }

  .rail-row:focus-visible,
  .rail-add:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent) 18%, transparent);
  }

  .rail-row-copy {
    min-width: 0;
    flex: 1;
    display: grid;
    gap: 2px;
  }

  .rail-row-copy strong {
    overflow: hidden;
    font-size: 14px;
    font-weight: 680;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rail-status {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }

  .status-dot {
    width: 7px;
    height: 7px;
    flex: none;
    border-radius: 50%;
    background: color-mix(in oklch, var(--muted) 55%, var(--surface));
  }

  [data-tone="good"] > .status-dot {
    background: var(--success);
  }

  [data-tone="warn"] > .status-dot {
    background: var(--warn);
  }

  [data-tone="bad"] > .status-dot {
    background: var(--danger);
  }

  [data-tone="active"] > .status-dot {
    background: var(--accent);
  }

  .rail-available {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .rail-available .rail-row {
    min-height: 40px;
  }

  .rail-add {
    width: 26px;
    height: 26px;
    flex: none;
    display: grid;
    place-items: center;
    margin-right: var(--space-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--muted);
    cursor: pointer;
    transition: color 160ms ease, border-color 160ms ease;
  }

  .rail-add:hover {
    border-color: color-mix(in oklch, var(--accent) 40%, var(--border));
    color: var(--accent);
  }

  .credential-body {
    min-height: 0;
    display: grid;
    align-content: start;
    gap: var(--space-5);
    padding: var(--space-5) var(--space-6) var(--space-6);
    overflow-y: auto;
  }

  .credential-section-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .credential-title {
    min-width: 0;
    flex: 1;
  }

  .credential-title h3 {
    margin: 0;
    font-size: 22px;
    line-height: 1.25;
  }

  .credential-title p {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .credential-switch {
    width: auto;
    min-width: 0;
    gap: var(--space-3);
    padding: 0 10px 0 12px;
    font-size: 13px;
    font-weight: 680;
  }

  .credential-switch.dirty {
    border-color: color-mix(in oklch, var(--accent) 44%, var(--border));
    background: var(--accent-soft);
  }

  .credential-switch .switch-track {
    background: var(--border);
    transition: background 180ms ease;
  }

  .credential-switch .switch-track::after {
    right: auto;
    left: 3px;
  }

  .credential-switch[aria-pressed="true"] .switch-track {
    background: var(--fg);
  }

  .credential-switch[aria-pressed="true"] .switch-track::after {
    transform: translateX(12px);
  }

  .last-sync {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .last-sync[data-tone="warn"] {
    border-color: color-mix(in oklch, var(--warn) 34%, var(--border));
    background: color-mix(in oklch, var(--warn) 6%, var(--surface));
  }

  .last-sync[data-tone="bad"] {
    border-color: color-mix(in oklch, var(--danger) 30%, var(--border));
    background: color-mix(in oklch, var(--danger) 6%, var(--surface));
  }

  .last-sync[data-tone="active"] {
    border-color: color-mix(in oklch, var(--accent) 28%, var(--border));
    background: color-mix(in oklch, var(--accent-soft) 40%, var(--surface));
  }

  .last-sync-icon {
    flex: none;
    display: grid;
    place-items: center;
    color: var(--muted);
  }

  .last-sync[data-tone="warn"] .last-sync-icon {
    color: var(--warn);
  }

  .last-sync[data-tone="bad"] .last-sync-icon {
    color: var(--danger);
  }

  .last-sync[data-tone="good"] .last-sync-icon {
    color: var(--success);
  }

  .last-sync-copy {
    min-width: 0;
    flex: 1;
    display: grid;
    gap: 2px;
  }

  .last-sync-copy strong {
    font-size: 14px;
    font-weight: 720;
  }

  .last-sync-copy span {
    color: var(--muted);
    font-size: 12px;
  }

  .last-sync .button {
    flex: none;
    min-height: 34px;
    padding: 0 var(--space-3);
  }

  .credential-block h4,
  .statement-selection-head h4 {
    margin: 0 0 var(--space-2);
    font-size: 15px;
    font-weight: 720;
  }

  .credential-fields,
  .statement-type-list {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .credential-row {
    min-height: 52px;
    display: grid;
    grid-template-columns: minmax(120px, 0.32fr) minmax(0, 1fr) auto;
    align-items: center;
    column-gap: var(--space-4);
    padding: var(--space-2) var(--space-4);
  }

  .credential-row + .credential-row,
  .statement-type-list li + li {
    border-top: 1px solid var(--border);
  }

  .credential-row.dirty {
    background: color-mix(in oklch, var(--accent-soft) 45%, var(--surface));
  }

  .credential-label {
    color: var(--muted);
    font-size: 13px;
  }

  .credential-value {
    min-width: 0;
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .credential-value .mask {
    letter-spacing: 0.12em;
  }

  .credential-value.file-name {
    font-family: inherit;
  }

  .muted-text {
    color: var(--muted);
    font-family: inherit;
  }

  .credential-row-meta {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .credential-badge {
    min-height: 22px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0 var(--space-2);
    border-radius: 6px;
    background: var(--surface-soft);
    color: var(--muted);
    font-size: 12px;
    font-weight: 650;
    white-space: nowrap;
  }

  .credential-badge.good {
    background: color-mix(in oklch, var(--success) 10%, white);
    color: var(--success);
  }

  .credential-badge.bad {
    background: color-mix(in oklch, var(--danger) 9%, white);
    color: var(--danger);
  }

  .credential-badge.staged {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .credential-inline-input,
  .credential-editor-input {
    min-height: 40px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
  }

  .credential-inline-input {
    min-width: 0;
    padding: 0 var(--space-3);
    font-family: var(--font-mono);
    font-size: 13px;
    outline: none;
  }

  .credential-inline-input:focus,
  .credential-editor-input:focus-within {
    border-color: var(--fg);
    box-shadow: 0 0 0 3px var(--surface-soft);
  }

  .credential-row.editing {
    grid-template-columns: minmax(0, 1fr);
    row-gap: var(--space-2);
    padding: var(--space-3) var(--space-4) var(--space-4);
    background: color-mix(in oklch, var(--surface-soft) 60%, var(--surface));
  }

  .credential-row.editing .credential-label {
    color: var(--fg);
    font-weight: 720;
  }

  .credential-editor-input {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    color: var(--muted);
  }

  .credential-editor-input input {
    min-width: 0;
    flex: 1;
    min-height: 38px;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: 14px;
  }

  .credential-editor-input input:focus,
  .credential-editor-input input:focus-visible {
    border: 0;
    box-shadow: none;
    outline: none;
  }

  .credential-editor-foot {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .credential-editor-foot p {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }

  .credential-editor-foot .button {
    min-height: 34px;
    padding: 0 var(--space-3);
  }

  .gmail-otp-settings {
    padding: var(--space-4) var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .gmail-otp-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .gmail-otp-head h4 {
    margin: 0 0 var(--space-1);
    font-size: 15px;
  }

  .gmail-otp-head p,
  .gmail-otp-status {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.55;
  }

  .gmail-otp-status {
    margin-top: var(--space-3);
  }

  .gmail-otp-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }

  .gmail-otp-actions .button {
    min-height: 36px;
  }

  .file-error {
    grid-column: 1 / -1;
    margin: var(--space-1) 0 0;
  }

  .statement-selection {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
    outline: none;
  }

  .statement-selection:focus-visible .statement-type-list {
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent) 18%, transparent);
  }

  .statement-selection-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .statement-count {
    color: var(--accent);
    font-size: 13px;
    font-weight: 680;
  }

  .statement-type-option {
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    cursor: pointer;
    transition: background 160ms ease;
  }

  .statement-type-option:hover {
    background: color-mix(in oklch, var(--surface-soft) 60%, var(--surface));
  }

  .statement-type-option:focus-within {
    background: color-mix(in oklch, var(--accent-soft) 45%, var(--surface));
  }

  .statement-type-option input {
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--fg);
  }

  .statement-type-name {
    flex: 1;
    font-size: 14px;
    font-weight: 650;
  }

  .statement-result {
    color: var(--muted);
    font-size: 12px;
    font-weight: 650;
    white-space: nowrap;
  }

  .statement-result[data-tone="good"] {
    color: var(--success);
  }

  .statement-result[data-tone="bad"] {
    color: var(--danger);
  }

  .statement-selection-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .statement-selection-foot:has(.statement-selection-error:empty):not(:has(.text-action)) {
    display: none;
  }

  .credential-error {
    margin: var(--space-2) 0 0;
    color: var(--danger);
    font-size: 13px;
  }

  .setup-guide {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-soft);
  }

  .setup-guide-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding-right: var(--space-4);
  }

  .setup-guide-toggle {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: 0;
    background: transparent;
    color: var(--muted);
    text-align: left;
    cursor: pointer;
  }

  .setup-guide-toggle > span {
    min-width: 0;
    flex: 1;
    display: grid;
    gap: 2px;
  }

  .setup-guide-toggle strong {
    color: var(--fg);
    font-size: 14px;
    font-weight: 720;
  }

  .setup-guide-toggle > span > span {
    font-size: 12px;
  }

  .setup-guide-toggle :global(svg:last-child) {
    flex: none;
    transition: transform 180ms ease;
  }

  .setup-guide.open .setup-guide-toggle :global(svg:last-child) {
    transform: rotate(180deg);
  }

  .setup-guide-toggle:focus-visible {
    outline: none;
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 3px color-mix(in oklch, var(--accent) 18%, transparent);
  }

  .setup-guide-body {
    padding: 0 var(--space-5) var(--space-4) calc(var(--space-4) + 28px);
  }

  .setup-guide-body h5 {
    margin: var(--space-2) 0 var(--space-1);
    font-size: 13px;
  }

  .setup-guide-body li {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.55;
  }

  .setup-guide-body ul,
  .setup-guide-body ol {
    margin: 0 0 var(--space-3);
    padding-left: 20px;
  }

  .setup-guide-links {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .setup-guide-links .button {
    min-height: 34px;
  }

  .setup-guide-extra {
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }

  .setup-guide-extra ol {
    margin-bottom: 0;
  }

  .credential-footer {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
    background: var(--surface);
  }

  .credential-footer-summary {
    min-width: 0;
    flex: 1;
    margin: 0;
    overflow: hidden;
    color: var(--muted);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .credential-footer-summary strong {
    color: var(--fg);
    font-weight: 680;
  }

  .credential-footer-summary .credential-error {
    margin: 0;
  }

  .text-action {
    min-height: 32px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--accent);
    font: inherit;
    font-size: 13px;
    font-weight: 680;
    white-space: nowrap;
    cursor: pointer;
  }

  .text-action:disabled {
    opacity: 0.48;
    cursor: not-allowed;
  }

  .text-action:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  .viewer-error {
    margin: 0;
    color: var(--danger);
    font-size: 13px;
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
      flex-direction: column;
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

    .workflow-product-row {
      flex-direction: column;
    }

    .workflow-product-details {
      justify-content: flex-start;
      text-align: left;
    }

    .credential-layout {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
      overflow-y: auto;
    }

    .credential-provider-list {
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }

    .credential-provider-list nav {
      max-height: 220px;
    }

    .credential-body {
      overflow: visible;
      padding: var(--space-4);
    }

    .credential-row {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .credential-row .credential-label {
      grid-column: 1 / -1;
    }

    .task-actions {
      justify-content: flex-start;
    }

    .sync-sheet {
      width: min(455px, 100vw);
    }
  }
</style>
