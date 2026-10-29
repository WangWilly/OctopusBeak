import type { Locale, Translation } from "../i18n/i18n.ts";
import type {
  AutomationCredentialSaveResult,
  AutomationCredentialStatus,
  CertificateFileSelectionResult,
  CertificateFileValidationReason,
  CredentialGroupDto,
} from "../desktop/api.ts";
import type { OnboardingNodeId } from "../onboarding/story.ts";
import { canSubmitCredentials } from "../onboarding/state.ts";
import { buildCredentialSetupPlan, firstInvalidCredentialGroup } from "./credential-setup.ts";
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
  selectAllStatementTypes,
  setGroupEnabled,
  stageCredentialFile,
  stageCredentialValue,
  toggleStatementType,
  updateCredentialEditor,
  type CredentialChanges,
  type PendingCredentialChange,
} from "./credential-changes.ts";

/**
 * The sign-in details sheet on the Automation page: which source it shows,
 * the unsaved edits, and whether a save is in flight.  Pure: the component
 * owns IPC, dialogs, focus and onboarding story events.
 */

export type CredentialSheetPresentation = "picker" | "details";

export type CredentialSheetState = Readonly<{
  open: boolean;
  presentation: CredentialSheetPresentation;
  selectedGroupId: string;
  search: string;
  changes: CredentialChanges;
  fileErrors: Readonly<Record<string, string>>;
  focusedKey: string | null;
  statementSelectionConfirmed: boolean;
  statementSelectionError: string;
  setupGuideOpen: boolean;
  saving: boolean;
  /** Advances on every open and close; an async result from an older generation is dropped. */
  generation: number;
}>;

export const CLOSED_CREDENTIAL_SHEET: CredentialSheetState = {
  open: false,
  presentation: "details",
  selectedGroupId: "",
  search: "",
  changes: NO_CREDENTIAL_CHANGES,
  fileErrors: {},
  focusedKey: null,
  statementSelectionConfirmed: false,
  statementSelectionError: "",
  setupGuideOpen: false,
  saving: false,
  generation: 0,
};

export type CredentialSheetContext = Readonly<{
  dictionary: Translation;
  locale: Locale;
  credentialGroups: readonly CredentialGroupDto[];
  /** Groups that have a collection task. */
  collectionGroupIds: ReadonlySet<string>;
  onboardingSourceSelection: boolean;
  onboardingSingleSource: boolean;
  onboardingNodeId: OnboardingNodeId | null;
  onboardingSelectedCredentialGroupId: string | null;
  credentialState(key: string): AutomationCredentialStatus;
}>;

export type CredentialSheetAction =
  | Readonly<{ type: "open" }>
  | Readonly<{ type: "close" }>
  | Readonly<{ type: "select-group"; groupId: string }>
  | Readonly<{ type: "choose-group"; groupId: string }>
  | Readonly<{ type: "enable-and-select-group"; groupId: string }>
  | Readonly<{ type: "present"; presentation: CredentialSheetPresentation }>
  | Readonly<{ type: "present-onboarding"; presentation: CredentialSheetPresentation; groupId: string | null }>
  | Readonly<{ type: "search"; search: string }>
  | Readonly<{ type: "toggle-group"; groupId: string }>
  | Readonly<{ type: "toggle-statement-type"; groupId: string; typeId: string }>
  | Readonly<{ type: "select-all-statement-types"; groupId: string }>
  | Readonly<{ type: "stage-value"; key: string; value: string }>
  | Readonly<{ type: "revert"; key: string }>
  | Readonly<{ type: "editor-start"; groupId: string; key: string }>
  | Readonly<{ type: "editor-draft"; draft: string }>
  | Readonly<{ type: "editor-confirm" }>
  | Readonly<{ type: "editor-cancel" }>
  | Readonly<{ type: "focus-field"; key: string }>
  | Readonly<{ type: "blur-field"; key: string }>
  | Readonly<{ type: "toggle-setup-guide" }>
  | Readonly<{ type: "certificate-file-started"; key: string }>
  | Readonly<{ type: "certificate-file-selected"; generation: number; key: string; result: CertificateFileSelectionResult }>
  | Readonly<{ type: "certificate-file-failed"; generation: number; key: string; message: string }>
  | Readonly<{ type: "saved-and-reloaded"; generation: number }>;

export type CredentialSheetView = Readonly<{
  pendingChanges: PendingCredentialChange[];
  dirty: boolean;
  savedEnabledGroupCount: number;
  visibleGroups: CredentialGroupDto[];
  railEnabledGroups: CredentialGroupDto[];
  railAvailableGroups: CredentialGroupDto[];
  /** Outside onboarding, falls back to the first visible group. */
  selectedGroup: CredentialGroupDto | undefined;
  onboardingMissingCredentialKey: string | null;
  onboardingSourceEnabled: boolean;
  onboardingNeedsStatements: boolean;
  onboardingCredentialsReady: boolean;
  canSubmit: boolean;
}>;

export type CredentialSavePlan =
  | Readonly<{ kind: "blocked" }>
  | Readonly<{ kind: "invalid"; groupId: string; state: CredentialSheetState }>
  | Readonly<{
    kind: "submit";
    plan: ReturnType<typeof buildCredentialSetupPlan>;
    savedGroupId: string;
    state: CredentialSheetState;
  }>;

export type CredentialSaveOutcome =
  | Readonly<{ kind: "result"; result: AutomationCredentialSaveResult }>
  | Readonly<{ kind: "failed" }>;

function credentialGroupShortName(group: CredentialGroupDto, language: Locale) {
  const name = group.displayName[language];
  const suffix = `（${group.displayName.en}）`;
  return language === "zh-TW" && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

export function credentialGroupName(group: CredentialGroupDto, locale: Locale) {
  return credentialGroupShortName(group, locale);
}

export function credentialGroupAltName(group: CredentialGroupDto, locale: Locale) {
  const other = credentialGroupShortName(group, locale === "zh-TW" ? "en" : "zh-TW");
  return other === credentialGroupName(group, locale) ? "" : other;
}

export function certificateFileValidationMessage(
  reason: CertificateFileValidationReason,
  storedFile: boolean,
  dictionary: Translation,
) {
  if (reason === "invalid-extension") return dictionary.automation.invalidCertificateExtension;
  return storedFile
    ? dictionary.automation.missingCertificateFile
    : dictionary.automation.unreadableCertificateFile;
}

function visibleCredentialGroups(groups: readonly CredentialGroupDto[], search: string) {
  const term = search.trim().toLowerCase();
  if (!term) return [...groups];
  return groups.filter((group) =>
    [
      group.label,
      group.displayName.en,
      group.displayName["zh-TW"],
      ...group.searchAliases,
    ].join(" ").toLowerCase().includes(term));
}

function resetChanges(state: CredentialSheetState): CredentialSheetState {
  return {
    ...state,
    changes: NO_CREDENTIAL_CHANGES,
    fileErrors: {},
    focusedKey: null,
    statementSelectionConfirmed: false,
    statementSelectionError: "",
  };
}

function selectGroup(
  state: CredentialSheetState,
  groupId: string,
  context: CredentialSheetContext,
): CredentialSheetState {
  const group = context.credentialGroups.find((candidate) => candidate.id === groupId);
  let changes = state.changes;
  // Single-source onboarding keeps exactly one collection source enabled.
  if (context.onboardingSourceSelection && context.onboardingSingleSource && groupId) {
    for (const other of context.credentialGroups) {
      if (other.id === groupId || !context.collectionGroupIds.has(other.id)) continue;
      changes = setGroupEnabled(context.credentialGroups, changes, other.id, false);
    }
  }
  return {
    ...state,
    changes,
    statementSelectionError: "",
    statementSelectionConfirmed: Boolean(group?.selectedStatementTypeIds.length),
    setupGuideOpen: state.selectedGroupId === groupId ? state.setupGuideOpen : false,
    selectedGroupId: groupId,
  };
}

function chooseGroup(
  state: CredentialSheetState,
  groupId: string,
  context: CredentialSheetContext,
): CredentialSheetState {
  const selected = selectGroup(state, groupId, context);
  return context.onboardingSourceSelection && context.onboardingNodeId === "source-selection"
    ? { ...selected, presentation: "details" }
    : selected;
}

function open(state: CredentialSheetState, context: CredentialSheetContext): CredentialSheetState {
  // Reset before selecting: single-source onboarding stages disables while selecting.
  const reset = resetChanges(state);
  const remembered = context.onboardingSelectedCredentialGroupId;
  const selected = selectGroup(
    reset,
    context.onboardingSourceSelection
      ? remembered && context.collectionGroupIds.has(remembered) ? remembered : ""
      : reset.selectedGroupId || context.credentialGroups[0]?.id || "",
    context,
  );
  return {
    ...selected,
    search: "",
    presentation: context.onboardingSourceSelection
      && ["source-entry", "source-selection"].includes(context.onboardingNodeId ?? "")
      ? "picker"
      : "details",
    open: true,
    saving: false,
    generation: state.generation + 1,
  };
}

function close(state: CredentialSheetState): CredentialSheetState {
  return {
    ...resetChanges(state),
    open: false,
    saving: false,
    generation: state.generation + 1,
  };
}

function withChanges(state: CredentialSheetState, changes: CredentialChanges): CredentialSheetState {
  return changes === state.changes ? state : { ...state, changes };
}

function withFileError(state: CredentialSheetState, key: string, message: string): CredentialSheetState {
  return { ...state, fileErrors: { ...state.fileErrors, [key]: message } };
}

export function reduceCredentialSheet(
  state: CredentialSheetState,
  action: CredentialSheetAction,
  context: CredentialSheetContext,
): CredentialSheetState {
  const groups = context.credentialGroups;
  switch (action.type) {
    case "open":
      return open(state, context);
    case "close":
      return close(state);
    case "select-group":
      return selectGroup(state, action.groupId, context);
    case "choose-group":
      return chooseGroup(state, action.groupId, context);
    case "enable-and-select-group": {
      // Choose first: single-source onboarding may disable the other groups.
      const chosen = chooseGroup(state, action.groupId, context);
      return withChanges(chosen, setGroupEnabled(groups, chosen.changes, action.groupId, true));
    }
    case "present":
      return { ...state, presentation: action.presentation };
    case "present-onboarding": {
      let next = state.open ? state : open(state, context);
      if (
        action.groupId
        && groups.some((group) => group.id === action.groupId)
        && next.selectedGroupId !== action.groupId
      ) {
        next = selectGroup(next, action.groupId, context);
      }
      return { ...next, presentation: action.presentation };
    }
    case "search": {
      const next = { ...state, statementSelectionError: "", search: action.search };
      const visible = visibleCredentialGroups(groups, action.search);
      if (visible.some((group) => group.id === next.selectedGroupId)) return next;
      return context.onboardingSourceSelection
        ? selectGroup(next, "", context)
        : { ...next, selectedGroupId: visible[0]?.id ?? "" };
    }
    case "toggle-group":
      return {
        ...state,
        statementSelectionError: "",
        changes: setGroupEnabled(
          groups,
          state.changes,
          action.groupId,
          !effectiveGroupEnabled(groups, state.changes, action.groupId),
        ),
      };
    case "toggle-statement-type":
      return {
        ...state,
        statementSelectionError: "",
        statementSelectionConfirmed: true,
        changes: toggleStatementType(groups, state.changes, action.groupId, action.typeId),
      };
    case "select-all-statement-types":
      return {
        ...state,
        statementSelectionError: "",
        statementSelectionConfirmed: true,
        changes: selectAllStatementTypes(groups, state.changes, action.groupId),
      };
    case "stage-value":
      return withChanges(state, stageCredentialValue(state.changes, action.key, action.value));
    case "revert":
      return withChanges(state, revertCredential(state.changes, action.key));
    case "editor-start":
      return withChanges(state, openCredentialEditor(state.changes, action.groupId, action.key));
    case "editor-draft":
      return withChanges(state, updateCredentialEditor(state.changes, action.draft));
    case "editor-confirm":
      return withChanges(state, confirmCredentialEditor(state.changes));
    case "editor-cancel":
      return withChanges(state, closeCredentialEditor(state.changes));
    case "focus-field":
      return { ...state, focusedKey: action.key };
    case "blur-field":
      return state.focusedKey === action.key ? { ...state, focusedKey: null } : state;
    case "toggle-setup-guide":
      return { ...state, setupGuideOpen: !state.setupGuideOpen };
    case "certificate-file-started":
      return withFileError(state, action.key, "");
    case "certificate-file-selected": {
      if (action.generation !== state.generation || action.result.cancelled) return state;
      if ("error" in action.result) {
        return withFileError(
          state,
          action.key,
          certificateFileValidationMessage(action.result.error, false, context.dictionary),
        );
      }
      return withChanges(
        state,
        stageCredentialFile(state.changes, action.key, action.result.path, action.result.filename),
      );
    }
    case "certificate-file-failed":
      return action.generation === state.generation
        ? withFileError(state, action.key, action.message)
        : state;
    case "saved-and-reloaded":
      return action.generation === state.generation ? close(state) : state;
  }
}

export function credentialSheetView(
  state: CredentialSheetState,
  context: CredentialSheetContext,
): CredentialSheetView {
  const groups = context.credentialGroups;
  const { changes } = state;
  const pendingChanges = pendingCredentialChanges(groups, changes);
  const visibleGroups = visibleCredentialGroups(groups, state.search);
  const selectedGroup = visibleGroups.find((group) => group.id === state.selectedGroupId)
    ?? (!context.onboardingSourceSelection ? visibleGroups[0] : undefined);
  const onboardingMissingCredentialKey = context.onboardingSourceSelection && selectedGroup
    ? selectedGroup.credentialKeys.find(
        (key) => !(key in changes.credentials) && context.credentialState(key) !== "ready",
      ) ?? null
    : null;
  const onboardingSourceEnabled = Boolean(
    selectedGroup && effectiveGroupEnabled(groups, changes, selectedGroup.id),
  );
  const onboardingNeedsStatements = Boolean(
    context.onboardingSourceSelection
    && selectedGroup?.statementTypes?.length
    && (
      !effectiveStatementSelection(groups, changes, selectedGroup.id).length
      || !state.statementSelectionConfirmed
    ),
  );
  const onboardingCredentialsReady = Boolean(
    context.onboardingSourceSelection
    && selectedGroup
    && onboardingSourceEnabled
    && !onboardingMissingCredentialKey
    && !onboardingNeedsStatements,
  );
  return {
    pendingChanges,
    dirty: pendingChanges.length > 0 || Boolean(changes.editor?.draft.trim()),
    savedEnabledGroupCount: groups.filter((group) => group.enabled).length,
    visibleGroups,
    railEnabledGroups: visibleGroups.filter((group) => effectiveGroupEnabled(groups, changes, group.id)),
    railAvailableGroups: visibleGroups.filter((group) => !effectiveGroupEnabled(groups, changes, group.id)),
    selectedGroup,
    onboardingMissingCredentialKey,
    onboardingSourceEnabled,
    onboardingNeedsStatements,
    onboardingCredentialsReady,
    canSubmit: !state.saving
      && !changes.editor
      && canSubmitCredentials(context.onboardingSourceSelection, onboardingCredentialsReady)
      && (context.onboardingSourceSelection || pendingChanges.length > 0),
  };
}

/** Decide what a submit does; a planned submit marks the sheet as saving. */
export function planCredentialSave(
  state: CredentialSheetState,
  context: CredentialSheetContext,
): CredentialSavePlan {
  if (state.saving || state.changes.editor) return { kind: "blocked" };
  const view = credentialSheetView(state, context);
  if (!canSubmitCredentials(context.onboardingSourceSelection, view.onboardingCredentialsReady)) {
    return { kind: "blocked" };
  }
  const groups = context.credentialGroups;
  const setupInput = credentialSetupInput(groups, state.changes);
  const invalid = firstInvalidCredentialGroup(groups, setupInput.enabled, setupInput.statementSelections);
  if (invalid) {
    const selected = selectGroup({ ...state, search: "" }, invalid.id, context);
    const invalidDisplayGroup = groups.find((group) => group.id === invalid.id);
    return {
      kind: "invalid",
      groupId: invalid.id,
      state: {
        ...selected,
        // The focus target lives in the details pane.
        presentation: "details",
        statementSelectionError: context.dictionary.automation.selectOneStatementType(
          invalidDisplayGroup ? credentialGroupName(invalidDisplayGroup, context.locale) : invalid.label,
        ),
      },
    };
  }
  const plan = buildCredentialSetupPlan({
    groups,
    enabled: setupInput.enabled,
    statementSelections: setupInput.statementSelections,
    credentialDrafts: setupInput.credentialDrafts,
    selectedCredentialGroupId: state.selectedGroupId,
    onboardingSingleSource: context.onboardingSingleSource,
    collectionGroupIds: context.collectionGroupIds,
  });
  return {
    kind: "submit",
    plan,
    savedGroupId: plan.selectedCredentialGroupId,
    state: { ...state, statementSelectionError: "", saving: true },
  };
}

/**
 * Apply a save's IPC outcome.  A saved result clears the edits but keeps the
 * sheet open and saving while the page reloads; `saved-and-reloaded` closes it.
 * An outcome from an older generation is dropped.
 */
export function applyCredentialSaveResult(
  state: CredentialSheetState,
  generation: number,
  outcome: CredentialSaveOutcome,
  context: Pick<CredentialSheetContext, "dictionary">,
): CredentialSheetState {
  if (generation !== state.generation) return state;
  if (outcome.kind === "failed") return { ...state, saving: false };
  const { result } = outcome;
  if (result.saved) return resetChanges(state);
  return {
    ...withFileError(
      state,
      result.credentialKey,
      certificateFileValidationMessage(result.reason, false, context.dictionary),
    ),
    saving: false,
  };
}
