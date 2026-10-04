import type { CredentialGroupDto } from "../desktop/api.ts";
import type { AutomationTaskRow } from "../automation/types.ts";
import type { OverviewPageDto } from "../overview/types.ts";
import type { OnboardingNodeId } from "./story.ts";
import type { OnboardingState } from "./state.ts";

export type OnboardingRoute =
  | "overview"
  | "assets"
  | "liabilities"
  | "spending"
  | "automation"
  | "settings";

export type CredentialSetupResult = {
  selectedCredentialGroupId: string;
  sourceConfiguredAt: string;
};

type OnboardingTask = Pick<
  AutomationTaskRow,
  "id" | "runId" | "kind" | "credentialGroupId" | "status" | "isActive" | "latestStartedAt" | "latestFinishedAt" | "appWorkflowOutcome"
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
  overview: Pick<OverviewPageDto, "accounts" | "importedAt" | "availability"> | null;
};

export function hasExistingProductData(facts: OnboardingFacts) {
  return Boolean(facts.overview?.accounts.length || facts.overview?.importedAt);
}

export function shouldNarrowOnboardingSources(
  facts: OnboardingFacts,
  state: OnboardingState | null,
  nodeId: OnboardingNodeId,
) {
  return ["source-entry", "source-selection", "credentials"].includes(nodeId)
    && !state?.selectedCredentialGroupId
    && !hasExistingProductData(facts);
}
