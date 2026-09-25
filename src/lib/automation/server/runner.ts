import { PGLITE_WORKFLOW_REQUIRED_ENV } from "../../../ledger/pglite/workflow-client.ts";
import type { OverviewPageDto } from "../../overview/types.ts";
import {
  finalizePersistedActiveRuns,
  finalizePersistedRun,
} from "./task-run-finalization.ts";
import {
  automationProcessEnv as workflowEnvironmentFromSettings,
  interruptActiveAppWorkflows,
  runAutomationTaskExecution,
} from "./task-run-execution.ts";
export { abortActiveAppWorkflowExecutions } from "./task-run-execution.ts";
import {
  isActiveTaskRunStatus,
  isTerminalTaskRunStatus,
  type AutomationPersistenceProvider,
  type AutomationTaskRun,
  type AutomationTaskStatus,
} from "./store.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, taskById } from "./tasks.ts";
import {
  isStatementSelectionGroup,
  selectStatementTypes,
} from "../statement-selection.ts";
import { readAutomationSettings } from "./settings.ts";
import {
  runCaptchaRetryCampaign,
} from "./captcha-retry-coordinator.ts";
import type { AutomationTaskExecutionOptions } from "./task-run-execution.ts";
import { automationRuntimeState, runtimeTaskSnapshotFromRun } from "./runtime-state.ts";

export async function hydrateAutomationRuntimeState(
  provider: AutomationPersistenceProvider,
) {
  const runs = Object.values(await provider.automation.latestTaskRuns()).map((run) =>
    runtimeTaskSnapshotFromRun(run),
  );
  automationRuntimeState.reset();
  for (const run of runs) automationRuntimeState.upsert(run);
  return automationRuntimeState.snapshot();
}

const activeTaskRunIds = new Map<string, string>();
const activeTaskRunCompletions = new Map<string, Promise<void>>();
const cancellationRequestedTaskIds = new Set<string>();
const forceTerminationRequestedTaskIds = new Set<string>();
const cancellationForceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const NON_BROWSER_APP_TASK_IDS = new Set(["exchange-rates", "sync-maicoin"]);

function assertAppExecutorTask(
  task: NonNullable<ReturnType<typeof taskById>>,
) {
  if (!task.workflowId && !NON_BROWSER_APP_TASK_IDS.has(task.id)) {
    throw new Error(`Automation task is not registered with the App executor: ${task.id}`);
  }
}

export type StartAutomationTaskOptions = {
  scheduledAtUtc?: string;
  taskRunId?: string;
  /** Test/worker seam for the async execution runner. */
  runExecution?: typeof runAutomationTaskExecution;
};

type PGliteWorkflowCapability = Readonly<{
  required: boolean;
  env: NodeJS.ProcessEnv;
}>;

/**
 * Carry the authenticated PGlite service capability into the typed App
 * workflow financial-commit adapter. No workflow process is launched.
 */
export function pgliteWorkflowRuntimeEnv(
  provider: AutomationPersistenceProvider,
): NodeJS.ProcessEnv {
  const workflow = (provider as AutomationPersistenceProvider & {
    pgliteWorkflow?: PGliteWorkflowCapability;
  }).pgliteWorkflow;
  if (!workflow) throw new Error("PGlite workflow transport is unavailable.");
  const values = Object.values(workflow.env);
  if (
    !workflow.required
    || workflow.env[PGLITE_WORKFLOW_REQUIRED_ENV] !== "1"
    || !workflow.env.OCTOPUSBEAK_PGLITE_CHILD_RPC_ENDPOINT?.trim()
    || !workflow.env.OCTOPUSBEAK_PGLITE_CHILD_RPC_TOKEN?.trim()
    || values.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw new Error("PGlite workflow transport is unavailable.");
  }
  return { ...workflow.env };
}

type PersistenceRunOptions = StartAutomationTaskOptions & {
  claimed?: boolean;
  runExecution?: typeof runAutomationTaskExecution;
};

export type StartedAutomationTask = {
  taskId: string;
  runId: string;
  runtime: ReturnType<typeof automationRuntimeState.snapshot>;
};

type AutomationTaskPersistenceExecutionRunnerInput = {
  task: NonNullable<ReturnType<typeof taskById>>;
  provider: AutomationPersistenceProvider;
  baseWorkflowEnvironment: NodeJS.ProcessEnv;
  currentTaskRunId: () => string | null;
  onRunCreated: (taskRunId: string) => void | Promise<void>;
  onRuntimeUpdate?: (taskRunId: string) => void | Promise<void>;
  isCancellationRequested: () => boolean;
  isForceTerminationRequested?: () => boolean;
  runExecution?: typeof runAutomationTaskExecution;
};

/** Build the async execution closure used by all App-owned workflow rounds. */
export function createAutomationTaskExecutionRunnerWithPersistence(
  input: AutomationTaskPersistenceExecutionRunnerInput,
) {
  const execute = input.runExecution ?? runAutomationTaskExecution;
  return (executionOptions: AutomationTaskExecutionOptions) =>
    execute(
      input.task,
      input.provider.automation,
      {
        ...executionOptions,
        launchEnv: {
          ...input.baseWorkflowEnvironment,
          ...(executionOptions.launchEnv ?? {}),
        },
        taskRunId:
          executionOptions.taskRunId ?? input.currentTaskRunId() ?? undefined,
        isCancellationRequested: input.isCancellationRequested,
        isForceTerminationRequested: input.isForceTerminationRequested,
        onRuntimeUpdate: input.onRuntimeUpdate,
        deferFinalization: true,
      },
      input.onRunCreated,
    );
}

function validateScheduledAtUtc(value: string | undefined) {
  if (
    value !== undefined &&
    (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value)
  ) {
    throw new Error(`Invalid scheduledAtUtc: ${value}`);
  }
}

export function hasActiveAutomationTask() {
  return activeTaskRunIds.size > 0;
}

export function activeAutomationTaskIds() {
  return Array.from(activeTaskRunIds.keys());
}

export function currentAutomationTaskRun(taskId: string) {
  const current = activeTaskRunIds.get(taskId);
  if (!current) return null;
  if (current === "pending" || current === "queued") {
    throw new Error(`Automation task is still preparing: ${taskId}`);
  }
  const runtime = automationRuntimeState.snapshot();
  return {
    runId: runtime.tasks.find((task) => task.taskId === taskId)?.runId ?? current,
    runtime,
  };
}

/** True after a user cancellation request until the current task exits. */
export function automationTaskCancellationRequested(taskId: string) {
  return cancellationRequestedTaskIds.has(taskId);
}

export function automationTaskForceTerminationRequested(taskId: string) {
  return forceTerminationRequestedTaskIds.has(taskId);
}

function claimTask(taskId: string) {
  if (activeTaskRunIds.has(taskId)) {
    throw new Error(`Automation task is already running: ${taskId}`);
  }
  activeTaskRunIds.set(taskId, "pending");
}

function runtimeForTask(taskId: string) {
  return automationRuntimeState.snapshot().tasks.find((task) => task.taskId === taskId);
}

/** Persist cancellation through the async worker port before publishing UI state. */
export async function persistCancellationTransitionForRunWithPersistence(
  provider: AutomationPersistenceProvider,
  runId: string,
  status: "cancelling" | "cancelled",
  finishedAt: string | null = null,
) {
  const persistence = provider.automation;
  const run = await persistence.taskRunById(runId);
  if (!run || isTerminalTaskRunStatus(run.status)) return run;
  if (!isActiveTaskRunStatus(run.status)) return run;
  if (status === "cancelled") {
    await persistence.transitionTaskRunToTerminal(runId, {
      status,
      finishedAt: finishedAt ?? new Date().toISOString(),
    });
  } else {
    await persistence.transitionTaskRunToActive(runId, { status });
  }
  return persistence.taskRunById(runId);
}

async function preparedRunForTaskWithPersistence(
  task: NonNullable<ReturnType<typeof taskById>>,
  provider: AutomationPersistenceProvider,
  options: StartAutomationTaskOptions = {},
  existingRun?: AutomationTaskRun,
) {
  if (existingRun) return existingRun;
  const created = await provider.automation.createTaskRun({
    taskId: task.id,
    kind: task.kind,
    status: "preparing",
    attempt: 1,
    maxAttempts: task.maxAttempts,
    startedAt: new Date().toISOString(),
    scheduledAtUtc: options.scheduledAtUtc,
  });
  const run = await provider.automation.taskRunById(created.taskRunId);
  if (!run) throw new Error(`Failed to create automation task run: ${task.id}`);
  return run;
}

async function startPreparedTaskWithPersistence(
  task: NonNullable<ReturnType<typeof taskById>>,
  provider: AutomationPersistenceProvider,
  options: StartAutomationTaskOptions = {},
  existingRun?: AutomationTaskRun,
): Promise<StartedAutomationTask> {
  const run = await preparedRunForTaskWithPersistence(task, provider, options, existingRun);
  activeTaskRunIds.set(task.id, run.taskRunId);
  const runtime = automationRuntimeState.upsert(
    runtimeTaskSnapshotFromRun(run, "preparing"),
  );
  void runAutomationTask(task.id, provider, {
    claimed: true,
    taskRunId: options.taskRunId ?? run.taskRunId,
    scheduledAtUtc: options.scheduledAtUtc,
    runExecution: options.runExecution,
  }).then(async () => {
    const finalRun = await provider.automation.taskRunById(run.taskRunId);
    if (finalRun) automationRuntimeState.upsert(runtimeTaskSnapshotFromRun(finalRun));
  }).catch(async () => {
    console.error("automation-task-run-failed");
    const failed = await provider.automation.taskRunById(run.taskRunId);
    if (!failed) return;
    try {
      await provider.automation.transitionTaskRunToTerminal(run.taskRunId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        exitCode: 1,
        signal: null,
        appWorkflowOutcome: { errorCode: "workflow-failed", summary: null },
      });
      const finalized = await provider.automation.taskRunById(run.taskRunId);
      if (finalized) automationRuntimeState.upsert(runtimeTaskSnapshotFromRun(finalized));
    } catch {
      console.error("automation-task-run-finalization-failed");
    }
  });
  return { taskId: task.id, runId: run.taskRunId, runtime };
}

export async function startAutomationTask(
  taskId: string,
  provider: AutomationPersistenceProvider,
  options: StartAutomationTaskOptions = {},
): Promise<StartedAutomationTask> {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  assertAppExecutorTask(task);
  validateScheduledAtUtc(options.scheduledAtUtc);
  const group = task.credentialGroupId
    ? AUTOMATION_CREDENTIAL_GROUPS.find(
        (candidate) => candidate.id === task.credentialGroupId,
      )
    : null;
  if (group && isStatementSelectionGroup(group) && group.id !== "fubon" && group.id !== "sinopac") {
    selectStatementTypes(group, readAutomationSettings(), "strict");
  }
  const current = activeTaskRunIds.get(taskId);
  if (current && current !== "pending") {
    const snapshot = runtimeForTask(taskId);
    if (snapshot) {
      return {
        taskId,
        runId: snapshot.runId ?? current,
        runtime: automationRuntimeState.snapshot(),
      };
    }
  }
  if (current === "pending") throw new Error(`Automation task is still preparing: ${taskId}`);
  claimTask(taskId);
  try {
    let existingRun: AutomationTaskRun | undefined;
    if (options.taskRunId) {
      existingRun = await provider.automation.taskRunById(options.taskRunId) ?? undefined;
      if (!existingRun) throw new Error(`Missing automation task run: ${options.taskRunId}`);
    }
    return await startPreparedTaskWithPersistence(task, provider, options, existingRun);
  } catch (error) {
    activeTaskRunIds.delete(taskId);
    throw error;
  }
}

export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
) {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("Concurrency limit must be a positive integer.");
  const active = new Set<Promise<void>>();
  const errors: unknown[] = [];
  for (const item of items) {
    if (active.size >= limit) await Promise.race(active);
    const task = Promise.resolve()
      .then(() => run(item))
      .catch((error) => {
        errors.push(error);
      })
      .finally(() => active.delete(task));
    active.add(task);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all(active);
  if (errors.length) throw errors[0];
}

export async function runAutomationBatch(
  taskIds: readonly string[],
  execute: (taskId: string) => Promise<void>,
) {
  const selectedTaskIds = [...new Set(taskIds)];
  const errors: unknown[] = [];
  // Keep App workflows on one slot while they use the shared browser host and
  // authenticated financial-commit service.
  await runWithConcurrency(selectedTaskIds, 1, execute).catch((error) => {
    errors.push(error);
  });
  if (errors.length) throw errors[0];
}

async function cancelAutomationTaskWithPersistence(
  taskId: string,
  provider: AutomationPersistenceProvider,
) {
  if (!activeTaskRunIds.has(taskId)) {
    throw new Error(`Automation task is not running: ${taskId}`);
  }
  cancellationRequestedTaskIds.add(taskId);
  const cancellationRequestedAt = new Date().toISOString();
  const activeRunId = runtimeForTask(taskId)?.runId
    ?? activeTaskRunIds.get(taskId);
  const cancellingRun = activeRunId && activeRunId !== "pending" && activeRunId !== "queued"
    ? await persistCancellationTransitionForRunWithPersistence(provider, activeRunId, "cancelling")
    : null;
  const runtime = runtimeForTask(taskId);
  if (cancellingRun) {
    automationRuntimeState.upsert(runtimeTaskSnapshotFromRun(cancellingRun, "cancelling"));
  } else if (runtime) {
    automationRuntimeState.upsert({
      ...runtime,
      status: "cancelling",
      cancellationRequestedAt,
      forceTerminateAvailable: false,
      updatedAt: cancellationRequestedAt,
    });
  }
  if (activeTaskRunIds.get(taskId) === "queued") {
    const queuedRunId = activeTaskRunIds.get(taskId);
    const cancelledRun = queuedRunId && queuedRunId !== "queued"
      ? await persistCancellationTransitionForRunWithPersistence(
          provider,
          queuedRunId,
          "cancelled",
          new Date().toISOString(),
        )
      : null;
    if (cancelledRun) {
      automationRuntimeState.upsert(runtimeTaskSnapshotFromRun(cancelledRun, "cancelled"));
    }
    activeTaskRunIds.delete(taskId);
    cancellationRequestedTaskIds.delete(taskId);
    forceTerminationRequestedTaskIds.delete(taskId);
    const queuedTimer = cancellationForceTimers.get(taskId);
    if (queuedTimer) clearTimeout(queuedTimer);
    cancellationForceTimers.delete(taskId);
    return { cancelled: taskId };
  }
  const previousTimer = cancellationForceTimers.get(taskId);
  if (previousTimer) clearTimeout(previousTimer);
  cancellationForceTimers.set(taskId, setTimeout(() => {
    cancellationForceTimers.delete(taskId);
    if (!activeTaskRunIds.has(taskId)) return;
    const current = runtimeForTask(taskId);
    if (!current || current.status !== "cancelling") return;
    automationRuntimeState.upsert({
      ...current,
      forceTerminateAvailable: true,
      updatedAt: new Date().toISOString(),
    });
  }, 10_000));
  return { cancelled: taskId };
}

export async function startAutomationTasks(
  taskIds: readonly string[],
  provider: AutomationPersistenceProvider,
): Promise<StartedAutomationTask[]> {
  const uniqueTaskIds = [...new Set(taskIds)];
  let settings: ReturnType<typeof readAutomationSettings> | undefined;
  for (const taskId of uniqueTaskIds) {
    const task = taskById(taskId);
    if (!task) throw new Error("Unknown automation task: " + taskId);
    assertAppExecutorTask(task);
    const group = task.credentialGroupId
      ? AUTOMATION_CREDENTIAL_GROUPS.find((candidate) => candidate.id === task.credentialGroupId)
      : null;
    if (group && isStatementSelectionGroup(group) && group.id !== "fubon" && group.id !== "sinopac") {
      settings ??= readAutomationSettings();
      selectStatementTypes(group, settings, "strict");
    }
  }
  return Promise.all(uniqueTaskIds.map((taskId) => startAutomationTask(taskId, provider)));
}

export async function cancelAutomationTask(
  taskId: string,
  provider: AutomationPersistenceProvider,
): Promise<{ cancelled: string }> {
  return cancelAutomationTaskWithPersistence(taskId, provider);
}

/** Force termination is available only after the normal cancellation grace period. */
async function forceTerminateAutomationTaskWithPersistence(
  taskId: string,
  provider: AutomationPersistenceProvider,
) {
  if (!activeTaskRunIds.has(taskId)) {
    throw new Error(`Automation task is not running: ${taskId}`);
  }
  forceTerminationRequestedTaskIds.add(taskId);
  cancellationRequestedTaskIds.add(taskId);
  const timer = cancellationForceTimers.get(taskId);
  if (timer) clearTimeout(timer);
  cancellationForceTimers.delete(taskId);
  const activeRunId = runtimeForTask(taskId)?.runId
    ?? activeTaskRunIds.get(taskId);
  const cancellingRun = activeRunId && activeRunId !== "pending" && activeRunId !== "queued"
    ? await persistCancellationTransitionForRunWithPersistence(provider, activeRunId, "cancelling")
    : null;
  const runtime = runtimeForTask(taskId);
  if (cancellingRun) {
    automationRuntimeState.upsert(runtimeTaskSnapshotFromRun(cancellingRun, "cancelling"));
  } else if (runtime) {
    automationRuntimeState.upsert({
      ...runtime,
      status: "cancelling",
      forceTerminateAvailable: true,
      updatedAt: new Date().toISOString(),
    });
  }
  await activeTaskRunCompletions.get(taskId);
  return { cancelled: taskId };
}

export async function forceTerminateAutomationTask(
  taskId: string,
  provider: AutomationPersistenceProvider,
) {
  return forceTerminateAutomationTaskWithPersistence(taskId, provider);
}

export type InterruptedAutomationRecoveryDependencies = {
  finalizeRunWithPersistence?: (
    provider: AutomationPersistenceProvider,
    run: AutomationTaskRun,
    reason: string,
    status?: Extract<AutomationTaskStatus, "failed" | "interrupted">,
  ) => Promise<void>;
};

export async function recoverInterruptedAutomationRuns(
  provider: AutomationPersistenceProvider,
  dependencies: InterruptedAutomationRecoveryDependencies = {},
): Promise<void> {
  const errors: unknown[] = [];
  for (const run of await provider.automation.activeTaskRuns()) {
    try {
      await (dependencies.finalizeRunWithPersistence ?? finalizePersistedRun)(
        provider,
        run,
        "App 前次異常結束",
        "interrupted",
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Failed to finalize persisted automation runs");
}

export async function shutdownAppAutomationWorkflows(
  provider: AutomationPersistenceProvider,
  dependencies: Partial<{
    finalizePersistedRuns: typeof finalizePersistedActiveRuns;
  }> = {},
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await interruptActiveAppWorkflows(provider.automation);
  } catch (error) {
    errors.push(error);
  }
  try {
    await Promise.all([...activeTaskRunCompletions.values()]);
  } catch (error) {
    errors.push(error);
  }
  const finalizePersistedRuns = dependencies.finalizePersistedRuns ?? finalizePersistedActiveRuns;
  try {
    await finalizePersistedRuns(provider, "App 關閉，人工操作未完成");
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, "Failed to shut down automation workflows");
}

export async function runAutomationTask(
  taskId: string,
  provider: AutomationPersistenceProvider,
  options: PersistenceRunOptions = {},
) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  assertAppExecutorTask(task);
  validateScheduledAtUtc(options.scheduledAtUtc);
  if (!options.claimed) claimTask(taskId);
  let completeRun!: () => void;
  const runCompletion = new Promise<void>((resolve) => { completeRun = resolve; });
  activeTaskRunCompletions.set(taskId, runCompletion);
  try {
    const workflowEnvironment = {
      ...workflowEnvironmentFromSettings(),
      ...pgliteWorkflowRuntimeEnv(provider),
    };
    const launchVerificationSettings = { ...readAutomationSettings() };
    let taskRunId: string | null = null;
    const onRunCreated = async (createdTaskRunId: string) => {
      taskRunId = createdTaskRunId;
      activeTaskRunIds.set(taskId, createdTaskRunId);
      const created = await provider.automation.taskRunById(createdTaskRunId);
      if (created) automationRuntimeState.upsert(runtimeTaskSnapshotFromRun(created));
    };
    const execution = createAutomationTaskExecutionRunnerWithPersistence({
      task,
      provider,
      baseWorkflowEnvironment: workflowEnvironment,
      currentTaskRunId: () => taskRunId,
      onRunCreated,
      onRuntimeUpdate: async (updatedTaskRunId) => {
        const updated = await provider.automation.taskRunById(updatedTaskRunId);
        if (updated) automationRuntimeState.upsert(runtimeTaskSnapshotFromRun(updated));
      },
      isCancellationRequested: () => automationTaskCancellationRequested(taskId),
      isForceTerminationRequested: () => automationTaskForceTerminationRequested(taskId),
      runExecution: options.runExecution,
    });
    const result = await runCaptchaRetryCampaign({
      taskId,
      appWorkflow: Boolean(task.workflowId),
      provider,
      launchVerificationSettings,
      initialExecutionOptions: {
        scheduledAtUtc: options.scheduledAtUtc,
        taskRunId: options.taskRunId,
      },
      execute: execution,
      isCancellationRequested: () => automationTaskCancellationRequested(taskId),
    });
    if (taskRunId) {
      const finalRun = await provider.automation.taskRunById(taskRunId);
      if (finalRun) automationRuntimeState.upsert(runtimeTaskSnapshotFromRun(finalRun));
    }
    return result;
  } finally {
    activeTaskRunIds.delete(taskId);
    if (activeTaskRunCompletions.get(taskId) === runCompletion) {
      activeTaskRunCompletions.delete(taskId);
    }
    completeRun();
    cancellationRequestedTaskIds.delete(taskId);
    forceTerminationRequestedTaskIds.delete(taskId);
    const forceTimer = cancellationForceTimers.get(taskId);
    if (forceTimer) clearTimeout(forceTimer);
    cancellationForceTimers.delete(taskId);
  }
}
