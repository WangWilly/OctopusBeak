import type { AutomationTaskRow } from "../automation/types.ts";
import type { OnboardingFacts, OnboardingRoute } from "./progression.ts";
import {
  FIRST_OVERVIEW_STORY,
  onboardingStoryNode,
  type OnboardingCommandId,
  type OnboardingCommandView,
  type OnboardingDisabledReason,
  type OnboardingNodeId,
  type OnboardingPresentation,
  type OnboardingStoryView,
} from "./story.ts";
import {
  createOnboardingState,
  type OnboardingOverviewReadiness,
  type OnboardingRun,
  type OnboardingState,
} from "./state.ts";

export type OnboardingTaskFact = Pick<
  AutomationTaskRow,
  "id" | "runId" | "status" | "isActive" | "latestStartedAt" | "latestFinishedAt" | "appWorkflowOutcome"
>;

export type OnboardingWorkflowToken = {
  progressionId: string;
  startToken: string;
  startedAt: string;
};

export type OnboardingControllerPort = {
  persist(state: OnboardingState): void;
  now(): string;
  navigate(route: OnboardingRoute): void;
  prepareOverview(run: OnboardingRun): Promise<OnboardingOverviewReadiness>;
  cancelRun(run: OnboardingRun): Promise<void>;
};

export type OnboardingPreviousResult = {
  nodeId: OnboardingNodeId;
  presentation: OnboardingPresentation;
  credentialGroupId: string | null;
};

function routeFor(state: OnboardingState): OnboardingRoute {
  return onboardingStoryNode(state.storyId, state.storyNodeId)?.route ?? "automation";
}

export function requiredOnboardingRoute(state: OnboardingState | null): OnboardingRoute | null {
  if (state?.status !== "active") return null;
  return routeFor(state);
}

function sameRun(task: OnboardingTaskFact | undefined, run: OnboardingRun) {
  if (!task || task.id !== run.taskId) return false;
  if (run.runId) return task.runId === run.runId;
  if (run.startedAt && task.latestStartedAt) {
    return Date.parse(task.latestStartedAt) >= Date.parse(run.startedAt);
  }
  return false;
}

function taskForRun(facts: OnboardingFacts, run: OnboardingRun) {
  return facts.automation?.tasks.find((task) => sameRun(task, run));
}

function overviewNode(readiness: OnboardingOverviewReadiness | null): OnboardingNodeId {
  return readiness === "accounts" ? "complete" : "overview-empty";
}

export function createOnboardingController(port: OnboardingControllerPort) {
  let state: OnboardingState | null = null;
  let generation = 0;
  let prepareKey: string | null = null;
  let startSequence = 0;
  let cancelPending = false;
  let pendingStart: {
    token: OnboardingWorkflowToken;
    promise: Promise<void>;
    resolve: () => void;
  } | null = null;

  function save(next: OnboardingState) {
    state = next;
    port.persist(next);
    return next;
  }

  function workflowKey(run: OnboardingRun) {
    return `${run.taskId}:${run.runId ?? run.startToken ?? run.startedAt ?? "pending"}`;
  }

  function commandDisabledReason(
    command: OnboardingCommandId,
    restartPending: boolean,
    nodeReason: OnboardingDisabledReason | undefined,
  ): OnboardingDisabledReason | null {
    if (command === "previous") {
      if (restartPending || cancelPending) return "restartCancelling";
      if (state?.phase === "running") return "workflowRunning";
      if (state?.phase === "preparing-overview") return "overviewPreparing";
      return nodeReason ?? null;
    }
    if (restartPending || cancelPending) return "restartCancelling";
    if (command === "cancelWorkflow" && state?.phase !== "running") return "workflowRunning";
    if (command === "retryWorkflow" && state?.phase !== "failed") return "workflowRunning";
    if (command === "retryOverview" && state?.phase !== "overview-error") return "overviewPreparing";
    if (command === "returnToOverview" && !(
      (state?.phase === "overview" && state.overviewReadiness)
      || (state?.phase === "overview-error" && state.trackedRun)
    )) {
      return "overviewPreparing";
    }
    if ((command === "addSource" || command === "finish") && state?.phase !== "overview") {
      return "overviewPreparing";
    }
    return null;
  }

  function storyView(restartPending = false): OnboardingStoryView | null {
    if (!state || state.status !== "active") return null;
    const definition = onboardingStoryNode(state.storyId, state.storyNodeId);
    if (!definition) return null;
    const commands: OnboardingCommandView[] = definition.commands.map((id) => {
      const disabledReason = commandDisabledReason(
        id,
        restartPending,
        id === "previous" ? definition.previousDisabledReason : undefined,
      );
      return { id, enabled: disabledReason === null, disabledReason };
    });
    return {
      id: definition.id,
      ordinal: definition.ordinal,
      copyKey: definition.copyKey,
      targetId: definition.targetId,
      route: definition.route,
      previous: definition.previous,
      previousDisabledReason: definition.previousDisabledReason,
      storyId: FIRST_OVERVIEW_STORY.id,
      total: FIRST_OVERVIEW_STORY.total,
      commands,
    };
  }

  async function prepareOverview(run: OnboardingRun, expectedGeneration: number) {
    const key = workflowKey(run);
    if (prepareKey === key) return;
    prepareKey = key;
    save({
      ...state!,
      phase: "preparing-overview",
      storyNodeId: "overview-preparing",
      overviewReadiness: null,
      error: null,
    });
    try {
      const overviewReadiness = await port.prepareOverview(run);
      if (
        generation !== expectedGeneration
        || state?.status !== "active"
        || !state.trackedRun
        || workflowKey(state.trackedRun) !== key
      ) return;
      save({
        ...state,
        phase: "overview",
        storyNodeId: overviewNode(overviewReadiness),
        overviewReadiness,
        error: null,
      });
      port.navigate("overview");
    } catch (error) {
      if (
        generation === expectedGeneration
        && state?.status === "active"
        && state.trackedRun
        && workflowKey(state.trackedRun) === key
      ) {
        save({
          ...state,
          phase: "overview-error",
          storyNodeId: "overview-preparation-failed",
          overviewReadiness: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (prepareKey === key) prepareKey = null;
    }
  }

  return {
    get state() {
      return state;
    },

    getStoryView(restartPending = false) {
      return storyView(restartPending);
    },

    hydrate(next: OnboardingState | null) {
      generation += 1;
      state = next;
    },

    begin() {
      const next = createOnboardingState(null, port.now());
      generation += 1;
      save(next);
      port.navigate("automation");
      return next;
    },

    async restart() {
      const expectedGeneration = ++generation;
      const pending = pendingStart;
      if (pending) await pending.promise;
      if (generation !== expectedGeneration) return false;
      const previous = state;
      if (previous?.trackedRun) {
        try {
          await port.cancelRun(previous.trackedRun);
        } catch (error) {
          if (generation === expectedGeneration && previous) {
            save({
              ...previous,
              status: "exited",
              error: error instanceof Error ? error.message : String(error),
              endedAt: previous.endedAt ?? port.now(),
            });
          }
          return false;
        }
      }
      if (generation !== expectedGeneration) return false;
      const next = createOnboardingState(previous, port.now());
      save(next);
      port.navigate("automation");
      return true;
    },

    exit() {
      if (!state || state.status !== "active") return;
      generation += 1;
      save({ ...state, status: "exited", error: null, endedAt: port.now() });
    },

    finish() {
      if (
        !state
        || state.status !== "active"
        || state.phase !== "overview"
        || !["overview-empty", "complete"].includes(state.storyNodeId)
      ) return;
      generation += 1;
      save({ ...state, status: "completed", error: null, endedAt: port.now() });
    },

    addSource() {
      if (
        !state
        || state.status !== "active"
        || state.phase !== "overview"
        || !["overview-empty", "complete"].includes(state.storyNodeId)
      ) return;
      generation += 1;
      save({
        ...state,
        phase: "setup",
        storyNodeId: "source-entry",
        selectedCredentialGroupId: null,
        sourceConfiguredAt: null,
        trackedRun: null,
        overviewReadiness: null,
        error: null,
      });
      port.navigate("automation");
    },

    openSourcePicker() {
      if (!state || state.status !== "active" || state.storyNodeId !== "source-entry") return false;
      save({ ...state, storyNodeId: "source-selection" });
      return true;
    },

    chooseSource(selectedCredentialGroupId: string) {
      if (!state || state.status !== "active" || state.storyNodeId !== "source-selection") return false;
      const sameSource = state.selectedCredentialGroupId === selectedCredentialGroupId;
      save({
        ...state,
        storyNodeId: "credentials",
        selectedCredentialGroupId,
        sourceConfiguredAt: sameSource ? state.sourceConfiguredAt : null,
        trackedRun: null,
        overviewReadiness: null,
        error: null,
      });
      return true;
    },

    sourceSaved(result: { selectedCredentialGroupId: string; sourceConfiguredAt: string }) {
      if (!state || state.status !== "active" || state.storyNodeId !== "credentials") return false;
      save({
        ...state,
        phase: "setup",
        storyNodeId: "collection",
        selectedCredentialGroupId: result.selectedCredentialGroupId,
        sourceConfiguredAt: result.sourceConfiguredAt,
        trackedRun: null,
        overviewReadiness: null,
        error: null,
      });
      return true;
    },

    previous(restartPending = false): OnboardingPreviousResult | null {
      if (!state) return null;
      const view = storyView(restartPending);
      const previousCommand = view?.commands.find((command) => command.id === "previous");
      const transition = view?.previous;
      if (!previousCommand?.enabled || !transition) return null;

      const presentation = transition.presentation;
      if (state.storyNodeId === "workflow-review") return null;
      if (state.storyNodeId === "overview-empty" || state.storyNodeId === "complete") {
        // Reviewing a completed run is a stable detour. Keep phase/readiness
        // intact and require the explicit Return to Overview command.
        save({ ...state, storyNodeId: "workflow-review" });
        port.navigate("automation");
      } else if (state.storyNodeId === "collection" || state.storyNodeId === "collection-failed") {
        save({
          ...state,
          phase: "setup",
          storyNodeId: "credentials",
          trackedRun: null,
          overviewReadiness: null,
          error: null,
        });
      } else {
        save({ ...state, storyNodeId: transition.nodeId });
      }
      return {
        nodeId: transition.nodeId,
        presentation,
        credentialGroupId: state.selectedCredentialGroupId,
      };
    },

    async returnToOverview() {
      if (!state || state.status !== "active" || state.storyNodeId !== "workflow-review") return false;
      if (state.phase === "overview-error" && state.trackedRun) {
        const expectedGeneration = generation;
        await prepareOverview(state.trackedRun, expectedGeneration);
        return (state as OnboardingState | null)?.phase === "overview";
      }
      if (state.phase !== "overview" || !state.overviewReadiness) return false;
      save({ ...state, storyNodeId: overviewNode(state.overviewReadiness) });
      port.navigate("overview");
      return true;
    },

    workflowStarting(taskId: string, credentialGroupId: string | null): OnboardingWorkflowToken | null {
      if (
        !state
        || state.status !== "active"
        || !state.selectedCredentialGroupId
        || state.selectedCredentialGroupId !== credentialGroupId
        || !["setup", "failed"].includes(state.phase)
        || !["collection", "collection-failed"].includes(state.storyNodeId)
      ) return null;
      const token = {
        progressionId: state.progressionId,
        startToken: `${state.progressionId}:start:${++startSequence}`,
        startedAt: port.now(),
      };
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      pendingStart = { token, promise, resolve };
      save({
        ...state,
        phase: "running",
        storyNodeId: "collection-progress",
        trackedRun: {
          taskId,
          runId: null,
          startedAt: token.startedAt,
          startToken: token.startToken,
        },
        error: null,
      });
      return token;
    },

    workflowStarted(
      token: OnboardingWorkflowToken | null,
      run: { taskId: string; runId: string | null },
    ) {
      if (!token) return;
      const finishPendingStart = () => {
        if (pendingStart?.token.startToken !== token.startToken) return;
        pendingStart.resolve();
        pendingStart = null;
      };
      if (!state || state.progressionId !== token.progressionId) {
        finishPendingStart();
        return;
      }
      if (
        state.trackedRun?.taskId !== run.taskId
        || state.trackedRun.startToken !== token.startToken
      ) {
        finishPendingStart();
        return;
      }
      save({
        ...state,
        trackedRun: {
          ...state.trackedRun,
          runId: run.runId,
        },
      });
      finishPendingStart();
    },

    workflowStartFailed(token: OnboardingWorkflowToken | null, message: string) {
      if (!token) return;
      const finishPendingStart = () => {
        if (pendingStart?.token.startToken !== token.startToken) return;
        pendingStart.resolve();
        pendingStart = null;
      };
      if (
        !state
        || state.progressionId !== token.progressionId
        || state.trackedRun?.startToken !== token.startToken
      ) {
        finishPendingStart();
        return;
      }
      save({ ...state, phase: "failed", storyNodeId: "collection-failed", error: message });
      finishPendingStart();
    },

    async reconcile(facts: OnboardingFacts) {
      if (!state || state.status !== "active" || !state.trackedRun) return;
      if (state.phase === "preparing-overview") {
        await prepareOverview(state.trackedRun, generation);
        return;
      }
      if (state.phase === "overview") {
        if (facts.route !== routeFor(state) || facts.route !== "overview" || !facts.overview) return;
        const hasAccounts = facts.overview.accounts.length > 0;
        const explicitEmpty = facts.overview.availability === "empty";
        const acceptedWorkflowNoData = state.overviewReadiness === "workflow-no-data";
        if (
          facts.overview.availability === "unavailable"
          || (!hasAccounts && !explicitEmpty && !acceptedWorkflowNoData)
        ) {
          save({
            ...state,
            phase: "overview-error",
            storyNodeId: "overview-preparation-failed",
            overviewReadiness: null,
            error: "The Overview is not ready yet. Retry the Overview read before continuing.",
          });
          port.navigate("automation");
        }
        return;
      }
      if (state.phase !== "running") return;
      const run = state.trackedRun;
      const currentTask = facts.automation?.tasks.find((candidate) => candidate.id === run.taskId);
      if (run.runId && currentTask?.runId && currentTask.runId !== run.runId) {
        save({ ...state, phase: "failed", storyNodeId: "collection-failed", error: "workflow-replaced" });
        return;
      }
      const task = taskForRun(facts, run);
      if (!task || task.isActive) return;
      if (task.status !== "completed") {
        const reason = task.appWorkflowOutcome?.errorCode
          ?? (task.status === "cancelled" ? "cancelled" : "workflow-failed");
        save({ ...state, phase: "failed", storyNodeId: "collection-failed", error: reason });
        return;
      }
      await prepareOverview(run, generation);
    },

    async retryOverview() {
      if (
        !state
        || state.status !== "active"
        || state.phase !== "overview-error"
        || !state.trackedRun
      ) return;
      const expectedGeneration = generation;
      await prepareOverview(state.trackedRun, expectedGeneration);
    },

    async cancelWorkflow() {
      if (cancelPending) return false;
      const expectedGeneration = generation;
      const pending = pendingStart;
      cancelPending = true;
      let expected: OnboardingRun | null = null;
      try {
        if (pending) await pending.promise;
        if (
          generation !== expectedGeneration
          || !state
          || state.status !== "active"
          || state.phase !== "running"
          || !state.trackedRun
        ) return false;
        expected = state.trackedRun;
        await port.cancelRun(expected);
        return true;
      } catch (error) {
        if (
          generation === expectedGeneration
          && state?.status === "active"
          && expected
          && state.trackedRun
          && workflowKey(state.trackedRun) === workflowKey(expected)
        ) {
          save({ ...state, error: error instanceof Error ? error.message : String(error) });
        }
        return false;
      } finally {
        cancelPending = false;
      }
    },
  };
}
