import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { businessDayUtcRange } from "./business-day.ts";
import { parseEnvText } from "./env-file.ts";
import { automationGroupEnabledStatus, readAutomationEnvText } from "./settings.ts";
import {
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

const activeTaskRunIds = new Map<string, string>();

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

export function automationProcessEnv(
  envText = readAutomationEnvText(),
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  return {
    ...baseEnv,
    ...parseEnvText(envText),
  };
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
  if (input.kind === "crawler" && input.attempt < input.maxAttempts) return "retrying";
  return "failed";
}

export function shouldCloseResumeSession(input: {
  status: AutomationTaskStatus;
  resumeSession?: string;
}) {
  return input.status === "failed" && Boolean(input.resumeSession);
}

export function librettoRunCdpPatchCommand(input: { resumeSession?: string }) {
  if (input.resumeSession) return null;
  return ["node", "scripts/patch-libretto-run-cdp.mjs"] as const;
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

export async function closeLibrettoSession(session: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["libretto", "close", "--session", session], {
      stdio: ["ignore", "ignore", "pipe"],
      env: automationProcessEnv(),
    });
    let errorText = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errorText = tail(errorText + chunk.toString("utf8"));
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(new Error(errorText || `libretto close exited with code ${exitCode}`));
    });
  });
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
    const maxAttempts = options.resumeSession ? 1 : task.maxAttempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = new Date().toISOString();
      const logPath = join(
        "data",
        "automation",
        "logs",
        `${task.id}-${Date.now()}-${attempt}.log`,
      );
      const script = options.resumeSession
        ? `npx libretto resume --session ${options.resumeSession}`
        : task.script;
      const run = createTaskRun(taskDb, {
        taskId: task.id,
        script,
        kind: task.kind,
        status: attempt > 1 ? "retrying" : "running",
        attempt,
        maxAttempts,
        startedAt,
        logPath,
      });
      activeTaskRunIds.set(task.id, run.taskRunId);
      let logTail = "";
      let closeResumeSessionPromise: Promise<void> | null = null;
      const closeResumeSessionAfterFailure = () => {
        if (!options.resumeSession) return null;
        closeResumeSessionPromise ??= closeLibrettoSession(
          options.resumeSession,
        ).catch((error: unknown) => {
          console.warn("automation-resume-session-close-failed", {
            session: options.resumeSession,
            message: error instanceof Error ? error.message : String(error),
          });
        });
        return closeResumeSessionPromise;
      };

      const result = await new Promise<{
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        error: Error | null;
      }>((resolve) => {
        const command = options.resumeSession
          ? ["npx", "libretto", "resume", "--session", options.resumeSession]
          : ["npm", "run", task.script];
        const env = automationProcessEnv();
        const onOutput = (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          appendLog(logPath, text);
          logTail = tail(logTail + text);
          if (!isForceQuitRun(taskRunById(taskDb, run.taskRunId))) {
            updateTaskRun(taskDb, run.taskRunId, liveTaskRunUpdate(logTail));
          }
          if (resumeFailureMessage(logTail)) {
            void closeResumeSessionAfterFailure();
          }
        };
        const patchCommand = librettoRunCdpPatchCommand(options);
        if (patchCommand) {
          const patch = spawnSync(patchCommand[0], patchCommand.slice(1), {
            env,
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
        const child = spawn(command[0], command.slice(1), {
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });
        child.stdout.on("data", onOutput);
        child.stderr.on("data", onOutput);
        child.on("error", (error) => {
          resolve({ exitCode: null, signal: null, error });
        });
        child.on("close", (exitCode, signal) => {
          resolve({ exitCode, signal, error: null });
        });
      });

      const resumeFailure = resumeFailureMessage(logTail);
      const status = result.error || resumeFailure
        ? "failed"
        : nextAttemptStatus({
          kind: task.kind,
          attempt,
          maxAttempts,
          exitCode: result.exitCode,
          waitingForHuman: shouldMarkWaitingForHuman(logTail),
        });
      if (isForceQuitRun(taskRunById(taskDb, run.taskRunId))) return { status: "failed" };
      updateTaskRun(taskDb, run.taskRunId, {
        status,
        finishedAt: new Date().toISOString(),
        exitCode: result.exitCode,
        signal: result.signal,
        logTail,
        errorMessage: result.error?.message
          ?? resumeFailure
          ?? (status === "failed" ? `Task exited with code ${result.exitCode}` : null),
      });
      if (shouldCloseResumeSession({ status, resumeSession: options.resumeSession })) {
        await closeResumeSessionAfterFailure();
      }
      if (status !== "retrying") {
        if (status !== "completed") return { status };
        const range = businessDayUtcRange();
        const enabledGroups = automationGroupEnabledStatus(readAutomationEnvText());
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
    }
    return { status: "failed" as const };
  } finally {
    activeTaskRunIds.delete(taskId);
    db?.close();
  }
}
