import type { OnboardingRoute } from "./progression.ts";

export const ONBOARDING_STORY_ID = "first-overview-v1" as const;
export type OnboardingStoryId = typeof ONBOARDING_STORY_ID;

export type OnboardingNodeId =
  | "source-entry"
  | "source-selection"
  | "credentials"
  | "collection"
  | "collection-progress"
  | "collection-failed"
  | "workflow-review"
  | "overview-preparing"
  | "overview-preparation-failed"
  | "overview-empty"
  | "complete";

export type OnboardingCopyKey =
  | "sourceEntry"
  | "sourceSelection"
  | "credentials"
  | "collection"
  | "collectionProgress"
  | "collectionFailed"
  | "workflowReview"
  | "overviewPreparing"
  | "overviewPreparationFailed"
  | "overviewEmpty"
  | "complete";

export type OnboardingDisabledReason =
  | "workflowRunning"
  | "overviewPreparing"
  | "workflowAlreadyCompleted"
  | "restartCancelling";

export type OnboardingCommandId =
  | "previous"
  | "exit"
  | "cancelWorkflow"
  | "retryWorkflow"
  | "retryOverview"
  | "addSource"
  | "finish"
  | "returnToOverview";

export type OnboardingPresentation = "none" | "close-credentials" | "show-picker" | "show-details";

export type OnboardingStoryEvent =
  | { type: "open-picker" }
  | { type: "choose-source"; credentialGroupId: string }
  | { type: "source-saved"; credentialGroupId: string; configuredAt: string };

export type OnboardingStoryNode = {
  id: OnboardingNodeId;
  /** Visible story ordinal. Several runtime nodes intentionally share one stage. */
  ordinal: 1 | 2 | 3 | 4 | 5;
  copyKey: OnboardingCopyKey;
  targetId: string | null;
  route: OnboardingRoute;
  commands: readonly OnboardingCommandId[];
  previous?: {
    nodeId: OnboardingNodeId;
    presentation: OnboardingPresentation;
  };
  previousDisabledReason?: OnboardingDisabledReason;
};

export type OnboardingCommandView = {
  id: OnboardingCommandId;
  enabled: boolean;
  disabledReason: OnboardingDisabledReason | null;
};

export type OnboardingStoryView = Omit<OnboardingStoryNode, "commands"> & {
  storyId: OnboardingStoryId;
  total: 5;
  commands: readonly OnboardingCommandView[];
};

/**
 * The story is the sole authority for visible copy, ordinal, target, route,
 * offered commands, and the safe Previous destination for every UI node.
 */
export const FIRST_OVERVIEW_STORY = {
  id: ONBOARDING_STORY_ID,
  firstNode: "source-entry",
  total: 5,
  nodes: {
    "source-entry": {
      id: "source-entry",
      ordinal: 1,
      copyKey: "sourceEntry",
      targetId: "automation.credentials",
      route: "automation",
      commands: ["exit"],
    },
    "source-selection": {
      id: "source-selection",
      ordinal: 2,
      copyKey: "sourceSelection",
      targetId: "automation.credentials",
      route: "automation",
      commands: ["previous", "exit"],
      previous: { nodeId: "source-entry", presentation: "close-credentials" },
    },
    credentials: {
      id: "credentials",
      ordinal: 3,
      copyKey: "credentials",
      targetId: "automation.credentials",
      route: "automation",
      commands: ["previous", "exit"],
      previous: { nodeId: "source-selection", presentation: "show-picker" },
    },
    collection: {
      id: "collection",
      ordinal: 4,
      copyKey: "collection",
      targetId: "automation.run",
      route: "automation",
      commands: ["previous", "exit"],
      previous: { nodeId: "credentials", presentation: "show-details" },
    },
    "collection-progress": {
      id: "collection-progress",
      ordinal: 4,
      copyKey: "collectionProgress",
      targetId: "automation.progress",
      route: "automation",
      commands: ["previous", "cancelWorkflow", "exit"],
      previous: { nodeId: "credentials", presentation: "show-details" },
      previousDisabledReason: "workflowRunning",
    },
    "collection-failed": {
      id: "collection-failed",
      ordinal: 4,
      copyKey: "collectionFailed",
      targetId: "automation.progress",
      route: "automation",
      commands: ["previous", "retryWorkflow", "exit"],
      previous: { nodeId: "credentials", presentation: "show-details" },
    },
    "workflow-review": {
      id: "workflow-review",
      ordinal: 4,
      copyKey: "workflowReview",
      targetId: "automation.progress",
      route: "automation",
      commands: ["previous", "returnToOverview", "exit"],
      previous: { nodeId: "credentials", presentation: "none" },
      previousDisabledReason: "workflowAlreadyCompleted",
    },
    "overview-preparing": {
      id: "overview-preparing",
      ordinal: 5,
      copyKey: "overviewPreparing",
      targetId: "automation.progress",
      route: "automation",
      commands: ["previous", "exit"],
      previous: { nodeId: "workflow-review", presentation: "none" },
      previousDisabledReason: "overviewPreparing",
    },
    "overview-preparation-failed": {
      id: "overview-preparation-failed",
      ordinal: 5,
      copyKey: "overviewPreparationFailed",
      targetId: "automation.progress",
      route: "automation",
      commands: ["previous", "retryOverview", "exit"],
      previous: { nodeId: "workflow-review", presentation: "none" },
    },
    "overview-empty": {
      id: "overview-empty",
      ordinal: 5,
      copyKey: "overviewEmpty",
      targetId: "overview.empty",
      route: "overview",
      commands: ["previous", "addSource", "finish"],
      previous: { nodeId: "workflow-review", presentation: "none" },
    },
    complete: {
      id: "complete",
      ordinal: 5,
      copyKey: "complete",
      targetId: "overview.summary",
      route: "overview",
      commands: ["previous", "addSource", "finish"],
      previous: { nodeId: "workflow-review", presentation: "none" },
    },
  },
} as const satisfies {
  id: OnboardingStoryId;
  firstNode: OnboardingNodeId;
  total: 5;
  nodes: Record<OnboardingNodeId, OnboardingStoryNode>;
};

export function onboardingStoryNode(
  storyId: string,
  nodeId: string,
): OnboardingStoryNode | null {
  if (storyId !== FIRST_OVERVIEW_STORY.id) return null;
  return FIRST_OVERVIEW_STORY.nodes[nodeId as OnboardingNodeId] ?? null;
}
