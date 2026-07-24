import type { AutomationDesktopModel, CredentialGroupDto } from "../desktop/api.ts";
import type { AutomationTaskRow } from "../automation/types.ts";
import type { OverviewPageDto } from "../overview/types.ts";

export const ONBOARDING_STORAGE_KEY = "octopusbeak-onboarding-v2";

export type OnboardingStatus = "active" | "paused" | "completed";
export type OnboardingStep =
  | "automation-nav"
  | "credentials"
  | "collection"
  | "assist"
  | "collection-failed"
  | "import"
  | "import-failed"
  | "overview"
  | "overview-empty"
  | "complete"
  | "hidden";

export type OnboardingCopyKey =
  | "automation"
  | "credentials"
  | "collection"
  | "assist"
  | "collectionFailed"
  | "import"
  | "importFailed"
  | "overview"
  | "overviewEmpty"
  | "complete";

export type OnboardingState = {
  version: 2;
  status: OnboardingStatus;
  selectedCredentialGroupId: string | null;
  sourceConfiguredAt: string | null;
};

export type OnboardingContext = {
  route: "overview" | "assets" | "liabilities" | "spending" | "automation" | "data-issues" | "settings";
  automation: AutomationDesktopModel | null;
  overview: OverviewPageDto | null;
  overviewLoadedForImportFinishedAt: string | null;
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

function importTask(context: OnboardingContext) {
  return context.automation?.automation.tasks.find((item) => item.id === "import-downloads-csv") ?? null;
}

export function hasExistingProductData(context: OnboardingContext) {
  const importer = importTask(context);
  return Boolean(
    context.overview?.accounts.length
    || context.overview?.importedAt
    || (importer?.status === "completed" && importer.latestFinishedAt),
  );
}

export function shouldNarrowOnboardingSources(
  context: OnboardingContext,
  state: OnboardingState | null,
  step: OnboardingStep,
) {
  return step === "credentials"
    && !state?.selectedCredentialGroupId
    && !hasExistingProductData(context);
}

function selectedGroup(context: OnboardingContext, state: OnboardingState) {
  return context.automation?.credentialGroups.find(
    (group) => group.id === state.selectedCredentialGroupId,
  ) ?? null;
}

function selectedTask(context: OnboardingContext, state: OnboardingState) {
  return context.automation?.automation.tasks.find(
    (item) => item.kind === "crawler" && item.credentialGroupId === state.selectedCredentialGroupId,
  ) ?? null;
}

function taskStartedAtOrAfter(
  task: AutomationTaskRow | null,
  boundary: string | null,
) {
  const startedAt = Date.parse(task?.latestStartedAt ?? "");
  const boundaryAt = Date.parse(boundary ?? "");
  return Number.isFinite(startedAt)
    && Number.isFinite(boundaryAt)
    && startedAt >= boundaryAt;
}

function groupReady(
  context: OnboardingContext,
  group: CredentialGroupDto | null,
) {
  if (!context.automation || !group?.enabled || group.statementSetupRequired) return false;
  return group.credentialKeys.every((key) => context.automation!.automation.credentials[key]);
}

function overviewIsFreshForImport(
  context: OnboardingContext,
  importer: AutomationTaskRow,
) {
  if (!importer.latestFinishedAt) return false;
  if (context.overviewLoadedForImportFinishedAt === importer.latestFinishedAt) return true;
  const overviewImportedAt = Date.parse(context.overview?.importedAt ?? "");
  const importFinishedAt = Date.parse(importer.latestFinishedAt);
  return Number.isFinite(overviewImportedAt)
    && Number.isFinite(importFinishedAt)
    && overviewImportedAt >= importFinishedAt;
}

export function resolveOnboardingStep(
  context: OnboardingContext,
  state: OnboardingState | null,
): OnboardingStep {
  if (!state || state.status !== "active" || !context.automation || !context.overview) return "hidden";
  const importer = importTask(context);
  const crawler = selectedTask(context, state);
  const freshCollection = taskStartedAtOrAfter(crawler, state.sourceConfiguredAt);
  const freshImport = freshCollection && taskStartedAtOrAfter(importer, crawler?.latestFinishedAt ?? null);
  const importComplete = freshImport && importer?.status === "completed";
  if (!importComplete && context.route !== "automation") return "automation-nav";
  const group = selectedGroup(context, state);
  if (
    !state.selectedCredentialGroupId
    || !state.sourceConfiguredAt
    || !groupReady(context, group)
  ) return "credentials";
  if (!crawler || !freshCollection) return "collection";
  if (crawler.status === "waiting_for_human") return "assist";
  if (crawler.status === "failed") return "collection-failed";
  const collectionComplete = crawler.status === "completed"
    || (crawler.status === "partial" && !context.automation.automation.importGate.locked);
  if (!collectionComplete) return "collection";
  if (!freshImport) return "import";
  if (importer?.status === "failed") return "import-failed";
  if (!importer || !importComplete) return "import";
  if (!overviewIsFreshForImport(context, importer)) return "overview";
  if (!context.overview.accounts.length) return "overview-empty";
  if (context.route !== "overview") return "overview";
  return "complete";
}

export function targetForOnboardingStep(
  step: OnboardingStep,
  state: OnboardingState,
  route: OnboardingContext["route"] = "overview",
) {
  if (step === "automation-nav") return '[data-onboarding="nav-automation"]';
  if (step === "credentials") return '[data-onboarding="automation-credentials"]';
  if (step === "assist") return '[data-onboarding="automation-assist"]';
  if (step === "overview") return '[data-onboarding="nav-overview"]';
  if (step === "overview-empty") {
    return route === "automation"
      ? '[data-onboarding-task="import-downloads-csv"][data-onboarding-action="logs"]'
      : '[data-onboarding="nav-automation"]';
  }
  if (step === "complete") return '[data-onboarding="overview-summary"]';
  const taskId = step === "import" || step === "import-failed"
    ? "import-downloads-csv"
    : state.selectedCredentialGroupId;
  const action = step.endsWith("failed") ? "logs" : "primary";
  return taskId
    ? `[data-onboarding-group="${taskId}"][data-onboarding-action="${action}"],`
      + `[data-onboarding-task="${taskId}"][data-onboarding-action="${action}"]`
    : null;
}

export function onboardingStepNumber(step: OnboardingStep) {
  if (step === "automation-nav") return 1;
  if (step === "credentials") return 2;
  if (["collection", "assist", "collection-failed"].includes(step)) return 3;
  if (["import", "import-failed"].includes(step)) return 4;
  return 5;
}

export function onboardingCopyKey(step: OnboardingStep): OnboardingCopyKey | null {
  if (step === "hidden") return null;
  if (step === "automation-nav") return "automation";
  if (step === "collection-failed") return "collectionFailed";
  if (step === "import-failed") return "importFailed";
  if (step === "overview-empty") return "overviewEmpty";
  if (step === "complete") return "complete";
  return step;
}
