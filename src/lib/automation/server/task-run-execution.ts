import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes as cryptoRandomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import {
  CAPTCHA_ROUND_OUTCOME_ENDPOINT_ENV,
  CAPTCHA_ROUND_OUTCOME_EXECUTION_ID_ENV,
  CAPTCHA_ROUND_OUTCOME_IPC_TOKEN_BYTES,
  CAPTCHA_ROUND_OUTCOME_TOKEN_ENV,
  createCaptchaRoundOutcomeReceiver,
  isCaptchaRoundOutcomeToken,
  parseCaptchaRoundOutcomeAuthFrame,
  parseCaptchaRoundOutcomeFrame,
  type CaptchaRoundOutcomeMessage,
} from "../captcha-round-outcome.ts";

const activeTaskChildren = new Map<string, ChildProcess>();

export type AutomationTaskExecutionOptions = {
  scheduledAtUtc?: string;
  resumeSession?: string;
  /** Reuse the user-visible task run for an internal execution. */
  taskRunId?: string;
  /** Snapshot of process configuration captured at campaign launch. */
  launchEnv?: NodeJS.ProcessEnv;
  /** Internal execution identity used by the private CAPTCHA bridge. */
  executionId?: string;
  attempt?: number;
  maxAttempts?: number;
  /** Stop before launching a child when the host task was cancelled. */
  isCancellationRequested?: () => boolean;
};

export type CaptchaRoundOutcomeIpcServer = {
  endpoint: string;
  token: string;
  executionId: string;
  env: {
    [CAPTCHA_ROUND_OUTCOME_ENDPOINT_ENV]: string;
    [CAPTCHA_ROUND_OUTCOME_TOKEN_ENV]: string;
    [CAPTCHA_ROUND_OUTCOME_EXECUTION_ID_ENV]: string;
  };
  ready: Promise<void>;
  close(): Promise<void>;
  messages(): readonly CaptchaRoundOutcomeMessage[];
};

const CAPTCHA_OUTCOME_AUTH_TIMEOUT_MS = 10_000;

function isNamedPipeEndpoint(endpoint: string) {
  return endpoint.startsWith("\\\\.\\pipe\\");
}

function createCaptchaOutcomeEndpoint() {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\octopusbeak-captcha-${randomUUID()}`
    : join(tmpdir(), `ob-captcha-${randomUUID().slice(0, 12)}.sock`);
}

async function unlinkCaptchaOutcomeEndpoint(endpoint: string) {
  if (isNamedPipeEndpoint(endpoint)) return;
  try {
    await unlink(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Host side of the private CAPTCHA outcome bridge. Only bounded, typed
 * outcome metadata crosses this socket; images, answers, and credentials do
 * not. It is intentionally kept next to process execution so the endpoint is
 * created and destroyed with exactly one child execution.
 */
export function createCaptchaRoundOutcomeIpcServer(input: {
  endpoint?: string;
  token?: string;
  executionId?: string;
  onProtocolError?: (reason: string) => void;
} = {}): CaptchaRoundOutcomeIpcServer {
  const endpoint = input.endpoint ?? createCaptchaOutcomeEndpoint();
  const token = input.token
    ?? Buffer.from(cryptoRandomBytes(CAPTCHA_ROUND_OUTCOME_IPC_TOKEN_BYTES)).toString("base64url");
  const executionId = input.executionId ?? createAutomationSessionId();
  if (!isCaptchaRoundOutcomeToken(token)) {
    throw new TypeError("CAPTCHA round outcome IPC token is invalid.");
  }
  let closed = false;
  let listening = false;
  let readySettled = false;
  let closePromise: Promise<void> | null = null;
  const sockets = new Set<Socket>();
  const accepted: CaptchaRoundOutcomeMessage[] = [];
  const receiver = createCaptchaRoundOutcomeReceiver(executionId);
  const report = (reason: string) => {
    try {
      input.onProtocolError?.(reason);
    } catch {
      // Diagnostics must never affect workflow execution.
    }
  };
  const server: Server = createServer((socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let authenticated = false;
    let terminated = false;
    let pending = "";
    const terminate = () => {
      if (terminated) return;
      terminated = true;
      sockets.delete(socket);
    };
    const handleLine = (line: string) => {
      if (terminated || line.length === 0) return;
      if (!authenticated) {
        const auth = parseCaptchaRoundOutcomeAuthFrame(line);
        if (!auth || auth.token !== token || auth.executionId !== executionId) {
          report("invalid-authentication");
          terminated = true;
          socket.destroy();
          return;
        }
        authenticated = true;
        socket.setTimeout(0);
        return;
      }
      const message = parseCaptchaRoundOutcomeFrame(line);
      if (!message) {
        report("invalid-outcome-frame");
        terminated = true;
        socket.destroy();
        return;
      }
      const acceptance = receiver.accept(message);
      if (!acceptance.accepted) {
        report(acceptance.reason);
        return;
      }
      accepted.push(message);
    };
    socket.setTimeout(CAPTCHA_OUTCOME_AUTH_TIMEOUT_MS, () => {
      report("authentication-timeout");
      socket.destroy();
    });
    socket.on("data", (chunk) => {
      if (terminated) return;
      pending += chunk.toString("utf8");
      if (pending.length > 32_768) {
        report("frame-too-large");
        terminated = true;
        socket.destroy();
        return;
      }
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        handleLine(line);
        if (terminated) return;
        newline = pending.indexOf("\n");
      }
    });
    socket.on("error", () => {
      report("socket-error");
      terminate();
    });
    socket.on("end", () => {
      if (pending.trim()) report("unterminated-frame");
      terminate();
    });
    socket.on("close", terminate);
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => {
      listening = true;
      readySettled = true;
      resolve();
    });
    server.on("error", (error) => {
      report("server-error");
      if (!readySettled) {
        readySettled = true;
        reject(error);
      }
    });
    try {
      server.listen(endpoint);
    } catch (error) {
      readySettled = true;
      reject(error);
    }
  });
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    for (const socket of sockets) socket.destroy();
    closePromise = new Promise<void>((resolve) => {
      const cleanup = () => {
        void unlinkCaptchaOutcomeEndpoint(endpoint).then(
          () => resolve(),
          () => {
            report("endpoint-cleanup-failed");
            resolve();
          },
        );
      };
      if (!listening || !server.listening) cleanup();
      else server.close(cleanup);
    });
    return closePromise;
  };
  void ready.catch(() => close());
  return {
    endpoint,
    token,
    executionId,
    env: {
      [CAPTCHA_ROUND_OUTCOME_ENDPOINT_ENV]: endpoint,
      [CAPTCHA_ROUND_OUTCOME_TOKEN_ENV]: token,
      [CAPTCHA_ROUND_OUTCOME_EXECUTION_ID_ENV]: executionId,
    },
    ready,
    close,
    messages: () => [...accepted],
  };
}

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
  let captchaOutcomeServer: CaptchaRoundOutcomeIpcServer | null = null;
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
      captchaOutcomeMessages: [],
    };
  }
  try {
    captchaOutcomeServer = createCaptchaRoundOutcomeIpcServer({
      executionId: execution.executionId,
      onProtocolError: (reason) => {
        console.warn(`captcha-round-outcome-bridge-protocol-error: ${reason}`);
      },
    });
    await captchaOutcomeServer.ready;
  } catch {
    await captchaOutcomeServer?.close();
    captchaOutcomeServer = null;
  }
  if (isCancellationRequested?.()) {
    await gmailOtpServer.close();
    await captchaOutcomeServer?.close();
    return {
      exitCode: null,
      signal: null,
      error: new Error("Automation task cancelled."),
      logTail,
      resumeFailure: null,
      statementSummary,
      outputPersistenceWarnings,
      externalPrerequisiteIds: [],
      captchaOutcomeMessages: [],
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
        ...(captchaOutcomeServer?.env ?? {}),
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
          await captchaOutcomeServer?.close();
          resolve(processResult);
        },
        async () => {
          await captchaOutcomeServer?.close();
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
    captchaOutcomeMessages: captchaOutcomeServer?.messages().slice() ?? [],
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
    const retryableOutcome = (result.captchaOutcomeMessages ?? [])
      .map((message) => message.outcome)
      .findLast((outcome) => outcome.kind === "retryable");
    if (retryableOutcome) {
      updateTaskRun(taskDb, execution.run.taskRunId, {
        logTail: result.logTail,
      });
      return {
        status: "captcha-retryable" as const,
        taskRunId: execution.run.taskRunId,
        executionId: execution.executionId,
        session: execution.session,
        owner: execution.owner,
        result,
      };
    }
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
