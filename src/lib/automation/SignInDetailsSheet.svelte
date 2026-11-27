<script lang="ts">
  import InstitutionLogo from "$lib/institutions/InstitutionLogo.svelte";
  import SourceDeviceRegistration from "$lib/automation/SourceDeviceRegistration.svelte";
  import { sourceLogo } from "$lib/institutions/institutions.ts";
  import { slide } from "svelte/transition";
  import {
    BookOpen,
    ChevronDown,
    ChevronRight,
    CircleAlert,
    CircleCheck,
    Info,
    KeyRound,
    Lock,
    RefreshCw,
    Search,
    FlaskConical,
    Smartphone,
    X,
  } from "@lucide/svelte";
  import type { CertificateFileValidationReason, CredentialGroupDto } from "$lib/desktop/api.ts";
  import type { RunActions } from "$lib/automation/run-actions.ts";
  import {
    deviceRegistrationSource,
    type DeviceRegistrationSource,
  } from "$lib/automation/types.ts";
  import { locale, t, type Translation } from "$lib/i18n/i18n.ts";
  import { credentialInputValue } from "$lib/automation/credential-redaction.ts";
  import {
    effectiveGroupEnabled,
    effectiveStatementSelection,
    type PendingCredentialChange,
  } from "$lib/automation/credential-changes.ts";
  import {
    certificateFileValidationMessage as certificateFileMessage,
    credentialGroupAltName as groupAltName,
    credentialGroupName as groupName,
    type CredentialSheetAction,
    type CredentialSheetContext,
    type CredentialSheetView,
  } from "$lib/automation/credential-sheet.ts";
  import type { CredentialEditor } from "$lib/automation/credential-editor.ts";
  import type { TaskRowView } from "$lib/automation/task-row-view.ts";
  import {
    registerOnboardingTarget,
    type OnboardingTargetRegistry,
  } from "$lib/onboarding/target-observer.ts";
  import { ONBOARDING_COACH_RESERVE } from "$lib/onboarding/placement.ts";
  import type { AutomationCredentialRedaction, AutomationTaskRow } from "./types.ts";

  /** The dashboard's editor: it opens the sheet from the page too, so the sheet only reads and dispatches. */
  export let credentialEditor: Pick<CredentialEditor, "state" | "dispatch" | "choose" | "selectCertificateFile">;
  export let sheetContext: CredentialSheetContext;
  export let sheetView: CredentialSheetView;
  export let tasks: readonly AutomationTaskRow[];
  export let present: (task: AutomationTaskRow) => TaskRowView;
  export let pendingTaskIds: ReadonlySet<string>;
  export let registrationBlocksRun: (task: Pick<AutomationTaskRow, "credentialGroupId">) => boolean;
  export let runActions: Pick<RunActions<AutomationTaskRow>, "actionError" | "setError" | "runTask">;
  export let onboardingTargets: OnboardingTargetRegistry;
  /** The open form, read by the dashboard to move focus to a source's section. */
  export let credentialForm: HTMLFormElement;
  export let deviceRegistering: Record<DeviceRegistrationSource, boolean>;
  export let onClose: () => void;
  export let onSave: (event: SubmitEvent) => void;
  // A second registration on one element needs its own directive name.
  const registerOnboardingRegion = registerOnboardingTarget;

  const credentialEditorState = credentialEditor.state;
  const actionError = runActions.actionError;
  $: sheet = $credentialEditorState;
  $: ({ credentialGroups, onboardingSourceSelection, onboardingNodeId, credentialState } = sheetContext);
  $: selectedGroupTask = sheetView.selectedGroup
    ? credentialGroupTask(sheetView.selectedGroup.id, tasks)
    : undefined;

  function disclosureSlide(node: Element) {
    return slide(node, {
      duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220,
    });
  }

  function localizedText(value: { en: string; "zh-TW": string }) {
    return value[$locale];
  }

  function credentialGroupName(group: CredentialGroupDto) {
    return groupName(group, $locale);
  }

  function credentialGroupAltName(group: CredentialGroupDto) {
    return groupAltName(group, $locale);
  }

  function credentialGroupTask(groupId: string, sourceTasks: readonly AutomationTaskRow[]) {
    return sourceTasks.find((task) => task.credentialGroupId === groupId);
  }

  function pendingChangeLabel(change: PendingCredentialChange, dictionary: Translation) {
    const group = credentialGroups.find((candidate) => candidate.id === change.groupId);
    const groupName = group ? credentialGroupName(group) : change.groupId;
    if (change.kind === "credential") {
      const field = group?.credentialFields.find((candidate) => candidate.key === change.key);
      const label = field ? localizedText(field.label) : change.key;
      return change.groupId === sheet.selectedGroupId ? label : `${groupName} · ${label}`;
    }
    if (change.kind === "enabled") {
      return `${groupName} · ${change.enabled ? dictionary.automation.changeEnableSync : dictionary.automation.changeDisableSync}`;
    }
    return `${groupName} · ${dictionary.automation.statementsToCollect}`;
  }

  function editorFieldLabel(dictionary: Translation) {
    const editor = sheet.changes.editor;
    const field = editor
      ? credentialGroups.find((group) => group.id === editor.groupId)?.credentialFields.find((candidate) => candidate.key === editor.key)
      : undefined;
    return field ? localizedText(field.label) : (editor?.key ?? "");
  }

  function certificateFileValidationMessage(
    reason: CertificateFileValidationReason,
    storedFile: boolean,
  ) {
    return certificateFileMessage(reason, storedFile, $t);
  }

  function dispatchSheet(action: CredentialSheetAction) {
    credentialEditor.dispatch(action, sheetContext);
  }

  function chooseCredentialGroup(groupId: string) {
    credentialEditor.choose(groupId, sheetContext);
  }

  function discardCredentialChanges() {
    if (onboardingSourceSelection) return;
    dispatchSheet({ type: "close" });
  }

  function toggleGroup(groupId: string) {
    dispatchSheet({ type: "toggle-group", groupId });
  }

  function toggleStatementType(groupId: string, typeId: string) {
    dispatchSheet({ type: "toggle-statement-type", groupId, typeId });
  }

  function selectAllStatementTypes(group: CredentialGroupDto) {
    dispatchSheet({ type: "select-all-statement-types", groupId: group.id });
  }

  function updateCredentialDraft(key: string, event: Event) {
    dispatchSheet({ type: "stage-value", key, value: (event.currentTarget as HTMLInputElement).value });
  }

  function updateEditorDraft(event: Event) {
    dispatchSheet({ type: "editor-draft", draft: (event.currentTarget as HTMLInputElement).value });
  }

  function credentialFieldText(key: string) {
    if (sheet.changes.editor?.key === key) return sheet.changes.editor.draft;
    const staged = sheet.changes.credentials[key];
    return staged?.kind === "value" ? staged.value : "";
  }

  function startCredentialEdit(groupId: string, key: string) {
    dispatchSheet({ type: "editor-start", groupId, key });
  }

  function confirmCredentialEdit() {
    dispatchSheet({ type: "editor-confirm" });
  }

  function cancelCredentialEdit() {
    dispatchSheet({ type: "editor-cancel" });
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
    dispatchSheet({ type: "focus-field", key });
    const input = event.currentTarget as HTMLInputElement;
    input.value = credentialInputValue(credentialFieldText(key), redaction, true);
  }

  function blurCredentialInput(
    key: string,
    redaction: AutomationCredentialRedaction,
    event: FocusEvent,
  ) {
    if (sheet.focusedKey !== key) return;
    dispatchSheet({ type: "blur-field", key });
    const input = event.currentTarget as HTMLInputElement;
    input.value = credentialInputValue(credentialFieldText(key), redaction, false);
  }

  async function selectCertificateFile(key: string) {
    runActions.setError("");
    await credentialEditor.selectCertificateFile(key, $locale, sheetContext);
  }

  function updateCredentialSearch(event: Event) {
    dispatchSheet({ type: "search", search: (event.currentTarget as HTMLInputElement).value });
  }

  async function openSetupGuideLink(groupId: string, linkId: string) {
    try {
      runActions.setError("");
      await window.octopusBeak.automation.openSetupGuideLink(groupId, linkId, $locale);
    } catch (error) {
      runActions.setError(error instanceof Error ? error.message : String(error));
    }
  }

  $: groupSyncStatus = (group: CredentialGroupDto) => {
    const task = credentialGroupTask(group.id, tasks);
    return task ? present(task).syncStatus : null;
  };
</script>

{#if sheet.open}
  <div
    class="modal"
    class:onboarding-guided={onboardingSourceSelection}
    style={`--onboarding-coach-reserve:${ONBOARDING_COACH_RESERVE}px`}
    role="dialog"
    aria-modal="true"
    aria-labelledby="credentials-title"
  >
    <button class="modal-backdrop" type="button" aria-label={$t.automation.closeCredentials} disabled={onboardingSourceSelection} onclick={onClose}></button>
    <form
      bind:this={credentialForm}
      class="modal-panel credential-modal"
      onsubmit={onSave}
      use:registerOnboardingTarget={{
        registry: onboardingTargets,
        id: onboardingSourceSelection && onboardingNodeId === "credentials"
          ? "automation.credentials"
          : null,
      }}
      use:registerOnboardingRegion={{
        registry: onboardingTargets,
        id: onboardingSourceSelection ? "automation.credentials.panel" : null,
      }}
    >
      <div class="modal-head credential-modal-head">
        <span class="credential-head-icon" aria-hidden="true"><KeyRound size={20} /></span>
        <div class="credential-head-copy">
          <h2 id="credentials-title">{$t.automation.credentialsTitle}</h2>
          <!-- The rail heading already counts the enabled services. -->
          <p>{$t.automation.credentialsSummary}</p>
        </div>
        {#if !onboardingSourceSelection}
          <button class="modal-close" type="button" aria-label={$t.common.close} onclick={onClose}><X size={20} /></button>
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
            <input value={sheet.search} oninput={updateCredentialSearch} placeholder={$t.automation.credentialSearch} />
          </label>
          <nav aria-label={$t.automation.credentialsTitle} tabindex="-1">
            {#if sheetView.railEnabledGroups.length}
              <h3 class="rail-heading"><span>{$t.automation.credentialGroupsEnabled}</span><span class="tabular">{sheetView.railEnabledGroups.length}</span></h3>
              <ul class="rail-list">
                {#each sheetView.railEnabledGroups as group (group.id)}
                  {@const syncStatus = groupSyncStatus(group)}
                  <li>
                    <button
                      type="button"
                      class="rail-row"
                      class:selected={group.id === sheet.selectedGroupId}
                      aria-current={group.id === sheet.selectedGroupId ? "true" : undefined}
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
                      {#if group.id === sheet.selectedGroupId}<ChevronRight size={16} aria-hidden="true" />{/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if sheetView.railAvailableGroups.length}
              <h3 class="rail-heading"><span>{$t.automation.credentialGroupsAvailable}</span><span class="tabular">{sheetView.railAvailableGroups.length}</span></h3>
              <ul class="rail-list">
                {#each sheetView.railAvailableGroups as group (group.id)}
                  <li class="rail-available">
                    <button
                      type="button"
                      class="rail-row"
                      class:selected={group.id === sheet.selectedGroupId}
                      aria-current={group.id === sheet.selectedGroupId ? "true" : undefined}
                      onclick={() => chooseCredentialGroup(group.id)}
                    >
                      <InstitutionLogo institution={sourceLogo(group.id)} size={24} />
                      <span class="rail-row-copy"><strong>{credentialGroupName(group)}</strong></span>
                      {#if group.id === sheet.selectedGroupId}<ChevronRight size={16} aria-hidden="true" />{/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </nav>
        </aside>
        {#if sheetView.selectedGroup && (!onboardingSourceSelection || sheet.presentation === "details")}
          {@const group = sheetView.selectedGroup}
          {@const groupOn = effectiveGroupEnabled(credentialGroups, sheet.changes, group.id)}
          {@const selectedTypes = effectiveStatementSelection(credentialGroups, sheet.changes, group.id)}
          <section class="credential-body" aria-labelledby={`${group.id}-credentials-title`}>
            <div class="credential-section-head">
              <InstitutionLogo institution={sourceLogo(group.id)} size={40} />
              <div class="credential-title">
                <h3 id={`${group.id}-credentials-title`} data-credential-focus="source" tabindex="-1">{credentialGroupName(group)}</h3>
                {#if credentialGroupAltName(group)}<p>{credentialGroupAltName(group)}</p>{/if}
              </div>
              <button
                class="switch credential-switch"
                class:dirty={group.id in sheet.changes.enabled}
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
              {@const syncStatus = present(syncTask).runStatus}
              {@const summary = present(syncTask).lastSyncSummary}
              <div class="last-sync" data-tone={syncTask.isActive ? "active" : syncStatus.tone} aria-live="polite">
                <span class="last-sync-icon" aria-hidden="true">
                  {#if syncTask.isActive}<span class="spinner"></span>{:else if syncStatus.tone === "good"}<CircleCheck size={16} />{:else}<CircleAlert size={16} />{/if}
                </span>
                <div class="last-sync-copy">
                  <strong>
                    {#if syncTask.isActive}
                      {$t.automation.credentialSyncStatuses.running}
                    {:else}
                      {$t.automation.lastSync(syncStatus.time, syncStatus.label)}
                    {/if}
                  </strong>
                  {#if syncTask.isActive}
                    <span>{present(syncTask).progressLabel}</span>
                  {:else if !syncTask.isActive && summary}
                    <span>{summary}</span>
                  {/if}
                </div>
                {#if !syncTask.isActive}
                  <button
                    class="button"
                    type="button"
                    disabled={!syncTask.canRun || pendingTaskIds.has(syncTask.id) || registrationBlocksRun(syncTask)}
                    onclick={() => void runActions.runTask(syncTask)}
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
                  {@const staged = sheet.changes.credentials[key]}
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
                          <button class="text-action" type="button" onclick={() => dispatchSheet({ type: "revert", key })}>{$t.automation.credentialRevert}</button>
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
                      {#if sheet.fileErrors[key]}
                        <p class="credential-error file-error" aria-live="polite">{sheet.fileErrors[key]}</p>
                      {/if}
                    </li>
                  {:else if sheet.changes.editor?.key === key}
                    <li class="credential-row editing">
                      <label class="credential-label" for={`credential-input-${key}`}>{fieldLabel}</label>
                      <span class="credential-editor-input">
                        <KeyRound size={16} aria-hidden="true" />
                        <input
                          id={`credential-input-${key}`}
                          name={key}
                          type={credentialField.input}
                          value={credentialInputValue(
                            sheet.changes.editor.draft,
                            credentialField.redaction,
                            sheet.focusedKey === key,
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
                          disabled={!sheet.changes.editor.draft.trim()}
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
                          sheet.focusedKey === key,
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
                          <button class="text-action" type="button" onclick={() => dispatchSheet({ type: "revert", key })}>{$t.automation.credentialRevert}</button>
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

            {#if group.preview}
              <div class="source-notice info" role="note" data-preview-disclosure>
                <FlaskConical size={16} aria-hidden="true" />
                <p>
                  <strong>{$t.automation.previewSourceTitle}</strong>
                  <span>{$t.automation.previewSourceBody}</span>
                </p>
              </div>
            {/if}

            {#if group.sessionTakeover}
              <div class="source-notice" role="note">
                <Smartphone size={16} aria-hidden="true" />
                <p>
                  <strong>{$t.automation.sessionTakeoverTitle}</strong>
                  <span>{localizedText(group.sessionTakeover.notice)}</span>
                </p>
              </div>
            {/if}

            {#if deviceRegistrationSource(group.id)}
              {@const source = deviceRegistrationSource(group.id)!}
              <SourceDeviceRegistration
                {source}
                signInDetailsSaved={group.credentialFields.every((credentialField) =>
                  credentialState(credentialField.key) === "ready" && !sheet.changes.credentials[credentialField.key])}
                syncActive={Boolean(selectedGroupTask?.isActive)}
                bind:registering={deviceRegistering[source]}
              />
            {/if}

            {#if group.statementTypes?.length}
              <fieldset
                class="statement-selection"
                data-credential-focus="statements"
                id={`${group.id}-statement-selection`}
                tabindex="-1"
                aria-describedby={sheet.statementSelectionError ? `${group.id}-statement-error` : undefined}
              >
                <legend class="visually-hidden">{$t.automation.statementsToCollect}</legend>
                <div class="statement-selection-head">
                  <!-- The legend names the group for a screen reader; this is its visible twin. -->
                  <span class="statement-selection-title" aria-hidden="true">{$t.automation.statementsToCollect}</span>
                  <span class="statement-selection-tools">
                    <span class="statement-count tabular">{$t.automation.selectedStatementCount(selectedTypes.length, group.statementTypes.length)}</span>
                    {#if selectedTypes.length < group.statementTypes.length}
                      <button type="button" class="text-action" onclick={() => selectAllStatementTypes(group)}>
                        {$t.automation.selectAllStatements}
                      </button>
                    {/if}
                  </span>
                </div>
                <ul class="statement-type-list">
                  {#each group.statementTypes as type (type.id)}
                    {@const checked = selectedTypes.includes(type.id)}
                    {@const lastResult = (selectedGroupTask ? present(selectedGroupTask).statementResults[type.id] : undefined) ?? null}
                    <li>
                      <label class="statement-type-option">
                        <input
                          type="checkbox"
                          {checked}
                          aria-describedby={sheet.statementSelectionError ? `${group.id}-statement-error` : undefined}
                          aria-invalid={sheet.statementSelectionError ? "true" : undefined}
                          onchange={() => toggleStatementType(group.id, type.id)}
                        />
                        <span class="statement-type-name">
                          {$t.automation.statementTypeLabels[type.id] ?? type.id}
                          {#if type.preview}
                            <span class="statement-type-preview" title={$t.automation.previewStatementTypeHint} data-preview-statement-type>{$t.automation.previewStatementType}</span>
                          {/if}
                        </span>
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
                  >{sheet.statementSelectionError}</p>
                </div>
              </fieldset>
            {/if}

            <section class="setup-guide" class:open={sheet.setupGuideOpen} aria-labelledby={`${group.id}-setup-guide-title`}>
              <div class="setup-guide-head">
                <button
                  class="setup-guide-toggle"
                  type="button"
                  aria-expanded={sheet.setupGuideOpen}
                  aria-controls={`${group.id}-setup-guide-body`}
                  onclick={() => dispatchSheet({ type: "toggle-setup-guide" })}
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
              {#if sheet.setupGuideOpen}
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
          {#if $actionError}
            <span class="credential-error">{$actionError}</span>
          {:else if sheet.changes.editor}
            {$t.automation.editingCredential(editorFieldLabel($t))}
          {:else if sheetView.pendingChanges.length}
            <strong>{$t.automation.pendingChangeSummary(sheetView.pendingChanges.length, sheetView.pendingChanges.map((change) => pendingChangeLabel(change, $t)).join($t.automation.changeListSeparator))}</strong>
            {#if sheetView.pendingChanges.some((change) => change.kind === "credential")}
              <span> · {$t.automation.pendingCredentialNote}</span>
            {/if}
          {:else}
            {$t.automation.noPendingChanges}
          {/if}
        </p>
        {#if !onboardingSourceSelection && !sheet.changes.editor}
          <!-- With nothing to discard, the button only closes, and says so. -->
          <button class="button" type="button" onclick={discardCredentialChanges}>{sheetView.dirty ? $t.common.cancel : $t.common.close}</button>
        {/if}
        <button
          class="button primary"
          type="submit"
          disabled={!sheetView.canSubmit}
        >{$t.automation.saveChanges}</button>
      </div>
    </form>
  </div>
{/if}

<style>
  .modal-head p {
    margin: var(--space-1) 0 0;
    color: var(--muted);
    font-size: 13px;
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

  /* Onboarding keeps a column free beside the panel so the coach never covers it. */
  .modal.onboarding-guided {
    padding-right: var(--onboarding-coach-reserve);
  }

  .modal.onboarding-guided .credential-modal {
    container-type: inline-size;
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

  .rail-row:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent) 18%, transparent);
  }

  .rail-row-copy {
    min-width: 0;
    flex: 1;
    display: grid;
    gap: 2px;
  }

  /* Two lines, so a long name keeps its product and 「（預覽）」, the part that tells sources apart. */
  .rail-row-copy strong {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    font-size: 14px;
    font-weight: 680;
    line-height: 1.35;
    overflow-wrap: anywhere;
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

  .rail-available .rail-row {
    min-height: 40px;
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

  .source-notice {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border: 1px solid color-mix(in oklch, var(--warn) 34%, var(--border));
    border-radius: var(--radius);
    background: color-mix(in oklch, var(--warn) 6%, var(--surface));
    color: var(--fg);
    font-size: 13px;
    line-height: 1.55;
  }

  .source-notice :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--warn);
  }

  .source-notice p {
    display: grid;
    gap: 2px;
    margin: 0;
  }

  .source-notice span {
    color: var(--muted);
  }

  /* A note that changes nothing the person does reads as information, so the warning tint stays for the ones that do. */
  .source-notice.info {
    border-color: var(--border);
    background: var(--surface-soft);
  }

  .source-notice.info :global(svg) {
    color: var(--muted);
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
  .statement-selection-title {
    display: block;
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

  /*
   * The rows share one set of columns, so an empty field's input ends where a
   * saved field's mask does, and the badge column keeps room for 「已輸入」
   * before anything is typed.
   */
  .credential-fields {
    display: grid;
    grid-template-columns: minmax(120px, 0.32fr) minmax(0, 1fr) minmax(88px, auto);
  }

  .credential-row {
    min-height: 52px;
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
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

  .statement-selection-tools {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-3);
  }

  /* A count, not a control: muted so the 全選 beside it reads as the action. */
  .statement-count {
    color: var(--muted);
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

  .statement-type-preview {
    display: inline-flex;
    align-items: center;
    min-height: 20px;
    margin-left: var(--space-2);
    padding: 0 var(--space-2);
    border: 1px solid color-mix(in oklch, var(--warn) 34%, transparent);
    border-radius: var(--radius);
    background: color-mix(in oklch, var(--warn) 10%, var(--surface));
    color: var(--warn);
    font-size: 11px;
    font-weight: 680;
    vertical-align: middle;
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

  .statement-selection-foot:has(.statement-selection-error:empty) {
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

  @media (max-width: 820px) {
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
  }

  /* The guided panel is narrowed by the coach column, not the viewport, so it
   * stacks like the narrow-window layout above based on its own width. */
  @container (max-width: 720px) {
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
      max-height: 160px;
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
  }
</style>
