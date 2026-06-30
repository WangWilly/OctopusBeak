import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { businessDayUtcRange } from "./business-day.ts";
import { automationGroupEnabledStatus, readAutomationEnvText } from "./settings.ts";
import {
  createTaskRun,
  importGateStatus,
  updateTaskRun,
  type AutomationTaskStatus,
} from "./store.ts";
import {
  enabledCsvImportDependencyIds,
  taskById,
  type AutomationTaskKind,
} from "./tasks.ts";

const activeTaskRunIds = new Map<string, string>();

export function shouldMarkWaitingForHuman(output: string) {
  return /resume --session|paused|captcha|otp|verification|certificate/i.test(output);
}

export function resumeSessionFromLog(output: string) {
  return output.match(/libretto resume --session\s+([\w-]+)/i)?.[1] ?? null;
}

export function parseAutomationProgress(output: string) {
  let progress: number | null = null;
  for (const match of output.matchAll(/automation-progress:\s*(\d+(?:\.\d+)?)/gi)) {
    const value = Math.round(Number(match[1]));
    progress = Math.max(0, Math.min(100, value));
  }
  return progress;
}

export function liveTaskRunUpdate(logTail: string) {
  if (shouldMarkWaitingForHuman(logTail)) {
    return { status: "waiting_for_human" as const, logTail };
  }
  return { logTail };
}

export function nextAttemptStatus(input: {
  kind: AutomationTaskKind;
  attempt: number;
  maxAttempts: number;
  exitCode: number | null;
  waitingForHuman?: boolean;
}): AutomationTaskStatus {
  if (input.waitingForHuman) return "waiting_for_human";
  if (input.exitCode === 0) return "completed";
  if (input.kind === "crawler" && input.attempt < input.maxAttempts) return "retrying";
  return "failed";
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

      const result = await new Promise<{
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        error: Error | null;
      }>((resolve) => {
        const command = options.resumeSession
          ? ["npx", "libretto", "resume", "--session", options.resumeSession]
          : ["npm", "run", task.script];
        const child = spawn(command[0], command.slice(1), {
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });
        const onOutput = (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          appendLog(logPath, text);
          logTail = tail(logTail + text);
          updateTaskRun(taskDb, run.taskRunId, liveTaskRunUpdate(logTail));
        };
        child.stdout.on("data", onOutput);
        child.stderr.on("data", onOutput);
        child.on("error", (error) => {
          resolve({ exitCode: null, signal: null, error });
        });
        child.on("close", (exitCode, signal) => {
          resolve({ exitCode, signal, error: null });
        });
      });

      const status = result.error
        ? "failed"
        : nextAttemptStatus({
          kind: task.kind,
          attempt,
          maxAttempts,
          exitCode: result.exitCode,
          waitingForHuman: shouldMarkWaitingForHuman(logTail),
        });
      updateTaskRun(taskDb, run.taskRunId, {
        status,
        finishedAt: new Date().toISOString(),
        exitCode: result.exitCode,
        signal: result.signal,
        logTail,
        errorMessage: result.error?.message
          ?? (status === "failed" ? `Task exited with code ${result.exitCode}` : null),
      });
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
