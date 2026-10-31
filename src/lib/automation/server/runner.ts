import { APP_WORKFLOW_CONCURRENCY, createWorkflowRunQueue } from "./workflow-run-queue.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";
import { resolveTaskRunPlan } from "./task-run-plan.ts";
import type {
  AutomationPersistenceProvider,
  AutomationTaskRun,
} from "./store.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, taskById } from "./tasks.ts";
import {
  isStatementSelectionGroup,
  selectStatementTypes,
} from "../statement-selection.ts";
import { readAutomationSettings } from "./settings.ts";
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

export type StartAutomationTaskOptions = {
  scheduledAtUtc?: string;
  /** Adopt an existing persisted run instead of creating one. */
  taskRunId?: string;
  onFinished?: (run: AutomationTaskRun) => void;
  /** Called once the run ends, with `null` when its record could not be finalized. */
  onSettled?: (taskId: string, run: AutomationTaskRun | null) => void;
  /** Test/worker seam for the async execution runner. */
  runExecution?: typeof runAutomationTaskExecution;
};

export type StartedAutomationTask = {
  taskId: string;
  runId: string;
  runtime: ReturnType<AutomationRuntimeState["snapshot"]>;
};

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

function assertStatementSelection(task: AutomationTask) {
  const group = task.credentialGroupId
    ? AUTOMATION_CREDENTIAL_GROUPS.find((candidate) => candidate.id === task.credentialGroupId)
    : null;
  if (group && isStatementSelectionGroup(group)) {
    selectStatementTypes(group, { ...readAutomationSettings(), [group.enabledKey]: true }, "strict");
  }
}

type ClaimedTask = {
  opening: Promise<ActiveAutomationTaskRun>;
  run?: ActiveAutomationTaskRun;
  lifecycle?: Promise<void>;
};

export function createAutomationRunner(options: Readonly<{
  runtime: AutomationRuntimeState;
  forceQuitAvailableAfterMs?: number;
}>) {
  const { runtime } = options;
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
    provider: AutomationPersistenceProvider,
    runOptions: StartAutomationTaskOptions,
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
      const plan = resolveTaskRunPlan(task, { pgliteRpc: provider.pgliteWorkflow });
      const runExecution = runOptions.runExecution ?? runAutomationTaskExecution;
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
    provider: AutomationPersistenceProvider,
    runOptions: StartAutomationTaskOptions,
  ) {
    let report: TaskRunReport;
    try {
      report = await execute(task, run, provider, runOptions);
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
    provider: AutomationPersistenceProvider,
    runOptions: StartAutomationTaskOptions,
  ): Promise<ActiveAutomationTaskRun> {
    let row: AutomationTaskRun | null;
    if (runOptions.taskRunId) {
      row = await provider.automation.taskRunById(runOptions.taskRunId);
      if (!row) throw new Error(`Missing automation task run: ${runOptions.taskRunId}`);
    } else {
      const created = await provider.automation.createTaskRun({
        taskId: task.id,
        kind: task.kind,
        status: "preparing",
        attempt: 1,
        maxAttempts: task.maxAttempts,
        startedAt: new Date().toISOString(),
        scheduledAtUtc: runOptions.scheduledAtUtc,
      });
      row = await provider.automation.taskRunById(created.taskRunId);
      if (!row) throw new Error(`Failed to create automation task run: ${task.id}`);
    }
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
    async start(
      taskId: string,
      provider: AutomationPersistenceProvider,
      runOptions: StartAutomationTaskOptions = {},
    ): Promise<StartedAutomationTask> {
      if (shuttingDown) throw new Error("App workflow runtime is shutting down.");
      if (holds > 0) throw new Error("Automation is paused while local data is being deleted.");
      const task = appExecutorTask(taskId);
      validateScheduledAtUtc(runOptions.scheduledAtUtc);
      assertStatementSelection(task);
      const existing = claimed.get(taskId);
      if (existing) {
        const run = await existing.opening;
        return { taskId, runId: run.taskRunId, runtime: runtime.snapshot() };
      }
      const device = sourceDeviceForTask(taskId);
      const holder = device?.lock.claim("sync");
      if (device && holder) throw new SourceDeviceBusyError(device.source, holder);
      const entry: ClaimedTask = { opening: open(task, provider, runOptions) };
      claimed.set(taskId, entry);
      let run: ActiveAutomationTaskRun;
      try {
        run = await entry.opening;
      } catch (error) {
        release(taskId, entry);
        throw error;
      }
      entry.run = run;
      // Release before notifying so an observer may start the task again.
      entry.lifecycle = drive(task, run, provider, runOptions).then((finished) => {
        release(taskId, entry);
        try {
          if (finished) runOptions.onFinished?.(finished);
        } catch {
          console.error("automation-task-run-finished-observer-failed");
        }
        try {
          runOptions.onSettled?.(taskId, finished);
        } catch {
          console.error("automation-task-run-settled-observer-failed");
        }
      });
      return { taskId, runId: run.taskRunId, runtime: runtime.snapshot() };
    },

    /** Start a task and wait for its terminal run. */
    async run(
      taskId: string,
      provider: AutomationPersistenceProvider,
      runOptions: StartAutomationTaskOptions = {},
    ): Promise<AutomationTaskRun> {
      const started = await this.start(taskId, provider, runOptions);
      await claimed.get(taskId)?.lifecycle;
      const finished = await provider.automation.taskRunById(started.runId);
      if (!finished) throw new Error(`Missing automation task run: ${started.runId}`);
      return finished;
    },

    async current(taskId: string) {
      const entry = claimed.get(taskId);
      if (!entry) return null;
      const run = await entry.opening.catch(() => null);
      return run ? { runId: run.taskRunId, runtime: runtime.snapshot() } : null;
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
      provider: AutomationPersistenceProvider,
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

