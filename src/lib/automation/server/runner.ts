import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { resolvePatchCommand } from "./desktop-command.ts";
import {
  finalizePersistedActiveRuns,
  finalizePersistedRun,
  scheduleAutomationTaskRunTimeout,
} from "./task-run-finalization.ts";
import {
  accumulateAutomationOutput,
  automationProcessEnv,
  automationTaskChild,
  claimRunAutomationSession,
  createAutomationOutputBuffer,
  createAutomationSessionId,
  createAutomationProgressFrameParser,
  liveTaskRunUpdate,
  resumeFailureMessage,
  runAutomationTaskExecution,
  terminateAutomationTaskProcessTree,
  terminateAutomationTaskProcesses,
} from "./task-run-execution.ts";
export {
  appendCleanupError,
  automationCleanupFailureDetails,
  automationSessionFromLog,
  finalFailureMessage,
  finalizeTerminalAutomationSession,
  isForceQuitRun,
  nextAttemptStatus,
  resumeSessionFromLog,
  shouldMarkWaitingForHuman,
  shouldRetainAutomationSession,
} from "./task-run-finalization.ts";
export {
  accumulateAutomationOutput,
  automationProcessEnv,
  claimRunAutomationSession,
  createAutomationOutputBuffer,
  createAutomationSessionId,
  createAutomationProgressFrameParser,
  liveTaskRunUpdate,
  resumeFailureMessage,
  terminateAutomationTaskProcesses,
} from "./task-run-execution.ts";
import {
  automationSessionOwnerForRun,
  isLiveOwnedAutomationSession,
  relinquishAutomationSessionForTask,
  type LiveAutomationSessionDependencies,
} from "./automation-session-disposition.ts";
import {
  claimAutomationSessionForCleanup,
  closeLibrettoSession,
  finalizeAllOwnedAutomationSessions,
  WAITING_SESSION_TIMEOUT_MS,
} from "./session-lifecycle.ts";
import {
  activeTaskRuns,
  assertAutomationRuntimeSchema,
  createTaskRun,
  latestTaskRuns,
  taskRunById,
  updateTaskRun,
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

export { closeLibrettoSession };

export function hydrateAutomationRuntimeState(
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) {
  const db = openLedgerDatabase(ledgerDir);
  try {
    assertAutomationRuntimeSchema(db);
    const runs = Object.values(latestTaskRuns(db)).map((run) =>
      runtimeTaskSnapshotFromRun(run),
    );
    automationRuntimeState.reset();
    for (const run of runs) automationRuntimeState.upsert(run);
    return automationRuntimeState.snapshot();
  } finally {
    db.close();
  }
}

const activeTaskRunIds = new Map<string, string>();
const activeTaskLedgerDirs = new Map<string, string>();
const cancellationRequestedTaskIds = new Set<string>();
const forceTerminationRequestedTaskIds = new Set<string>();
const cancellationForceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let librettoRunCdpPatched = false;

export type StartAutomationTaskOptions = {
  scheduledAtUtc?: string;
  resumeSession?: string;
  taskRunId?: string;
};

export type StartedAutomationTask = {
  taskId: string;
  runId: string;
  runtime: ReturnType<typeof automationRuntimeState.snapshot>;
};

type AutomationTaskExecutionRunnerInput = {
  task: NonNullable<ReturnType<typeof taskById>>;
  taskDb: ReturnType<typeof openLedgerDatabase>;
  ledgerDir: string;
  baseLaunchEnv: NodeJS.ProcessEnv;
  currentTaskRunId: () => string | null;
  onRunCreated: (taskRunId: string) => void;
  onRuntimeUpdate?: (taskRunId: string) => void;
  isCancellationRequested: () => boolean;
  isForceTerminationRequested?: () => boolean;
  runExecution?: typeof runAutomationTaskExecution;
};

/**
 * Build the execution closure shared by every round in one user operation.
 * The captured environment is the stable base; narrowly scoped per-execution
 * capabilities, such as a session-bound dialog owner, override only their key.
 */
export function createAutomationTaskExecutionRunner(
  input: AutomationTaskExecutionRunnerInput,
) {
  const execute = input.runExecution ?? runAutomationTaskExecution;
  return (executionOptions: AutomationTaskExecutionOptions) =>
    execute(
      input.task,
      input.taskDb,
      input.ledgerDir,
      {
        ...executionOptions,
        launchEnv: {
          ...input.baseLaunchEnv,
          ...(executionOptions.launchEnv ?? {}),
        },
        taskRunId:
          executionOptions.taskRunId ?? input.currentTaskRunId() ?? undefined,
        isCancellationRequested: input.isCancellationRequested,
        isForceTerminationRequested: input.isForceTerminationRequested,
        onRuntimeUpdate: input.onRuntimeUpdate,
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

export function shouldCloseResumeSession(input: {
  status: AutomationTaskStatus;
  resumeSession?: string;
}) {
  return input.status === "failed" && Boolean(input.resumeSession);
}

export function librettoRunCdpPatchCommand(input: { resumeSession?: string }) {
  const command = resolvePatchCommand(input);
  return command ? ([command.command, ...command.args] as const) : null;
}

export function prepareLibrettoRunCdpPatch(
  runPatch: () => void = () => {
    const command = resolvePatchCommand({});
    if (!command) return;
    const patch = spawnSync(command.command, command.args, {
      env: command.env,
      encoding: "utf8",
    });
    if (patch.stdout) console.info(patch.stdout.trim());
    if (patch.stderr) console.warn(patch.stderr.trim());
    if (patch.error || patch.status !== 0) {
      throw (
        patch.error ??
        new Error(`Libretto CDP patch exited with code ${patch.status}`)
      );
    }
  },
) {
  if (librettoRunCdpPatched) return;
  runPatch();
  librettoRunCdpPatched = true;
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

function persistCancellationTransition(
  taskId: string,
  status: "cancelling" | "cancelled",
  finishedAt: string | null = null,
) {
  const runtime = runtimeForTask(taskId);
  const activeRunId = activeTaskRunIds.get(taskId);
  const runId = runtime?.runId ?? (activeRunId && activeRunId !== "pending" && activeRunId !== "queued" ? activeRunId : null);
  if (!runId) return null;
  const db = openLedgerDatabase(activeTaskLedgerDirs.get(taskId) ?? process.env.LEDGER_DIR ?? "data/ledger");
  try {
    const run = taskRunById(db, runId);
    if (!run || ["completed", "partial", "failed", "cancelled", "interrupted"].includes(run.status)) {
      return run;
    }
    updateTaskRun(db, runId, {
      status,
      ...(status === "cancelled" ? { finishedAt } : {}),
    });
    return taskRunById(db, runId);
  } finally {
    db.close();
  }
}

function preparedRunForTask(
  task: NonNullable<ReturnType<typeof taskById>>,
  ledgerDir: string,
  options: StartAutomationTaskOptions = {},
  existingRun?: AutomationTaskRun,
) {
  if (existingRun) return existingRun;
  const db = openLedgerDatabase(ledgerDir);
  try {
    const created = createTaskRun(db, {
      taskId: task.id,
      script: options.scheduledAtUtc
        ? `${task.script} --scheduled-at-utc ${options.scheduledAtUtc}`
        : task.script,
      kind: task.kind,
      status: "preparing",
      attempt: 1,
      maxAttempts: task.maxAttempts,
      startedAt: new Date().toISOString(),
      logPath: join("data", "automation", "logs", `${task.id}-${Date.now()}-1.log`),
    });
    const run = taskRunById(db, created.taskRunId);
    if (!run) throw new Error(`Failed to create automation task run: ${task.id}`);
    return run;
  } finally {
    db.close();
  }
}

function startPreparedTask(
  task: NonNullable<ReturnType<typeof taskById>>,
  ledgerDir: string,
  options: StartAutomationTaskOptions = {},
  existingRun?: AutomationTaskRun,
): StartedAutomationTask {
  const run = preparedRunForTask(task, ledgerDir, options, existingRun);
  activeTaskRunIds.set(task.id, run.taskRunId);
  activeTaskLedgerDirs.set(task.id, ledgerDir);
  const runtime = automationRuntimeState.upsert(
    runtimeTaskSnapshotFromRun(run, "preparing"),
  );
  void runAutomationTask(task.id, ledgerDir, {
    claimed: true,
    taskRunId: options.taskRunId ?? run.taskRunId,
    scheduledAtUtc: options.scheduledAtUtc,
    resumeSession: options.resumeSession,
  }).then(() => {
    const db = openLedgerDatabase(ledgerDir);
    try {
      const finalRun = taskRunById(db, run.taskRunId);
      if (finalRun) automationRuntimeState.upsert(runtimeTaskSnapshotFromRun(finalRun));
    } finally {
      db.close();
    }
  }).catch((error) => {
    console.error("automation-task-run-failed", error);
    const db = openLedgerDatabase(ledgerDir);
    try {
      const failed = taskRunById(db, run.taskRunId);
      if (failed) {
        updateTaskRun(db, run.taskRunId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          errorMessage: "Automation task failed to start.",
        });
        const finalized = taskRunById(db, run.taskRunId);
        if (finalized) automationRuntimeState.upsert(runtimeTaskSnapshotFromRun(finalized));
      }
    } finally {
      db.close();
    }
  });
  return { taskId: task.id, runId: run.taskRunId, runtime };
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
  // Each automation workflow can open the canonical database in its own
  // Libretto process. Keep the batch on one slot so those processes never
  // contend for the lifecycle's exclusive path lease while a capture is
  // being admitted or the projection is rebuilt.
  await runWithConcurrency(selectedTaskIds, 1, execute).catch((error) => {
    errors.push(error);
  });
  if (errors.length) throw errors[0];
}

export function startAutomationTask(
  taskId: string,
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  options: StartAutomationTaskOptions = {},
): StartedAutomationTask {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  validateScheduledAtUtc(options.scheduledAtUtc);
  const group = task.credentialGroupId
    ? AUTOMATION_CREDENTIAL_GROUPS.find(
        (candidate) => candidate.id === task.credentialGroupId,
      )
    : null;
  if (
    !options.resumeSession &&
    group &&
    isStatementSelectionGroup(group) &&
    group.id !== "fubon" &&
    group.id !== "sinopac"
  ) {
    selectStatementTypes(group, readAutomationSettings(), "strict");
  }
  const current = activeTaskRunIds.get(taskId);
  if (options.resumeSession && current) {
    throw new Error(`Automation task is already running: ${taskId}`);
  }
  if (current && current !== "pending") {
    const snapshot = runtimeForTask(taskId);
    if (snapshot) return { taskId, runId: snapshot.runId ?? current, runtime: automationRuntimeState.snapshot() };
  }
  if (current === "pending") throw new Error(`Automation task is still preparing: ${taskId}`);
  claimTask(taskId);
  try {
    let existingRun: AutomationTaskRun | undefined;
    if (options.taskRunId) {
      const db = openLedgerDatabase(ledgerDir);
      try {
        existingRun = taskRunById(db, options.taskRunId) ?? undefined;
      } finally {
        db.close();
      }
      if (!existingRun) throw new Error(`Missing automation task run: ${options.taskRunId}`);
    }
    return startPreparedTask(task, ledgerDir, options, existingRun);
  } catch (error) {
    // The claim is a lease, not a durable run.  If the preparing row cannot be
    // committed, release it so the next click can retry safely.
    activeTaskRunIds.delete(taskId);
    activeTaskLedgerDirs.delete(taskId);
    throw error;
  }
}

export function startAutomationTasks(
  taskIds: readonly string[],
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) : StartedAutomationTask[] {
  const uniqueTaskIds = [...new Set(taskIds)];
  let settings: ReturnType<typeof readAutomationSettings> | undefined;
  for (const taskId of uniqueTaskIds) {
    const task = taskById(taskId);
    if (!task) throw new Error(`Unknown automation task: ${taskId}`);
    const group = task.credentialGroupId
      ? AUTOMATION_CREDENTIAL_GROUPS.find(
          (candidate) => candidate.id === task.credentialGroupId,
        )
      : null;
    if (
      group &&
      isStatementSelectionGroup(group) &&
      group.id !== "fubon" &&
      group.id !== "sinopac"
    ) {
      settings ??= readAutomationSettings();
      selectStatementTypes(group, settings, "strict");
    }
  }
  return uniqueTaskIds.map((taskId) => startAutomationTask(taskId, ledgerDir));
}

export function startAutomationResume(
  taskId: string,
  session: string,
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) {
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);
  if (!session.match(/^[\w-]+$/))
    throw new Error(`Invalid Libretto session: ${session}`);
  const db = openLedgerDatabase(ledgerDir);
  let currentRun: AutomationTaskRun | null = null;
  try {
    currentRun = latestTaskRuns(db)[taskId] ?? null;
  } finally {
    db.close();
  }
  return startAutomationTask(taskId, ledgerDir, {
    resumeSession: session,
    ...(currentRun ? { taskRunId: currentRun.taskRunId } : {}),
  });
}

export async function cancelAutomationTask(taskId: string) {
  if (!activeTaskRunIds.has(taskId))
    throw new Error(`Automation task is not running: ${taskId}`);
  cancellationRequestedTaskIds.add(taskId);
  const cancellationRequestedAt = new Date().toISOString();
  const cancellingRun = persistCancellationTransition(taskId, "cancelling");
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
    const cancelledRun = persistCancellationTransition(taskId, "cancelled", new Date().toISOString());
    if (cancelledRun) {
      automationRuntimeState.upsert(runtimeTaskSnapshotFromRun(cancelledRun, "cancelled"));
    }
    activeTaskRunIds.delete(taskId);
    activeTaskLedgerDirs.delete(taskId);
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
  const child = automationTaskChild(taskId);
  // A CAPTCHA retry round can be between child processes while its previous
  // session is being cleaned up. Keep the cancellation request latched so the
  // campaign coordinator observes it after cleanup and never starts round N+1.
  if (!child) {
    // Yield briefly so a pending execution can observe the latched request
    // before a caller that polls cancellation in a tight loop continues.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    return { cancelled: taskId };
  }
  child.kill("SIGTERM");
  await relinquishAutomationSessionForTask(taskId);
  return { cancelled: taskId };
}

/** Force termination is available only after the normal cancellation grace period. */
export async function forceTerminateAutomationTask(taskId: string) {
  if (!activeTaskRunIds.has(taskId))
    throw new Error(`Automation task is not running: ${taskId}`);
  forceTerminationRequestedTaskIds.add(taskId);
  cancellationRequestedTaskIds.add(taskId);
  const timer = cancellationForceTimers.get(taskId);
  if (timer) clearTimeout(timer);
  cancellationForceTimers.delete(taskId);
  const cancellingRun = persistCancellationTransition(taskId, "cancelling");
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
  const child = automationTaskChild(taskId);
  await terminateAutomationTaskProcessTree(taskId);
  await relinquishAutomationSessionForTask(taskId);
  return { cancelled: taskId };
}

export type AbandonedAutomationRecoveryDependencies =
  LiveAutomationSessionDependencies & {
    finalizeRun?: typeof finalizePersistedRun;
    claimSession?: typeof claimAutomationSessionForCleanup;
    scheduleWaitingTimeout?: typeof scheduleAutomationTaskRunTimeout;
    now?: () => number;
  };

function waitingSessionExpired(
  run: Pick<AutomationTaskRun, "startedAt">,
  now: () => number,
) {
  const startedAt = Date.parse(run.startedAt);
  if (!Number.isFinite(startedAt)) return true;
  try {
    const age = now() - startedAt;
    return age < 0 || age >= WAITING_SESSION_TIMEOUT_MS;
  } catch {
    return true;
  }
}

async function preserveWaitingHumanSession(
  db: ReturnType<typeof openLedgerDatabase>,
  run: AutomationTaskRun,
  ledgerDir: string,
  dependencies: AbandonedAutomationRecoveryDependencies,
) {
  if (!run.humanAssistanceContract) return false;
  if (waitingSessionExpired(run, dependencies.now ?? (() => Date.now())))
    return false;
  const owner = automationSessionOwnerForRun(run);
  if (!owner || owner.pid === null) return false;
  if (!(await isLiveOwnedAutomationSession(owner, dependencies))) return false;
  const claimSession =
    dependencies.claimSession ?? claimAutomationSessionForCleanup;
  try {
    if (!claimSession(owner)) return false;
    (dependencies.scheduleWaitingTimeout ?? scheduleAutomationTaskRunTimeout)({
      taskDb: db,
      taskId: run.taskId,
      taskKind: run.kind,
      taskRunId: run.taskRunId,
      logPath: run.logPath,
      ledgerDir,
    });
    return true;
  } catch {
    return false;
  }
}

export async function recoverAbandonedAutomationSessions(
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  dependencies: AbandonedAutomationRecoveryDependencies = {},
) {
  const db = openLedgerDatabase(ledgerDir);
  const errors: unknown[] = [];
  try {
    for (const run of activeTaskRuns(db)) {
      try {
        if (
          run.status === "waiting_for_human" &&
          (await preserveWaitingHumanSession(db, run, ledgerDir, dependencies))
        ) {
          continue;
        }
        await (dependencies.finalizeRun ?? finalizePersistedRun)(
          db,
          run,
          "App 前次異常結束",
          "interrupted",
        );
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    db.close();
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Failed to finalize persisted automation runs",
    );
}

export async function shutdownAutomationSessions(
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  dependencies: Partial<{
    finalizeOwnedSessions: typeof finalizeAllOwnedAutomationSessions;
    finalizePersistedRuns: typeof finalizePersistedActiveRuns;
  }> = {},
) {
  terminateAutomationTaskProcesses();
  const errors: unknown[] = [];
  const finalizeOwnedSessions =
    dependencies.finalizeOwnedSessions ?? finalizeAllOwnedAutomationSessions;
  const finalizePersistedRuns =
    dependencies.finalizePersistedRuns ?? finalizePersistedActiveRuns;
  try {
    await finalizeOwnedSessions();
  } catch (error) {
    errors.push(error);
  }
  try {
    await finalizePersistedRuns(ledgerDir, "App 關閉，人工操作未完成");
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(errors, "Failed to shut down automation sessions");
}

export async function runAutomationTask(
  taskId: string,
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  options: StartAutomationTaskOptions & {
    claimed?: boolean;
    resumeSession?: string;
    taskRunId?: string;
  } = {},
) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  validateScheduledAtUtc(options.scheduledAtUtc);
  if (!options.claimed) claimTask(taskId);
  activeTaskLedgerDirs.set(taskId, ledgerDir);

  let db: ReturnType<typeof openLedgerDatabase> | null = null;
  try {
    db = openLedgerDatabase(ledgerDir);
    const launchEnv = { ...automationProcessEnv() };
    // Verification actor and solver settings belong to this user operation.
    // Capture them once so a settings-file edit while a CAPTCHA campaign is
    // between rounds cannot silently change the next execution's policy.
    const launchVerificationSettings = { ...readAutomationSettings() };
    let taskRunId: string | null = null;
    const onRunCreated = (createdTaskRunId: string) => {
      taskRunId = createdTaskRunId;
      activeTaskRunIds.set(taskId, createdTaskRunId);
      const created = taskRunById(db!, createdTaskRunId);
      if (created) automationRuntimeState.upsert(runtimeTaskSnapshotFromRun(created));
    };
    const execution = createAutomationTaskExecutionRunner({
      task,
      taskDb: db,
      ledgerDir,
      baseLaunchEnv: launchEnv,
      currentTaskRunId: () => taskRunId,
      onRunCreated,
      onRuntimeUpdate: (updatedTaskRunId) => {
        const updated = taskRunById(db!, updatedTaskRunId);
        if (updated) automationRuntimeState.upsert(runtimeTaskSnapshotFromRun(updated));
      },
      isCancellationRequested: () =>
        automationTaskCancellationRequested(taskId),
      isForceTerminationRequested: () =>
        automationTaskForceTerminationRequested(taskId),
    });
    const result = await runCaptchaRetryCampaign({
      taskId,
      taskDb: db,
      ledgerDir,
      launchVerificationSettings,
      initialExecutionOptions: {
        scheduledAtUtc: options.scheduledAtUtc,
        resumeSession: options.resumeSession,
        taskRunId: options.taskRunId,
      },
      execute: execution,
      isCancellationRequested: () =>
        automationTaskCancellationRequested(taskId),
    });
    if (taskRunId) {
      const finalRun = taskRunById(db, taskRunId);
      if (finalRun) automationRuntimeState.upsert(runtimeTaskSnapshotFromRun(finalRun));
    }
    return result;
  } finally {
    activeTaskRunIds.delete(taskId);
    activeTaskLedgerDirs.delete(taskId);
    cancellationRequestedTaskIds.delete(taskId);
    forceTerminationRequestedTaskIds.delete(taskId);
    const forceTimer = cancellationForceTimers.get(taskId);
    if (forceTimer) clearTimeout(forceTimer);
    cancellationForceTimers.delete(taskId);
    db?.close();
  }
}
