import { get, writable, type Readable } from "svelte/store";
import type { Locale } from "../i18n/i18n.ts";
import type { OctopusBeakApi } from "../desktop/api.ts";
import type { OnboardingStoryEvent } from "../onboarding/story.ts";
import type { AutomationTaskRow } from "./types.ts";
import {
  CLOSED_CREDENTIAL_SHEET,
  applyCredentialSaveResult,
  planCredentialSave,
  reduceCredentialSheet,
  type CredentialSheetAction,
  type CredentialSheetContext,
  type CredentialSheetState,
} from "./credential-sheet.ts";

type EditorTask = Pick<AutomationTaskRow, "credentialGroupId" | "canRun">;

export type CredentialEditorPorts<Task extends EditorTask = AutomationTaskRow> = Readonly<{
  /** Read on every call, so a replaced bridge is the one used. */
  bridge(): Pick<OctopusBeakApi["automation"], "saveCredentials" | "selectCertificateFile">;
  page: Readonly<{
    /** Reloads the Automation page after a save. */
    reload(): Promise<void>;
    /** The page's task rows as they are now. */
    tasks(): readonly Task[];
  }>;
  onboarding: Readonly<{ story(event: OnboardingStoryEvent): void }>;
  runTask(task: Task): Promise<void>;
  now(): string;
}>;

export type CredentialEditorState = Readonly<{
  sheet: CredentialSheetState;
  /** Set when the last save could not reach the host; the page shows its own copy. */
  failure: "save-failed" | null;
}>;

/** What a save asks of the view: nothing, or focus on the source whose Statement Selection is invalid. */
export type CredentialSaveResult =
  | Readonly<{ kind: "done" }>
  | Readonly<{ kind: "focus-statement-selection"; groupId: string }>;

/**
 * The Automation page's sign-in details editor: the sheet state, and every
 * step that talks to the host or the onboarding story. The view keeps the
 * DOM work: focus, confirm dialogs and input redaction.
 */
export function createCredentialEditor<Task extends EditorTask>(ports: CredentialEditorPorts<Task>) {
  const store = writable<CredentialEditorState>({ sheet: CLOSED_CREDENTIAL_SHEET, failure: null });
  const sheet = () => get(store).sheet;
  const setSheet = (next: CredentialSheetState) => store.update((state) => ({ ...state, sheet: next }));
  const dispatch = (action: CredentialSheetAction, context: CredentialSheetContext) =>
    setSheet(reduceCredentialSheet(sheet(), action, context));
  const choosingSource = (context: CredentialSheetContext) =>
    context.onboardingSourceSelection && context.onboardingNodeId === "source-selection";

  return {
    state: { subscribe: store.subscribe } satisfies Readable<CredentialEditorState>,
    sheet,
    dispatch,

    /** Opens the sheet; at the story's source entry it opens the picker and tells the story. */
    openFromStoryEntry(context: CredentialSheetContext) {
      dispatch({ type: "open" }, context);
      if (context.onboardingSourceSelection && context.onboardingNodeId === "source-entry") {
        ports.onboarding.story({ type: "open-picker" });
        dispatch({ type: "present", presentation: "picker" }, context);
      }
    },

    choose(groupId: string, context: CredentialSheetContext) {
      const choosing = choosingSource(context);
      dispatch({ type: "choose-group", groupId }, context);
      if (choosing) ports.onboarding.story({ type: "choose-source", credentialGroupId: groupId });
    },

    enableAndSelect(groupId: string, context: CredentialSheetContext) {
      const choosing = choosingSource(context);
      dispatch({ type: "enable-and-select-group", groupId }, context);
      if (choosing) ports.onboarding.story({ type: "choose-source", credentialGroupId: groupId });
    },

    async selectCertificateFile(key: string, locale: Locale, context: CredentialSheetContext) {
      store.update((state) => ({ ...state, failure: null }));
      dispatch({ type: "certificate-file-started", key }, context);
      const { generation } = sheet();
      try {
        const result = await ports.bridge().selectCertificateFile(locale);
        dispatch({ type: "certificate-file-selected", generation, key, result }, context);
      } catch (error) {
        dispatch({
          type: "certificate-file-failed",
          generation,
          key,
          message: error instanceof Error ? error.message : String(error),
        }, context);
      }
    },

    /**
     * Saves the staged changes. A result for a sheet closed or reopened since
     * is dropped. During the story's source selection a saved source is told to
     * the story and its task, when runnable, starts.
     */
    async save(context: CredentialSheetContext): Promise<CredentialSaveResult> {
      const save = planCredentialSave(sheet(), context);
      if (save.kind === "blocked") return { kind: "done" };
      store.set({ sheet: save.state, failure: null });
      if (save.kind === "invalid") return { kind: "focus-statement-selection", groupId: save.groupId };
      const { generation } = save.state;
      try {
        const result = await ports.bridge().saveCredentials(save.plan.updates);
        setSheet(applyCredentialSaveResult(sheet(), generation, { kind: "result", result }, context));
        if (!result.saved) return { kind: "done" };
        // The sheet stays open, still saving, while the page reloads.
        await ports.page.reload();
        if (sheet().generation !== generation) return { kind: "done" };
        const { savedGroupId } = save;
        if (context.onboardingSourceSelection && savedGroupId) {
          ports.onboarding.story({ type: "source-saved", credentialGroupId: savedGroupId, configuredAt: ports.now() });
          dispatch({ type: "saved-and-reloaded", generation }, context);
          const task = ports.page.tasks().find((candidate) => candidate.credentialGroupId === savedGroupId);
          if (task?.canRun) await ports.runTask(task);
        } else {
          dispatch({ type: "saved-and-reloaded", generation }, context);
        }
      } catch {
        store.set({ sheet: applyCredentialSaveResult(sheet(), generation, { kind: "failed" }, context), failure: "save-failed" });
      }
      return { kind: "done" };
    },
  };
}

export type CredentialEditor = ReturnType<typeof createCredentialEditor<AutomationTaskRow>>;
