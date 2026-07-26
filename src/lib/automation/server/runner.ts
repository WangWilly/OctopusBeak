import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import {
  parseStatementRunSummary,
  type StatementRunSummary,
} from "../statement-run-summary.ts";
import {
  resolvePatchCommand,
  resolveTaskCommand,
} from "./desktop-command.ts";
import { automationConfigEnv } from "./config-files.ts";
import { validateLibrettoSessionName } from "./libretto-session.ts";
import {
  appendLog,
  errorMessage,
  finalizeAutomationTaskRun,
  finalizePersistedActiveRuns,
  finalizePersistedRun,
  isForceQuitRun,
  sessionFromRun,
  sessionPid,
  shouldMarkWaitingForHuman,
  tail,
  type AutomationTaskProcessResult,
  type AutomationTaskRunExecution,
} from "./task-run-finalization.ts";
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
import {
  closeLibrettoSession,
  disarmAutomationSessionTimeout,
  finalizeAllOwnedAutomationSessions,
  finalizeOwnedAutomationSession,
  ownAutomationSession,
  ownedAutomationSession,
  restoreAutomationSessionOwnership,
  type OwnedAutomationSession,
} from "./session-lifecycle.ts";
import {
  activeTaskRuns,
  createTaskRun,
  taskRunById,
  updateTaskRun,
  type AutomationTaskRun,
  type AutomationTaskStatus,
} from "./store.ts";
import {
  AUTOMATION_CREDENTIAL_GROUPS,
  taskById,
} from "./tasks.ts";
import {
  isStatementSelectionGroup,
  selectStatementTypes,
} from "../statement-selection.ts";
import { readAutomationSettings } from "./settings.ts";

export { closeLibrettoSession };

const activeTaskRunIds = new Map<string, string>();
const activeTaskChildren = new Map<string, ChildProcess>();
let librettoRunCdpPatched = false;

export type StartAutomationTaskOptions = {
  scheduledAtUtc?: string;
};

function validateScheduledAtUtc(value: string | undefined) {
  if (value !== undefined && (
    Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value
  )) {
    throw new Error(`Invalid scheduledAtUtc: ${value}`);
  }
}

export function createAutomationSessionId(uuid: () => string = randomUUID): string {
  return validateLibrettoSessionName("ses-octopus-" + uuid());
}

export function resumeFailureMessage(output: string) {
  return output.match(/Workflow failed after resume:\s*([^\r\n]+)/i)?.[1]?.trim() ?? null;
}

export function parseAutomationProgress(output: string) {
  let progress: number | null = null;
  for (const match of output.matchAll(/automation-progress:\s*(\d+(?:\.\d+)?)/gi)) {
    const value = Math.round(Number(match[1]));
    progress = Math.max(0, Math.min(100, value));
  }
  return progress;
}

export function automationProcessEnv(baseEnv: NodeJS.ProcessEnv = process.env) {
  return automationConfigEnv({ baseEnv });
}

export function liveTaskRunUpdate(logTail: string) {
  const resumeFailure = resumeFailureMessage(logTail);
  if (resumeFailure) {
    return { status: "failed" as const, errorMessage: resumeFailure, logTail };
  }
  if (shouldMarkWaitingForHuman(logTail)) {
    return { status: "waiting_for_human" as const, logTail };
  }
  return { logTail };
}

export function shouldCloseResumeSession(input: {
  status: AutomationTaskStatus;
  resumeSession?: string;
}) {
  return input.status === "failed" && Boolean(input.resumeSession);
}

export function librettoRunCdpPatchCommand(input: { resumeSession?: string }) {
  const command = resolvePatchCommand(input);
  return command ? [command.command, ...command.args] as const : null;
}

export function prepareLibrettoRunCdpPatch(runPatch: () => void = () => {
  const command = resolvePatchCommand({});
  if (!command) return;
  const patch = spawnSync(command.command, command.args, {
    env: command.env,
    encoding: "utf8",
  });
  if (patch.stdout) console.info(patch.stdout.trim());
  if (patch.stderr) console.warn(patch.stderr.trim());
  if (patch.error || patch.status !== 0) {
    throw patch.error ?? new Error(`Libretto CDP patch exited with code ${patch.status}`);
  }
}) {
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

export function createAutomationOutputBuffer(
  write: (chunk: string) => void,
  delayMs = 500,
  onError: (error: unknown) => void = (error) => {
    console.error("automation-output-write-failed", error);
  },
) {
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (retry: boolean) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const chunk = pending;
    pending = "";
    try {
      write(chunk);
    } catch (error) {
      pending = tail(chunk + pending);
      if (retry) timer = setTimeout(() => flush(true), delayMs);
      try {
        onError(error);
      } catch (handlerError) {
        console.error("automation-output-error-handler-failed", handlerError);
      }
    }
  };
  return {
    push(chunk: string) {
      pending = tail(pending + chunk);
      if (!timer) timer = setTimeout(() => flush(true), delayMs);
    },
    flush: () => flush(false),
  };
}

export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Concurrency limit must be a positive integer.");
  const active = new Set<Promise<void>>();
  const errors: unknown[] = [];
  for (const item of items) {
    if (active.size >= limit) await Promise.race(active);
    const task = Promise.resolve()
      .then(() => run(item))
      .catch((error) => { errors.push(error); })
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
  const selectedTaskIds = taskIds.filter((taskId) => taskId !== "import-downloads-csv");
  const errors: unknown[] = [];
  await runWithConcurrency(selectedTaskIds, 2, execute).catch((error) => { errors.push(error); });
  if (
    taskIds.includes("import-downloads-csv")
    || selectedTaskIds.some((taskId) => taskById(taskId)?.kind === "crawler")
  ) {
    await execute("import-downloads-csv").catch((error) => { errors.push(error); });
  }
  if (errors.length) throw errors[0];
}

export function claimRunAutomationSession(
  db: ReturnType<typeof openLedgerDatabase>,
  taskRunId: string,
  owner: OwnedAutomationSession,
  options: { resumeSession?: string; resumeFrom?: AutomationTaskRun } = {},
) {
  const current = ownedAutomationSession(owner.taskId);
  const resumeFrom = options.resumeFrom;
  let claimError: unknown = null;
  const isResumeHandoff = Boolean(
    options.resumeSession
      && options.resumeSession === owner.session
      && resumeFrom?.status === "waiting_for_human"
      && resumeFrom.taskId === owner.taskId
      && resumeFrom.taskRunId !== taskRunId
      && sessionFromRun(resumeFrom) === owner.session
      && (!current
        || (current.taskRunId === resumeFrom.taskRunId && current.session === owner.session)),
  );
  if ((!options.resumeSession || isResumeHandoff) && (!current || isResumeHandoff)) {
    if (resumeFrom) {
      const claimRejected = new Error("Automation session registry claim rejected");
      let registryClaimed = false;
      db.exec("BEGIN");
      try {
        updateTaskRun(db, resumeFrom.taskRunId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          errorMessage: `Superseded by resume handoff: ${taskRunId}`,
          logTail: tail(`${resumeFrom.logTail}\nautomation-resume-handoff: ${taskRunId}\n`),
        });
        if (!ownAutomationSession(owner)) throw claimRejected;
        registryClaimed = true;
        db.exec("COMMIT");
        disarmAutomationSessionTimeout(owner.taskId);
        return true;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } finally {
          if (registryClaimed) restoreAutomationSessionOwnership(owner, current);
        }
        claimError = error;
      }
    } else if (ownAutomationSession(owner)) {
      disarmAutomationSessionTimeout(owner.taskId);
      return true;
    }
  }
  updateTaskRun(db, taskRunId, {
    status: "failed",
    finishedAt: new Date().toISOString(),
    exitCode: null,
    signal: null,
    errorMessage: claimError && errorMessage(claimError) !== "Automation session registry claim rejected"
      ? `Automation session handoff failed: ${errorMessage(claimError)}`
      : "Automation session is still closing. Try again after cleanup finishes.",
  });
  return false;
}

export function accumulateAutomationOutput(
  state: { logTail: string; resumeFailure: string | null },
  chunk: string,
) {
  const logChunk = stripVTControlCharacters(chunk);
  const combined = state.logTail + logChunk;
  return {
    logChunk,
    logTail: tail(combined),
    resumeFailure: state.resumeFailure ?? resumeFailureMessage(combined),
  };
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
    ? AUTOMATION_CREDENTIAL_GROUPS.find((candidate) => candidate.id === task.credentialGroupId)
    : null;
  if (group && isStatementSelectionGroup(group)) {
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
      ? AUTOMATION_CREDENTIAL_GROUPS.find((candidate) => candidate.id === task.credentialGroupId)
      : null;
    if (group && isStatementSelectionGroup(group)) {
      settings ??= readAutomationSettings();
      selectStatementTypes(group, settings, "strict");
    }
    if (activeTaskRunIds.has(taskId)) throw new Error(`Automation task is already running: ${taskId}`);
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
  if (!session.match(/^[\w-]+$/)) throw new Error(`Invalid Libretto session: ${session}`);
  claimTask(taskId);
  void runAutomationTask(taskId, ledgerDir, { claimed: true, resumeSession: session }).catch((error) => {
    console.error("automation-task-resume-failed", error);
  });
}

export async function cancelAutomationTask(taskId: string) {
  if (!activeTaskRunIds.has(taskId)) throw new Error(`Automation task is not running: ${taskId}`);
  if (activeTaskRunIds.get(taskId) === "queued") {
    activeTaskRunIds.delete(taskId);
    return { cancelled: taskId };
  }
  const child = activeTaskChildren.get(taskId);
  if (!child) throw new Error(`Automation task has not started a process yet: ${taskId}`);
  child.kill("SIGTERM");
  await finalizeOwnedAutomationSession(taskId);
  return { cancelled: taskId };
}

export async function recoverAbandonedAutomationSessions(
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  dependencies: { finalizeRun?: typeof finalizePersistedRun } = {},
) {
  await finalizePersistedActiveRuns(
    ledgerDir,
    "App 前次異常結束",
    dependencies.finalizeRun,
  );
}

export async function shutdownAutomationSessions(
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  dependencies: Partial<{
    finalizeOwnedSessions: typeof finalizeAllOwnedAutomationSessions;
    finalizePersistedRuns: typeof finalizePersistedActiveRuns;
  }> = {},
) {
  for (const child of activeTaskChildren.values()) child.kill("SIGTERM");
  const errors: unknown[] = [];
  const finalizeOwnedSessions = dependencies.finalizeOwnedSessions
    ?? finalizeAllOwnedAutomationSessions;
  const finalizePersistedRuns = dependencies.finalizePersistedRuns
    ?? finalizePersistedActiveRuns;
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
  if (errors.length) throw new AggregateError(errors, "Failed to shut down automation sessions");
}

function createAutomationTaskRunExecution(
  task: NonNullable<ReturnType<typeof taskById>>,
  taskDb: ReturnType<typeof openLedgerDatabase>,
  options: StartAutomationTaskOptions & { resumeSession?: string },
): AutomationTaskRunExecution | null {
  const attempt = 1;
  const maxAttempts = 1;
  const startedAt = new Date().toISOString();
  const logPath = join(
    "data",
    "automation",
    "logs",
    `${task.id}-${Date.now()}-${attempt}.log`,
  );
  const env = automationProcessEnv();
  const isLibrettoTask = task.command[0] === "libretto";
  const session = isLibrettoTask
    ? options.resumeSession ?? createAutomationSessionId()
    : null;
  const command = resolveTaskCommand(task, {
    resumeSession: options.resumeSession,
    session: options.resumeSession ? undefined : session ?? undefined,
  }, env);
  if (task.id === "exchange-rates" && options.scheduledAtUtc) {
    if (command.command === "npm") command.args.push("--");
    command.args.push("--scheduled-at-utc", options.scheduledAtUtc);
    command.display += ` --scheduled-at-utc ${options.scheduledAtUtc}`;
  }
  const run = createTaskRun(taskDb, {
    taskId: task.id,
    script: command.display,
    kind: task.kind,
    status: "running",
    attempt,
    maxAttempts,
    startedAt,
    logPath,
  });
  activeTaskRunIds.set(task.id, run.taskRunId);
  const owner = session ? {
    taskId: task.id,
    taskRunId: run.taskRunId,
    session,
    pid: sessionPid(session),
  } : null;
  if (session) {
    appendLog(logPath, "automation-session: " + session + "\n");
    const resumeFrom = options.resumeSession
      ? activeTaskRuns(taskDb).find((candidate) =>
        candidate.taskId === task.id
        && candidate.taskRunId !== run.taskRunId
        && candidate.status === "waiting_for_human"
        && sessionFromRun(candidate) === options.resumeSession
      )
      : undefined;
    if (!claimRunAutomationSession(taskDb, run.taskRunId, owner!, {
      resumeSession: options.resumeSession,
      resumeFrom,
    })) return null;
  }
  return { task, taskDb, run, logPath, command, session, owner };
}

async function executeAutomationTaskProcess(
  execution: AutomationTaskRunExecution,
): Promise<AutomationTaskProcessResult> {
  let logTail = "";
  let detectedResumeFailure: string | null = null;
  let statementSummary: StatementRunSummary | null = null;
  const outputPersistenceWarnings: string[] = [];
  const result = await new Promise<Pick<AutomationTaskProcessResult, "exitCode" | "signal" | "error">>((resolve) => {
    const recordOutputPersistenceError = (error: unknown) => {
      const line = `automation-output-write-failed: ${errorMessage(error)}`;
      console.error(line);
      logTail = tail(`${logTail}\n${line}\n`);
      outputPersistenceWarnings.push(line);
    };
    const outputBuffer = createAutomationOutputBuffer(
      () => {
        if (!isForceQuitRun(taskRunById(execution.taskDb, execution.run.taskRunId))) {
          updateTaskRun(execution.taskDb, execution.run.taskRunId, liveTaskRunUpdate(logTail));
        }
      },
      500,
      recordOutputPersistenceError,
    );
    const onOutput = (chunk: Buffer) => {
      const output = accumulateAutomationOutput(
        { logTail, resumeFailure: detectedResumeFailure },
        chunk.toString("utf8"),
      );
      statementSummary = parseStatementRunSummary(`${logTail}${output.logChunk}`)
        ?? statementSummary;
      logTail = output.logTail;
      detectedResumeFailure = output.resumeFailure;
      try {
        appendLog(execution.logPath, output.logChunk);
      } catch (error) {
        recordOutputPersistenceError(error);
      }
      outputBuffer.push(output.logChunk);
      if (execution.owner) {
        ownAutomationSession({ ...execution.owner, pid: sessionPid(execution.owner.session) });
      }
    };
    const child = spawn(execution.command.command, execution.command.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: execution.command.env,
    });
    activeTaskChildren.set(execution.task.id, child);
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.on("error", (error) => {
      activeTaskChildren.delete(execution.task.id);
      outputBuffer.flush();
      resolve({ exitCode: null, signal: null, error });
    });
    child.on("close", (exitCode, signal) => {
      activeTaskChildren.delete(execution.task.id);
      outputBuffer.flush();
      resolve({ exitCode, signal, error: null });
    });
  });
  return {
    ...result,
    logTail,
    resumeFailure: detectedResumeFailure ?? resumeFailureMessage(logTail),
    statementSummary,
    outputPersistenceWarnings,
  };
}

export async function runAutomationTask(
  taskId: string,
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  options: StartAutomationTaskOptions & { claimed?: boolean; resumeSession?: string } = {},
) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  validateScheduledAtUtc(options.scheduledAtUtc);
  if (!options.claimed) claimTask(taskId);

  let db: ReturnType<typeof openLedgerDatabase> | null = null;
  try {
    db = openLedgerDatabase(ledgerDir);
    const execution = createAutomationTaskRunExecution(task, db, options);
    if (!execution) return { status: "failed" as const };
    const result = await executeAutomationTaskProcess(execution);
    return await finalizeAutomationTaskRun(execution, result, ledgerDir);
  } finally {
    activeTaskRunIds.delete(taskId);
    activeTaskChildren.delete(taskId);
    db?.close();
  }
}
