import assert from "node:assert/strict";
import test from "node:test";
import type { OnboardingFacts } from "./progression.ts";
import {
  createOnboardingController,
  requiredOnboardingRoute,
} from "./controller.ts";
import {
  createOnboardingState,
  type OnboardingOverviewReadiness,
  type OnboardingRun,
  type OnboardingState,
} from "./state.ts";

const timestamp = "2026-10-04T04:00:00.000Z";
const task = {
  id: "bank-task",
  runId: "run-1",
  status: "completed",
  isActive: false,
  latestStartedAt: "2026-10-04T03:00:00.000Z",
  latestFinishedAt: "2026-10-04T03:30:00.000Z",
  kind: "sync",
  credentialGroupId: "bank",
  appWorkflowOutcome: null,
} as const;

function facts(
  override: Partial<OnboardingFacts["automation"]> & { route?: OnboardingFacts["route"] } = {},
): OnboardingFacts {
  const { route = "automation", ...automationOverride } = override;
  return {
    route,
    automation: {
      tasks: [task],
      credentialGroups: [{
        id: "bank",
        enabled: true,
        statementSetupRequired: false,
        credentialKeys: [],
      }],
      credentials: {},
      ...automationOverride,
    },
    overview: { accounts: [], importedAt: null, availability: "empty" },
  };
}

function configuredState(
  phase: OnboardingState["phase"] = "setup",
  trackedRun: OnboardingRun | null = null,
): OnboardingState {
  const storyNodeId = {
    setup: "collection",
    running: "collection-progress",
    "preparing-overview": "overview-preparing",
    "overview-error": "overview-preparation-failed",
    overview: "complete",
    failed: "collection-failed",
  }[phase] as OnboardingState["storyNodeId"];
  return {
    ...createOnboardingState(null, timestamp, "progress-1"),
    selectedCredentialGroupId: "bank",
    sourceConfiguredAt: timestamp,
    phase,
    storyNodeId,
    overviewReadiness: phase === "overview" ? "empty" : null,
    trackedRun,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function harness(options: {
  prepareOverview?: (run: OnboardingRun) => Promise<OnboardingOverviewReadiness>;
  cancelRun?: (run: OnboardingRun) => Promise<void>;
} = {}) {
  const persisted: OnboardingState[] = [];
  const navigated: string[] = [];
  let clock = Date.parse(timestamp);
  const controller = createOnboardingController({
    persist: (state) => persisted.push(state),
    now: () => new Date(clock++).toISOString(),
    navigate: (route) => navigated.push(route),
    prepareOverview: options.prepareOverview ?? (async () => "empty"),
    cancelRun: options.cancelRun ?? (async () => {}),
  });
  return { controller, persisted, navigated };
}

test("route permissions keep active onboarding on its current stage and release it after exit", () => {
  assert.equal(requiredOnboardingRoute(configuredState("setup")), "automation");
  assert.equal(requiredOnboardingRoute(configuredState("preparing-overview")), "automation");
  assert.equal(requiredOnboardingRoute(configuredState("overview")), "overview");
  assert.equal(requiredOnboardingRoute({ ...configuredState(), status: "exited" }), null);
  assert.equal(requiredOnboardingRoute({ ...configuredState(), status: "completed" }), null);
});

test("controller story view advances only on explicit source events and Previous restores the offered panel", () => {
  const { controller } = harness();
  controller.begin();
  let view = controller.getStoryView();
  assert.equal(view?.id, "source-entry");
  assert.equal(view?.ordinal, 1);
  assert.equal(view?.copyKey, "sourceEntry");
  assert.equal(view?.targetId, "automation.credentials");

  assert.equal(controller.openSourcePicker(), true);
  view = controller.getStoryView();
  assert.equal(view?.id, "source-selection");
  assert.equal(view?.ordinal, 2);
  assert.ok(view?.commands.some((command) => command.id === "previous" && command.enabled));

  assert.equal(controller.chooseSource("bank"), true);
  view = controller.getStoryView();
  assert.equal(view?.id, "credentials");
  assert.equal(view?.ordinal, 3);
  assert.equal(controller.state?.selectedCredentialGroupId, "bank");

  const backToPicker = controller.previous();
  assert.deepEqual(backToPicker, {
    nodeId: "source-selection",
    presentation: "show-picker",
    credentialGroupId: "bank",
  });
  assert.equal(controller.getStoryView()?.ordinal, 2);
  const backToEntry = controller.previous();
  assert.equal(backToEntry?.presentation, "close-credentials");
  assert.equal(controller.getStoryView()?.ordinal, 1);
});

test("Previous from workflow setup returns to reusable details and retains the selected source", () => {
  const { controller } = harness();
  controller.hydrate(configuredState());
  const transition = controller.previous();
  assert.deepEqual(transition, {
    nodeId: "credentials",
    presentation: "show-details",
    credentialGroupId: "bank",
  });
  assert.equal(controller.state?.phase, "setup");
  assert.equal(controller.state?.storyNodeId, "credentials");
  assert.equal(controller.state?.selectedCredentialGroupId, "bank");
  assert.equal(controller.state?.trackedRun, null);
});

test("Previous is disabled while a workflow is active, without cancelling or replaying it", () => {
  const { controller } = harness();
  controller.hydrate(configuredState());
  const token = controller.workflowStarting("bank-task", "bank");
  assert.ok(token);
  const previous = controller.getStoryView()?.commands.find((command) => command.id === "previous");
  assert.equal(previous?.enabled, false);
  assert.equal(previous?.disabledReason, "workflowRunning");
  assert.equal(controller.previous(), null);
  assert.equal(controller.state?.phase, "running");
  assert.equal(controller.state?.storyNodeId, "collection-progress");
});

test("only a completed matching run prepares Overview, and a fresh empty read completes that stage", async () => {
  const prepareCalls: OnboardingRun[] = [];
  const { controller, navigated } = harness({
    prepareOverview: async (run) => {
      prepareCalls.push(run);
      return "empty";
    },
  });
  const run = { taskId: "bank-task", runId: "run-1", startedAt: timestamp };
  controller.hydrate(configuredState("running", run));

  await controller.reconcile(facts());
  assert.deepEqual(prepareCalls, [run]);
  assert.equal(controller.state?.phase, "overview");
  assert.equal(controller.state?.overviewReadiness, "empty");
  assert.deepEqual(navigated, ["overview"]);

  const previous = controller.previous();
  assert.deepEqual(previous, {
    nodeId: "workflow-review",
    presentation: "none",
    credentialGroupId: "bank",
  });
  assert.equal(requiredOnboardingRoute(controller.state), "automation");
  assert.equal(controller.state?.phase, "overview");
  assert.equal(controller.state?.overviewReadiness, "empty");
  assert.equal(controller.getStoryView()?.id, "workflow-review");
  assert.equal(
    controller.getStoryView()?.commands.find((command) => command.id === "previous")?.disabledReason,
    "workflowAlreadyCompleted",
  );
  assert.equal(await controller.returnToOverview(), true);
  assert.equal(controller.state?.storyNodeId, "overview-empty");
  assert.deepEqual(navigated, ["overview", "automation", "overview"]);
  assert.deepEqual(prepareCalls, [run]);
});

test("a tracked no-data preparation persists its readiness classification", async () => {
  const { controller } = harness({
    prepareOverview: async () => "workflow-no-data",
  });
  controller.hydrate(configuredState("running", {
    taskId: "bank-task",
    runId: "run-1",
    startedAt: timestamp,
  }));

  await controller.reconcile(facts());
  assert.equal(controller.state?.phase, "overview");
  assert.equal(controller.state?.overviewReadiness, "workflow-no-data");
});

test("an old overview phase without fresh readiness proof returns to retryable preparation", async () => {
  const { controller, navigated } = harness();
  controller.hydrate(configuredState("overview", {
    taskId: "bank-task",
    runId: "run-1",
    startedAt: timestamp,
  }));
  const awaitingFacts = {
    ...facts({ route: "overview" }),
    overview: { accounts: [], importedAt: null, availability: "awaiting" as const },
  };

  await controller.reconcile(awaitingFacts);
  assert.equal(controller.state?.phase, "overview-error");
  assert.equal(controller.state?.overviewReadiness, null);
  assert.deepEqual(navigated, ["automation"]);
});

test("a persisted tracked run fails visibly when another concrete run replaced it", async () => {
  let prepareCalls = 0;
  const { controller } = harness({
    prepareOverview: async () => {
      prepareCalls += 1;
      return "empty";
    },
  });
  controller.hydrate(configuredState("running", {
    taskId: "bank-task",
    runId: "run-old",
    startedAt: timestamp,
  }));

  await controller.reconcile(facts({ tasks: [{ ...task, runId: "run-new", status: "running", isActive: true }] }));
  assert.equal(controller.state?.phase, "failed");
  assert.equal(controller.state?.error, "workflow-replaced");
  assert.equal(prepareCalls, 0);
});

test("Overview read errors remain retryable and a retry establishes a fresh preparation", async () => {
  let reads = 0;
  const { controller, navigated } = harness({
    prepareOverview: async () => {
      reads += 1;
      if (reads === 1) throw new Error("data view unavailable");
      return "empty";
    },
  });
  controller.hydrate(configuredState("running", {
    taskId: "bank-task",
    runId: "run-1",
    startedAt: timestamp,
  }));

  await controller.reconcile(facts());
  assert.equal(controller.state?.phase, "overview-error");
  assert.equal(controller.state?.error, "data view unavailable");
  assert.deepEqual(navigated, []);

  await controller.retryOverview();
  assert.equal(controller.state?.phase, "overview");
  assert.deepEqual(navigated, ["overview"]);
});

test("Previous from preparation failure enters run review and Return explicitly retries the missing readiness read", async () => {
  let reads = 0;
  const { controller, navigated } = harness({
    prepareOverview: async () => {
      reads += 1;
      if (reads === 1) throw new Error("temporary Overview read failure");
      return "empty";
    },
  });
  controller.hydrate(configuredState("running", {
    taskId: "bank-task",
    runId: "run-1",
    startedAt: timestamp,
  }));
  await controller.reconcile(facts());
  assert.equal(controller.state?.phase, "overview-error");
  assert.equal(controller.state?.storyNodeId, "overview-preparation-failed");

  const previous = controller.previous();
  assert.equal(previous?.nodeId, "workflow-review");
  assert.equal(previous?.presentation, "none");
  assert.equal(requiredOnboardingRoute(controller.state), "automation");
  const returnCommand = controller.getStoryView()?.commands.find((command) => command.id === "returnToOverview");
  assert.equal(returnCommand?.enabled, true);
  assert.equal(await controller.returnToOverview(), true);
  assert.equal(reads, 2);
  assert.equal(controller.state?.phase, "overview");
  assert.equal(controller.state?.overviewReadiness, "empty");
  assert.deepEqual(navigated, ["overview"]);
});

test("exit during Overview preparation invalidates its late completion and navigation", async () => {
  const pendingRead = deferred<OnboardingOverviewReadiness>();
  const { controller, navigated } = harness({ prepareOverview: () => pendingRead.promise });
  controller.hydrate(configuredState("running", {
    taskId: "bank-task",
    runId: "run-1",
    startedAt: timestamp,
  }));

  const preparation = controller.reconcile(facts());
  assert.equal(controller.state?.phase, "preparing-overview");
  controller.exit();
  pendingRead.resolve("empty");
  await preparation;

  assert.equal(controller.state?.status, "exited");
  assert.equal(controller.state?.phase, "preparing-overview");
  assert.deepEqual(navigated, []);
});

test("restart waits for an in-flight start, then for exact-run cancellation before creating a new progression", async () => {
  const cancellation = deferred<void>();
  const cancelCalls: OnboardingRun[] = [];
  const { controller, navigated } = harness({
    cancelRun: (run) => {
      cancelCalls.push(run);
      return cancellation.promise;
    },
  });
  controller.hydrate(configuredState());
  const token = controller.workflowStarting("bank-task", "bank");
  assert.ok(token);
  const oldProgressionId = controller.state?.progressionId;

  let restarted = false;
  const restart = controller.restart().then((result) => {
    restarted = result;
    return result;
  });
  await Promise.resolve();
  assert.deepEqual(cancelCalls, []);

  controller.workflowStarted(token, { taskId: "bank-task", runId: "run-pending-start" });
  await Promise.resolve();
  assert.deepEqual(cancelCalls, [{
    taskId: "bank-task",
    runId: "run-pending-start",
    startedAt: token.startedAt,
    startToken: token.startToken,
  }]);
  assert.equal(controller.state?.progressionId, oldProgressionId);
  assert.equal(restarted, false);

  cancellation.resolve();
  assert.equal(await restart, true);
  assert.notEqual(controller.state?.progressionId, oldProgressionId);
  assert.equal(controller.state?.trackedRun, null);
  assert.equal(controller.state?.storyNodeId, "source-entry");
  assert.equal(controller.state?.selectedCredentialGroupId, "bank");
  assert.deepEqual(navigated, ["automation"]);
});

test("explicit Cancel waits for an in-flight start before cancelling its run identity", async () => {
  const cancellation = deferred<void>();
  const cancelCalls: OnboardingRun[] = [];
  const { controller } = harness({
    cancelRun: (run) => {
      cancelCalls.push(run);
      return cancellation.promise;
    },
  });
  controller.hydrate(configuredState());
  const token = controller.workflowStarting("bank-task", "bank");
  assert.ok(token);
  const cancellationRequest = controller.cancelWorkflow();
  await Promise.resolve();
  assert.deepEqual(cancelCalls, []);

  controller.workflowStarted(token, { taskId: "bank-task", runId: "run-created-after-click" });
  await Promise.resolve();
  assert.deepEqual(cancelCalls, [{
    taskId: "bank-task",
    runId: "run-created-after-click",
    startedAt: token.startedAt,
    startToken: token.startToken,
  }]);
  cancellation.resolve();
  assert.equal(await cancellationRequest, true);
});

test("late start response from an earlier same-task retry cannot bind to the newer run", () => {
  const { controller } = harness();
  controller.hydrate(configuredState());
  const oldToken = controller.workflowStarting("bank-task", "bank");
  assert.ok(oldToken);
  controller.workflowStartFailed(oldToken, "temporary failure");
  const newToken = controller.workflowStarting("bank-task", "bank");
  assert.ok(newToken);
  assert.notEqual(newToken.startToken, oldToken.startToken);

  controller.workflowStarted(oldToken, { taskId: "bank-task", runId: "old-run" });
  assert.equal(controller.state?.trackedRun?.runId, null);
  controller.workflowStarted(newToken, { taskId: "bank-task", runId: "new-run" });
  assert.equal(controller.state?.trackedRun?.runId, "new-run");
});

test("restart cancellation failures stay visible and do not create a new progression", async () => {
  const { controller, navigated } = harness({
    cancelRun: async () => { throw new Error("cancellation did not settle"); },
  });
  const previous = configuredState("running", {
    taskId: "bank-task",
    runId: "run-1",
    startedAt: timestamp,
  });
  controller.hydrate(previous);

  assert.equal(await controller.restart(), false);
  assert.equal(controller.state?.status, "exited");
  assert.equal(controller.state?.progressionId, previous.progressionId);
  assert.equal(controller.state?.error, "cancellation did not settle");
  assert.deepEqual(navigated, []);
});

test("rehydrating a pending overview preparation retries the persisted stage", async () => {
  let reads = 0;
  const { controller, navigated } = harness({
    prepareOverview: async () => {
      reads += 1;
      return "empty";
    },
  });
  controller.hydrate(configuredState("preparing-overview", {
    taskId: "bank-task",
    runId: "run-1",
    startedAt: timestamp,
  }));
  await controller.reconcile(facts());
  assert.equal(reads, 1);
  assert.equal(controller.state?.phase, "overview");
  assert.deepEqual(navigated, ["overview"]);
});
