import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { businessDayUtcRange } from "./business-day.ts";
import {
  resolvePatchCommand,
  resolveTaskCommand,
} from "./desktop-command.ts";
import { automationConfigEnv } from "./config-files.ts";
import { readLibrettoSessionState, validateLibrettoSessionName } from "./libretto-session.ts";
import {
  armAutomationSessionTimeout,
  closeLibrettoSession,
  disarmAutomationSessionTimeout,
  finalizeAllOwnedAutomationSessions,
  finalizeOwnedAutomationSession,
  ownAutomationSession,
} from "./session-lifecycle.ts";
import {
  automationBusinessTimezone,
  automationGroupEnabledStatus,
  readAutomationSettings,
} from "./settings.ts";
import {
  activeTaskRuns,
  createTaskRun,
  importGateStatus,
  taskRunById,
  updateTaskRun,
  type AutomationTaskRun,
  type AutomationTaskStatus,
} from "./store.ts";
import {
  enabledCsvImportDependencyIds,
  taskById,
  type AutomationTaskKind,
} from "./tasks.ts";

export { closeLibrettoSession };

const activeTaskRunIds = new Map<string, string>();
const activeTaskChildren = new Map<string, ChildProcess>();

export function createAutomationSessionId(uuid: () => string = randomUUID): string {
  return validateLibrettoSessionName("ses-octopus-" + uuid());
}

export function automationSessionFromLog(output: string) {
  return output.match(/automation-session:\s+([A-Za-z0-9._-]+)/i)?.[1] ?? null;
}

export function shouldRetainAutomationSession(status: AutomationTaskStatus) {
  return status === "waiting_for_human";
}

export function appendCleanupError(message: string | null, cleanup: string) {
  const suffix = "Session cleanup failed: " + cleanup;
  return message ? message + "\n" + suffix : suffix;
}

export function shouldMarkWaitingForHuman(output: string) {
  return /manual-(?:auth|otp)-required|workflow paused|resume --session|\benter\b[^\r\n]*(?:captcha|otp|verification|certificate)/i.test(output);
}

export function resumeSessionFromLog(output: string) {
  return output.match(/libretto resume --session\s+([\w-]+)/i)?.[1] ?? null;
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

export function finalFailureMessage(logTail: string, exitCode: number | null) {
  const message = logTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .toReversed()
    .find((line) =>
      !/^automation-progress:/i.test(line) &&
      !/^libretto run CDP patch/i.test(line) &&
      !/^Running workflow /i.test(line) &&
      !/^Browser is still open\./i.test(line)
    );
  return message ?? `Task exited with code ${exitCode}`;
}

export function isForceQuitRun(
  run: Pick<AutomationTaskRun, "status" | "errorMessage"> | null | undefined,
) {
  return run?.status === "failed" && run.errorMessage?.startsWith("Browser session force quit") === true;
}

export function nextAttemptStatus(input: {
  kind: AutomationTaskKind;
  attempt: number;
  maxAttempts: number;
  exitCode: number | null;
  waitingForHuman?: boolean;
}): AutomationTaskStatus {
  if (input.exitCode === 0 && input.waitingForHuman) return "waiting_for_human";
  if (input.exitCode === 0) return "completed";
  return "failed";
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

export function shouldAutoRunImport(input: {
  kind: AutomationTaskKind;
  status: AutomationTaskStatus;
  importLocked: boolean;
}) {
  return input.kind === "crawler" && input.status === "completed" && !input.importLocked;
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

function appendLog(logPath: string, chunk: string) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, chunk);
}

function tail(value: string) {
  return value.slice(-4000);
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
) {
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);
  claimTask(taskId);
  void runAutomationTask(taskId, ledgerDir, { claimed: true }).catch((error) => {
    console.error("automation-task-run-failed", error);
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
  const child = activeTaskChildren.get(taskId);
  if (!child) throw new Error(`Automation task has not started a process yet: ${taskId}`);
  child.kill("SIGTERM");
  await finalizeOwnedAutomationSession(taskId);
  return { cancelled: taskId };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sessionPid(session: string) {
  try {
    return readLibrettoSessionState(session)?.pid ?? null;
  } catch {
    return null;
  }
}

function sessionFromRun(run: AutomationTaskRun) {
  try {
    const output = readFileSync(run.logPath, "utf8");
    const session = automationSessionFromLog(output) ?? resumeSessionFromLog(output);
    if (session) return session;
  } catch {
    // The bounded log tail remains the recovery source when the log file is unavailable.
  }
  return automationSessionFromLog(run.logTail) ?? resumeSessionFromLog(run.logTail);
}

async function finalizePersistedRun(
  db: ReturnType<typeof openLedgerDatabase>,
  run: AutomationTaskRun,
  reason: string,
) {
  const session = sessionFromRun(run);
  const pid = session ? sessionPid(session) : null;
  let cleanupError: string | null = null;
  if (!session) {
    cleanupError = "Missing Libretto session identity";
  } else {
    ownAutomationSession({ taskId: run.taskId, taskRunId: run.taskRunId, session, pid });
    try {
      await finalizeOwnedAutomationSession(run.taskId);
    } catch (error) {
      cleanupError = errorMessage(error);
    }
  }
  updateTaskRun(db, run.taskRunId, {
    status: "failed",
    finishedAt: new Date().toISOString(),
    exitCode: null,
    signal: null,
    errorMessage: cleanupError
      ? appendCleanupError(run.errorMessage ?? reason, cleanupError)
      : run.errorMessage ?? reason,
  });
  appendLog(
    run.logPath,
    `automation-session-finalize: session=${session ?? "unknown"} pid=${pid ?? "unknown"} cleanup-error=${cleanupError ?? "none"}\n`,
  );
}

async function finalizePersistedActiveRuns(ledgerDir: string, reason: string) {
  const db = openLedgerDatabase(ledgerDir);
  const errors: unknown[] = [];
  try {
    for (const run of activeTaskRuns(db)) {
      try {
        await finalizePersistedRun(db, run, reason);
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    db.close();
  }
  if (errors.length) throw new AggregateError(errors, "Failed to finalize persisted automation runs");
}

export async function recoverAbandonedAutomationSessions(
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) {
  await finalizePersistedActiveRuns(ledgerDir, "App 前次異常結束");
}

export async function shutdownAutomationSessions(
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) {
  for (const child of activeTaskChildren.values()) child.kill("SIGTERM");
  const errors: unknown[] = [];
  try {
    await finalizeAllOwnedAutomationSessions();
  } catch (error) {
    errors.push(error);
  }
  try {
    await finalizePersistedActiveRuns(ledgerDir, "App 關閉，人工操作未完成");
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, "Failed to shut down automation sessions");
}

export async function runAutomationTask(
  taskId: string,
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  options: { claimed?: boolean; resumeSession?: string } = {},
) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  if (!options.claimed) claimTask(taskId);

  let db: ReturnType<typeof openLedgerDatabase> | null = null;
  try {
    db = openLedgerDatabase(ledgerDir);
    const taskDb = db;
    const maxAttempts = 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
      const script = command.display;
      const run = createTaskRun(taskDb, {
        taskId: task.id,
        script,
        kind: task.kind,
        status: "running",
        attempt,
        maxAttempts,
        startedAt,
        logPath,
      });
      activeTaskRunIds.set(task.id, run.taskRunId);
      if (session) {
        appendLog(logPath, "automation-session: " + session + "\n");
        disarmAutomationSessionTimeout(task.id);
        ownAutomationSession({
          taskId: task.id,
          taskRunId: run.taskRunId,
          session,
          pid: sessionPid(session),
        });
      }
      let logTail = "";
      let detectedResumeFailure: string | null = null;

      const result = await new Promise<{
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        error: Error | null;
      }>((resolve) => {
        const onOutput = (chunk: Buffer) => {
          const output = accumulateAutomationOutput(
            { logTail, resumeFailure: detectedResumeFailure },
            chunk.toString("utf8"),
          );
          appendLog(logPath, output.logChunk);
          if (session) {
            ownAutomationSession({
              taskId: task.id,
              taskRunId: run.taskRunId,
              session,
              pid: sessionPid(session),
            });
          }
          logTail = output.logTail;
          detectedResumeFailure = output.resumeFailure;
          if (!isForceQuitRun(taskRunById(taskDb, run.taskRunId))) {
            updateTaskRun(taskDb, run.taskRunId, liveTaskRunUpdate(logTail));
          }
        };
        const patchCommand = resolvePatchCommand(options, env);
        if (patchCommand) {
          const patch = spawnSync(patchCommand.command, patchCommand.args, {
            env: patchCommand.env,
            encoding: "utf8",
          });
          if (patch.stdout) onOutput(Buffer.from(patch.stdout));
          if (patch.stderr) onOutput(Buffer.from(patch.stderr));
          if (patch.error || patch.status !== 0) {
            resolve({
              exitCode: patch.status,
              signal: patch.signal,
              error: patch.error ?? new Error(`Libretto CDP patch exited with code ${patch.status}`),
            });
            return;
          }
        }
        const child = spawn(command.command, command.args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: command.env,
        });
        activeTaskChildren.set(task.id, child);
        child.stdout.on("data", onOutput);
        child.stderr.on("data", onOutput);
        child.on("error", (error) => {
          activeTaskChildren.delete(task.id);
          resolve({ exitCode: null, signal: null, error });
        });
        child.on("close", (exitCode, signal) => {
          activeTaskChildren.delete(task.id);
          resolve({ exitCode, signal, error: null });
        });
      });

      const resumeFailure = detectedResumeFailure ?? resumeFailureMessage(logTail);
      let status: AutomationTaskStatus = result.error || resumeFailure
        ? "failed"
        : nextAttemptStatus({
          kind: task.kind,
          attempt,
          maxAttempts,
          exitCode: result.exitCode,
          waitingForHuman: shouldMarkWaitingForHuman(logTail),
        });
      let taskError = result.error?.message
        ?? resumeFailure
        ?? (status === "failed" ? finalFailureMessage(logTail, result.exitCode) : null);
      if (session && !shouldRetainAutomationSession(status)) {
        try {
          await finalizeOwnedAutomationSession(task.id);
        } catch (error) {
          taskError = appendCleanupError(taskError, errorMessage(error));
          if (status === "completed") status = "failed";
        }
      }
      if (isForceQuitRun(taskRunById(taskDb, run.taskRunId))) return { status: "failed" };
      updateTaskRun(taskDb, run.taskRunId, {
        status,
        finishedAt: new Date().toISOString(),
        exitCode: result.exitCode,
        signal: result.signal,
        logTail,
        errorMessage: taskError,
      });
      if (session && shouldRetainAutomationSession(status)) {
        armAutomationSessionTimeout(task.id, async () => {
          const timeoutDb = openLedgerDatabase(ledgerDir);
          try {
            if (taskRunById(timeoutDb, run.taskRunId)?.status !== "waiting_for_human") return;
            let timeoutError: string | null = null;
            try {
              await finalizeOwnedAutomationSession(task.id);
            } catch (error) {
              timeoutError = errorMessage(error);
            }
            if (taskRunById(timeoutDb, run.taskRunId)?.status !== "waiting_for_human") return;
            updateTaskRun(timeoutDb, run.taskRunId, {
              status: "failed",
              finishedAt: new Date().toISOString(),
              exitCode: null,
              signal: null,
              errorMessage: timeoutError
                ? appendCleanupError("等待人工操作超過 20 分鐘", timeoutError)
                : "等待人工操作超過 20 分鐘",
            });
          } catch (error) {
            console.error("automation-session-timeout-failed", error);
          } finally {
            timeoutDb.close();
          }
        });
      }
      if (status !== "completed") return { status };
      const settings = readAutomationSettings();
      const range = businessDayUtcRange(undefined, automationBusinessTimezone(settings));
      const enabledGroups = automationGroupEnabledStatus(settings);
      const gate = importGateStatus(taskDb, {
        dependencyIds: enabledCsvImportDependencyIds(enabledGroups),
        startUtc: range.startUtc,
        endUtc: range.endUtc,
      });
      if (shouldAutoRunImport({
        kind: task.kind,
        status,
        importLocked: gate.locked,
      }) && !activeTaskRunIds.has("import-downloads-csv")) {
        await runAutomationTask("import-downloads-csv", ledgerDir);
      }
      return { status };
    }
    return { status: "failed" as const };
  } finally {
    activeTaskRunIds.delete(taskId);
    activeTaskChildren.delete(taskId);
    db?.close();
  }
}
