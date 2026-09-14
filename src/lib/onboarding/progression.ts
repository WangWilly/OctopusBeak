import type { CredentialGroupDto } from "../desktop/api.ts";
import type { AutomationTaskRow } from "../automation/types.ts";
import type { OverviewPageDto } from "../overview/types.ts";
import type { OnboardingState } from "./state.ts";

export type OnboardingRoute =
  | "overview"
  | "assets"
  | "liabilities"
  | "spending"
  | "automation"
  | "settings";

export type OnboardingStep =
  | "automation-nav"
  | "credentials"
  | "collection"
  | "assist"
  | "collection-failed"
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
  | "overview"
  | "overviewEmpty"
  | "complete";

export type OnboardingTarget =
  | { kind: "automation-nav" }
  | { kind: "credentials" }
  | { kind: "assist" }
  | { kind: "overview-nav" }
  | { kind: "overview-empty"; route: OnboardingRoute; taskId?: string }
  | { kind: "complete" }
  | { kind: "task"; taskId: string; action: "primary" | "logs" };

export type CredentialSetupResult = {
  selectedCredentialGroupId: string;
  sourceConfiguredAt: string;
};

type OnboardingTask = Pick<
  AutomationTaskRow,
  "id" | "kind" | "credentialGroupId" | "status" | "latestStartedAt" | "latestFinishedAt"
>;

type OnboardingCredentialGroup = Pick<
  CredentialGroupDto,
  "id" | "enabled" | "statementSetupRequired" | "credentialKeys"
>;

export type OnboardingFacts = {
  route: OnboardingRoute;
  automation: {
    tasks: readonly OnboardingTask[];
    credentialGroups: readonly OnboardingCredentialGroup[];
    credentials: Readonly<Record<string, boolean>>;
  } | null;
  overview: Pick<OverviewPageDto, "accounts" | "importedAt"> | null;
  overviewLoadedForTaskFinishedAt: string | null;
};

export function hasExistingProductData(facts: OnboardingFacts) {
  return Boolean(
    facts.overview?.accounts.length
    || facts.overview?.importedAt
  );
}

export function shouldNarrowOnboardingSources(
  facts: OnboardingFacts,
  state: OnboardingState | null,
  step: OnboardingStep,
) {
  return step === "credentials"
    && !state?.selectedCredentialGroupId
    && !hasExistingProductData(facts);
}

function selectedGroup(facts: OnboardingFacts, state: OnboardingState) {
  return facts.automation?.credentialGroups.find(
    (group) => group.id === state.selectedCredentialGroupId,
  ) ?? null;
}

function selectedTask(facts: OnboardingFacts, state: OnboardingState) {
  return facts.automation?.tasks.find(
    (item) => item.credentialGroupId === state.selectedCredentialGroupId,
  ) ?? null;
}

function taskStartedAtOrAfter(
  task: OnboardingTask | null,
  boundary: string | null,
) {
  const startedAt = Date.parse(task?.latestStartedAt ?? "");
  const boundaryAt = Date.parse(boundary ?? "");
  return Number.isFinite(startedAt)
    && Number.isFinite(boundaryAt)
    && startedAt >= boundaryAt;
}

function groupReady(
  facts: OnboardingFacts,
  group: OnboardingCredentialGroup | null,
) {
  if (!facts.automation || !group?.enabled || group.statementSetupRequired) return false;
  return group.credentialKeys.every((key) => facts.automation!.credentials[key]);
}

function overviewIsFreshForTask(
  facts: OnboardingFacts,
  task: OnboardingTask,
) {
  if (!task.latestFinishedAt) return false;
  if (facts.overviewLoadedForTaskFinishedAt === task.latestFinishedAt) return true;
  const overviewImportedAt = Date.parse(facts.overview?.importedAt ?? "");
  const taskFinishedAt = Date.parse(task.latestFinishedAt);
  return Number.isFinite(overviewImportedAt)
    && Number.isFinite(taskFinishedAt)
    && overviewImportedAt >= taskFinishedAt;
}

export function onboardingTaskSucceeded(task: Pick<OnboardingTask, "status"> | null) {
  return task?.status === "completed";
}

export function resolveOnboardingStep(
  facts: OnboardingFacts,
  state: OnboardingState | null,
): OnboardingStep {
  if (!state || state.status !== "active" || !facts.automation || !facts.overview) return "hidden";
  const group = selectedGroup(facts, state);
  const task = selectedTask(facts, state);
  const freshTask = taskStartedAtOrAfter(task, state.sourceConfiguredAt);
  const taskComplete = freshTask && onboardingTaskSucceeded(task);
  if (
    facts.route !== "automation"
    && (!groupReady(facts, group) || !taskComplete)
  ) return "automation-nav";
  if (
    !state.selectedCredentialGroupId
    || !state.sourceConfiguredAt
    || !groupReady(facts, group)
  ) return "credentials";
  if (!task || !freshTask) {
    return "collection";
  }
  if (task.status === "waiting_for_human") return "assist";
  if (task.status === "failed") return "collection-failed";
  if (!taskComplete) return "collection";
  if (!overviewIsFreshForTask(facts, task)) return "overview";
  if (!facts.overview.accounts.length) return "overview-empty";
  if (facts.route !== "overview") return "overview";
  return "complete";
}

export function targetForOnboardingStep(
  step: OnboardingStep,
  state: OnboardingState,
  route: OnboardingRoute = "overview",
): OnboardingTarget | null {
  if (step === "automation-nav") return { kind: "automation-nav" };
  if (step === "credentials") return { kind: "credentials" };
  if (step === "assist") return { kind: "assist" };
  if (step === "overview") return { kind: "overview-nav" };
  if (step === "overview-empty") {
    return {
      kind: "overview-empty",
      route,
      ...(route === "automation" && state.selectedCredentialGroupId
        ? { taskId: state.selectedCredentialGroupId }
        : {}),
    };
  }
  if (step === "complete") return { kind: "complete" };
  const taskId = state.selectedCredentialGroupId;
  const action = step.endsWith("failed") ? "logs" : "primary";
  return taskId ? { kind: "task", taskId, action } : null;
}

export function onboardingStepNumber(step: OnboardingStep) {
  if (step === "automation-nav") return 1;
  if (step === "credentials") return 2;
  if (["collection", "assist", "collection-failed"].includes(step)) return 3;
  return 4;
}

export function onboardingCanGoBack(step: OnboardingStep) {
  return step === "credentials" || step === "assist";
}

export function onboardingCopyKey(step: OnboardingStep): OnboardingCopyKey | null {
  if (step === "hidden") return null;
  if (step === "automation-nav") return "automation";
  if (step === "collection-failed") return "collectionFailed";
  if (step === "overview-empty") return "overviewEmpty";
  if (step === "complete") return "complete";
  return step;
}
