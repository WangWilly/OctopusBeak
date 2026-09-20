import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
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
import type { AutomationTaskProgress } from "../types.ts";
import {
  AUTOMATION_PROGRESS_FD_ENV,
  type AutomationProgressEvent,
} from "../progress.ts";
import { sanitizeAutomationLogChunk, sanitizeAutomationLogTail } from "./log-sanitizer.ts";

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
  isForceTerminationRequested?: () => boolean;
  onRuntimeUpdate?: (taskRunId: string) => void;
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
  const logChunk = sanitizeAutomationLogChunk(chunk);
  const combined = state.logTail + logChunk;
  return {
    logChunk,
    logTail: sanitizeAutomationLogTail(combined),
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
    ? { taskRunId: existingRun.taskRunId, attempt }
    : {
        ...createTaskRun(taskDb, {
          taskId: task.id,
          script: command.display,
          kind: task.kind,
          status: "running",
          attempt,
          maxAttempts,
          startedAt,
          logPath,
          progress: indeterminateProgress(attempt),
          humanAssistanceContract: resumeHumanAssistanceContract(
            resumeFrom?.humanAssistanceContract,
          ),
        }),
        attempt,
      };
  if (existingRun) {
    updateTaskRun(taskDb, existingRun.taskRunId, {
      status: "running",
      attempt,
      maxAttempts,
      finishedAt: null,
      exitCode: null,
      signal: null,
      errorMessage: null,
      progress: indeterminateProgress(attempt),
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
    onRuntimeUpdate: options.onRuntimeUpdate,
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
  let latestProgress: AutomationTaskProgress | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
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
      const line = sanitizeAutomationLogChunk(
        `automation-output-write-failed: ${errorMessage(error)}`,
      );
      console.error(line);
      logTail = tail(`${logTail}\n${line}\n`);
      outputPersistenceWarnings.push(line);
    };
    const persistRuntimeUpdate = () => {
      if (
        !isForceQuitRun(
          taskRunById(execution.taskDb, execution.run.taskRunId),
        )
      ) {
        updateTaskRun(execution.taskDb, execution.run.taskRunId, {
          ...liveTaskRunUpdate(
            logTail,
            execution.run.attempt,
            latestProgress ?? undefined,
          ),
        });
        execution.onRuntimeUpdate?.(execution.run.taskRunId);
      }
    };
    const recordProgress = () => {
      if (progressTimer) return;
      progressTimer = setTimeout(() => {
        progressTimer = null;
        try {
          persistRuntimeUpdate();
        } catch (error) {
          recordOutputPersistenceError(error);
        }
      }, 1_000);
    };
    const outputBuffer = createAutomationOutputBuffer(
      persistRuntimeUpdate,
      500,
      recordOutputPersistenceError,
    );
    const progressParser = createAutomationProgressFrameParser((event) => {
      latestProgress = {
        phaseCode: event.phaseCode,
        completed: event.completed,
        total: event.total,
        percent: event.percent,
        attempt: event.attempt ?? execution.run.attempt,
        ...(event.params ? { params: event.params } : {}),
      };
      recordProgress();
    });
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
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] as const,
      detached: process.platform !== "win32",
      env: {
        ...execution.command.env,
        [HUMAN_ASSISTANCE_HOST_FD_ENV]: "3",
        [HUMAN_ASSISTANCE_HOST_PATH_ENV]: humanAssistancePath,
        [GMAIL_OTP_IPC_ENDPOINT_ENV]: gmailOtpServer.endpoint,
        [GMAIL_OTP_IPC_TOKEN_ENV]: gmailOtpServer.token,
        [AUTOMATION_PROGRESS_FD_ENV]: "4",
      },
    });
    activeTaskChildren.set(execution.task.id, child);
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.stdio[3]?.on("data", hostContractParser.push);
    child.stdio[4]?.on("data", progressParser.push);
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
      progressParser.flush();
      outputBuffer.flush();
      if (progressTimer) clearTimeout(progressTimer);
      progressTimer = null;
      try {
        persistRuntimeUpdate();
      } catch (error) {
        recordOutputPersistenceError(error);
      }
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

export function liveTaskRunUpdate(
  logTail: string,
  attempt = 1,
  progress?: AutomationTaskProgress,
) {
  const resumeFailure = resumeFailureMessage(logTail);
  const progressUpdate = progress ? { progress } : {};
  if (resumeFailure) return { errorMessage: resumeFailure, logTail, ...progressUpdate };
  if (shouldMarkWaitingForHuman(logTail))
    return { status: "waiting_for_human" as const, logTail, ...progressUpdate };
  return { logTail, ...progressUpdate };
}

function indeterminateProgress(attempt: number): AutomationTaskProgress {
  return {
    phaseCode: null,
    completed: null,
    total: null,
    percent: null,
    attempt,
  };
}

export function createAutomationProgressFrameParser(
  onProgress: (event: AutomationProgressEvent) => void,
) {
  const isSafeParams = (value: unknown): value is Readonly<Record<string, string | number | boolean>> =>
    Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((param) =>
      typeof param === "string" || typeof param === "number" || typeof param === "boolean",
    );
  let pending = "";
  return {
    push(chunk: Buffer | string) {
      pending = (pending + chunk.toString("utf8")).slice(-64 * 1024);
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
        if (!line) continue;
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (value.type !== "progress") continue;
          const phaseCode = value.phaseCode;
          const completed = value.completed;
          const total = value.total;
          const percent = value.percent;
          const attempt = value.attempt;
          if (
            (phaseCode !== null && typeof phaseCode !== "string")
            || (completed !== null && typeof completed !== "number")
            || (total !== null && typeof total !== "number")
            || (percent !== null && typeof percent !== "number")
            || (attempt !== undefined && typeof attempt !== "number")
            || (typeof completed === "number" && !Number.isFinite(completed))
            || (typeof total === "number" && !Number.isFinite(total))
            || (typeof percent === "number" && (!Number.isFinite(percent) || percent < 0 || percent > 100))
            || (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 0))
          ) continue;
          if (value.params !== undefined && !isSafeParams(value.params)) continue;
          onProgress({
            type: "progress",
            phaseCode: phaseCode as string | null,
            completed: completed as number | null,
            total: total as number | null,
            percent: percent as number | null,
            ...(attempt === undefined ? {} : { attempt }),
            ...(value.params !== undefined ? { params: value.params } : {}),
          });
        } catch {
          // Malformed producer frames are ignored; diagnostics stay in logs.
        }
      }
    },
    flush() {
      pending = "";
    },
  };
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
  if (!execution) {
    if (options.taskRunId && taskRunById(taskDb, options.taskRunId)) {
      updateTaskRun(taskDb, options.taskRunId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        errorMessage: "Automation task run could not be resumed.",
      });
    }
    return { status: "failed" as const };
  }
  onRunCreated(execution.run.taskRunId);
  if (options.isCancellationRequested?.()) {
    const cancelledResult: AutomationTaskProcessResult = {
      exitCode: null,
      signal: "SIGTERM",
      error: new Error("Automation task cancelled."),
      logTail: "",
      resumeFailure: null,
      statementSummary: null,
      outputPersistenceWarnings: [],
      externalPrerequisiteIds: [],
    };
    const finalized = await finalizeAutomationTaskRun({
      taskDb,
      taskId: task.id,
      taskKind: task.kind,
      taskRunId: execution.run.taskRunId,
      logPath: execution.logPath,
      ledgerDir,
    }, cancelledResult);
    return {
      status: finalized.status,
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
      forceTerminated: options.isForceTerminationRequested?.() === true,
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

function signalAutomationChildTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid && process.platform === "win32") {
    try {
      // Windows has no POSIX process groups; taskkill's /T flag is the
      // equivalent tree boundary and /F is required for force termination.
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      return;
    } catch {
      // Fall back to the direct child below when taskkill is unavailable.
    }
  }
  if (child.pid && process.platform !== "win32") {
    try {
      // Child processes are detached into their own group so descendants are
      // terminated together. Fall back to the direct child when the group has
      // already disappeared.
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may have exited between the lookup and the signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Shutdown and force termination are best-effort by contract.
  }
}

export async function terminateAutomationTaskProcessTree(
  taskId: string,
  signal: NodeJS.Signals = "SIGKILL",
  timeoutMs = 2_000,
) {
  const child = activeTaskChildren.get(taskId);
  if (!child) return;
  signalAutomationChildTree(child, signal);
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(resolve, timeoutMs);
    const done = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      resolve();
    };
    child.once("close", done);
    child.once("error", done);
  });
}

export function terminateAutomationTaskProcesses() {
  for (const child of activeTaskChildren.values()) {
    signalAutomationChildTree(child, "SIGTERM");
  }
}
