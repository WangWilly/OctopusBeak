import { APP_WORKFLOW_CONCURRENCY, createWorkflowRunQueue } from "./workflow-run-queue.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";
import { resolveTaskRunPlan } from "./task-run-plan.ts";
import type {
  AutomationPersistenceProvider,
  AutomationTaskRun,
} from "./store.ts";
import { taskById } from "./tasks.ts";
import type { AutomationCredentialStore, AutomationSettingsStore } from "./config-files.ts";
import { runCaptchaRetryCampaign } from "./captcha-retry-campaign.ts";
import { captchaRoundExecution } from "./captcha-round-execution.ts";
import { runtimeTaskSnapshotFromRun, type AutomationRuntimeState } from "./runtime-state.ts";
import { SourceDeviceBusyError, sourceDeviceForTask } from "./source-device-lock.ts";
import {
  activeRunPageLookup,
  finalizeOrphanedRuns,
  openActiveTaskRun,
  type ActiveAutomationTaskRun,
  type TaskRunReport,
} from "./active-task-run.ts";

export async function hydrateAutomationRuntimeState(
  provider: AutomationPersistenceProvider,
  state: AutomationRuntimeState,
) {
  const runs = Object.values(await provider.automation.latestTaskRuns()).map((run) =>
    runtimeTaskSnapshotFromRun(run),
  );
  state.reset();
  for (const run of runs) state.upsert(run);
  return state.snapshot();
}

export type ClaimAutomationTaskOptions = Readonly<{ scheduledAtUtc?: string }>;

/** A task this runner claimed: its run once the row exists, and its end. */
export type ClaimedAutomationTask = Readonly<{
  /** Rejects when the run row could not be created; the task is released. */
  runId: Promise<string>;
  /** The terminal record, or `null` when the run never opened or could not be finalized. */
  settled: Promise<AutomationTaskRun | null>;
}>;

type AutomationTask = NonNullable<ReturnType<typeof taskById>>;

const CANCELLED: TaskRunReport = { summary: null, failure: { code: "cancelled", proven: true } };

function appExecutorTask(taskId: string): AutomationTask {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  if (!task.workflowId) {
    throw new Error(`Automation task is not registered with the App executor: ${task.id}`);
  }
  return task;
}

function validateScheduledAtUtc(value: string | undefined) {
  if (
    value !== undefined &&
    (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value)
  ) {
    throw new Error(`Invalid scheduledAtUtc: ${value}`);
  }
}

type ClaimedTask = {
  opening: Promise<ActiveAutomationTaskRun>;
  run?: ActiveAutomationTaskRun;
  lifecycle?: Promise<AutomationTaskRun | null>;
};

export function createAutomationRunner(options: Readonly<{
  runtime: AutomationRuntimeState;
  provider: AutomationPersistenceProvider;
  /** Test seam for the Workflow execution. */
  runExecution?: typeof runAutomationTaskExecution;
  credentials: AutomationCredentialStore;
  settings: AutomationSettingsStore;
  userDataDirectory: string;
  forceQuitAvailableAfterMs?: number;
}>) {
  const { runtime, provider } = options;
  const runExecution = options.runExecution ?? runAutomationTaskExecution;
  const queue = createWorkflowRunQueue(APP_WORKFLOW_CONCURRENCY);
  const claimed = new Map<string, ClaimedTask>();
  let shuttingDown = false;
  let holds = 0;

  /** The opened Active Automation Task Run with this run id, or null (ADR 0067). */
  function activeRun(taskRunId: string): ActiveAutomationTaskRun | null {
    for (const entry of claimed.values()) {
      if (entry.run?.taskRunId === taskRunId) return entry.run;
    }
    return null;
  }
  const pageForRun = activeRunPageLookup(activeRun);

  async function execute(
    task: AutomationTask,
    run: ActiveAutomationTaskRun,
  ): Promise<TaskRunReport> {
    let ticket: ReturnType<typeof queue.enter>;
    try {
      ticket = queue.enter(run.signal);
    } catch {
      return CANCELLED;
    }
    let release: (() => void) | undefined;
    try {
      // Observe rejection before awaiting persistence to avoid an unhandled abort.
      void ticket.ready.catch(() => undefined);
      if (ticket.queued) await run.transition("queued");
      try {
        release = await ticket.ready;
      } catch {
        return CANCELLED;
      }
      if (run.signal.aborted) return CANCELLED;
      // Resolved after admission so settings edited while the run queued apply.
      const plan = resolveTaskRunPlan(task, {
        pgliteRpc: provider.pgliteWorkflow,
        credentials: options.credentials,
        settings: options.settings,
        userDataDirectory: options.userDataDirectory,
      });
      return await runCaptchaRetryCampaign({
        plan,
        run,
        executeRound: captchaRoundExecution({
          plan,
          run,
          pageForRun,
          execute: (round) => runExecution(plan, run, round),
        }),
      });
    } finally {
      if (release) release();
      else void ticket.ready.then((admitted) => admitted(), () => undefined);
    }
  }

  async function drive(
    task: AutomationTask,
    run: ActiveAutomationTaskRun,
  ) {
    let report: TaskRunReport;
    try {
      report = await execute(task, run);
    } catch {
      console.error("automation-task-run-failed");
      report = { summary: null, failure: { code: "workflow-failed", proven: false } };
    }
    try {
      return await run.finish(report);
    } catch {
      console.error("automation-task-run-finalization-failed");
      return null;
    }
  }

  async function open(
    task: AutomationTask,
    claimOptions: ClaimAutomationTaskOptions,
  ): Promise<ActiveAutomationTaskRun> {
    const created = await provider.automation.createTaskRun({
      taskId: task.id,
      kind: task.kind,
      status: "preparing",
      attempt: 1,
      maxAttempts: task.maxAttempts,
      startedAt: new Date().toISOString(),
      scheduledAtUtc: claimOptions.scheduledAtUtc,
    });
    const row = await provider.automation.taskRunById(created.taskRunId);
    if (!row) throw new Error(`Failed to create automation task run: ${task.id}`);
    return openActiveTaskRun({
      run: row,
      persistence: provider.automation,
      runtime,
      forceQuitAvailableAfterMs: options.forceQuitAvailableAfterMs,
    });
  }

  function release(taskId: string, entry: ClaimedTask) {
    if (claimed.get(taskId) !== entry) return;
    claimed.delete(taskId);
    sourceDeviceForTask(taskId)?.lock.release("sync");
  }

  /** The Active Automation Task Run claimed for a task, checked against the caller's run. */
  async function claimedRun(taskId: string, expectedRunId: string | undefined, action: string) {
    const entry = claimed.get(taskId);
    if (!entry) throw new Error(`Automation task is not running: ${taskId}`);
    if (expectedRunId !== undefined && !expectedRunId) {
      throw new Error(`Automation task run changed before ${action}: ${taskId}`);
    }
    const run = await entry.opening.catch(() => {
      throw new Error(`Automation task is not running: ${taskId}`);
    });
    if (expectedRunId !== undefined && run.taskRunId !== expectedRunId) {
      throw new Error(`Automation task run changed before ${action}: ${taskId}`);
    }
    return { run, entry };
  }

  return {
    /**
     * Claim the task and open its run. Every refusal throws before anything
     * awaits, so two claims of one task can never both succeed.
     */
    claim(taskId: string, claimOptions: ClaimAutomationTaskOptions = {}): ClaimedAutomationTask {
      if (shuttingDown) throw new Error("App workflow runtime is shutting down.");
      if (holds > 0) throw new Error("Automation is paused while local data is being deleted.");
      const task = appExecutorTask(taskId);
      validateScheduledAtUtc(claimOptions.scheduledAtUtc);
      if (claimed.has(taskId)) throw new Error(`Automation task is already running: ${taskId}`);
      const device = sourceDeviceForTask(taskId);
      const holder = device?.lock.claim("sync");
      if (device && holder) throw new SourceDeviceBusyError(device.source, holder);
      const entry: ClaimedTask = { opening: open(task, claimOptions) };
      claimed.set(taskId, entry);
      const opened = entry.opening.then(
        (run) => {
          entry.run = run;
          const lifecycle = drive(task, run).then((finished) => {
            release(taskId, entry);
            return finished;
          });
          entry.lifecycle = lifecycle;
          return { taskRunId: run.taskRunId, lifecycle };
        },
        (error: unknown) => {
          release(taskId, entry);
          throw error;
        },
      );
      return {
        runId: opened.then(({ taskRunId }) => taskRunId),
        settled: opened.then(({ lifecycle }) => lifecycle, () => null),
      };
    },

    /** The run id of the task's current claim, or null when nothing holds it. */
    claimedRunId(taskId: string): Promise<string> | null {
      return claimed.get(taskId)?.opening.then((run) => run.taskRunId) ?? null;
    },

    activeRun,

    hasActive() {
      return claimed.size > 0;
    },

    activeTaskIds() {
      return [...claimed.keys()];
    },

    async cancel(taskId: string, expectedRunId?: string): Promise<{ cancelled: string }> {
      const { run } = await claimedRun(taskId, expectedRunId, "cancellation");
      await run.requestStop("cancelled");
      return { cancelled: taskId };
    },

    async forceTerminate(taskId: string, expectedRunId?: string): Promise<{ cancelled: string }> {
      const { run, entry } = await claimedRun(taskId, expectedRunId, "force termination");
      await run.requestStop("forced");
      await entry.lifecycle;
      return { cancelled: taskId };
    },

    /**
     * Cancel every run as a person would, wait until each is terminal, then
     * run `work`. No run starts until `work` settles.
     */
    async whileStopped<T>(work: () => Promise<T>): Promise<T> {
      holds += 1;
      try {
        while (claimed.size > 0) {
          const entries = [...claimed.values()];
          await Promise.all(entries.map((entry) => entry.opening.then(
            async (run) => {
              await run.requestStop("cancelled");
              await entry.lifecycle;
            },
            () => undefined,
          )));
        }
        return await work();
      } finally {
        holds -= 1;
      }
    },

    /** Stop every run without waiting, for a fatal exit. */
    abortAll() {
      for (const { run } of claimed.values()) void run?.requestStop("shutdown");
    },

    async shutdown(
      dependencies: Partial<{
        finalizePersistedRuns: typeof finalizeOrphanedRuns;
      }> = {},
    ): Promise<void> {
      shuttingDown = true;
      const entries = [...claimed.values()];
      const errors: unknown[] = [];
      // Stop opened runs synchronously so a slot freed meanwhile admits no queued run.
      await Promise.all(entries.map((entry) => (entry.run
        ? entry.run.requestStop("shutdown")
        : entry.opening.then((run) => run.requestStop("shutdown"), () => undefined)
      ).catch((error: unknown) => { errors.push(error); })));
      await Promise.all(entries.map((entry) => entry.lifecycle));
      try {
        await (dependencies.finalizePersistedRuns ?? finalizeOrphanedRuns)(provider);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, "Failed to shut down automation workflows");
    },
  };
}

export type AutomationRunner = ReturnType<typeof createAutomationRunner>;

