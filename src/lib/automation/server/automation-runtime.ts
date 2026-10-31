import type { AutomationRunManyResult, AutomationRunManyTaskResult } from "$lib/desktop/api.ts";
import {
  assertAutomationTaskCanStartInModel,
  loadAutomationDesktopModel,
  type AutomationLiveRuns,
} from "./automation-desktop-model.ts";
import {
  createAutomationRunner,
  hydrateAutomationRuntimeState,
  type StartAutomationTaskOptions,
} from "./runner.ts";
import { finalizeOrphanedRuns } from "./active-task-run.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import type { AutomationPersistenceProvider } from "./store.ts";
import { AUTOMATION_TASKS } from "./tasks.ts";

/**
 * The App process's one owner of Automation Task Runs: the runner, its
 * runtime snapshot, and every start path's admission check. The Electron
 * main process creates it once and hands it to IPC and the schedulers.
 */
export function createAutomationRuntime(
  provider: AutomationPersistenceProvider,
  options: Readonly<{ forceQuitAvailableAfterMs?: number }> = {},
) {
  const state = createAutomationRuntimeState(undefined, {
    knownTaskIds: new Set(AUTOMATION_TASKS.map((task) => task.id)),
  });
  const runner = createAutomationRunner({ runtime: state, ...options });
  const live = (): AutomationLiveRuns => ({
    snapshot: state.snapshot(),
    activeTaskIds: runner.activeTaskIds(),
  });
  const desktopModel = () => loadAutomationDesktopModel(provider, live());

  return Object.freeze({
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
    activeTaskIds: () => runner.activeTaskIds(),
    activeRun: (taskRunId: string) => runner.activeRun(taskRunId),
    hasActive: () => runner.hasActive(),

    async run(taskId: string, runOptions: StartAutomationTaskOptions = {}) {
      const current = await runner.current(taskId);
      if (current) return { started: taskId, runId: current.runId, runtime: current.runtime };
      const task = assertAutomationTaskCanStartInModel(taskId, await desktopModel());
      const started = await runner.start(task.id, provider, runOptions);
      return { started: task.id, runId: started.runId, runtime: started.runtime };
    },

    async runMany(
      taskIds: string[],
      runOptions: StartAutomationTaskOptions = {},
    ): Promise<AutomationRunManyResult> {
      if (!Array.isArray(taskIds) || taskIds.some((taskId) => typeof taskId !== "string")) {
        throw new TypeError("Task IDs must be an array of strings.");
      }
      if (taskIds.length === 0) return { started: [] as string[], results: {} };
      const model = await desktopModel();
      const started: string[] = [];
      const errors: Record<string, string> = {};
      const results: Record<string, AutomationRunManyTaskResult> = {};
      for (const taskId of [...new Set(taskIds)]) {
        try {
          const existing = await runner.current(taskId);
          if (existing) {
            results[taskId] = { status: "already_running", runId: existing.runId };
            continue;
          }
          const task = assertAutomationTaskCanStartInModel(taskId, model);
          const run = await runner.start(task.id, provider, runOptions);
          if (run.adopted) {
            results[task.id] = { status: "already_running", runId: run.runId };
            continue;
          }
          started.push(task.id);
          results[task.id] = { status: "started", runId: run.runId };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors[taskId] = message;
          results[taskId] = { status: "error", error: message };
        }
      }
      return { started, results, ...(Object.keys(errors).length ? { errors } : {}) };
    },

    /** Skips the admission check; only the packaged browser fixture's synthetic tasks start this way. */
    startWithoutAdmission: (taskId: string) => runner.start(taskId, provider),
    cancel: (taskId: string, expectedRunId?: string) => runner.cancel(taskId, expectedRunId),
    forceTerminate: (taskId: string, expectedRunId?: string) => runner.forceTerminate(taskId, expectedRunId),
    whileStopped: <T>(work: () => Promise<T>) => runner.whileStopped(work),
    /** Stop every run without waiting, for a fatal exit. */
    abortAll: () => runner.abortAll(),
    shutdown: () => runner.shutdown(provider),
  });
}

export type AutomationRuntime = ReturnType<typeof createAutomationRuntime>;
