import type { CredentialGroupDto } from "../desktop/api.ts";
import type { AutomationTaskRow } from "../automation/types.ts";
import type { OnboardingStep } from "./progression.ts";

export const ONBOARDING_STORAGE_KEY = "octopusbeak-onboarding-v2";

export type OnboardingStatus = "active" | "paused" | "completed";
export type OnboardingState = {
  version: 2;
  status: OnboardingStatus;
  selectedCredentialGroupId: string | null;
  sourceConfiguredAt: string | null;
};

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export function settleAssistTextSubmission<T>(input: T, succeeded: boolean) {
  return {
    floatingInput: succeeded ? null : input,
    assistInteracted: succeeded,
  };
}

export function canResumeAssist(assistInteracted: boolean, floatingInputOpen: boolean) {
  return assistInteracted && !floatingInputOpen;
}

export function canSubmitCredentials(onboarding: boolean, ready: boolean) {
  return !onboarding || ready;
}

export function nextOnboardingCredentialKey(
  keys: readonly string[],
  current: string | null,
  drafts: Readonly<Record<string, string>>,
) {
  if (!current || !drafts[current]?.trim()) return current;
  const index = keys.indexOf(current);
  return index < 0 ? current : keys[index + 1] ?? null;
}

export function settleAssistDrag(succeeded: boolean) {
  return succeeded;
}

export function createOnboardingState(): OnboardingState {
  return {
    version: 2,
    status: "active",
    selectedCredentialGroupId: null,
    sourceConfiguredAt: null,
  };
}

export function readOnboardingState(storage: StorageReader = localStorage): OnboardingState | null {
  try {
    const value = JSON.parse(storage.getItem(ONBOARDING_STORAGE_KEY) ?? "null");
    if (
      value?.version !== 2
      || !["active", "paused", "completed"].includes(value.status)
      || !(typeof value.selectedCredentialGroupId === "string" || value.selectedCredentialGroupId === null)
      || !(value.sourceConfiguredAt === null
        || (typeof value.sourceConfiguredAt === "string"
          && Number.isFinite(Date.parse(value.sourceConfiguredAt))
          && new Date(value.sourceConfiguredAt).toISOString() === value.sourceConfiguredAt))
    ) return null;
    return value as OnboardingState;
  } catch {
    return null;
  }
}

export function writeOnboardingState(
  storage: StorageWriter = localStorage,
  state: OnboardingState,
) {
  storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state));
}

export function singleSourceUpdates(
  groups: readonly CredentialGroupDto[],
  selectedGroupId: string,
  collectionGroupIds: ReadonlySet<string>,
) {
  return Object.fromEntries(
    groups
      .filter((group) => collectionGroupIds.has(group.id))
      .map((group) => [
        group.enabledKey,
        group.id === selectedGroupId ? "true" : "false",
      ]),
  );
}

export function onboardingTaskDisclosure(
  step: OnboardingStep,
  selectedCredentialGroupId: string | null,
  tasks: readonly AutomationTaskRow[],
) {
  const target = ["import", "import-failed", "overview-empty"].includes(step)
    ? tasks.find((task) => task.id === "import-downloads-csv")
    : ["collection", "assist", "collection-failed"].includes(step)
      ? tasks.find((task) =>
        task.kind === "crawler" && task.credentialGroupId === selectedCredentialGroupId
      )
      : null;
  if (!target) return null;
  const collectionTasks = tasks.filter((task) => task.kind === "crawler");
  return {
    stageId: target.kind === "crawler" ? "collect" : target.kind,
    showAllCollectTasks: target.kind === "crawler" && collectionTasks.indexOf(target) >= 5,
  };
}

export function completedImportFinishedAt(tasks: readonly AutomationTaskRow[]) {
  const importer = tasks.find((task) => task.id === "import-downloads-csv");
  return importer?.status === "completed" ? importer.latestFinishedAt : null;
}
