import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  parseStatementRunSummary,
  type StatementRunSummary,
} from "../statement-run-summary.ts";
import { parseExternalPrerequisiteSignals } from "../external-prerequisite.ts";
import {
  createHumanAssistanceContractFrameParser,
  HUMAN_ASSISTANCE_HOST_FD_ENV,
  HUMAN_ASSISTANCE_HOST_PATH_ENV,
  type HumanAssistanceContractInput,
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
  nextAttemptStatus,
  shouldMarkWaitingForHuman,
  type AutomationTaskProcessResult,
  type AutomationTaskRunFinalizationContext,
  type AutomationTaskRunExecution,
} from "./task-run-finalization.ts";
import {
  resumeHumanAssistanceContract,
  type AutomationPersistencePort,
} from "./store.ts";
import { taskById } from "./tasks.ts";
import type { AutomationTaskProgress } from "../types.ts";
import {
  AUTOMATION_PROGRESS_FD_ENV,
  type AutomationProgressEvent,
} from "../progress.ts";
import { sanitizeAutomationLogChunk, sanitizeAutomationLogTail } from "./log-sanitizer.ts";
import {
  SINOPAC_DIALOG_OWNER_ENV,
  sinopacHostDialogOwner,
} from "../sinopac-captcha.ts";

const activeTaskChildren = new Map<string, ChildProcess>();

export type AutomationTaskExecutionOptions = {
  scheduledAtUtc?: string;
  resumeSession?: string;
  /** Reuse the user-visible task run for an internal execution. */
  taskRunId?: string;
  /** Snapshot of process configuration captured at campaign launch. */
  launchEnv?: NodeJS.ProcessEnv;
  /** Set on the original daemon launch, not only on a later resume CLI. */
  hostOwnedDialogProvider?: "sinopac";
  /** Identity used to correlate host-side CAPTCHA routing with this execution. */
  executionId?: string;
  attempt?: number;
  maxAttempts?: number;
  /** Let a higher-level campaign own the single terminal transition. */
  deferFinalization?: boolean;
  /** Stop before launching a child when the host task was cancelled. */
  isCancellationRequested?: () => boolean;
  isForceTerminationRequested?: () => boolean;
  onRuntimeUpdate?: (taskRunId: string) => void | Promise<void>;
  /** Worker-owned exchange-rate command; absence fails closed. */
  runExchangeRateSync?: (options: {
    scheduledAtUtc?: string;
    emitProgress?: (event: Omit<AutomationProgressEvent, "type">) => void;
  }) => Promise<unknown>;
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

export function automationDialogOwnerLaunchEnv(
  baseEnv: NodeJS.ProcessEnv,
  taskId: string,
  session: string | null,
  provider: AutomationTaskExecutionOptions["hostOwnedDialogProvider"],
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  if (provider === "sinopac" && taskId === "sinopac-statements" && session) {
    env[SINOPAC_DIALOG_OWNER_ENV] = sinopacHostDialogOwner(session);
  }
  return env;
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

async function createAutomationTaskRunExecution(
  task: NonNullable<ReturnType<typeof taskById>>,
  persistence: AutomationPersistencePort,
  options: AutomationTaskExecutionOptions,
): Promise<AutomationTaskRunExecution | null> {
  const attempt = options.attempt ?? 1;
  const maxAttempts = options.maxAttempts ?? 1;
  const startedAt = new Date().toISOString();
  const isLibrettoTask = task.command[0] === "libretto";
  const session = isLibrettoTask
    ? (options.resumeSession ?? createAutomationSessionId())
    : null;
  const env = automationDialogOwnerLaunchEnv(
    options.launchEnv ?? automationProcessEnv(),
    task.id,
    session,
    options.resumeSession ? undefined : options.hostOwnedDialogProvider,
  );
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
  const activeRuns = options.resumeSession
    ? await persistence.activeTaskRuns()
    : [];
  const resumeFrom = options.resumeSession
    ? activeRuns.find(
        (candidate) =>
          candidate.taskId === task.id &&
          candidate.status === "waiting_for_human" &&
          sessionFromRun(candidate) === options.resumeSession,
      )
    : undefined;
  const existingRun = options.taskRunId
    ? await persistence.taskRunById(options.taskRunId)
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
        ...(await persistence.createTaskRun({
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
        })),
        attempt,
      };
  if (existingRun) {
    await persistence.updateTaskRun(existingRun.taskRunId, {
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
        !(await claimAutomationTaskRunSession(
          persistence,
          run.taskRunId,
          owner!,
          { resumeFrom },
        ))
      ) return null;
    } else if (!ownAutomationSession(owner!)) {
      return null;
    }
  }
  return {
    task,
    persistence,
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
    let persistenceQueue = Promise.resolve();
    const enqueuePersistence = (work: () => Promise<void>) => {
      persistenceQueue = persistenceQueue.then(work).catch((error) => {
        recordOutputPersistenceError(error);
      });
    };
    const persistRuntimeUpdate = () => enqueuePersistence(async () => {
      const current = await execution.persistence.taskRunById(
        execution.run.taskRunId,
      );
      if (isForceQuitRun(current)) return;
      await execution.persistence.updateTaskRun(
        execution.run.taskRunId,
        liveTaskRunUpdate(
          logTail,
          execution.run.attempt,
          latestProgress ?? undefined,
        ),
      );
      await execution.onRuntimeUpdate?.(execution.run.taskRunId);
    });
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
    const onHumanAssistanceContract = (latestHumanAssistanceContract: HumanAssistanceContractInput) => {
      const contractJson = JSON.stringify(latestHumanAssistanceContract);
      if (contractJson === lastHumanAssistanceContractJson) return;
      enqueuePersistence(async () => {
        await execution.persistence.updateHumanAssistanceContract(
          execution.run.taskRunId,
          latestHumanAssistanceContract,
        );
        lastHumanAssistanceContractJson = contractJson;
      });
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
    const finishChild = async (processResult: {
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
      try {
        await gmailOtpServer.close();
      } catch {
        // Closing the local broker is best effort after the child exits.
      }
      await persistenceQueue;
      resolve(processResult);
    };
    child.on("error", (error) => {
      void finishChild({ exitCode: null, signal: null, error });
    });
    child.on("close", (exitCode, signal) => {
      void finishChild({ exitCode, signal, error: null });
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
          const attempt = value.attempt === undefined
            ? undefined
            : typeof value.attempt === "number"
              ? value.attempt
              : null;
          const params = value.params;
          const safeParams = params === undefined
            ? undefined
            : isSafeParams(params)
              ? params
              : null;
          if (
            (phaseCode !== null && typeof phaseCode !== "string")
            || (completed !== null && typeof completed !== "number")
            || (total !== null && typeof total !== "number")
            || (percent !== null && typeof percent !== "number")
            || attempt === null
            || (typeof completed === "number" && !Number.isFinite(completed))
            || (typeof total === "number" && !Number.isFinite(total))
            || (typeof percent === "number" && (!Number.isFinite(percent) || percent < 0 || percent > 100))
            || (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 0))
          ) continue;
          if (safeParams === null) continue;
          onProgress({
            type: "progress",
            phaseCode: phaseCode as string | null,
            completed: completed as number | null,
            total: total as number | null,
            percent: percent as number | null,
            ...(attempt === undefined ? {} : { attempt }),
            ...(safeParams !== undefined ? { params: safeParams } : {}),
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
  persistence: AutomationPersistencePort,
  options: AutomationTaskExecutionOptions,
  onRunCreated: (taskRunId: string) => void | Promise<void>,
) {
  if (options.isCancellationRequested?.()) {
    return { status: "cancelled" as const };
  }
  if (task.id === "exchange-rates" && !options.runExchangeRateSync) {
    throw new Error("PGlite exchange-rate synchronization is unavailable.");
  }
  const execution = await createAutomationTaskRunExecution(
    task,
    persistence,
    options,
  );
  if (!execution) {
    if (options.taskRunId && await persistence.taskRunById(options.taskRunId)) {
      await persistence.updateTaskRun(options.taskRunId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        errorMessage: "Automation task run could not be resumed.",
      });
    }
    return { status: "failed" as const };
  }
  await onRunCreated(execution.run.taskRunId);
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
    if (options.deferFinalization) {
      return {
        status: "cancelled" as const,
        taskRunId: execution.run.taskRunId,
        executionId: execution.executionId,
        session: execution.session,
        owner: execution.owner,
        result: cancelledResult,
      };
    }
    const finalized = await finalizeAutomationTaskRun(
      {
        provider: { automation: persistence },
        taskId: task.id,
        taskKind: task.kind,
        taskRunId: execution.run.taskRunId,
        logPath: execution.logPath,
      },
      cancelledResult,
    );
    return {
      status: finalized.status,
      taskRunId: execution.run.taskRunId,
      executionId: execution.executionId,
      session: execution.session,
      owner: execution.owner,
      };
  }
  if (task.id === "exchange-rates") {
    let result: AutomationTaskProcessResult;
    let progressQueue = Promise.resolve();
    const emitProgress = (event: Omit<AutomationProgressEvent, "type">) => {
      progressQueue = progressQueue.then(async () => {
        await persistence.updateTaskRun(execution.run.taskRunId, {
          progress: {
            phaseCode: event.phaseCode,
            completed: event.completed,
            total: event.total,
            percent: event.percent,
            attempt: execution.run.attempt,
            ...(event.params ? { params: event.params } : {}),
          },
        });
        await execution.onRuntimeUpdate?.(execution.run.taskRunId);
      });
    };
    try {
      const runExchangeRateSync = options.runExchangeRateSync;
      if (!runExchangeRateSync) {
        throw new Error("PGlite exchange-rate synchronization is unavailable.");
      }
      await runExchangeRateSync({
        scheduledAtUtc: options.scheduledAtUtc,
        emitProgress,
      });
      await progressQueue;
      result = {
        exitCode: 0,
        signal: null,
        error: null,
        logTail: "",
        resumeFailure: null,
        statementSummary: null,
        outputPersistenceWarnings: [],
        externalPrerequisiteIds: [],
      };
    } catch (error) {
      result = {
        exitCode: 1,
        signal: null,
        error: error instanceof Error ? error : new Error(String(error)),
        logTail: "",
        resumeFailure: null,
        statementSummary: null,
        outputPersistenceWarnings: [],
        externalPrerequisiteIds: [],
      };
    }
    const provider = { automation: persistence };
    if (options.deferFinalization) {
      return {
        status: automationTaskProcessStatus(task.kind, result, {
          attempt: execution.run.attempt,
          maxAttempts: options.maxAttempts ?? execution.run.attempt,
          forceTerminated: options.isForceTerminationRequested?.() === true,
        }),
        taskRunId: execution.run.taskRunId,
        executionId: execution.executionId,
        session: execution.session,
        owner: execution.owner,
        result,
      };
    }
    const finalized = await finalizeAutomationTaskRun(
      {
        provider,
        taskId: task.id,
        taskKind: task.kind,
        taskRunId: execution.run.taskRunId,
        logPath: execution.logPath,
        forceTerminated: options.isForceTerminationRequested?.() === true,
      },
      result,
    );
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
    const provider = { automation: persistence };
    if (options.deferFinalization) {
      return {
        status: automationTaskProcessStatus(task.kind, result, {
          attempt: execution.run.attempt,
          maxAttempts: options.maxAttempts ?? execution.run.attempt,
          forceTerminated: options.isForceTerminationRequested?.() === true,
        }),
        taskRunId: execution.run.taskRunId,
        executionId: execution.executionId,
        session: execution.session,
        owner: execution.owner,
        result,
      };
    }
    const finalized = await finalizeAutomationTaskRun(
      {
        provider,
        taskId: task.id,
        taskKind: task.kind,
        taskRunId: execution.run.taskRunId,
        logPath: execution.logPath,
        forceTerminated: options.isForceTerminationRequested?.() === true,
      },
      result,
    );
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

export function automationTaskProcessStatus(
  taskKind: NonNullable<ReturnType<typeof taskById>>["kind"],
  result: AutomationTaskProcessResult,
  options: {
    attempt?: number;
    maxAttempts?: number;
    forceTerminated?: boolean;
  } = {},
) {
  const cancelled = options.forceTerminated === true
    || result.signal === "SIGTERM"
    || result.error?.message === "Automation task cancelled.";
  let status = cancelled
    ? "cancelled" as const
    : result.error || result.resumeFailure
      ? "failed" as const
      : nextAttemptStatus({
          kind: taskKind,
          attempt: options.attempt ?? 1,
          maxAttempts: options.maxAttempts ?? 1,
          exitCode: result.exitCode,
          waitingForHuman: shouldMarkWaitingForHuman(result.logTail),
        });
  if (status === "completed" && result.statementSummary) {
    status = result.statementSummary.status;
  }
  return status;
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
