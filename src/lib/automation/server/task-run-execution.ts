import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
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
  HUMAN_ASSISTANCE_HOST_PATH_ENV,
} from "../human-assistance.ts";
import {
  GMAIL_OTP_IPC_ENDPOINT_ENV,
  GMAIL_OTP_IPC_TOKEN_ENV,
} from "../gmail-otp.ts";
import { createGmailOtpIpcServer } from "./gmail-otp-broker.ts";
import {
  ensureCathayGmailOtpAccess,
  prepareCathayGmailOtpRetrieval,
  retrieveCathayGmailOtp,
} from "./gmail-otp-service.ts";
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
import { ownAutomationSession } from "./session-lifecycle.ts";
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
  resumeHumanAssistanceContract,
  taskRunById,
  updateHumanAssistanceContract,
  updateTaskRun,
} from "./store.ts";
import { taskById } from "./tasks.ts";

const activeTaskChildren = new Map<string, ChildProcess>();

export type AutomationTaskExecutionOptions = {
  scheduledAtUtc?: string;
  resumeSession?: string;
  /** Reuse the user-visible task run for an internal execution. */
  taskRunId?: string;
  /** Snapshot of process configuration captured at campaign launch. */
  launchEnv?: NodeJS.ProcessEnv;
  /** Identity used to correlate host-side CAPTCHA routing with this execution. */
  executionId?: string;
  attempt?: number;
  maxAttempts?: number;
  /** Stop before launching a child when the host task was cancelled. */
  isCancellationRequested?: () => boolean;
};

export function createAutomationSessionId(
  uuid: () => string = randomUUID,
): string {
  return validateLibrettoSessionName("ses-octopus-" + uuid());
}

export function resumeFailureMessage(output: string) {
  return (
    output.match(/Workflow failed after resume:\s*([^\r\n]+)/i)?.[1]?.trim() ??
    null
  );
}

export function parseAutomationProgress(output: string) {
  let progress: number | null = null;
  for (const match of output.matchAll(
    /automation-progress:\s*(\d+(?:\.\d+)?)/gi,
  )) {
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
  const attempt = options.attempt ?? 1;
  const maxAttempts = options.maxAttempts ?? 1;
  const startedAt = new Date().toISOString();
  const env = { ...(options.launchEnv ?? automationProcessEnv()) };
  const isLibrettoTask = task.command[0] === "libretto";
  const session = isLibrettoTask
    ? (options.resumeSession ?? createAutomationSessionId())
    : null;
  const command = resolveTaskCommand(
    task,
    {
      resumeSession: options.resumeSession,
      session: options.resumeSession ? undefined : (session ?? undefined),
    },
    env,
  );
  if (task.id === "exchange-rates" && options.scheduledAtUtc) {
    if (command.command === "npm") command.args.push("--");
    command.args.push("--scheduled-at-utc", options.scheduledAtUtc);
    command.display += ` --scheduled-at-utc ${options.scheduledAtUtc}`;
  }
  const resumeFrom = options.resumeSession
    ? activeTaskRuns(taskDb).find(
        (candidate) =>
          candidate.taskId === task.id &&
          candidate.status === "waiting_for_human" &&
          sessionFromRun(candidate) === options.resumeSession,
      )
    : undefined;
  const existingRun = options.taskRunId
    ? taskRunById(taskDb, options.taskRunId)
    : resumeFrom;
  if (options.taskRunId && !existingRun) return null;
  const logPath = existingRun?.logPath ?? join(
    "data",
    "automation",
    "logs",
    `${task.id}-${Date.now()}-${attempt}.log`,
  );
  const run = existingRun
    ? { taskRunId: existingRun.taskRunId }
    : createTaskRun(taskDb, {
        taskId: task.id,
        script: command.display,
        kind: task.kind,
        status: "running",
        attempt,
        maxAttempts,
        startedAt,
        logPath,
        humanAssistanceContract: resumeHumanAssistanceContract(
          resumeFrom?.humanAssistanceContract,
        ),
      });
  if (existingRun) {
    updateTaskRun(taskDb, existingRun.taskRunId, {
      status: "running",
      attempt,
      maxAttempts,
      finishedAt: null,
      exitCode: null,
      signal: null,
      errorMessage: null,
    });
  }
  const owner = session
    ? {
        taskId: task.id,
        taskRunId: run.taskRunId,
        session,
        pid: sessionPid(session),
      }
    : null;
  if (session) {
    if (!options.resumeSession || !existingRun) {
      appendLog(logPath, "automation-session: " + session + "\n");
    }
    if (!options.resumeSession) {
      if (
        !claimRunAutomationSession(taskDb, run.taskRunId, owner!, {
          resumeFrom,
        })
      )
        return null;
    } else if (!ownAutomationSession(owner!)) {
      return null;
    }
  }
  return {
    task,
    taskDb,
    run,
    logPath,
    command,
    session,
    owner,
    executionId: options.executionId ?? createAutomationSessionId(),
  };
}

async function executeAutomationTaskProcess(
  execution: AutomationTaskRunExecution,
  isCancellationRequested?: () => boolean,
): Promise<AutomationTaskProcessResult> {
  let logTail = "";
  let detectedResumeFailure: string | null = null;
  let lastHumanAssistanceContractJson: string | null = null;
  let statementSummary: StatementRunSummary | null = null;
  const externalPrerequisiteIds = new Set<string>();
  const outputPersistenceWarnings: string[] = [];
  const humanAssistancePath = join(
    "data",
    "automation",
    "human-assistance",
    `${execution.session ?? execution.run.taskRunId}.jsonl`,
  );
  let humanAssistanceReadOffset = 0;
  let humanAssistanceReadTimer: ReturnType<typeof setInterval> | null = null;
  let gmailOtpServer: ReturnType<typeof createGmailOtpIpcServer>;
  try {
    gmailOtpServer = createGmailOtpIpcServer({
      service: {
        ensureAccess: ensureCathayGmailOtpAccess,
        prepareRetrieval: prepareCathayGmailOtpRetrieval,
        retrieve: retrieveCathayGmailOtp,
      },
      onProtocolError: (reason) => {
        console.warn(`gmail-otp-bridge-protocol-error: ${reason}`);
      },
    });
    await gmailOtpServer.ready;
  } catch {
    return {
      exitCode: null,
      signal: null,
      error: new Error("Gmail OTP bridge could not start."),
      logTail,
      resumeFailure: null,
      statementSummary,
      outputPersistenceWarnings,
      externalPrerequisiteIds: [],
    };
  }
  if (isCancellationRequested?.()) {
    await gmailOtpServer.close();
    return {
      exitCode: null,
      signal: null,
      error: new Error("Automation task cancelled."),
      logTail,
      resumeFailure: null,
      statementSummary,
      outputPersistenceWarnings,
      externalPrerequisiteIds: [],
    };
  }
  const result = await new Promise<
    Pick<AutomationTaskProcessResult, "exitCode" | "signal" | "error">
  >((resolve) => {
    const recordOutputPersistenceError = (error: unknown) => {
      const line = `automation-output-write-failed: ${errorMessage(error)}`;
      console.error(line);
      logTail = tail(`${logTail}\n${line}\n`);
      outputPersistenceWarnings.push(line);
    };
    const outputBuffer = createAutomationOutputBuffer(
      () => {
        if (
          !isForceQuitRun(
            taskRunById(execution.taskDb, execution.run.taskRunId),
          )
        ) {
          updateTaskRun(execution.taskDb, execution.run.taskRunId, {
            ...liveTaskRunUpdate(logTail),
          });
        }
      },
      500,
      recordOutputPersistenceError,
    );
    const onHumanAssistanceContract = (
      latestHumanAssistanceContract: Parameters<
        typeof updateHumanAssistanceContract
      >[2],
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
    const hostContractParser = createHumanAssistanceContractFrameParser(
      onHumanAssistanceContract,
    );
    const readHumanAssistanceFile = () => {
      try {
        const content = readFileSync(humanAssistancePath);
        if (content.length <= humanAssistanceReadOffset) return;
        hostContractParser.push(content.subarray(humanAssistanceReadOffset));
        humanAssistanceReadOffset = content.length;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(
            `human-assistance-contract-read-failed: ${errorMessage(error)}`,
          );
        }
      }
    };
    mkdirSync(dirname(humanAssistancePath), { recursive: true });
    rmSync(humanAssistancePath, { force: true });
    humanAssistanceReadTimer = setInterval(readHumanAssistanceFile, 50);
    const onOutput = (chunk: Buffer) => {
      const output = accumulateAutomationOutput(
        { logTail, resumeFailure: detectedResumeFailure },
        chunk.toString("utf8"),
      );
      statementSummary =
        parseStatementRunSummary(`${logTail}${output.logChunk}`) ??
        statementSummary;
      for (const prerequisiteId of parseExternalPrerequisiteSignals(
        `${logTail}${output.logChunk}`,
      )) {
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
      // fd 3 is the existing human-assistance contract stream. Gmail OTP uses
      // an authenticated local socket because child-process fd numbers are not
      // stable across the Libretto CLI -> daemon spawn boundary.
      stdio: ["ignore", "pipe", "pipe", "pipe"] as const,
      env: {
        ...execution.command.env,
        [HUMAN_ASSISTANCE_HOST_FD_ENV]: "3",
        [HUMAN_ASSISTANCE_HOST_PATH_ENV]: humanAssistancePath,
        [GMAIL_OTP_IPC_ENDPOINT_ENV]: gmailOtpServer.endpoint,
        [GMAIL_OTP_IPC_TOKEN_ENV]: gmailOtpServer.token,
      },
    });
    activeTaskChildren.set(execution.task.id, child);
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.stdio[3]?.on("data", hostContractParser.push);
    let childSettled = false;
    const finishChild = (processResult: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      error: Error | null;
    }) => {
      if (childSettled) return;
      childSettled = true;
      activeTaskChildren.delete(execution.task.id);
      if (humanAssistanceReadTimer) clearInterval(humanAssistanceReadTimer);
      readHumanAssistanceFile();
      hostContractParser.flush();
      outputBuffer.flush();
      rmSync(humanAssistancePath, { force: true });
      void gmailOtpServer.close().then(
        async () => {
          resolve(processResult);
        },
        async () => {
          resolve(processResult);
        },
      );
    };
    child.on("error", (error) => {
      finishChild({ exitCode: null, signal: null, error });
    });
    child.on("close", (exitCode, signal) => {
      finishChild({ exitCode, signal, error: null });
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
  if (shouldMarkWaitingForHuman(logTail))
    return { status: "waiting_for_human" as const, logTail };
  return { logTail };
}

export async function runAutomationTaskExecution(
  task: NonNullable<ReturnType<typeof taskById>>,
  taskDb: ReturnType<typeof openLedgerDatabase>,
  ledgerDir: string,
  options: AutomationTaskExecutionOptions,
  onRunCreated: (taskRunId: string) => void,
) {
  if (options.isCancellationRequested?.()) {
    return { status: "cancelled" as const };
  }
  const execution = createAutomationTaskRunExecution(task, taskDb, options);
  if (!execution) return { status: "failed" as const };
  onRunCreated(execution.run.taskRunId);
  if (options.isCancellationRequested?.()) {
    return {
      status: "cancelled" as const,
      taskRunId: execution.run.taskRunId,
      executionId: execution.executionId,
      session: execution.session,
      owner: execution.owner,
    };
  }
  try {
    const result = await executeAutomationTaskProcess(
      execution,
      options.isCancellationRequested,
    );
    const finalizationContext: AutomationTaskRunFinalizationContext = {
      taskDb,
      taskId: task.id,
      taskKind: task.kind,
      taskRunId: execution.run.taskRunId,
      logPath: execution.logPath,
      ledgerDir,
    };
    const finalized = await finalizeAutomationTaskRun(finalizationContext, result);
    return {
      status: finalized.status,
      taskRunId: execution.run.taskRunId,
      executionId: execution.executionId,
      session: execution.session,
      owner: execution.owner,
      result,
    };
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
