import type { AutomationTaskRow } from "../automation/types.ts";
import {
  FIRST_OVERVIEW_STORY,
  ONBOARDING_STORY_ID,
  type OnboardingNodeId,
  type OnboardingStoryId,
} from "./story.ts";

export const ONBOARDING_STORAGE_KEY = "octopusbeak-onboarding-v2";

export type OnboardingStatus = "active" | "exited" | "completed";
export type OnboardingOverviewReadiness = "accounts" | "empty" | "workflow-no-data";
export type OnboardingPhase =
  | "setup"
  | "running"
  | "preparing-overview"
  | "overview-error"
  | "overview"
  | "failed";
export type OnboardingRun = {
  taskId: string;
  runId: string | null;
  startedAt: string | null;
  /** Renderer-owned identity for a start request before the task run ID arrives. */
  startToken?: string | null;
};
export type OnboardingState = {
  version: 5;
  status: OnboardingStatus;
  phase: OnboardingPhase;
  storyId: OnboardingStoryId;
  storyNodeId: OnboardingNodeId;
  selectedCredentialGroupId: string | null;
  sourceConfiguredAt: string | null;
  progressionId: string;
  trackedRun: OnboardingRun | null;
  /** Readiness evidence accepted before onboarding navigated to Overview. */
  overviewReadiness: OnboardingOverviewReadiness | null;
  error: string | null;
  /** When the progression completed or exited; null while active or for records from before v5. */
  endedAt: string | null;
};

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

const PHASES: readonly OnboardingPhase[] = [
  "setup",
  "running",
  "preparing-overview",
  "overview-error",
  "overview",
  "failed",
];
const STATUSES: readonly OnboardingStatus[] = ["active", "exited", "completed"];
const OVERVIEW_READINESS: readonly OnboardingOverviewReadiness[] = ["accounts", "empty", "workflow-no-data"];
const STORY_NODES = Object.keys(FIRST_OVERVIEW_STORY.nodes) as OnboardingNodeId[];

export function canSubmitCredentials(onboarding: boolean, ready: boolean) {
  return !onboarding || ready;
}

export function createOnboardingState(
  previous: Pick<OnboardingState, "selectedCredentialGroupId" | "sourceConfiguredAt"> | null = null,
  now = new Date().toISOString(),
  progressionId: string = globalThis.crypto?.randomUUID?.() ?? `onboarding-${Date.now()}`,
): OnboardingState {
  return {
    version: 5,
    status: "active",
    phase: "setup",
    storyId: ONBOARDING_STORY_ID,
    // Every fresh progression begins at the explicit entry node, even when a
    // previously selected source can be reused by the credential form.
    storyNodeId: "source-entry",
    selectedCredentialGroupId: previous?.selectedCredentialGroupId ?? null,
    // Selection alone is not evidence that credentials or source settings
    // were saved. Preserve only configuration evidence that already existed.
    sourceConfiguredAt: previous?.sourceConfiguredAt ?? null,
    progressionId,
    trackedRun: null,
    overviewReadiness: null,
    error: null,
    endedAt: null,
  };
}

function isDateOrNull(value: unknown) {
  return value === null || (
    typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value
  );
}

function isRun(value: unknown): value is OnboardingRun | null {
  return value === null || Boolean(
    value
    && typeof value === "object"
    && typeof (value as OnboardingRun).taskId === "string"
    && (typeof (value as OnboardingRun).runId === "string" || (value as OnboardingRun).runId === null)
    && (typeof (value as OnboardingRun).startedAt === "string" || (value as OnboardingRun).startedAt === null)
    && ((value as OnboardingRun).startToken === undefined
      || typeof (value as OnboardingRun).startToken === "string"
      || (value as OnboardingRun).startToken === null)
  );
}

function migratedNode(phase: OnboardingPhase, readiness: OnboardingOverviewReadiness | null): OnboardingNodeId {
  if (phase === "running") return "collection-progress";
  if (phase === "preparing-overview") return "overview-preparing";
  if (phase === "overview-error") return "overview-preparation-failed";
  if (phase === "failed") return "collection-failed";
  if (phase === "overview") {
    if (readiness === "accounts") return "complete";
    if (readiness === "empty" || readiness === "workflow-no-data") return "overview-empty";
    return "overview-preparation-failed";
  }
  return "source-entry";
}

function validLegacyV2(value: Record<string, unknown>) {
  return ["active", "paused", "completed"].includes(String(value.status))
    && (typeof value.selectedCredentialGroupId === "string" || value.selectedCredentialGroupId === null)
    && isDateOrNull(value.sourceConfiguredAt);
}

function validLegacyV3(value: Record<string, unknown>) {
  return ["active", "exited", "completed"].includes(String(value.status))
    && PHASES.includes(value.phase as OnboardingPhase)
    && (typeof value.selectedCredentialGroupId === "string" || value.selectedCredentialGroupId === null)
    && isDateOrNull(value.sourceConfiguredAt)
    && typeof value.progressionId === "string"
    && isRun(value.trackedRun)
    && (value.overviewReadiness === undefined
      || value.overviewReadiness === null
      || OVERVIEW_READINESS.includes(value.overviewReadiness as OnboardingOverviewReadiness))
    && (typeof value.error === "string" || value.error === null);
}

function validCurrentState(value: Record<string, unknown>) {
  return STATUSES.includes(value.status as OnboardingStatus)
    && PHASES.includes(value.phase as OnboardingPhase)
    && (typeof value.selectedCredentialGroupId === "string" || value.selectedCredentialGroupId === null)
    && isDateOrNull(value.sourceConfiguredAt)
    && typeof value.progressionId === "string"
    && isRun(value.trackedRun)
    && (value.overviewReadiness === null
      || OVERVIEW_READINESS.includes(value.overviewReadiness as OnboardingOverviewReadiness))
    && (typeof value.error === "string" || value.error === null);
}

export function readOnboardingState(storage: StorageReader = localStorage): OnboardingState | null {
  try {
    const value = JSON.parse(storage.getItem(ONBOARDING_STORAGE_KEY) ?? "null") as Record<string, unknown> | null;
    if (!value || typeof value !== "object") return null;
    if (value.version === 2) {
      if (!validLegacyV2(value)) return null;
      return {
        ...createOnboardingState(null, new Date().toISOString(), "migrated-onboarding"),
        status: value.status === "completed" ? "completed" : "exited",
        selectedCredentialGroupId: value.selectedCredentialGroupId as string | null,
        sourceConfiguredAt: value.sourceConfiguredAt as string | null,
      };
    }
    if (value.version === 3) {
      if (!validLegacyV3(value)) return null;
      const overviewReadiness = (value.overviewReadiness ?? null) as OnboardingOverviewReadiness | null;
      const phase = value.phase as OnboardingPhase;
      return {
        ...(value as unknown as Omit<OnboardingState, "version" | "storyId" | "storyNodeId" | "endedAt">),
        version: 5,
        endedAt: null,
        storyId: ONBOARDING_STORY_ID,
        // Legacy state never persisted presentation state. Only lifecycle facts
        // with durable meaning are mapped; setup always returns to the entry.
        storyNodeId: migratedNode(phase, overviewReadiness),
        overviewReadiness,
      };
    }
    if (value.version !== 4 && value.version !== 5) return null;
    if (!validCurrentState(value) || (value.version === 5 && !isDateOrNull(value.endedAt))) return null;

    const storyIsCurrent = value.storyId === ONBOARDING_STORY_ID;
    const nodeIsCurrent = STORY_NODES.includes(value.storyNodeId as OnboardingNodeId);
    return {
      ...(value as unknown as OnboardingState),
      version: 5,
      // v4 never recorded when a progression ended.
      endedAt: value.version === 5 ? value.endedAt as string | null : null,
      // Invalid story metadata resets only guidance. Run identity, readiness,
      // source selection, and lifecycle are retained for safety.
      storyId: ONBOARDING_STORY_ID,
      storyNodeId: storyIsCurrent && nodeIsCurrent
        ? value.storyNodeId as OnboardingNodeId
        : migratedNode(
            value.phase as OnboardingPhase,
            value.overviewReadiness as OnboardingOverviewReadiness | null,
          ),
    };
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

export function onboardingTaskDisclosure(
  nodeId: OnboardingNodeId,
  selectedCredentialGroupId: string | null,
  tasks: readonly AutomationTaskRow[],
) {
  const target = ["collection", "collection-progress", "collection-failed", "overview-empty", "workflow-review"].includes(nodeId)
    ? tasks.find((task) => task.credentialGroupId === selectedCredentialGroupId)
    : null;
  if (!target) return null;
  return {
    stageId: "sync",
    showAllCollectTasks: false,
  };
}
