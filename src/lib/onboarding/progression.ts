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
  | "data-issues"
  | "settings";

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

export type OnboardingTarget =
  | { kind: "automation-nav" }
  | { kind: "credentials" }
  | { kind: "assist" }
  | { kind: "overview-nav" }
  | { kind: "overview-empty"; route: OnboardingRoute }
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
    importGateLocked: boolean;
  } | null;
  overview: Pick<OverviewPageDto, "accounts" | "importedAt"> | null;
  overviewLoadedForImportFinishedAt: string | null;
};

function importTask(facts: OnboardingFacts) {
  return facts.automation?.tasks.find((item) => item.id === "import-downloads-csv") ?? null;
}

export function hasExistingProductData(facts: OnboardingFacts) {
  const importer = importTask(facts);
  return Boolean(
    facts.overview?.accounts.length
    || facts.overview?.importedAt
    || (importer?.status === "completed" && importer.latestFinishedAt),
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
    (item) => item.kind === "crawler" && item.credentialGroupId === state.selectedCredentialGroupId,
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

function overviewIsFreshForImport(
  facts: OnboardingFacts,
  importer: OnboardingTask,
) {
  if (!importer.latestFinishedAt) return false;
  if (facts.overviewLoadedForImportFinishedAt === importer.latestFinishedAt) return true;
  const overviewImportedAt = Date.parse(facts.overview?.importedAt ?? "");
  const importFinishedAt = Date.parse(importer.latestFinishedAt);
  return Number.isFinite(overviewImportedAt)
    && Number.isFinite(importFinishedAt)
    && overviewImportedAt >= importFinishedAt;
}

export function resolveOnboardingStep(
  facts: OnboardingFacts,
  state: OnboardingState | null,
): OnboardingStep {
  if (!state || state.status !== "active" || !facts.automation || !facts.overview) return "hidden";
  const importer = importTask(facts);
  const crawler = selectedTask(facts, state);
  const freshCollection = taskStartedAtOrAfter(crawler, state.sourceConfiguredAt);
  const freshImport = freshCollection && taskStartedAtOrAfter(importer, crawler?.latestFinishedAt ?? null);
  const importComplete = freshImport && importer?.status === "completed";
  if (!importComplete && facts.route !== "automation") return "automation-nav";
  const group = selectedGroup(facts, state);
  if (
    !state.selectedCredentialGroupId
    || !state.sourceConfiguredAt
    || !groupReady(facts, group)
  ) return "credentials";
  if (!crawler || !freshCollection) return "collection";
  if (crawler.status === "waiting_for_human") return "assist";
  if (crawler.status === "failed") return "collection-failed";
  const collectionComplete = crawler.status === "completed"
    || (crawler.status === "partial" && !facts.automation.importGateLocked);
  if (!collectionComplete) return "collection";
  if (!freshImport) return "import";
  if (importer?.status === "failed") return "import-failed";
  if (!importer || !importComplete) return "import";
  if (!overviewIsFreshForImport(facts, importer)) return "overview";
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
  if (step === "overview-empty") return { kind: "overview-empty", route };
  if (step === "complete") return { kind: "complete" };
  const taskId = step === "import" || step === "import-failed"
    ? "import-downloads-csv"
    : state.selectedCredentialGroupId;
  const action = step.endsWith("failed") ? "logs" : "primary";
  return taskId ? { kind: "task", taskId, action } : null;
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
