import type { AutomationDesktopModel } from "$lib/desktop/api.ts";
import {
  assertAutomationTaskCanStartInModel,
  loadAutomationDesktopModel,
  type AutomationLiveRuns,
} from "./automation-desktop-model.ts";
import {
  createAutomationRunner,
  hydrateAutomationRuntimeState,
  type ClaimedAutomationTask,
} from "./runner.ts";
import { finalizeOrphanedRuns } from "./active-task-run.ts";
import type { runAutomationTaskExecution } from "./task-run-execution.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import type { AutomationCredentialStore, AutomationSettingsStore } from "./config-files.ts";
import { AUTOMATION_TASKS } from "./tasks.ts";
import type { AutomationPersistenceProvider, AutomationTaskRun } from "./store.ts";

export type AutomationStartResult = Readonly<
  | { taskId: string; status: "started"; runId: string }
  /** Another start holds the task; its run belongs to that start. */
  | { taskId: string; status: "already_running"; runId: string }
  | { taskId: string; status: "error"; error: Error }
>;

export type StartAutomationTasksOptions = Readonly<{
  scheduledAtUtc?: string;
  /** Called once a started run ends, with `null` when its record could not be finalized. */
  onSettled?: (taskId: string, run: AutomationTaskRun | null) => void;
}>;

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

/**
 * The App process's one owner of Automation Task Runs: their admission,
 * lifecycle and runtime snapshot. The Electron main process creates it once
 * and hands it to IPC and the schedulers.
 */
export function createAutomationRuntime(
  provider: AutomationPersistenceProvider,
  options: Readonly<{
    credentials: AutomationCredentialStore;
    settings: AutomationSettingsStore;
    userDataDirectory: string;
    forceQuitAvailableAfterMs?: number;
    /** Test seam for the Workflow execution. */
    runExecution?: typeof runAutomationTaskExecution;
  }>,
) {
  const state = createAutomationRuntimeState(undefined, {
    knownTaskIds: new Set(AUTOMATION_TASKS.map((task) => task.id)),
  });
  const { claim, claimedRunId, ...runs } = createAutomationRunner({ runtime: state, provider, ...options });
  const live = (): AutomationLiveRuns => ({
    snapshot: state.snapshot(),
    activeTaskIds: runs.activeTaskIds(),
  });
  const desktopModel = () => loadAutomationDesktopModel(provider, live(), options.credentials, options.settings.read());

  function admit(
    taskId: string,
    model: AutomationDesktopModel,
    startOptions: StartAutomationTasksOptions,
  ): Promise<AutomationStartResult> {
    const existing = claimedRunId(taskId);
    if (existing) {
      return existing.then(
        (runId) => ({ taskId, status: "already_running", runId }),
        (error: unknown) => ({ taskId, status: "error", error: asError(error) }),
      );
    }
    let claimed: ClaimedAutomationTask;
    try {
      const task = assertAutomationTaskCanStartInModel(taskId, model, options.settings);
      claimed = claim(task.id, { scheduledAtUtc: startOptions.scheduledAtUtc });
    } catch (error) {
      return Promise.resolve({ taskId, status: "error", error: asError(error) });
    }
    return claimed.runId.then(
      (runId) => {
        void claimed.settled.then((run) => {
          try {
            startOptions.onSettled?.(taskId, run);
          } catch {
            console.error("automation-task-run-settled-observer-failed");
          }
        });
        return { taskId, status: "started", runId };
      },
      (error: unknown) => ({ taskId, status: "error", error: asError(error) }),
    );
  }

  return Object.freeze({
    ...runs,
    provider,
    snapshot: () => state.snapshot(),
    subscribe: state.subscribe,
    /** Isolated Electron fixtures seed runtime-only rows through this. */
    upsertRuntimeTask: state.upsert,
    live,
    desktopModel,
    /** Finish rows a previous process left active, then publish the persisted runs. */
    async recover() {
      await finalizeOrphanedRuns(provider);
      await hydrateAutomationRuntimeState(provider, state);
    },
    rehydrate: () => hydrateAutomationRuntimeState(provider, state),

    /**
     * Start each task through one admission: the desktop model is read once,
     * then every task is checked and claimed with nothing awaited between, so
     * a task another start holds is `already_running`, never a second run.
     */
    async start(taskIds: readonly string[], startOptions: StartAutomationTasksOptions = {}): Promise<AutomationStartResult[]> {
      if (!Array.isArray(taskIds) || taskIds.some((taskId) => typeof taskId !== "string")) {
        throw new TypeError("Task IDs must be an array of strings.");
      }
      if (taskIds.length === 0) return [];
      const model = await desktopModel();
      const admissions = [...new Set(taskIds)].map((taskId) => admit(taskId, model, startOptions));
      return Promise.all(admissions);
    },
  });
}

export type AutomationRuntime = ReturnType<typeof createAutomationRuntime>;
