<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { slide } from "svelte/transition";
  import { ArrowLeftRight, CircleEllipsis, CloudDownload, Import as ImportIcon, Landmark, Search, X } from "@lucide/svelte";
  import type { CertificateFileValidationReason, CredentialGroupDto } from "$lib/desktop/api.ts";
  import type {
    CathayGmailOtpConnectionError,
    CathayGmailOtpStatus,
  } from "$lib/automation/types.ts";
  import { locale, t, type Translation } from "$lib/i18n/i18n.ts";
  import {
    canResumeAssist,
    canSubmitCredentials,
    nextOnboardingCredentialKey,
    onboardingTaskDisclosure,
    previousOnboardingCredentialState,
    settleAssistDrag,
    settleAssistTextSubmission,
    shouldGuideAssistViewer,
  } from "$lib/onboarding/state.ts";
  import {
    buildCredentialSetupPlan,
    firstInvalidCredentialGroup,
  } from "$lib/automation/credential-setup.ts";
  import { credentialInputValue } from "$lib/automation/credential-redaction.ts";
  import {
    mapViewerPointer,
    shouldDispatchViewerClickBeforeType,
    viewerOverlayAnchorForRect,
  } from "$lib/automation/viewer-coordinate.ts";
  import type { CredentialSetupResult, OnboardingStep } from "$lib/onboarding/progression.ts";
  import { systemTimezone } from "$lib/settings/system-timezone-store.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";
  import { formatUtcDateTime } from "$lib/time/timezone.ts";
  import type {
    AutomationPageModel,
    AutomationCredentialRedaction,
    AutomationTaskHistoryRow,
    AutomationTaskPrerequisiteNotice,
    AutomationTaskRow,
  } from "./types.ts";

  export let automation: AutomationPageModel;
  export let credentialGroups: CredentialGroupDto[];
  export let reload: () => Promise<void>;
  export let onboardingSourceSelection = false;
  export let onboardingSingleSource = false;
  export let onboardingStep: OnboardingStep = "hidden";
  export let onboardingSelectedCredentialGroupId: string | null = null;
  export let onOnboardingSourceSaved: (result: CredentialSetupResult) => void = () => {};

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
  let historySearch = "";
  let historyFilter: "all" | "running" | "completed" | "failed" = "all";
  let expandedHistoryRunId: string | null = null;
  let humanTask: AutomationTaskRow | null = null;
  let assistInteracted = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let viewerTimer: ReturnType<typeof setInterval> | null = null;
  let viewerRequestId = 0;
  let viewerImageUrl = "";
  let viewerError = "";
  let completionChecking = false;
  let actionError = "";
  let statementSelectionError = "";
  let dragStart: { x: number; y: number; pointerId: number } | null = null;
  let floatingInput: { left: number; top: number; value: string; targetId: string; contractVersion: number } | null = null;
  let floatingInputEl: HTMLInputElement | null = null;
  let viewerScale = 1;
  let viewerImageSize = { width: 0, height: 0 };
  let viewerExpanded = false;
  let hoveredTask: AutomationTaskRow | null = null;
  let taskTooltipPosition = { left: 0, top: 0 };
  let groupEnabled: Record<string, boolean> = {};
  let credentialDrafts: Record<string, string> = {};
  let credentialFileDraftNames: Record<string, string> = {};
  let credentialFileErrors: Record<string, string> = {};
  let focusedCredentialKey: string | null = null;
  let cathayGmailOtpBusy = false;
  let cathayGmailOtpError = "";
  let statementSelectionDrafts: Record<string, string[]> = {};
  let statementSelectionConfirmed = false;
  let onboardingCredentialTargetKey: string | null = null;
  let selectedCredentialGroupId = "";
  let credentialSearch = "";
  let stageOpen: Record<string, boolean> = { collect: true, import: false, sync: false };
  const defaultCathayGmailOtpStatus: CathayGmailOtpStatus = {
    enabled: false,
    connectedEmail: null,
    needsAuthorization: false,
  };
  let cathayGmailOtpStatus: CathayGmailOtpStatus = defaultCathayGmailOtpStatus;

  $: sideValue = automation.active
    ? $t.common.runningCount(automation.activeTaskCount)
    : automation.importGate.locked
      ? $t.common.importLocked
      : $t.common.ready;
  $: sideSub = $t.common.businessDay(automation.businessDate);
  $: parallelTaskIds = new Set(automation.parallelRunnableTaskIds);
  $: guideAssistViewer = shouldGuideAssistViewer(
    assistInteracted,
    Boolean(floatingInput),
    humanTask?.humanAssistanceContract?.completion,
  );
  $: activeTasks = automation.tasks.filter((task) => task.isActive);
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
  $: prerequisiteNoticeGroups = [...automation.externalPrerequisiteNotices.reduce(
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
  $: credentialInputDirty = Object.values(credentialDrafts).some((value) => value.trim().length > 0);
  $: credentialToggleDirty = credentialGroups.some((group) => (groupEnabled[group.id] !== false) !== group.enabled);
  $: cathayGmailOtpStatus = automation.cathayGmailOtp ?? defaultCathayGmailOtpStatus;
  $: statementSelectionDirty = credentialGroups.some((group) =>
    (statementSelectionDrafts[group.id] ?? []).join(",") !== group.selectedStatementTypeIds.join(","),
  );
  $: credentialsDirty = credentialInputDirty || credentialToggleDirty || statementSelectionDirty;
  $: credentialGroupStatuses = Object.fromEntries(
    credentialGroups.map((group) => [
      group.id,
      credentialGroupStatus(
        group,
        groupEnabled[group.id] !== false,
        statementSelectionDrafts[group.id]?.length ?? 0,
        $t,
      ),
    ]),
  );
  $: collectionGroupIds = new Set(
    automation.tasks
      .filter((task) => task.kind === "crawler" && task.credentialGroupId)
      .map((task) => task.credentialGroupId as string),
  );
  $: onboardingDisclosure = onboardingTaskDisclosure(
    onboardingStep,
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
        (key) => !credentialDrafts[key]?.trim(),
      ) ?? null
    : null;
  $: onboardingSourceEnabled = Boolean(
    selectedCredentialGroup
    && groupEnabled[selectedCredentialGroup.id] !== false,
  );
  $: onboardingNeedsStatements = Boolean(
    onboardingSourceSelection
    && selectedCredentialGroup?.statementTypes?.length
    && selectedCredentialGroup.id !== "fubon"
    && (
      !(statementSelectionDrafts[selectedCredentialGroup.id]?.length)
      || !statementSelectionConfirmed
    ),
  );
  $: onboardingCredentialsReady = Boolean(
    onboardingSourceSelection
    && selectedCredentialGroup
    && onboardingSourceEnabled
    && !onboardingCredentialTargetKey
    && !onboardingMissingCredentialKey
    && !onboardingNeedsStatements,
  );
  $: visibleHistoryRows = historyRows.filter((run) => {
    const term = historySearch.trim().toLowerCase();
    return (historyFilter === "all" || historyStatusGroup(run.status) === historyFilter)
      && (!term || `${taskIdLabel(run.taskId, $t)} ${run.script}`.toLowerCase().includes(term));
  });
  $: historyCounts = historyRows.reduce(
    (counts, run) => {
      counts[historyStatusGroup(run.status)] += 1;
      return counts;
    },
    { running: 0, completed: 0, failed: 0 },
  );

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
    if (disclosure.showAllCollectTasks) showAllCollectTasks = true;
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
    return task.status !== "needs_setup" && task.credentialKeys.every((key) => automation.credentials[key]);
  }

  function localizedText(value: { en: string; "zh-TW": string }) {
    return value[$locale];
  }

  function credentialGroupName(group: CredentialGroupDto) {
    return localizedText(group.displayName);
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
    credentialDrafts = {};
    credentialFileDraftNames = {};
    credentialFileErrors = {};
    focusedCredentialKey = null;
    cathayGmailOtpError = "";
    onboardingCredentialTargetKey = null;
    statementSelectionConfirmed = false;
    statementSelectionError = "";
    groupEnabled = Object.fromEntries(credentialGroups.map((group) => [group.id, group.enabled]));
    statementSelectionDrafts = Object.fromEntries(
      credentialGroups.map((group) => [group.id, [...group.selectedStatementTypeIds]]),
    );
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
      event.stopImmediatePropagation();
      floatingInput = null;
      return;
    }
    closeCredentialsOnEscape(event);
  }

  function toggleGroup(groupId: string) {
    statementSelectionError = "";
    groupEnabled = {
      ...groupEnabled,
      [groupId]: !(groupEnabled[groupId] !== false),
    };
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

  async function setCathayGmailOtpEnabled(enabled: boolean) {
    if (cathayGmailOtpBusy) return;
    cathayGmailOtpBusy = true;
    cathayGmailOtpError = "";
    try {
      if (enabled) {
        const result = await window.octopusBeak.automation.enableCathayGmailOtp();
        await reload();
        if (result.connectionError)
          cathayGmailOtpError = cathayGmailOtpConnectionErrorMessage(result.connectionError);
      } else {
        await window.octopusBeak.automation.setCathayGmailOtpEnabled(false);
        await reload();
      }
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
    const group = credentialGroups.find((candidate) => candidate.id === groupId);
    const selected = new Set(statementSelectionDrafts[groupId] ?? []);
    if (selected.has(typeId)) selected.delete(typeId);
    else selected.add(typeId);
    statementSelectionDrafts = {
      ...statementSelectionDrafts,
      [groupId]: (group?.statementTypes ?? []).map((type) => type.id).filter((id) => selected.has(id)),
    };
  }

  function selectAllStatementTypes(group: CredentialGroupDto) {
    statementSelectionError = "";
    statementSelectionConfirmed = true;
    statementSelectionDrafts = {
      ...statementSelectionDrafts,
      [group.id]: (group.statementTypes ?? []).map((type) => type.id),
    };
  }

  function credentialGroupStatus(group: CredentialGroupDto, enabled: boolean, selectedCount: number, dictionary: Translation) {
    if (!enabled) return dictionary.common.disabled;
    if (group.id === "fubon") return dictionary.common.enabled;
    if (group.statementSetupRequired && group.selectedStatementTypeIds.length) return dictionary.automation.needsSetup;
    if (group.statementTypes?.length && !selectedCount) return dictionary.automation.needsSetup;
    if (group.statementTypes?.length) {
      return dictionary.automation.selectedStatementCount(selectedCount, group.statementTypes.length);
    }
    return dictionary.common.enabled;
  }

  function updateCredentialDraft(key: string, event: Event) {
    credentialDrafts = {
      ...credentialDrafts,
      [key]: (event.currentTarget as HTMLInputElement).value,
    };
  }

  function focusCredentialInput(
    key: string,
    redaction: AutomationCredentialRedaction,
    event: FocusEvent,
  ) {
    focusedCredentialKey = key;
    const input = event.currentTarget as HTMLInputElement;
    input.value = credentialInputValue(credentialDrafts[key] ?? "", redaction, true);
  }

  function blurCredentialInput(
    key: string,
    redaction: AutomationCredentialRedaction,
    event: FocusEvent,
  ) {
    if (focusedCredentialKey !== key) return;
    focusedCredentialKey = null;
    const input = event.currentTarget as HTMLInputElement;
    input.value = credentialInputValue(credentialDrafts[key] ?? "", redaction, false);
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
      credentialDrafts = { ...credentialDrafts, [key]: result.path };
      credentialFileDraftNames = { ...credentialFileDraftNames, [key]: result.filename };
      if (onboardingSourceSelection && key === onboardingCredentialTargetKey) {
        await advanceOnboardingCredential();
      }
    } catch (error) {
      credentialFileErrors = {
        ...credentialFileErrors,
        [key]: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function handleOnboardingCredentialKeydown(key: string, event: KeyboardEvent) {
    if (
      event.key !== "Enter"
      || event.isComposing
      || !onboardingSourceSelection
      || key !== onboardingCredentialTargetKey
      || !credentialDrafts[key]?.trim()
    ) return;
    event.preventDefault();
    void advanceOnboardingCredential();
  }

  async function advanceOnboardingCredential() {
    if (!selectedCredentialGroup) return;
    const nextKey = nextOnboardingCredentialKey(
      selectedCredentialGroup.credentialKeys,
      onboardingCredentialTargetKey,
      credentialDrafts,
    );
    onboardingCredentialTargetKey = nextKey;
    await tick();
    if (nextKey) document.getElementById(`credential-input-${nextKey}`)?.focus();
  }

  function backOnboardingCredential(event: Event) {
    event.preventDefault();
    const previous = previousOnboardingCredentialState(
      selectedCredentialGroup?.credentialKeys ?? [],
      {
        selectedCredentialGroupId,
        targetKey: onboardingCredentialTargetKey,
        statementSelectionConfirmed,
      },
      Boolean(selectedCredentialGroup?.statementTypes?.length),
    );
    if (previous.closeCredentials) {
      resetCredentialChanges();
      credentialsOpen = false;
      return;
    }
    selectedCredentialGroupId = previous.selectedCredentialGroupId;
    onboardingCredentialTargetKey = previous.targetKey;
    statementSelectionConfirmed = previous.statementSelectionConfirmed;
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
    statementSelectionConfirmed = false;
    selectedCredentialGroupId = groupId;
    onboardingCredentialTargetKey = onboardingSourceSelection
      ? credentialGroups.find((group) => group.id === groupId)?.credentialKeys[0] ?? null
      : null;
    if (onboardingSourceSelection && onboardingSingleSource && groupId) {
      groupEnabled = Object.fromEntries(
        credentialGroups.map((group) => [
          group.id,
          group.id === groupId
            ? groupEnabled[group.id] !== false
            : (!onboardingSingleSource || !collectionGroupIds.has(group.id))
              && groupEnabled[group.id] !== false,
        ]),
      );
    }
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
    try {
      actionError = "";
      await window.octopusBeak.automation.runMany(tasks.map((task) => task.id));
      await reload();
    } catch (error) {
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
    try {
      actionError = "";
      if (task.status === "waiting_for_human") await window.octopusBeak.automation.forceQuit(task.id);
      else await window.octopusBeak.automation.cancel(task.id);
      await reload();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    }
  }

  async function openRunHistory() {
    historyOpen = true;
    historyLoading = true;
    historySearch = "";
    historyFilter = "all";
    expandedHistoryRunId = null;
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

  async function saveCredentials(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmitCredentials(onboardingSourceSelection, onboardingCredentialsReady)) return;
    const invalid = firstInvalidCredentialGroup(
      credentialGroups,
      groupEnabled,
      statementSelectionDrafts,
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
      enabled: groupEnabled,
      statementSelections: statementSelectionDrafts,
      credentialDrafts,
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
        onOnboardingSourceSaved({
          selectedCredentialGroupId: savedGroupId,
          sourceConfiguredAt: new Date().toISOString(),
        });
        credentialsOpen = false;
        const selectedTask = automation.tasks.find(
          (task) => task.kind === "crawler" && task.credentialGroupId === savedGroupId,
        );
        if (selectedTask?.canRun) {
          await window.octopusBeak.automation.run(selectedTask.id);
          await reload();
        }
      } else {
        credentialsOpen = false;
      }
    } catch {
      actionError = $t.automation.saveCredentialsFailed;
    }
  }

  async function refreshViewerImage() {
    const taskId = humanTask?.id;
    if (!taskId) return;
    const requestId = ++viewerRequestId;
    try {
      const bytes = await window.octopusBeak.automation.viewerScreenshot(taskId);
      if (humanTask?.id !== taskId || requestId !== viewerRequestId) return;
      if (!bytes) {
        if (!viewerImageUrl) viewerError = $t.automation.screenshotUnavailable;
        return;
      }
      if (viewerImageUrl) URL.revokeObjectURL(viewerImageUrl);
      viewerImageUrl = URL.createObjectURL(new Blob([bytes.slice()], { type: "image/jpeg" }));
      viewerError = "";
    } catch (error) {
      if (humanTask?.id === taskId && requestId === viewerRequestId && !viewerImageUrl) {
        viewerError = $t.automation.screenshotUnavailable;
      }
    }
  }

  function openHumanViewer(task: AutomationTaskRow) {
    humanTask = task;
    assistInteracted = false;
    viewerScale = Math.max(1, Math.min(2.5, task.humanAssistanceContract?.focus.initialZoom ?? 1));
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
    assistInteracted = false;
    if (viewerImageUrl) URL.revokeObjectURL(viewerImageUrl);
    viewerImageUrl = "";
    viewerError = "";
    completionChecking = false;
    dragStart = null;
    floatingInput = null;
    viewerScale = 1;
    viewerImageSize = { width: 0, height: 0 };
    viewerExpanded = false;
  }

  function viewerFocusStyle(imageSize = viewerImageSize) {
    const contract = humanTask?.humanAssistanceContract;
    const target = contract?.targets.find(
      (candidate) => candidate.id === contract.focus.targetId,
    );
    const contextRects = contract?.contextRegions
      .filter((region) => contract.focus.contextRegionIds.includes(region.id))
      .flatMap((region) => region.rect ? [region.rect] : []) ?? [];
    const rects = [target?.rect, ...contextRects].filter((rect): rect is NonNullable<typeof rect> => Boolean(rect));
    const bounds = rects.length > 0
      ? {
        x: Math.min(...rects.map((rect) => rect.x)),
        y: Math.min(...rects.map((rect) => rect.y)),
        right: Math.max(...rects.map((rect) => rect.x + rect.width)),
        bottom: Math.max(...rects.map((rect) => rect.y + rect.height)),
      }
      : null;
    const originX = bounds && imageSize.width
      ? ((bounds.x + (bounds.right - bounds.x) / 2) / imageSize.width) * 100
      : 50;
    const originY = bounds && imageSize.height
      ? ((bounds.y + (bounds.bottom - bounds.y) / 2) / imageSize.height) * 100
      : 50;
    return `--viewer-scale: ${viewerScale}; --viewer-origin-x: ${originX}%; --viewer-origin-y: ${originY}%;`;
  }

  function backOnboardingAssist(event: Event) {
    event.preventDefault();
    if (floatingInput) {
      floatingInput = null;
      return;
    }
    if (assistInteracted) {
      assistInteracted = false;
      return;
    }
    closeHumanViewer();
  }

  async function sendViewerInput(input: unknown) {
    if (!humanTask) return false;
    try {
      const result = await window.octopusBeak.automation.viewerInput(humanTask.id, input);
      if (result.contract) {
        humanTask = { ...humanTask, humanAssistanceContract: result.contract };
      }
      viewerError = "";
      if (result.resumed) {
        closeHumanViewer();
        await reload();
        return true;
      }
      await refreshViewerImage();
      return true;
    } catch (error) {
      viewerError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  async function checkHumanViewerCompletion() {
    if (!humanTask || humanTask.humanAssistanceContract?.completion.mode !== "independent") return;
    completionChecking = true;
    try {
      const result = await window.octopusBeak.automation.viewerCompletionCheck(humanTask.id);
      if (result.contract) {
        humanTask = { ...humanTask, humanAssistanceContract: result.contract };
      }
      viewerError = result.verified ? "" : $t.automation.verificationIncomplete;
      if (result.verified) await reload();
    } catch (error) {
      viewerError = error instanceof Error ? error.message : String(error);
    } finally {
      completionChecking = false;
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
    if (!humanTask || !canResumeAssist(
      assistInteracted,
      Boolean(floatingInput),
      humanTask.humanAssistanceContract?.completion,
    )) return;
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

  function viewerImageFromEvent(event: { currentTarget: EventTarget | null }) {
    if (event.currentTarget instanceof HTMLImageElement) return event.currentTarget;
    return event.currentTarget instanceof HTMLElement
      ? event.currentTarget.querySelector<HTMLImageElement>(".viewer-image")
      : null;
  }

  function viewerImageLayoutOffset(image: HTMLImageElement, focus: HTMLElement) {
    let left = 0;
    let top = 0;
    let current: HTMLElement | null = image;
    while (current && current !== focus) {
      left += current.offsetLeft;
      top += current.offsetTop;
      current = current.offsetParent instanceof HTMLElement ? current.offsetParent : null;
    }
    return current === focus ? { left, top } : { left: 0, top: 0 };
  }

  function pointerPoint(event: Pick<PointerEvent, "clientX" | "clientY"> & { currentTarget: EventTarget | null }) {
    const image = viewerImageFromEvent(event);
    if (!image) return null;
    const focus = image.closest(".viewer-focus") as HTMLElement | null;
    const imageRect = image.getBoundingClientRect();
    const layoutWidth = image.clientWidth;
    const layoutHeight = image.clientHeight;
    if (!image.naturalWidth || !image.naturalHeight || !layoutWidth || !layoutHeight) return null;
    const layoutOffset = focus ? viewerImageLayoutOffset(image, focus) : { left: 0, top: 0 };
    return mapViewerPointer({
      clientX: event.clientX,
      clientY: event.clientY,
      imageRect,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      layoutWidth,
      layoutHeight,
      layoutLeft: layoutOffset.left,
      layoutTop: layoutOffset.top,
      frameWidth: focus?.clientWidth ?? layoutWidth,
      frameHeight: focus?.clientHeight ?? layoutHeight,
    });
  }

  function floatingInputAnchor(
    point: NonNullable<ReturnType<typeof pointerPoint>>,
    targetRect: { x: number; y: number; width: number; height: number },
  ) {
    return viewerOverlayAnchorForRect({
      targetRect,
      naturalWidth: point.naturalWidth,
      naturalHeight: point.naturalHeight,
      layoutWidth: point.layoutWidth,
      layoutHeight: point.layoutHeight,
      layoutLeft: point.layoutLeft,
      layoutTop: point.layoutTop,
      frameWidth: point.frameWidth,
      frameHeight: point.frameHeight,
      overlayWidth: 288,
      overlayHeight: 44,
    });
  }

  function handleViewerPointerDown(event: PointerEvent) {
    const point = pointerPoint(event);
    if (!point) return;
    dragStart = { ...point, pointerId: event.pointerId };
    (event.currentTarget as HTMLImageElement).setPointerCapture(event.pointerId);
  }

  function handleViewerPointerUp(event: PointerEvent) {
    if (!dragStart || dragStart.pointerId !== event.pointerId) return;
    const target = event.currentTarget as HTMLElement;
    const point = pointerPoint(event);
    const start = dragStart;
    dragStart = null;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    if (!point) return;

    const moved = Math.hypot(point.x - start.x, point.y - start.y);
    if (moved <= 8) {
      void handleViewerClick(point);
      return;
    }
    floatingInput = null;
    void submitViewerDrag(start, point);
  }

  async function submitViewerDrag(start: { x: number; y: number }, point: { x: number; y: number }) {
    const inspected = await inspectViewerPoint(start);
    if (!inspected?.targetId || inspected.contractVersion === undefined || !inspected.modes?.includes("drag")) return;
    const succeeded = await sendViewerInput({
      type: "drag",
      x: start.x,
      y: start.y,
      toX: point.x,
      toY: point.y,
      targetId: inspected.targetId,
      contractVersion: inspected.contractVersion,
    });
    if (settleAssistDrag(succeeded)) assistInteracted = true;
  }

  function handleViewerPointerCancel(event: PointerEvent) {
    if (dragStart?.pointerId !== event.pointerId) return;
    const target = event.currentTarget as HTMLElement;
    dragStart = null;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  }

  async function handleViewerClick(point: NonNullable<ReturnType<typeof pointerPoint>>) {
    floatingInput = null;
    const inspected = await inspectViewerPoint({ x: point.x, y: point.y });
    if (!inspected?.targetId || inspected.contractVersion === undefined) return;
    const modes = inspected.modes ?? [];
    if (shouldDispatchViewerClickBeforeType(modes) && !await sendViewerInput({
      type: "click",
      x: point.x,
      y: point.y,
      targetId: inspected.targetId,
      contractVersion: inspected.contractVersion,
    })) return;
    if (!modes.includes("type")) {
      assistInteracted = true;
      return;
    }
    if (!inspected.rect) return;
    const anchor = floatingInputAnchor(point, inspected.rect);
    if (!anchor) return;
    floatingInput = {
      ...anchor,
      value: "",
      targetId: inspected.targetId,
      contractVersion: inspected.contractVersion,
    };
    await tick();
    floatingInputEl?.focus();
  }

  function handleViewerKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    const image = viewerImageFromEvent(event);
    if (!image) return;
    const rect = image.getBoundingClientRect();
    const point = pointerPoint({
      currentTarget: image,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    } as unknown as PointerEvent);
    if (point) void handleViewerClick(point);
  }

  function updateFloatingInput(event: Event) {
    if (!floatingInput) return;
    floatingInput = { ...floatingInput, value: (event.currentTarget as HTMLInputElement).value };
  }

  async function submitFloatingInput(event: SubmitEvent) {
    event.preventDefault();
    if (!floatingInput?.value) return;
    const input = floatingInput;
    const succeeded = await sendViewerInput({
      type: "type",
      text: input.value,
      targetId: input.targetId,
      contractVersion: input.contractVersion,
    });
    if (floatingInput !== input) return;
    const result = settleAssistTextSubmission(input, succeeded);
    floatingInput = result.floatingInput;
    if (result.assistInteracted) assistInteracted = true;
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
    if (task.status === "partial") return dictionary.automation.progressPartial;
    if (task.status === "failed") return dictionary.automation.progressFailed;
    if (task.status === "locked") return dictionary.automation.progressLocked;
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
  {sideSub}
>
  <svelte:fragment slot="topbar-actions">
    <button
      class="button secondary topbar-action"
      type="button"
      data-onboarding={!credentialsOpen ? "automation-credentials" : undefined}
      onclick={openCredentials}
    >
      {$t.automation.credentials}
    </button>
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
                  aria-label={`${$t.automation.logs} · ${taskLabel(task, $t)}`}
                  aria-describedby={hoveredTask?.id === task.id ? "active-task-tooltip" : undefined}
                  title={taskLabel(task, $t)}
                  data-onboarding-task={task.id}
                  data-onboarding-group={task.credentialGroupId}
                  data-onboarding-action={task.status === "waiting_for_human" ? "open-assist" : "logs"}
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

    {#if prerequisiteNoticeGroups.length}
      <section class="card prerequisite-notices" aria-labelledby="prerequisite-notices-title">
        <div class="prerequisite-notices-head">
          <div>
            <p class="section-eyebrow">{$t.automation.prerequisiteNoticesTitle}</p>
            <h2 id="prerequisite-notices-title">{$t.automation.prerequisiteNoticesTitle}</h2>
            <p>{$t.automation.prerequisiteNoticeDescription}</p>
          </div>
        </div>
        <div class="prerequisite-notice-list">
          {#each prerequisiteNoticeGroups as group (group.prerequisiteId)}
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
                  {@const task = automation.tasks.find((candidate) => candidate.id === notice.taskId)}
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
                    {#if task.id === "import-downloads-csv" && task.canRun && automation.importGate.warnings.length}
                      <div class="import-warning">
                        <span>{$t.automation.partialImportWarning}</span>
                        {#each automation.importGate.warnings as warning}
                          <span>
                            {taskIdLabel(warning.taskId, $t)}{#if warning.failedTypeIds.length}:
                              {warning.failedTypeIds.map((typeId) => $t.automation.statementTypeLabels[typeId] ?? typeId).join(", ")}
                            {/if}
                          </span>
                        {/each}
                      </div>
                    {/if}
                    <button
                      class={`button task-control ${task.primaryAction === "Cancel" ? "danger" : "primary"}`}
                      type="button"
                      disabled={!task.canRun}
                      aria-busy={task.isActive}
                      title={importLockTitle(task, $t)}
                      data-onboarding-task={task.id}
                      data-onboarding-group={task.credentialGroupId}
                      data-onboarding-action="primary"
                      onclick={() => void primaryTaskAction(task)}
                    >
                      {#if task.isActive}<span class="spinner" aria-hidden="true"></span>{/if}
                      <span>{$t.automation.actionLabels[task.primaryAction]}</span>
                    </button>
                    {#if task.status === "waiting_for_human" && task.humanSession}
                      <button
                        class="button secondary task-control"
                        type="button"
                        data-onboarding={onboardingStep === "assist" && !humanTask
                          && task.credentialGroupId === onboardingSelectedCredentialGroupId
                          ? "automation-assist"
                          : undefined}
                        data-onboarding-action="open-assist"
                        onclick={() => openHumanViewer(task)}
                      >
                        {$t.automation.assist}
                      </button>
                    {/if}
                    <button
                      class="button secondary task-control"
                      class:active-log={expandedLogTaskId === task.id}
                      type="button"
                      aria-expanded={expandedLogTaskId === task.id}
                      aria-controls={`${task.id}-inline-log`}
                      data-onboarding-task={task.id}
                      data-onboarding-group={task.credentialGroupId}
                      data-onboarding-action="logs"
                      onclick={() => (expandedLogTaskId = expandedLogTaskId === task.id ? null : task.id)}
                    >
                      {$t.automation.logs}
                    </button>
                  </div>
                </td>
              </tr>
              {#if task.status === "partial" && task.statementFailures.length}
                <tr class="partial-task-detail">
                  <td colspan="5">
                    <details>
                      <summary>{$t.automation.partialImportWarning}</summary>
                      <ul>
                        {#each task.statementFailures as failure}
                          <li>
                            <strong>{$t.automation.statementTypeLabels[failure.typeId] ?? failure.typeId}</strong>
                            {#if failure.error}<span>{failure.error}</span>{/if}
                          </li>
                        {/each}
                      </ul>
                    </details>
                  </td>
                </tr>
              {/if}
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
    <form
      class="modal-panel credential-modal"
      onsubmit={saveCredentials}
      ononboardingadvance={advanceOnboardingCredential}
      ononboardingback={backOnboardingCredential}
    >
      <div class="modal-head">
        <div>
          <h2 id="credentials-title">{$t.automation.credentialsTitle}</h2>
          <p>{$t.automation.credentialsDescription}</p>
        </div>
        <div class="credential-head-actions">
          <button class="button fixed-action" type="button" onclick={closeCredentials}>{$t.common.cancel}</button>
          <button
            class="button primary fixed-action"
            type="submit"
            disabled={!canSubmitCredentials(onboardingSourceSelection, onboardingCredentialsReady)}
            data-onboarding={onboardingCredentialsReady
              ? "automation-credentials"
              : undefined}
            data-onboarding-action="save-credentials"
          >{$t.common.save}</button>
          <button class="modal-close" type="button" aria-label={$t.common.close} onclick={closeCredentials}><X size={20} /></button>
        </div>
      </div>
      <div class="modal-body credential-layout">
        <aside class="credential-provider-list">
          <label class="modal-search">
            <Search size={18} />
            <input value={credentialSearch} oninput={updateCredentialSearch} placeholder={$t.automation.credentialSearch} />
          </label>
          <nav
            aria-label={$t.automation.credentialsTitle}
            tabindex="-1"
            data-onboarding={onboardingSourceSelection
              && credentialsOpen
              && !selectedCredentialGroupId
                ? "automation-credentials"
                : undefined}
            data-onboarding-action="select-source"
          >
            {#each visibleCredentialGroups as group}
              <button
                type="button"
                class:selected={group.id === selectedCredentialGroupId}
                aria-current={group.id === selectedCredentialGroupId ? "true" : undefined}
                data-onboarding-group={group.id}
                onclick={() => selectCredentialGroup(group.id)}
              >
                <strong>{credentialGroupName(group)}</strong>
                <span>{credentialGroupStatuses[group.id]}</span>
              </button>
            {/each}
          </nav>
        </aside>
        {#if selectedCredentialGroup}
          <section class="credential-body" aria-labelledby={`${selectedCredentialGroup.id}-credentials-title`}>
            <div class="credential-section-head">
              <h3 id={`${selectedCredentialGroup.id}-credentials-title`}>{credentialGroupName(selectedCredentialGroup)}</h3>
              <button
                class="switch credential-switch"
                class:dirty={(groupEnabled[selectedCredentialGroup.id] !== false) !== selectedCredentialGroup.enabled}
                type="button"
                aria-pressed={groupEnabled[selectedCredentialGroup.id] !== false}
                data-onboarding={onboardingSourceSelection && !onboardingSourceEnabled
                  ? "automation-credentials"
                  : undefined}
                data-onboarding-action="enable-source"
                onclick={() => toggleGroup(selectedCredentialGroup.id)}
              >
                <span>{$t.common.enabled}</span>
                <span class="switch-track" aria-hidden="true"></span>
              </button>
            </div>
            <div class="credential-grid">
              {#each selectedCredentialGroup.credentialFields as credentialField}
                {@const key = credentialField.key}
                {#if credentialField.input === "certificate-file"}
                  {@const selectedFileName = credentialFileDraftNames[key] ?? selectedCredentialGroup.storedCredentialFileNames[key]}
                  {@const storedFileError = selectedCredentialGroup.invalidCredentialFileReasons?.[key]
                    ?? (selectedCredentialGroup.invalidCredentialFileKeys.includes(key) ? "missing-or-unreadable" : undefined)}
                  <div class="credential-field certificate-file-field">
                    <span>{localizedText(credentialField.label)}</span>
                    <div class:dirty={Boolean(credentialDrafts[key])} class="certificate-file-control">
                      {#if selectedFileName}
                        <p>{$t.automation.selectedCertificateFile(selectedFileName)}</p>
                      {/if}
                      <button
                        id={`credential-input-${key}`}
                        class="button secondary"
                        type="button"
                        data-onboarding={onboardingSourceEnabled && key === onboardingCredentialTargetKey
                          ? "automation-credentials"
                          : undefined}
                        data-onboarding-action="enter-credentials"
                        onclick={() => void selectCertificateFile(key)}
                      >{selectedFileName ? $t.automation.chooseAnotherCertificateFile : $t.automation.chooseCertificateFile}</button>
                    </div>
                    {#if !credentialDrafts[key] && storedFileError}
                      <p class="credential-error file-error">{certificateFileValidationMessage(storedFileError, true)}</p>
                    {/if}
                    {#if credentialFileErrors[key]}
                      <p class="credential-error file-error" aria-live="polite">{credentialFileErrors[key]}</p>
                    {/if}
                  </div>
                {:else}
                  <label class="credential-field">
                    <span>{localizedText(credentialField.label)}</span>
                    <input
                      id={`credential-input-${key}`}
                      name={key}
                      type={credentialField.input}
                      value={credentialInputValue(
                        credentialDrafts[key] ?? "",
                        credentialField.redaction,
                        focusedCredentialKey === key,
                      )}
                      class:dirty={Boolean(credentialDrafts[key]?.trim())}
                      data-onboarding={onboardingSourceEnabled && key === onboardingCredentialTargetKey
                        ? "automation-credentials"
                        : undefined}
                      data-onboarding-action="enter-credentials"
                      onfocus={(event) => focusCredentialInput(key, credentialField.redaction, event)}
                      onblur={(event) => blurCredentialInput(key, credentialField.redaction, event)}
                      oninput={(event) => updateCredentialDraft(key, event)}
                      onkeydown={(event) => handleOnboardingCredentialKeydown(key, event)}
                      placeholder={automation.credentials[key] ? $t.common.saved : $t.common.missing}
                      autocomplete="off"
                    />
                  </label>
                {/if}
              {/each}
            </div>
            {#if selectedCredentialGroup.id === "cathay"}
              <section class="gmail-otp-settings" aria-labelledby="cathay-gmail-otp-title">
                <div class="gmail-otp-head">
                  <div>
                    <h4 id="cathay-gmail-otp-title">{$t.automation.cathayGmailOtpTitle}</h4>
                    <p>{$t.automation.cathayGmailOtpDescription}</p>
                  </div>
                  <button
                    class="switch credential-switch"
                    type="button"
                    aria-pressed={cathayGmailOtpStatus.enabled}
                    disabled={cathayGmailOtpBusy}
                    onclick={() => void setCathayGmailOtpEnabled(!cathayGmailOtpStatus.enabled)}
                  >
                    <span>{$t.automation.cathayGmailOtpToggle}</span>
                    <span class="switch-track" aria-hidden="true"></span>
                  </button>
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
            {#if selectedCredentialGroup.id === "fubon" && selectedCredentialGroup.statementTypes?.length}
              <fieldset class="statement-selection" id="fubon-statement-selection" tabindex="-1">
                <legend>{$t.automation.statementsToCollect}</legend>
                <p id="fubon-statement-help">{$t.automation.statementSelectionAllSupported(credentialGroupName(selectedCredentialGroup))}</p>
              </fieldset>
            {:else if selectedCredentialGroup.statementTypes?.length}
              <fieldset
                class="statement-selection"
                id={`${selectedCredentialGroup.id}-statement-selection`}
                tabindex="-1"
                data-onboarding={!onboardingCredentialTargetKey && onboardingNeedsStatements
                  ? "automation-credentials"
                  : undefined}
                data-onboarding-action="select-statements"
                aria-describedby={statementSelectionError
                  ? `${selectedCredentialGroup.id}-statement-help ${selectedCredentialGroup.id}-statement-error`
                  : `${selectedCredentialGroup.id}-statement-help`}
              >
                <legend>{$t.automation.statementsToCollect}</legend>
                <div class="statement-selection-head">
                  <p id={`${selectedCredentialGroup.id}-statement-help`}>
                    {$t.automation.statementSelectionHelp(credentialGroupName(selectedCredentialGroup))}
                  </p>
                  <button type="button" class="text-action" onclick={() => selectAllStatementTypes(selectedCredentialGroup)}>
                    {$t.automation.selectAllStatements}
                  </button>
                </div>
                <div class="statement-type-grid">
                  {#each selectedCredentialGroup.statementTypes as type}
                    <label class="statement-type-option">
                      <input
                        type="checkbox"
                        checked={statementSelectionDrafts[selectedCredentialGroup.id]?.includes(type.id)}
                        aria-describedby={statementSelectionError ? `${selectedCredentialGroup.id}-statement-error` : undefined}
                        aria-invalid={statementSelectionError ? "true" : undefined}
                        onchange={() => toggleStatementType(selectedCredentialGroup.id, type.id)}
                      />
                      <span>{$t.automation.statementTypeLabels[type.id] ?? type.id}</span>
                    </label>
                  {/each}
                </div>
                <p
                  id={`${selectedCredentialGroup.id}-statement-error`}
                  class="credential-error statement-selection-error"
                  aria-live="polite"
                >{statementSelectionError}</p>
              </fieldset>
            {/if}
            <section class="setup-guide" aria-labelledby={`${selectedCredentialGroup.id}-setup-guide-title`}>
              <h4 id={`${selectedCredentialGroup.id}-setup-guide-title`}>{$t.automation.setupGuide}</h4>
              <p>{localizedText(selectedCredentialGroup.setupGuide.summary)}</p>
              <h5>{$t.automation.whatYouNeed}</h5>
              <ul>
                {#each selectedCredentialGroup.setupGuide.requirements as requirement}
                  <li>{localizedText(requirement)}</li>
                {/each}
              </ul>
              <h5>{$t.automation.setupSteps}</h5>
              <ol>
                {#each selectedCredentialGroup.setupGuide.steps as step}
                  <li>{localizedText(step)}</li>
                {/each}
              </ol>
              <div class="setup-guide-links" aria-label={$t.automation.officialServices}>
                {#each selectedCredentialGroup.setupGuide.links as guideLink}
                  <button class="button secondary" type="button" onclick={() => void openSetupGuideLink(selectedCredentialGroup.id, guideLink.id)}>
                    {localizedText(guideLink.label)}
                  </button>
                {/each}
              </div>
              {#if selectedCredentialGroup.setupGuide.extra}
                <div class="setup-guide-extra">
                  <h5>{localizedText(selectedCredentialGroup.setupGuide.extra.title)}</h5>
                  <ol>
                    {#each selectedCredentialGroup.setupGuide.extra.steps as step}
                      <li>{localizedText(step)}</li>
                    {/each}
                  </ol>
                </div>
              {/if}
            </section>
            {#if actionError}<p class="credential-error" aria-live="polite">{actionError}</p>{/if}
          </section>
        {/if}
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
          <p>{$t.automation.historyTaskCount(historyRows.length)}</p>
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
          <button class:selected={historyFilter === "all"} type="button" onclick={() => (historyFilter = "all")}><span>{$t.automation.historyAll}</span><strong>{historyRows.length}</strong></button>
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
                  <td><div class="task-name"><strong>{taskIdLabel(run.taskId, $t)}</strong><span>{run.script}</span></div></td>
                  <td><span class={`chip ${statusClass(run.status)}`}>{$t.automation.statusLabels[run.status]}</span></td>
                  <td class="mono">{formatTime(run.startedAt)}</td>
                  <td class="mono">{formatDuration(run)}</td>
                  <td class="history-error">
                    {#if run.errorMessage}
                      <button type="button" onclick={() => (expandedHistoryRunId = expandedHistoryRunId === run.taskRunId ? null : run.taskRunId)}>{run.errorMessage}</button>
                    {:else}--{/if}
                  </td>
                </tr>
                {#if run.errorMessage && expandedHistoryRunId === run.taskRunId}
                  <tr class="history-error-detail"><td colspan="5"><strong>{$t.automation.historyError}</strong><code>{run.errorMessage}</code></td></tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if humanTask}
  <div class="modal" class:viewer-modal-expanded={viewerExpanded} role="dialog" aria-modal="true" aria-labelledby="human-viewer-title">
    <button class="modal-backdrop" type="button" aria-label={$t.automation.closeAssist} onclick={closeHumanViewer}></button>
    <div
      class="modal-panel human-viewer-modal"
      class:expanded={viewerExpanded}
      ononboardingback={backOnboardingAssist}
    >
      <div class="modal-head viewer-head">
        <div class="viewer-title">
          <h2 id="human-viewer-title">{$t.automation.assistTitle(taskLabel(humanTask, $t))}</h2>
          <p>{humanTask.humanSession ?? $t.automation.noSession}</p>
          {#if humanTask.humanAssistanceContract}
            <span class="viewer-contract-stage">
              {humanTask.humanAssistanceContract.title} · v{humanTask.humanAssistanceContract.version}
            </span>
          {/if}
        </div>
        <div class="viewer-actions">
          <button class="button danger fixed-action force-quit-action" type="button" onclick={forceQuitHumanViewer}>
            {$t.automation.forceQuit}
          </button>
          {#if humanTask.humanAssistanceContract?.completion.mode === "independent"
            && humanTask.humanAssistanceContract.completion.status !== "verified"}
            <button
              class="button secondary fixed-action"
              type="button"
              disabled={completionChecking}
              onclick={checkHumanViewerCompletion}
            >
              {$t.automation.checkVerification}
            </button>
          {/if}
          <button
            class="button primary fixed-action"
            type="button"
            disabled={!canResumeAssist(assistInteracted, Boolean(floatingInput), humanTask.humanAssistanceContract?.completion)}
            data-onboarding={onboardingStep === "assist" && humanTask && canResumeAssist(assistInteracted, Boolean(floatingInput), humanTask.humanAssistanceContract?.completion)
              ? "automation-assist"
              : undefined}
            data-onboarding-action="resume-collection"
            onclick={resumeHumanViewer}
          >
            {onboardingStep === "assist" && canResumeAssist(
              assistInteracted,
              Boolean(floatingInput),
              humanTask.humanAssistanceContract?.completion,
            )
              ? $t.onboarding.resumeCollection
              : $t.automation.resume}
          </button>
          <button class="modal-close" type="button" aria-label={$t.common.close} onclick={closeHumanViewer}>x</button>
        </div>
      </div>
      <div class="modal-body viewer-body">
        <div class="viewer-frame">
          <div class="viewer-focus" style={viewerFocusStyle(viewerImageSize)}>
            <button
              class="viewer-image-button"
              type="button"
              aria-label={$t.onboarding.verificationViewerAria}
              onkeydown={handleViewerKeydown}
              onpointerdown={handleViewerPointerDown}
              onpointerup={handleViewerPointerUp}
              onpointercancel={handleViewerPointerCancel}
            >
              {#if viewerImageUrl}
                <img
                  class="viewer-image"
                  data-onboarding={onboardingStep === "assist" && humanTask && guideAssistViewer
                    ? "automation-assist"
                    : undefined}
                  data-onboarding-action="choose-verification-control"
                  src={viewerImageUrl}
                  alt={$t.automation.pausedBrowser}
                  draggable="false"
                  tabindex="-1"
                  onload={(event) => {
                    const image = event.currentTarget as HTMLImageElement;
                    viewerImageSize = { width: image.naturalWidth, height: image.naturalHeight };
                    viewerError = "";
                  }}
                  onerror={() => {
                    URL.revokeObjectURL(viewerImageUrl);
                    viewerImageUrl = "";
                    viewerImageSize = { width: 0, height: 0 };
                    viewerError = $t.automation.screenshotUnavailable;
                  }}
                />
              {:else}
                <div class="viewer-screenshot-placeholder" role="status" aria-live="polite">
                  {viewerError || $t.automation.screenshotUnavailable}
                </div>
              {/if}
            </button>
          {#if onboardingStep === "assist" && humanTask && guideAssistViewer}
            <div class="verification-viewer-tooltip" role="tooltip">
              {$t.onboarding.clickVerificationField}
            </div>
          {/if}
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
                data-onboarding={onboardingStep === "assist" && floatingInput
                  ? "automation-assist"
                  : undefined}
                data-onboarding-action="enter-verification"
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

  .import-warning {
    flex-basis: 100%;
    display: grid;
    gap: 2px;
    color: var(--warn);
    font-size: 11px;
    line-height: 1.35;
    text-align: right;
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

  .partial-task-detail td {
    padding: 0 var(--space-4) var(--space-4);
    border-top: 0;
    color: var(--fg);
    background: color-mix(in oklch, var(--warn) 3%, var(--surface));
  }

  .partial-task-detail details {
    padding: var(--space-3) var(--space-4);
    border: 1px solid color-mix(in oklch, var(--warn) 28%, var(--border));
    border-radius: var(--radius);
  }

  .partial-task-detail summary {
    color: var(--warn);
    font-size: 12px;
    font-weight: 720;
    cursor: pointer;
  }

  .partial-task-detail ul {
    margin: var(--space-3) 0 0;
    padding-left: var(--space-5);
  }

  .partial-task-detail li span {
    display: block;
    margin-top: var(--space-1);
    color: var(--muted);
    font-size: 12px;
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
    width: min(1180px, 100%);
    height: min(760px, calc(100vh - 40px));
  }

  .history-head-actions,
  .credential-head-actions {
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

  .history-table .task-name span {
    display: block;
    margin-top: 4px;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .history-error {
    max-width: 0;
    color: var(--muted);
    font-size: 12px;
  }

  .history-error button {
    width: 100%;
    overflow: hidden;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }

  .history-error-detail td {
    padding: 0 var(--space-4) var(--space-4);
    border-top: 0;
  }

  .history-error-detail td > strong,
  .history-error-detail code {
    display: block;
    padding: var(--space-3) var(--space-4);
    color: var(--danger);
    background: color-mix(in oklch, var(--danger) 5%, var(--surface));
  }

  .history-error-detail td > strong {
    padding-bottom: 0;
    border: 1px solid color-mix(in oklch, var(--danger) 24%, var(--border));
    border-bottom: 0;
    border-radius: var(--radius) var(--radius) 0 0;
    font-size: 12px;
  }

  .history-error-detail code {
    padding-top: var(--space-2);
    border: 1px solid color-mix(in oklch, var(--danger) 24%, var(--border));
    border-top: 0;
    border-radius: 0 0 var(--radius) var(--radius);
    white-space: pre-wrap;
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
    width: min(1120px, 100%);
    height: min(960px, calc(100vh - 40px));
    max-height: min(960px, calc(100vh - 40px));
  }

  .credential-layout {
    min-height: 0;
    flex: 1;
    display: grid;
    grid-template-columns: 250px minmax(0, 1fr);
    overflow: hidden;
  }

  .credential-provider-list {
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    border-right: 1px solid var(--border);
  }

  .credential-provider-list nav {
    min-height: 0;
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
    background: var(--muted);
  }

  .credential-provider-list nav button {
    width: 100%;
    min-height: 58px;
    display: grid;
    gap: 3px;
    padding: var(--space-3);
    border: 0;
    background: transparent;
    color: var(--fg);
    text-align: left;
    cursor: pointer;
  }

  .credential-provider-list nav button:hover {
    background: var(--surface-soft);
  }

  .credential-provider-list nav button.selected strong {
    text-decoration: underline;
    text-decoration-color: var(--muted);
    text-underline-offset: 6px;
  }

  .credential-provider-list nav button.selected {
    background: var(--surface-soft);
    box-shadow: inset 3px 0 0 var(--fg);
  }

  .credential-provider-list nav button span {
    color: var(--muted);
    font-size: 12px;
  }

  .credential-body {
    min-height: 0;
    padding: var(--space-6);
    overflow-y: auto;
  }

  .credential-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .credential-body h3 {
    margin: 0;
    font-size: 24px;
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
    min-width: 0;
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

  .gmail-otp-settings {
    margin-top: var(--space-6);
    padding: var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-soft);
  }

  .gmail-otp-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .gmail-otp-head h4 {
    margin: 0 0 var(--space-2);
    font-size: 16px;
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
    margin-top: var(--space-4);
  }

  .gmail-otp-actions .button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 36px;
  }

  .certificate-file-control {
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .certificate-file-control.dirty {
    border-color: color-mix(in oklch, var(--accent) 44%, var(--border));
    background: var(--accent-soft);
  }

  .certificate-file-control p {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--fg);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .certificate-file-control .button {
    min-height: 34px;
    flex: 0 0 auto;
  }

  .file-error {
    margin-top: 0;
  }

  .statement-selection {
    min-width: 0;
    margin: var(--space-6) 0 0;
    padding: var(--space-5) 0 0;
    border: 0;
    border-top: 1px solid var(--border);
    outline: none;
  }

  .statement-selection:focus {
    border-radius: var(--radius);
    box-shadow: 0 0 0 3px var(--surface-soft);
  }

  .statement-selection legend {
    padding: 0;
    color: var(--fg);
    font-size: 15px;
    font-weight: 760;
  }

  .statement-selection-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .statement-selection-head p {
    margin: var(--space-1) 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .text-action {
    min-height: 32px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--accent);
    font: inherit;
    font-size: 12px;
    font-weight: 720;
    cursor: pointer;
  }

  .text-action:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  .statement-type-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2);
    margin-top: var(--space-3);
  }

  .statement-type-option {
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    cursor: pointer;
  }

  .statement-type-option:has(input:checked) {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .statement-type-option:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .statement-type-option input {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--accent);
  }

  .statement-type-option span {
    font-size: 13px;
    font-weight: 650;
  }

  .credential-error {
    margin: var(--space-4) 0 0;
    color: var(--danger);
    font-size: 13px;
  }

  .statement-selection-error:empty {
    margin: 0;
  }

  .setup-guide {
    margin-top: var(--space-6);
    padding: var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-soft);
  }

  .setup-guide h4,
  .setup-guide h5,
  .setup-guide p,
  .setup-guide ul,
  .setup-guide ol {
    margin-top: 0;
  }

  .setup-guide h4 {
    margin-bottom: var(--space-2);
    font-size: 16px;
  }

  .setup-guide h5 {
    margin-bottom: var(--space-2);
    font-size: 13px;
  }

  .setup-guide p,
  .setup-guide li {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.55;
  }

  .setup-guide ul,
  .setup-guide ol {
    margin-bottom: var(--space-4);
    padding-left: 20px;
  }

  .setup-guide-links {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .setup-guide-links .button {
    min-height: 36px;
  }

  .setup-guide-extra {
    margin-top: var(--space-4);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }

  .setup-guide-extra ol {
    margin-bottom: 0;
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

  .viewer-contract-stage {
    width: fit-content;
    max-width: 100%;
    color: var(--accent);
    font-size: 12px;
    font-weight: 700;
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

  .viewer-focus {
    position: relative;
    width: 100%;
    display: grid;
    place-items: center;
    transform: scale(var(--viewer-scale, 1));
    transform-origin: var(--viewer-origin-x, 50%) var(--viewer-origin-y, 50%);
    transition: transform 180ms ease;
  }

  .human-viewer-modal.expanded .viewer-frame {
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: 0;
  }

  .human-viewer-modal.expanded .viewer-focus {
    height: 100%;
  }

  .viewer-image-button {
    display: block;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: crosshair;
  }

  .viewer-image-button:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: -3px;
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

  .viewer-screenshot-placeholder {
    display: grid;
    width: 100%;
    min-height: 180px;
    place-items: center;
    padding: var(--space-6);
    color: color-mix(in oklch, white 76%, transparent);
    text-align: center;
  }

  .viewer-image:focus,
  .viewer-image:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: -3px;
  }

  .verification-viewer-tooltip {
    position: absolute;
    z-index: 3;
    left: 50%;
    bottom: var(--space-4);
    max-width: min(360px, calc(100% - 32px));
    padding: 10px 14px;
    border: 1px solid rgb(255 255 255 / 0.32);
    border-radius: 999px;
    color: white;
    background: rgb(15 23 42 / 0.9);
    box-shadow: var(--shadow);
    pointer-events: none;
    transform: translateX(-50%);
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
    transform: translate(-50%, -50%);
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

    .statement-type-grid {
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
