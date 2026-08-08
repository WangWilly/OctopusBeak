import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import {
  parseStatementRunSummary,
  type StatementRunSummary,
} from "../statement-run-summary.ts";
import { parseExternalPrerequisiteSignals } from "../external-prerequisite.ts";
import {
  createHumanAssistanceContractFrameParser,
  HUMAN_ASSISTANCE_HOST_FD_ENV,
} from "../human-assistance.ts";
import { resolveTaskCommand } from "./desktop-command.ts";
import { automationConfigEnv } from "./config-files.ts";
import { validateLibrettoSessionName } from "./libretto-session.ts";
import {
  appendLog,
  errorMessage,
  sessionPid,
  tail,
  claimAutomationTaskRunSession,
  refreshAutomationSession,
  sessionFromRun,
  type OwnedAutomationSession,
} from "./automation-session-disposition.ts";
import {
  finalizeAutomationTaskRun,
  isForceQuitRun,
  shouldMarkWaitingForHuman,
  type AutomationTaskProcessResult,
  type AutomationTaskRunFinalizationContext,
  type AutomationTaskRunExecution,
} from "./task-run-finalization.ts";
import {
  activeTaskRuns,
  createTaskRun,
  taskRunById,
  updateHumanAssistanceContract,
  updateTaskRun,
} from "./store.ts";
import { taskById } from "./tasks.ts";

const activeTaskChildren = new Map<string, ChildProcess>();

export type AutomationTaskExecutionOptions = {
  scheduledAtUtc?: string;
  resumeSession?: string;
};

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

export const claimRunAutomationSession = claimAutomationTaskRunSession;

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

function createAutomationTaskRunExecution(
  task: NonNullable<ReturnType<typeof taskById>>,
  taskDb: ReturnType<typeof openLedgerDatabase>,
  options: AutomationTaskExecutionOptions,
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
  const resumeFrom = options.resumeSession
    ? activeTaskRuns(taskDb).find((candidate) =>
      candidate.taskId === task.id
      && candidate.status === "waiting_for_human"
      && sessionFromRun(candidate) === options.resumeSession
    )
    : undefined;
  const run = createTaskRun(taskDb, {
    taskId: task.id,
    script: command.display,
    kind: task.kind,
    status: "running",
    attempt,
    maxAttempts,
    startedAt,
    logPath,
    humanAssistanceContract: resumeFrom?.humanAssistanceContract ?? null,
  });
  const owner = session ? {
    taskId: task.id,
    taskRunId: run.taskRunId,
    session,
    pid: sessionPid(session),
  } : null;
  if (session) {
    appendLog(logPath, "automation-session: " + session + "\n");
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
  let lastHumanAssistanceContractJson: string | null = null;
  let statementSummary: StatementRunSummary | null = null;
  const externalPrerequisiteIds = new Set<string>();
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
          updateTaskRun(execution.taskDb, execution.run.taskRunId, {
            ...liveTaskRunUpdate(logTail),
          });
        }
      },
      500,
      recordOutputPersistenceError,
    );
    const onHumanAssistanceContract = (
      latestHumanAssistanceContract: Parameters<typeof updateHumanAssistanceContract>[2],
    ) => {
      const contractJson = JSON.stringify(latestHumanAssistanceContract);
      if (contractJson === lastHumanAssistanceContractJson) return;
      try {
        updateHumanAssistanceContract(
          execution.taskDb,
          execution.run.taskRunId,
          latestHumanAssistanceContract,
        );
        lastHumanAssistanceContractJson = contractJson;
      } catch (error) {
        const warning = `human-assistance-contract-rejected: ${errorMessage(error)}`;
        console.error(warning);
        outputPersistenceWarnings.push(warning);
      }
    };
    const hostContractParser = createHumanAssistanceContractFrameParser(onHumanAssistanceContract);
    const onOutput = (chunk: Buffer) => {
      const output = accumulateAutomationOutput(
        { logTail, resumeFailure: detectedResumeFailure },
        chunk.toString("utf8"),
      );
      statementSummary = parseStatementRunSummary(`${logTail}${output.logChunk}`)
        ?? statementSummary;
      for (const prerequisiteId of parseExternalPrerequisiteSignals(`${logTail}${output.logChunk}`)) {
        externalPrerequisiteIds.add(prerequisiteId);
      }
      logTail = output.logTail;
      detectedResumeFailure = output.resumeFailure;
      try {
        appendLog(execution.logPath, output.logChunk);
      } catch (error) {
        recordOutputPersistenceError(error);
      }
      outputBuffer.push(output.logChunk);
      if (execution.owner) {
        refreshAutomationSession(execution.owner);
      }
    };
    const child = spawn(execution.command.command, execution.command.args, {
      stdio: ["ignore", "pipe", "pipe", "pipe"] as const,
      env: {
        ...execution.command.env,
        [HUMAN_ASSISTANCE_HOST_FD_ENV]: "3",
      },
    });
    activeTaskChildren.set(execution.task.id, child);
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.stdio[3]?.on("data", hostContractParser.push);
    child.on("error", (error) => {
      activeTaskChildren.delete(execution.task.id);
      hostContractParser.flush();
      outputBuffer.flush();
      resolve({ exitCode: null, signal: null, error });
    });
    child.on("close", (exitCode, signal) => {
      activeTaskChildren.delete(execution.task.id);
      hostContractParser.flush();
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
    externalPrerequisiteIds: [...externalPrerequisiteIds],
  };
}

export function liveTaskRunUpdate(logTail: string) {
  const resumeFailure = resumeFailureMessage(logTail);
  if (resumeFailure) return { errorMessage: resumeFailure, logTail };
  if (shouldMarkWaitingForHuman(logTail)) return { status: "waiting_for_human" as const, logTail };
  return { logTail };
}

export async function runAutomationTaskExecution(
  task: NonNullable<ReturnType<typeof taskById>>,
  taskDb: ReturnType<typeof openLedgerDatabase>,
  ledgerDir: string,
  options: AutomationTaskExecutionOptions,
  onRunCreated: (taskRunId: string) => void,
) {
  const execution = createAutomationTaskRunExecution(task, taskDb, options);
  if (!execution) return { status: "failed" as const };
  onRunCreated(execution.run.taskRunId);
  try {
    const result = await executeAutomationTaskProcess(execution);
    const finalizationContext: AutomationTaskRunFinalizationContext = {
      taskDb,
      taskId: task.id,
      taskKind: task.kind,
      taskRunId: execution.run.taskRunId,
      logPath: execution.logPath,
      ledgerDir,
    };
    return await finalizeAutomationTaskRun(finalizationContext, result);
  } finally {
    activeTaskChildren.delete(task.id);
  }
}

export function automationTaskChild(taskId: string) {
  return activeTaskChildren.get(taskId);
}

export function terminateAutomationTaskProcesses() {
  for (const child of activeTaskChildren.values()) child.kill("SIGTERM");
}
