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
import type { TaskRunExecution } from "./task-run-execution.ts";
import type { ExecutionHost } from "./execution-host.ts";
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

/** A start's result once its run ended; `run` is `null` when the record could not be finalized. */
export type SettledAutomationStart = Readonly<
  | (Extract<AutomationStartResult, { status: "started" }> & { run: AutomationTaskRun | null })
  | Exclude<AutomationStartResult, { status: "started" }>
>;

export type StartAutomationTasksOptions = Readonly<{
  scheduledAtUtc?: string;
  /** Called once, after every task this start started has ended. */
  onSettled?: (results: readonly SettledAutomationStart[]) => void;
}>;

type Admission = Readonly<{ result: AutomationStartResult; settled: Promise<SettledAutomationStart> }>;

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
    /** Where each round's page and worker come from; the App's Chromium thread host by default. */
    executionHost?: ExecutionHost;
    /** Replaces whole rounds, for checks of the run lifecycle without a workflow. */
    runExecution?: TaskRunExecution;
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

  const unstarted = (result: Exclude<AutomationStartResult, { status: "started" }>): Admission => ({ result, settled: Promise.resolve(result) });

  function admit(taskId: string, model: AutomationDesktopModel, scheduledAtUtc: string | undefined): Promise<Admission> {
    const existing = claimedRunId(taskId);
    if (existing) {
      return existing.then(
        (runId) => unstarted({ taskId, status: "already_running", runId }),
        (error: unknown) => unstarted({ taskId, status: "error", error: asError(error) }),
      );
    }
    let claimed: ClaimedAutomationTask;
    try {
      const task = assertAutomationTaskCanStartInModel(taskId, model, options.settings);
      claimed = claim(task.id, { scheduledAtUtc });
    } catch (error) {
      return Promise.resolve(unstarted({ taskId, status: "error", error: asError(error) }));
    }
    return claimed.runId.then(
      (runId) => {
        const result = { taskId, status: "started", runId } as const;
        return { result, settled: claimed.settled.then((run) => ({ ...result, run })) };
      },
      (error: unknown) => unstarted({ taskId, status: "error", error: asError(error) }),
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
     * `onSettled` sees every result, after every task this start started ended.
     */
    async start(taskIds: readonly string[], startOptions: StartAutomationTasksOptions = {}): Promise<AutomationStartResult[]> {
      if (!Array.isArray(taskIds) || taskIds.some((taskId) => typeof taskId !== "string")) {
        throw new TypeError("Task IDs must be an array of strings.");
      }
      const unique = [...new Set(taskIds)];
      const admissions: Promise<Admission>[] = [];
      if (unique.length) {
        const model = await desktopModel();
        for (const taskId of unique) admissions.push(admit(taskId, model, startOptions.scheduledAtUtc));
      }
      const admitted = await Promise.all(admissions);
      const { onSettled } = startOptions;
      if (onSettled) {
        void Promise.all(admitted.map(({ settled }) => settled)).then((settled) => {
          try {
            onSettled(settled);
          } catch {
            console.error("automation-task-run-settled-observer-failed");
          }
        });
      }
      return admitted.map(({ result }) => result);
    },
  });
}

export type AutomationRuntime = ReturnType<typeof createAutomationRuntime>;
