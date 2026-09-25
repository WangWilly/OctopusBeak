import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcess } from "node:child_process";
import { automationConfigEnv } from "./config-files.ts";
import {
  tail,
  claimAutomationTaskRunSession,
} from "./automation-session-disposition.ts";
import {
  finalizeAutomationTaskRun,
  nextAttemptStatus,
  shouldMarkWaitingForHuman,
  type AutomationTaskProcessResult,
  type AutomationTaskRunExecution,
} from "./task-run-finalization.ts";
import {
  type AutomationPersistencePort,
} from "./store.ts";
import { taskById } from "./tasks.ts";
import type { AutomationTaskProgress } from "../types.ts";
import {
  type AutomationProgressEvent,
} from "../progress.ts";
import { sanitizeAutomationLogChunk, sanitizeAutomationLogTail } from "./log-sanitizer.ts";
import { strictSourceText } from "../source-text.ts";
import { createWorkflowExecutor } from "../workflow-executor.ts";
import type {
  WorkflowBrowserPort,
  WorkflowExecutorPorts,
  WorkflowRunEvent,
} from "../workflow-executor.ts";
import {
  classifyTypedWorkflowFailure,
  summarizeTypedWorkflowOutput,
} from "./typed-workflow-outcome.ts";
import { createExchangeRateWorkflow } from "../exchange-rate-workflow.ts";
import { createOperationalWorkflowEventPort } from "../workflow-run-events.ts";
import { createMaicoinWorkflow } from "../maicoin-workflow.ts";
import { createWorkflowFinancialCommitPort } from "../workflow-financial-commit.ts";
import { createAppWorkflowBrowserPort } from "./app-browser-host.ts";
import { createAppWorkflowHumanAssistancePort } from "./app-workflow-human-assistance.ts";
import {
  workflowDefinitionForTask,
  workflowInputForTask,
  workflowStartUrlForTask,
  registerWorkflowHumanAssistanceForTask,
} from "./app-workflow-registry.ts";
import {
  PGLITE_CHILD_RPC_ENDPOINT_ENV,
  PGLITE_CHILD_RPC_TOKEN_ENV,
  createPGliteChildRpcClient,
  requirePGliteChildRpcClientFromEnv,
} from "../../../../electron/pglite-child-rpc-client.ts";

const activeWorkflowControllers = new Map<string, AbortController>();
const activeWorkflowRunIds = new Map<string, string>();
const activeExchangeRateWorkCompletions = new Map<string, Promise<void>>();
const appShutdownRunIds = new Set<string>();
const appShutdownTransitions = new Map<string, Promise<void>>();

export type AutomationTaskExecutionOptions = {
  scheduledAtUtc?: string;
  /** Legacy field retained for the runner contract; App workflows do not resume Libretto sessions. */
  resumeSession?: string;
  /** Reuse the user-visible task run for an internal execution. */
  taskRunId?: string;
  /** Snapshot of process configuration captured at campaign launch. */
  launchEnv?: NodeJS.ProcessEnv;
  /** Legacy field retained while the runner API is retired. */
  hostOwnedDialogProvider?: "sinopac";
  /** Identity used to correlate host-side CAPTCHA routing with this execution. */
  executionId?: string;
  attempt?: number;
  maxAttempts?: number;
  /** Let a higher-level campaign own the single terminal transition. */
  deferFinalization?: boolean;
  /** Stop a typed workflow when the host task was cancelled. */
  isCancellationRequested?: () => boolean;
  isForceTerminationRequested?: () => boolean;
  onRuntimeUpdate?: (taskRunId: string) => void | Promise<void>;
  /** Worker-owned exchange-rate command; absence fails closed. */
  runExchangeRateSync?: (options: {
    signal: AbortSignal;
    scheduledAtUtc?: string;
    emitProgress?: (event: Omit<AutomationProgressEvent, "type">) => void;
  }) => Promise<unknown>;
  /** App composition may replace a typed workflow capability at its port seam. */
  workflowPorts?: Partial<WorkflowExecutorPorts>;
  workflowBrowserPortFactory?: (input: {
    taskId: string;
    taskRunId: string;
    signal: AbortSignal;
    userDataDirectory: string;
    startUrl?: string;
  }) => WorkflowBrowserPort;
};

async function executeAppWorkflow(
  execution: AutomationTaskRunExecution,
  options: AutomationTaskExecutionOptions,
): Promise<AutomationTaskProcessResult> {
  const definition = workflowDefinitionForTask(execution.task.workflowId);
  if (!definition || !execution.task.workflowId) {
    return {
      exitCode: 1,
      signal: null,
      error: new Error("App workflow definition is unavailable."),
      logTail: "",
      resumeFailure: null,
      statementSummary: null,
      appWorkflowOutcome: { errorCode: "workflow-failed", summary: null },
      outputPersistenceWarnings: [],
      externalPrerequisiteIds: [],
    };
  }

  const controller = new AbortController();
  const cancellationPoll = setInterval(() => {
    if (options.isCancellationRequested?.() && !controller.signal.aborted) {
      controller.abort(new Error("Automation task cancelled."));
    }
  }, 50);
  cancellationPoll.unref();
  activeWorkflowControllers.set(execution.task.id, controller);
  activeWorkflowRunIds.set(execution.task.id, execution.run.taskRunId);

  let childRpc: ReturnType<typeof requirePGliteChildRpcClientFromEnv> | undefined;
  let unregisterHumanAssistance: (() => void) | undefined;
  let result: AutomationTaskProcessResult;
  try {
    const launchEnv = options.launchEnv ?? automationProcessEnv();
    if (options.isCancellationRequested?.()) {
      controller.abort(new Error("Automation task cancelled."));
    }
    const injectedPorts = options.workflowPorts ?? {};
    let financialCommit = injectedPorts.financialCommit;
    if (definition.requiresFinancialCommit && !financialCommit) {
      childRpc = requirePGliteChildRpcClientFromEnv(launchEnv);
      await childRpc.ready;
      financialCommit = createWorkflowFinancialCommitPort(childRpc.workflow);
    }
    const userDataDirectory = launchEnv.OCTOPUSBEAK_USER_DATA ?? process.cwd();
    const startUrl = workflowStartUrlForTask(execution.task.workflowId);
    const browser = injectedPorts.browser
      ?? options.workflowBrowserPortFactory?.({
        taskId: execution.task.id,
        taskRunId: execution.run.taskRunId,
        signal: controller.signal,
        userDataDirectory,
        startUrl,
      })
      ?? createAppWorkflowBrowserPort({
        taskId: execution.task.id,
        taskRunId: execution.run.taskRunId,
        signal: controller.signal,
        userDataDirectory,
        startUrl,
      });
    const ports: WorkflowExecutorPorts = {
      browser,
      text: strictSourceText,
      humanAssistance: injectedPorts.humanAssistance
        ?? createAppWorkflowHumanAssistancePort({
          taskRunId: execution.run.taskRunId,
          persistence: execution.persistence,
          onRuntimeUpdate: execution.onRuntimeUpdate,
        }),
      ...(financialCommit ? { financialCommit } : {}),
      events: injectedPorts.events ?? {
        async append(event) {
          await execution.persistence.appendRunEvent(event);
          await execution.onRuntimeUpdate?.(event.runId);
        },
      },
      now: injectedPorts.now ?? (() => new Date().toISOString()),
      onEventFailure: injectedPorts.onEventFailure
        ?? (() => console.error("workflow-event-persistence-failed")),
    };
    const executor = createWorkflowExecutor([definition], ports);
    unregisterHumanAssistance = await registerWorkflowHumanAssistanceForTask(
      execution.task.workflowId,
      { automation: execution.persistence },
    );
    const workflowOutput = await executor.run(
      execution.task.workflowId,
      execution.run.taskRunId,
      workflowInputForTask(execution.task.workflowId, launchEnv),
      controller.signal,
    );
    result = {
      exitCode: 0,
      signal: null,
      error: null,
      logTail: "",
      resumeFailure: null,
      statementSummary: null,
      appWorkflowOutcome: {
        errorCode: null,
        summary: summarizeTypedWorkflowOutput(workflowOutput),
      },
      outputPersistenceWarnings: [],
      externalPrerequisiteIds: [],
    };
  } catch (error) {
    const cancelled = controller.signal.aborted
      || options.isCancellationRequested?.() === true;
    let events: readonly WorkflowRunEvent[] = [];
    try {
      events = (await execution.persistence.taskRunById(execution.run.taskRunId))?.events ?? [];
    } catch {
      // Classification falls back to the opaque workflow code if events are unavailable.
    }
    result = {
      exitCode: cancelled ? null : 1,
      signal: cancelled ? "SIGTERM" : null,
      // Provider exceptions may contain account or invoice data. Persist only
      // a stable task-level classification in the operational database.
      error: cancelled
        ? new Error("Automation task cancelled.")
        : new Error("App workflow failed (workflow-failed)."),
      logTail: "",
      resumeFailure: null,
      statementSummary: null,
      appWorkflowOutcome: {
        errorCode: classifyTypedWorkflowFailure(error, events, cancelled),
        summary: null,
      },
      outputPersistenceWarnings: [],
      externalPrerequisiteIds: [],
    };
  } finally {
    unregisterHumanAssistance?.();
    clearInterval(cancellationPoll);
    activeWorkflowControllers.delete(execution.task.id);
    activeWorkflowRunIds.delete(execution.task.id);
    childRpc?.close();
  }
  return result;
}

export function createAutomationSessionId(
  uuid: () => string = randomUUID,
): string {
  // Compatibility name for runner/captcha coordination. This value is an
  // execution correlation ID; typed workflows do not create Libretto sessions.
  return "ses-octopus-" + uuid();
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

/** @deprecated Compatibility export; App-owned workflows do not claim sessions. */
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
  const existingRun = options.taskRunId
    ? await persistence.taskRunById(options.taskRunId)
    : null;
  if (options.taskRunId && !existingRun) return null;
  const env = options.launchEnv ?? automationProcessEnv();
  const command = {
    command: "",
    args: [],
    display: `workflow:${task.workflowId ?? task.id}`,
    env,
  };
  const logPath = "";
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
          scheduledAtUtc: options.scheduledAtUtc,
          logPath,
          progress: indeterminateProgress(attempt),
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
  return {
    task,
    persistence,
    run,
    logPath,
    command,
    session: null,
    owner: null,
    executionId: options.executionId ?? createAutomationSessionId(),
    onRuntimeUpdate: options.onRuntimeUpdate,
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
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk: Buffer | string) {
      pending = (pending + (typeof chunk === "string" ? chunk : decoder.write(chunk))).slice(-64 * 1024);
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
      pending += decoder.end();
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
  if (options.resumeSession) {
    throw new Error("Libretto session resume is not supported by App workflows.");
  }
  if (
    !task.workflowId &&
    task.id !== "exchange-rates" &&
    task.id !== "sync-maicoin"
  ) {
    throw new Error("App workflow definition is unavailable.");
  }
  const maicoinLaunchEnv = task.id === "sync-maicoin"
    ? options.launchEnv ?? automationProcessEnv()
    : undefined;
  if (maicoinLaunchEnv
    && (!maicoinLaunchEnv[PGLITE_CHILD_RPC_ENDPOINT_ENV]?.trim()
      || !maicoinLaunchEnv[PGLITE_CHILD_RPC_TOKEN_ENV]?.trim())) {
    throw new Error("PGlite workflow transport is unavailable.");
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
  if (task.workflowId) {
    const result = await executeAppWorkflow(execution, options);
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
  }
  if (task.id === "exchange-rates") {
    let result: AutomationTaskProcessResult;
    const controller = new AbortController();
    const cancellationPoll = setInterval(() => {
      if (options.isCancellationRequested?.() && !controller.signal.aborted) {
        controller.abort(new Error("Automation task cancelled."));
      }
    }, 50);
    cancellationPoll.unref();
    activeWorkflowControllers.set(task.id, controller);
    activeWorkflowRunIds.set(task.id, execution.run.taskRunId);
    let settleSync!: () => void;
    const syncSettled = new Promise<void>((resolve) => { settleSync = resolve; });
    activeExchangeRateWorkCompletions.set(task.id, syncSettled);
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
      const executor = createWorkflowExecutor([createExchangeRateWorkflow(
        runExchangeRateSync,
        {
          scheduledAtUtc: options.scheduledAtUtc,
          emitProgress,
        },
      )], {
        browser: { withPage: async () => { throw new Error("Exchange rates do not use a browser."); } },
        text: strictSourceText,
        humanAssistance: { request: async () => { throw new Error("Exchange rates do not use human assistance."); } },
        events: createOperationalWorkflowEventPort(persistence),
        now: () => new Date().toISOString(),
        onEventFailure: () => console.error("workflow-event-persistence-failed"),
      });
      await executor.run(
        "exchange-rates",
        execution.run.taskRunId,
        undefined,
        controller.signal,
      );
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
      const cancelled = controller.signal.aborted
        || options.isCancellationRequested?.() === true;
      result = {
        exitCode: cancelled ? null : 1,
        signal: cancelled ? "SIGTERM" : null,
        error: cancelled
          ? new Error("Automation task cancelled.")
          : new Error("Exchange-rate workflow failed."),
        logTail: "",
        resumeFailure: null,
        statementSummary: null,
        outputPersistenceWarnings: [],
        externalPrerequisiteIds: [],
      };
    } finally {
      await progressQueue.catch(() => undefined);
      clearInterval(cancellationPoll);
      settleSync();
      if (activeExchangeRateWorkCompletions.get(task.id) === syncSettled) {
        activeExchangeRateWorkCompletions.delete(task.id);
      }
      activeWorkflowControllers.delete(task.id);
      activeWorkflowRunIds.delete(task.id);
    }
    if (appShutdownRunIds.has(execution.run.taskRunId)) {
      await appShutdownTransitions.get(execution.run.taskRunId);
      appShutdownRunIds.delete(execution.run.taskRunId);
      appShutdownTransitions.delete(execution.run.taskRunId);
      return {
        status: "interrupted" as const,
        taskRunId: execution.run.taskRunId,
        executionId: execution.executionId,
        session: execution.session,
        owner: execution.owner,
        result,
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
  if (task.id === "sync-maicoin") {
    let result: AutomationTaskProcessResult;
    const env = maicoinLaunchEnv!;
    const controller = new AbortController();
    const cancellationPoll = setInterval(() => {
      if (options.isCancellationRequested?.() && !controller.signal.aborted) {
        controller.abort(new Error("Automation task cancelled."));
      }
    }, 50);
    cancellationPoll.unref();
    activeWorkflowControllers.set(task.id, controller);
    let childRpc: ReturnType<typeof createPGliteChildRpcClient> | undefined;
    try {
      const client = createPGliteChildRpcClient({ environment: env });
      childRpc = client;
      await client.ready;
      if (options.isCancellationRequested?.()) {
        controller.abort(new Error("Automation task cancelled."));
      }
      const executor = createWorkflowExecutor([createMaicoinWorkflow()], {
        browser: { withPage: async () => { throw new Error("MaiCoin does not use a browser."); } },
        text: strictSourceText,
        humanAssistance: { request: async () => { throw new Error("MaiCoin does not use human assistance."); } },
        financialCommit: createWorkflowFinancialCommitPort(client.workflow),
        maicoinPersistence: client.operationalProvider.maicoin,
        events: {
          async append(event) {
            await persistence.appendRunEvent(event);
            await execution.onRuntimeUpdate?.(event.runId);
          },
        },
        now: () => new Date().toISOString(),
        onEventFailure: () => console.error("workflow-event-persistence-failed"),
      });
      await executor.run(task.id, execution.run.taskRunId, {
        credentials: {
          accessKey: env.MAX_ACCESS_KEY ?? "",
          secretKey: env.MAX_SECRET_KEY ?? "",
          subAccount: env.MAX_SUB_ACCOUNT?.trim() || "main",
          ...(env.MAX_PROVIDER_EMAIL?.trim()
            ? { providerEmail: env.MAX_PROVIDER_EMAIL.trim() }
            : {}),
        },
      }, controller.signal);
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
      const cancelled = controller.signal.aborted || options.isCancellationRequested?.() === true;
      const normalizedError = cancelled
        ? new Error("Automation task cancelled.")
        : error instanceof Error && error.name === "MaicoinWorkflowError"
          ? error
          : new Error("MaiCoin workflow failed.");
      result = {
        exitCode: cancelled ? null : 1,
        signal: cancelled ? "SIGTERM" : null,
        error: normalizedError,
        logTail: "",
        resumeFailure: null,
        statementSummary: null,
        outputPersistenceWarnings: [],
        externalPrerequisiteIds: [],
      };
    } finally {
      clearInterval(cancellationPoll);
      activeWorkflowControllers.delete(task.id);
      childRpc?.close();
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
      result,
    };
  }
  throw new Error("App workflow definition is unavailable.");
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

export function automationTaskChild(_taskId: string): ChildProcess | undefined {
  return undefined;
}

/** Abort live App workflows and persist interruption before startup recovery. */
export async function interruptActiveAppWorkflows(
  persistence: AutomationPersistencePort,
) {
  for (const [taskId, taskRunId] of activeWorkflowRunIds) {
    const controller = activeWorkflowControllers.get(taskId);
    if (taskId === "exchange-rates") {
      appShutdownRunIds.add(taskRunId);
      const completion = activeExchangeRateWorkCompletions.get(taskId);
      const transition = Promise.resolve().then(async () => {
        await completion;
        const current = await persistence.taskRunById(taskRunId);
        if (!current || !["preparing", "queued", "running", "retrying", "cancelling", "waiting_for_human"].includes(current.status)) {
          return;
        }
        await persistence.transitionTaskRunToTerminal(taskRunId, {
          status: "interrupted",
          finishedAt: new Date().toISOString(),
          exitCode: null,
          signal: null,
          errorMessage: "App closed while this workflow was running.",
          logTail: "",
        });
      });
      appShutdownTransitions.set(taskRunId, transition);
      if (controller && !controller.signal.aborted) {
        controller.abort(new Error("App is shutting down."));
      }
      await transition;
      continue;
    }
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error("App is shutting down."));
    }
    const current = await persistence.taskRunById(taskRunId);
    if (!current || !["preparing", "queued", "running", "retrying", "cancelling", "waiting_for_human"].includes(current.status)) {
      continue;
    }
    await persistence.transitionTaskRunToTerminal(taskRunId, {
      status: "interrupted",
      finishedAt: new Date().toISOString(),
      exitCode: null,
      signal: null,
      errorMessage: "App closed while this workflow was running.",
      logTail: "",
    });
  }
}

export async function terminateAutomationTaskProcessTree(
  taskId: string,
  _signal: NodeJS.Signals = "SIGKILL",
  _timeoutMs = 2_000,
) {
  const workflowController = activeWorkflowControllers.get(taskId);
  if (workflowController && !workflowController.signal.aborted) {
    workflowController.abort(new Error("Automation task cancelled."));
  }
}

export function terminateAutomationTaskProcesses() {
  for (const controller of activeWorkflowControllers.values()) {
    if (!controller.signal.aborted) controller.abort(new Error("App is shutting down."));
  }
}
