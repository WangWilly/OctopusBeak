import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { businessDayUtcRange } from "./business-day.ts";
import {
  createTaskRun,
  importGateStatus,
  updateTaskRun,
  type AutomationTaskStatus,
} from "./store.ts";
import {
  CSV_IMPORT_DEPENDENCY_IDS,
  taskById,
  type AutomationTaskKind,
} from "./tasks.ts";

let activeTaskRunId: string | null = null;

export function shouldMarkWaitingForHuman(output: string) {
  return /resume --session|paused|captcha|otp|verification|certificate/i.test(output);
}

export function resumeSessionFromLog(output: string) {
  return output.match(/libretto resume --session\s+([\w-]+)/i)?.[1] ?? null;
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
  return activeTaskRunId !== null;
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
  if (activeTaskRunId) throw new Error("Another automation task is already running.");
  void runAutomationTask(taskId, ledgerDir).catch((error) => {
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
  if (activeTaskRunId) throw new Error("Another automation task is already running.");
  void runAutomationTask(taskId, ledgerDir, { resumeSession: session }).catch((error) => {
    console.error("automation-task-resume-failed", error);
  });
}

export async function runAutomationTask(
  taskId: string,
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  options: { resumeSession?: string } = {},
) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  if (activeTaskRunId) throw new Error("Another automation task is already running.");

  const db = openLedgerDatabase(ledgerDir);
  try {
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
      const run = createTaskRun(db, {
        taskId: task.id,
        script,
        kind: task.kind,
        status: attempt > 1 ? "retrying" : "running",
        attempt,
        maxAttempts,
        startedAt,
        logPath,
      });
      activeTaskRunId = run.taskRunId;
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
          if (shouldMarkWaitingForHuman(logTail)) {
            updateTaskRun(db, run.taskRunId, { status: "waiting_for_human", logTail });
          }
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
      updateTaskRun(db, run.taskRunId, {
        status,
        finishedAt: new Date().toISOString(),
        exitCode: result.exitCode,
        signal: result.signal,
        logTail,
        errorMessage: result.error?.message
          ?? (status === "failed" ? `Task exited with code ${result.exitCode}` : null),
      });
      activeTaskRunId = null;
      if (status !== "retrying") {
        if (status !== "completed") return { status };
        const range = businessDayUtcRange();
        const gate = importGateStatus(db, {
          dependencyIds: CSV_IMPORT_DEPENDENCY_IDS,
          startUtc: range.startUtc,
          endUtc: range.endUtc,
        });
        if (shouldAutoRunImport({
          kind: task.kind,
          status,
          importLocked: gate.locked,
        })) {
          await runAutomationTask("import-downloads-csv", ledgerDir);
        }
        return { status };
      }
    }
    return { status: "failed" as const };
  } finally {
    activeTaskRunId = null;
    db.close();
  }
}
