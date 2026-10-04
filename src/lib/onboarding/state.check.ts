import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationTaskRow } from "../automation/types.ts";
import type { OnboardingFacts } from "./progression.ts";
import { FIRST_OVERVIEW_STORY } from "./story.ts";
import {
  canSubmitCredentials,
  createOnboardingState,
  onboardingTaskDisclosure,
  readOnboardingState,
  writeOnboardingState,
  ONBOARDING_STORAGE_KEY,
} from "./state.ts";
import { hasExistingProductData, shouldNarrowOnboardingSources } from "./progression.ts";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const task = {
  id: "bank-task",
  runId: "old-run",
  kind: "sync",
  credentialGroupId: "bank",
  status: "completed",
  isActive: false,
  latestStartedAt: "2026-10-03T09:00:00.000Z",
  latestFinishedAt: "2026-10-03T09:01:00.000Z",
  appWorkflowOutcome: null,
} as const;

const facts: OnboardingFacts = {
  route: "automation",
  automation: {
    tasks: [task],
    credentialGroups: [{
      id: "bank",
      enabled: true,
      statementSetupRequired: false,
      credentialKeys: ["username", "password"],
    }],
    credentials: { username: true, password: true },
  },
  overview: { accounts: [], importedAt: null, availability: "empty" },
};

test("story definition owns stable ordinals, copy, targets, routes, and commands", () => {
  const nodes = Object.values(FIRST_OVERVIEW_STORY.nodes);
  assert.equal(FIRST_OVERVIEW_STORY.total, 5);
  assert.equal(FIRST_OVERVIEW_STORY.nodes["source-entry"].ordinal, 1);
  assert.equal(FIRST_OVERVIEW_STORY.nodes["source-selection"].ordinal, 2);
  assert.equal(FIRST_OVERVIEW_STORY.nodes.credentials.ordinal, 3);
  assert.equal(FIRST_OVERVIEW_STORY.nodes.collection.ordinal, 4);
  assert.equal(FIRST_OVERVIEW_STORY.nodes["collection-progress"].ordinal, 4);
  assert.equal(FIRST_OVERVIEW_STORY.nodes["workflow-review"].ordinal, 4);
  assert.equal(FIRST_OVERVIEW_STORY.nodes.complete.ordinal, 5);
  for (const [nodeId, node] of Object.entries(FIRST_OVERVIEW_STORY.nodes)) {
    assert.equal(node.id, nodeId);
    assert.ok(node.copyKey);
    assert.ok(node.route);
    assert.ok(Array.isArray(node.commands));
  }
  assert.equal(FIRST_OVERVIEW_STORY.nodes["workflow-review"].targetId, "automation.progress");
  assert.deepEqual(FIRST_OVERVIEW_STORY.nodes["workflow-review"].commands, [
    "previous", "returnToOverview", "exit",
  ]);
});

test("fresh and restarted state always returns to the entry while preserving the selected institution", () => {
  const configured = {
    ...createOnboardingState(null, "2026-10-01T00:00:00.000Z", "old-progress"),
    selectedCredentialGroupId: "bank",
    storyNodeId: "credentials" as const,
    sourceConfiguredAt: "2026-10-01T00:00:00.000Z",
    phase: "running" as const,
    trackedRun: { taskId: "bank-task", runId: "old-run", startedAt: "2026-10-02T00:00:00.000Z" },
  };
  const fresh = createOnboardingState(null, "2026-10-04T00:00:00.000Z", "fresh");
  const restarted = createOnboardingState(configured, "2026-10-04T00:00:00.000Z", "new-progress");

  assert.equal(fresh.storyNodeId, "source-entry");
  assert.equal(fresh.selectedCredentialGroupId, null);
  assert.equal(restarted.storyNodeId, "source-entry");
  assert.equal(restarted.selectedCredentialGroupId, "bank");
  assert.equal(restarted.sourceConfiguredAt, "2026-10-01T00:00:00.000Z");
  assert.equal(restarted.phase, "setup");
  assert.equal(restarted.trackedRun, null);
  assert.equal(restarted.progressionId, "new-progress");
});

test("restarting with a selected but unconfigured institution does not invent saved configuration evidence", () => {
  const selectedButUnconfigured = {
    ...createOnboardingState(null, "2026-10-01T00:00:00.000Z", "old-progress"),
    selectedCredentialGroupId: "bank",
  };
  const restarted = createOnboardingState(selectedButUnconfigured, "2026-10-04T00:00:00.000Z", "new-progress");

  assert.equal(restarted.storyNodeId, "source-entry");
  assert.equal(restarted.selectedCredentialGroupId, "bank");
  assert.equal(restarted.sourceConfiguredAt, null);
});

test("v3 setup migrates to entry without discarding saved institution selection", () => {
  const storage = new MemoryStorage();
  storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
    version: 3,
    status: "active",
    phase: "setup",
    selectedCredentialGroupId: "bank",
    sourceConfiguredAt: "2026-10-01T00:00:00.000Z",
    progressionId: "v3-setup",
    trackedRun: null,
    overviewReadiness: null,
    error: null,
  }));

  const migrated = readOnboardingState(storage as unknown as Storage);
  assert.equal(migrated?.version, 4);
  assert.equal(migrated?.storyNodeId, "source-entry");
  assert.equal(migrated?.selectedCredentialGroupId, "bank");
  assert.equal(migrated?.sourceConfiguredAt, "2026-10-01T00:00:00.000Z");
});

test("v3 active run and Overview preparation migrate to matching nodes and retain exact run evidence", () => {
  const storage = new MemoryStorage();
  const run = { taskId: "bank-task", runId: "run-9", startedAt: "2026-10-04T01:00:00.000Z" };
  const legacy = {
    version: 3,
    status: "active",
    selectedCredentialGroupId: "bank",
    sourceConfiguredAt: "2026-10-01T00:00:00.000Z",
    progressionId: "v3-running",
    trackedRun: run,
    overviewReadiness: null,
    error: null,
  };
  storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ ...legacy, phase: "running" }));
  const running = readOnboardingState(storage as unknown as Storage);
  assert.equal(running?.storyNodeId, "collection-progress");
  assert.deepEqual(running?.trackedRun, run);

  storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ ...legacy, phase: "preparing-overview" }));
  const preparing = readOnboardingState(storage as unknown as Storage);
  assert.equal(preparing?.storyNodeId, "overview-preparing");
  assert.deepEqual(preparing?.trackedRun, run);
});

test("invalid story metadata resets guidance only and keeps readiness plus run identity", () => {
  const storage = new MemoryStorage();
  const state = {
    ...createOnboardingState(null, "2026-10-04T00:00:00.000Z", "preserved"),
    phase: "overview" as const,
    storyId: "removed-story",
    storyNodeId: "removed-node",
    selectedCredentialGroupId: "bank",
    trackedRun: { taskId: "bank-task", runId: "run-9", startedAt: "2026-10-04T01:00:00.000Z" },
    overviewReadiness: "workflow-no-data" as const,
  };
  storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state));

  const repaired = readOnboardingState(storage as unknown as Storage);
  assert.equal(repaired?.storyNodeId, "overview-empty");
  assert.equal(repaired?.storyId, "first-overview-v1");
  assert.equal(repaired?.progressionId, "preserved");
  assert.equal(repaired?.selectedCredentialGroupId, "bank");
  assert.deepEqual(repaired?.trackedRun, state.trackedRun);
  assert.equal(repaired?.overviewReadiness, "workflow-no-data");
});

test("current story node, lifecycle phase, and tracked run persist together", () => {
  const storage = new MemoryStorage();
  const initial = {
    ...createOnboardingState(null, "2026-10-04T00:00:00.000Z", "progress-1"),
    storyNodeId: "collection-progress" as const,
    phase: "running" as const,
    selectedCredentialGroupId: "bank",
    trackedRun: { taskId: "bank-task", runId: "run-4", startedAt: "2026-10-04T01:00:00.000Z" },
  };
  writeOnboardingState(storage as unknown as Storage, initial);
  assert.deepEqual(readOnboardingState(storage as unknown as Storage), initial);
});

test("v2 paused state migrates to exited and cannot resume its old progression", () => {
  const storage = new MemoryStorage();
  storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
    version: 2,
    status: "paused",
    selectedCredentialGroupId: "bank",
    sourceConfiguredAt: "2026-10-01T00:00:00.000Z",
  }));
  const migrated = readOnboardingState(storage as unknown as Storage);
  assert.equal(migrated?.status, "exited");
  assert.equal(migrated?.phase, "setup");
  assert.equal(migrated?.storyNodeId, "source-entry");
  assert.equal(migrated?.selectedCredentialGroupId, "bank");
  assert.equal(migrated?.trackedRun, null);
});

test("source narrowing reflects the authoritative setup node and product data", () => {
  const fresh = createOnboardingState();
  assert.equal(shouldNarrowOnboardingSources(facts, fresh, "source-entry"), true);
  assert.equal(shouldNarrowOnboardingSources(facts, fresh, "collection"), false);
  assert.equal(hasExistingProductData({ ...facts, overview: { accounts: [{ id: "a" } as never], importedAt: null, availability: "available" } }), true);
});

test("credential submit gating keeps ordinary setup available", () => {
  assert.deepEqual([
    canSubmitCredentials(true, false),
    canSubmitCredentials(true, true),
    canSubmitCredentials(false, false),
  ], [false, true, true]);
});

test("task disclosure follows explicit workflow nodes and stays scoped to the selected source", () => {
  const disclosureTask = {
    ...task,
    label: "Bank workflow",
    credentialKeys: [],
    dependencies: [],
    attempt: 1,
    maxAttempts: 1,
    events: [],
    progressPercent: null,
    progressText: "Completed",
    humanSession: null,
    humanAssistanceContract: null,
    isActive: false,
    ranToday: true,
    primaryAction: "Run again" as const,
    canRun: true,
  } satisfies AutomationTaskRow;
  for (const node of ["collection", "collection-progress", "collection-failed", "workflow-review"] as const) {
    assert.deepEqual(onboardingTaskDisclosure(node, "bank", [disclosureTask]), {
      stageId: "sync",
      showAllCollectTasks: false,
    });
  }
  assert.equal(onboardingTaskDisclosure("complete", "bank", [disclosureTask]), null);
});
