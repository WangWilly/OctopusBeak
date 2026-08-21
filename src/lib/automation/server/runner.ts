import { spawnSync } from "node:child_process";
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
  liveTaskRunUpdate,
  parseAutomationProgress,
  resumeFailureMessage,
  runAutomationTaskExecution,
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
  liveTaskRunUpdate,
  parseAutomationProgress,
  resumeFailureMessage,
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
  type AutomationTaskRun,
  type AutomationTaskStatus,
} from "./store.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, taskById } from "./tasks.ts";
import {
  isStatementSelectionGroup,
  selectStatementTypes,
} from "../statement-selection.ts";
import { readAutomationSettings } from "./settings.ts";

export { closeLibrettoSession };

const activeTaskRunIds = new Map<string, string>();
let librettoRunCdpPatched = false;

export type StartAutomationTaskOptions = {
  scheduledAtUtc?: string;
};

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

function claimTask(taskId: string) {
  if (activeTaskRunIds.has(taskId)) {
    throw new Error(`Automation task is already running: ${taskId}`);
  }
  activeTaskRunIds.set(taskId, "pending");
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
  const selectedTaskIds = taskIds.filter(
    (taskId) => taskId !== "import-downloads-csv",
  );
  const errors: unknown[] = [];
  await runWithConcurrency(selectedTaskIds, 2, execute).catch((error) => {
    errors.push(error);
  });
  if (
    taskIds.includes("import-downloads-csv") ||
    selectedTaskIds.some((taskId) => taskById(taskId)?.kind === "crawler")
  ) {
    await execute("import-downloads-csv").catch((error) => {
      errors.push(error);
    });
  }
  if (errors.length) throw errors[0];
}

export function startAutomationTask(
  taskId: string,
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  options: StartAutomationTaskOptions = {},
) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  validateScheduledAtUtc(options.scheduledAtUtc);
  const group = task.credentialGroupId
    ? AUTOMATION_CREDENTIAL_GROUPS.find(
        (candidate) => candidate.id === task.credentialGroupId,
      )
    : null;
  if (group && isStatementSelectionGroup(group) && group.id !== "fubon") {
    selectStatementTypes(group, readAutomationSettings(), "strict");
  }
  claimTask(taskId);
  void runAutomationTask(taskId, ledgerDir, {
    claimed: true,
    scheduledAtUtc: options.scheduledAtUtc,
  }).catch((error) => {
    console.error("automation-task-run-failed", error);
  });
}

export function startAutomationTasks(
  taskIds: readonly string[],
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) {
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
    if (group && isStatementSelectionGroup(group) && group.id !== "fubon") {
      settings ??= readAutomationSettings();
      selectStatementTypes(group, settings, "strict");
    }
    if (activeTaskRunIds.has(taskId))
      throw new Error(`Automation task is already running: ${taskId}`);
  }
  for (const taskId of uniqueTaskIds) {
    claimTask(taskId);
    activeTaskRunIds.set(taskId, "queued");
  }
  setImmediate(() => {
    void runAutomationBatch(uniqueTaskIds, async (taskId) => {
      const claimed = uniqueTaskIds.includes(taskId);
      if (claimed) {
        if (activeTaskRunIds.get(taskId) !== "queued") return;
        activeTaskRunIds.set(taskId, "pending");
      }
      await runAutomationTask(taskId, ledgerDir, { claimed }).catch((error) => {
        console.error(
          taskId === "import-downloads-csv"
            ? "automation-import-run-failed"
            : "automation-task-run-failed",
          error,
        );
      });
    }).catch((error) => {
      console.error("automation-batch-run-failed", error);
    });
  });
}

export function startAutomationResume(
  taskId: string,
  session: string,
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) {
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);
  if (!session.match(/^[\w-]+$/))
    throw new Error(`Invalid Libretto session: ${session}`);
  claimTask(taskId);
  void runAutomationTask(taskId, ledgerDir, {
    claimed: true,
    resumeSession: session,
  }).catch((error) => {
    console.error("automation-task-resume-failed", error);
  });
}

export async function cancelAutomationTask(taskId: string) {
  if (!activeTaskRunIds.has(taskId))
    throw new Error(`Automation task is not running: ${taskId}`);
  if (activeTaskRunIds.get(taskId) === "queued") {
    activeTaskRunIds.delete(taskId);
    return { cancelled: taskId };
  }
  const child = automationTaskChild(taskId);
  if (!child)
    throw new Error(`Automation task has not started a process yet: ${taskId}`);
  child.kill("SIGTERM");
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
  } = {},
) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  validateScheduledAtUtc(options.scheduledAtUtc);
  if (!options.claimed) claimTask(taskId);

  let db: ReturnType<typeof openLedgerDatabase> | null = null;
  try {
    db = openLedgerDatabase(ledgerDir);
    return await runAutomationTaskExecution(
      task,
      db,
      ledgerDir,
      options,
      (taskRunId) => {
        activeTaskRunIds.set(taskId, taskRunId);
      },
    );
  } finally {
    activeTaskRunIds.delete(taskId);
    db?.close();
  }
}
