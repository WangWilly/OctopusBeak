import { spawnSync } from "node:child_process";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { resolvePatchCommand } from "./desktop-command.ts";
import {
  finalizeAutomationTaskRun,
  finalizePersistedActiveRuns,
  finalizePersistedRun,
  scheduleAutomationTaskRunTimeout,
} from "./task-run-finalization.ts";
import {
  accumulateAutomationOutput,
  automationProcessEnv,
  automationTaskChild,
  claimRunAutomationSession,
  createAutomationOutputBuffer,
  createAutomationSessionId,
  liveTaskRunUpdate,
  parseAutomationProgress,
  resumeFailureMessage,
  runAutomationTaskExecution,
  terminateAutomationTaskProcesses,
} from "./task-run-execution.ts";
export {
  appendCleanupError,
  automationCleanupFailureDetails,
  automationSessionFromLog,
  finalFailureMessage,
  finalizeTerminalAutomationSession,
  isForceQuitRun,
  nextAttemptStatus,
  resumeSessionFromLog,
  shouldMarkWaitingForHuman,
  shouldRetainAutomationSession,
} from "./task-run-finalization.ts";
export {
  accumulateAutomationOutput,
  automationProcessEnv,
  claimRunAutomationSession,
  createAutomationOutputBuffer,
  createAutomationSessionId,
  liveTaskRunUpdate,
  parseAutomationProgress,
  resumeFailureMessage,
} from "./task-run-execution.ts";
import {
  appendLog,
  automationSessionOwnerForRun,
  errorMessage,
  finalizeAutomationSessionForRun,
  isLiveOwnedAutomationSession,
  relinquishAutomationSessionForTask,
  sessionFromRun,
  type OwnedAutomationSession,
  type LiveAutomationSessionDependencies,
} from "./automation-session-disposition.ts";
import {
  claimAutomationSessionForCleanup,
  closeLibrettoSession,
  finalizeAllOwnedAutomationSessions,
  WAITING_SESSION_TIMEOUT_MS,
} from "./session-lifecycle.ts";
import {
  activeTaskRuns,
  taskRunById,
  updateTaskRun,
  type AutomationTaskRun,
  type AutomationTaskStatus,
} from "./store.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, taskById } from "./tasks.ts";
import {
  isStatementSelectionGroup,
  selectStatementTypes,
} from "../statement-selection.ts";
import { readAutomationSettings } from "./settings.ts";
import { routeWaitingRunVerification } from "./verification-routing.ts";
import {
  createCaptchaRetryCampaign,
  isCaptchaRetryCampaignReady,
  transitionCaptchaRetryCampaign,
  type CaptchaRetryCampaign,
} from "./captcha-retry-campaign.ts";
import { MAX_CAPTCHA_RETRY_ROUNDS } from "./captcha-retry-campaign.ts";
import type { CaptchaRoundOutcomeMessage } from "../captcha-round-outcome.ts";
import type { AutomationTaskProcessResult } from "./task-run-finalization.ts";

export { closeLibrettoSession };

const activeTaskRunIds = new Map<string, string>();
const cancellationRequestedTaskIds = new Set<string>();
let librettoRunCdpPatched = false;

export type StartAutomationTaskOptions = {
  scheduledAtUtc?: string;
};

function validateScheduledAtUtc(value: string | undefined) {
  if (
    value !== undefined &&
    (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value)
  ) {
    throw new Error(`Invalid scheduledAtUtc: ${value}`);
  }
}

export function shouldCloseResumeSession(input: {
  status: AutomationTaskStatus;
  resumeSession?: string;
}) {
  return input.status === "failed" && Boolean(input.resumeSession);
}

export function librettoRunCdpPatchCommand(input: { resumeSession?: string }) {
  const command = resolvePatchCommand(input);
  return command ? ([command.command, ...command.args] as const) : null;
}

export function prepareLibrettoRunCdpPatch(
  runPatch: () => void = () => {
    const command = resolvePatchCommand({});
    if (!command) return;
    const patch = spawnSync(command.command, command.args, {
      env: command.env,
      encoding: "utf8",
    });
    if (patch.stdout) console.info(patch.stdout.trim());
    if (patch.stderr) console.warn(patch.stderr.trim());
    if (patch.error || patch.status !== 0) {
      throw (
        patch.error ??
        new Error(`Libretto CDP patch exited with code ${patch.status}`)
      );
    }
  },
) {
  if (librettoRunCdpPatched) return;
  runPatch();
  librettoRunCdpPatched = true;
}

export function hasActiveAutomationTask() {
  return activeTaskRunIds.size > 0;
}

export function activeAutomationTaskIds() {
  return Array.from(activeTaskRunIds.keys());
}

/** True after a user cancellation request until the current task exits. */
export function automationTaskCancellationRequested(taskId: string) {
  return cancellationRequestedTaskIds.has(taskId);
}

function claimTask(taskId: string) {
  if (activeTaskRunIds.has(taskId)) {
    throw new Error(`Automation task is already running: ${taskId}`);
  }
  activeTaskRunIds.set(taskId, "pending");
}

export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
) {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("Concurrency limit must be a positive integer.");
  const active = new Set<Promise<void>>();
  const errors: unknown[] = [];
  for (const item of items) {
    if (active.size >= limit) await Promise.race(active);
    const task = Promise.resolve()
      .then(() => run(item))
      .catch((error) => {
        errors.push(error);
      })
      .finally(() => active.delete(task));
    active.add(task);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all(active);
  if (errors.length) throw errors[0];
}

export async function runAutomationBatch(
  taskIds: readonly string[],
  execute: (taskId: string) => Promise<void>,
) {
  const selectedTaskIds = taskIds.filter(
    (taskId) => taskId !== "import-downloads-csv",
  );
  const errors: unknown[] = [];
  await runWithConcurrency(selectedTaskIds, 2, execute).catch((error) => {
    errors.push(error);
  });
  if (
    taskIds.includes("import-downloads-csv") ||
    selectedTaskIds.some((taskId) => taskById(taskId)?.kind === "crawler")
  ) {
    await execute("import-downloads-csv").catch((error) => {
      errors.push(error);
    });
  }
  if (errors.length) throw errors[0];
}

export function startAutomationTask(
  taskId: string,
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  options: StartAutomationTaskOptions = {},
) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  validateScheduledAtUtc(options.scheduledAtUtc);
  const group = task.credentialGroupId
    ? AUTOMATION_CREDENTIAL_GROUPS.find(
        (candidate) => candidate.id === task.credentialGroupId,
      )
    : null;
  if (
    group &&
    isStatementSelectionGroup(group) &&
    group.id !== "fubon" &&
    group.id !== "sinopac"
  ) {
    selectStatementTypes(group, readAutomationSettings(), "strict");
  }
  claimTask(taskId);
  void runAutomationTask(taskId, ledgerDir, {
    claimed: true,
    scheduledAtUtc: options.scheduledAtUtc,
  }).catch((error) => {
    console.error("automation-task-run-failed", error);
  });
}

export function startAutomationTasks(
  taskIds: readonly string[],
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) {
  const uniqueTaskIds = [...new Set(taskIds)];
  let settings: ReturnType<typeof readAutomationSettings> | undefined;
  for (const taskId of uniqueTaskIds) {
    const task = taskById(taskId);
    if (!task) throw new Error(`Unknown automation task: ${taskId}`);
    const group = task.credentialGroupId
      ? AUTOMATION_CREDENTIAL_GROUPS.find(
          (candidate) => candidate.id === task.credentialGroupId,
        )
      : null;
    if (
      group &&
      isStatementSelectionGroup(group) &&
      group.id !== "fubon" &&
      group.id !== "sinopac"
    ) {
      settings ??= readAutomationSettings();
      selectStatementTypes(group, settings, "strict");
    }
    if (activeTaskRunIds.has(taskId))
      throw new Error(`Automation task is already running: ${taskId}`);
  }
  for (const taskId of uniqueTaskIds) {
    claimTask(taskId);
    activeTaskRunIds.set(taskId, "queued");
  }
  setImmediate(() => {
    void runAutomationBatch(uniqueTaskIds, async (taskId) => {
      const claimed = uniqueTaskIds.includes(taskId);
      if (claimed) {
        if (activeTaskRunIds.get(taskId) !== "queued") return;
        activeTaskRunIds.set(taskId, "pending");
      }
      await runAutomationTask(taskId, ledgerDir, { claimed }).catch((error) => {
        console.error(
          taskId === "import-downloads-csv"
            ? "automation-import-run-failed"
            : "automation-task-run-failed",
          error,
        );
      });
    }).catch((error) => {
      console.error("automation-batch-run-failed", error);
    });
  });
}

export function startAutomationResume(
  taskId: string,
  session: string,
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) {
  if (!taskById(taskId)) throw new Error(`Unknown automation task: ${taskId}`);
  if (!session.match(/^[\w-]+$/))
    throw new Error(`Invalid Libretto session: ${session}`);
  claimTask(taskId);
  void runAutomationTask(taskId, ledgerDir, {
    claimed: true,
    resumeSession: session,
  }).catch((error) => {
    console.error("automation-task-resume-failed", error);
  });
}

export async function cancelAutomationTask(taskId: string) {
  if (!activeTaskRunIds.has(taskId))
    throw new Error(`Automation task is not running: ${taskId}`);
  if (activeTaskRunIds.get(taskId) === "queued") {
    activeTaskRunIds.delete(taskId);
    return { cancelled: taskId };
  }
  cancellationRequestedTaskIds.add(taskId);
  const child = automationTaskChild(taskId);
  // A CAPTCHA retry round can be between child processes while its previous
  // session is being cleaned up. Keep the cancellation request latched so the
  // campaign coordinator observes it after cleanup and never starts round N+1.
  if (!child) {
    // Yield briefly so a pending execution can observe the latched request
    // before a caller that polls cancellation in a tight loop continues.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    return { cancelled: taskId };
  }
  child.kill("SIGTERM");
  await relinquishAutomationSessionForTask(taskId);
  return { cancelled: taskId };
}

export type AbandonedAutomationRecoveryDependencies =
  LiveAutomationSessionDependencies & {
    finalizeRun?: typeof finalizePersistedRun;
    claimSession?: typeof claimAutomationSessionForCleanup;
    scheduleWaitingTimeout?: typeof scheduleAutomationTaskRunTimeout;
    now?: () => number;
  };

function waitingSessionExpired(
  run: Pick<AutomationTaskRun, "startedAt">,
  now: () => number,
) {
  const startedAt = Date.parse(run.startedAt);
  if (!Number.isFinite(startedAt)) return true;
  try {
    const age = now() - startedAt;
    return age < 0 || age >= WAITING_SESSION_TIMEOUT_MS;
  } catch {
    return true;
  }
}

async function preserveWaitingHumanSession(
  db: ReturnType<typeof openLedgerDatabase>,
  run: AutomationTaskRun,
  ledgerDir: string,
  dependencies: AbandonedAutomationRecoveryDependencies,
) {
  if (!run.humanAssistanceContract) return false;
  if (waitingSessionExpired(run, dependencies.now ?? (() => Date.now())))
    return false;
  const owner = automationSessionOwnerForRun(run);
  if (!owner || owner.pid === null) return false;
  if (!(await isLiveOwnedAutomationSession(owner, dependencies))) return false;
  const claimSession =
    dependencies.claimSession ?? claimAutomationSessionForCleanup;
  try {
    if (!claimSession(owner)) return false;
    (dependencies.scheduleWaitingTimeout ?? scheduleAutomationTaskRunTimeout)({
      taskDb: db,
      taskId: run.taskId,
      taskKind: run.kind,
      taskRunId: run.taskRunId,
      logPath: run.logPath,
      ledgerDir,
    });
    return true;
  } catch {
    return false;
  }
}

export async function recoverAbandonedAutomationSessions(
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  dependencies: AbandonedAutomationRecoveryDependencies = {},
) {
  const db = openLedgerDatabase(ledgerDir);
  const errors: unknown[] = [];
  try {
    for (const run of activeTaskRuns(db)) {
      try {
        if (
          run.status === "waiting_for_human" &&
          (await preserveWaitingHumanSession(db, run, ledgerDir, dependencies))
        ) {
          continue;
        }
        await (dependencies.finalizeRun ?? finalizePersistedRun)(
          db,
          run,
          "App 前次異常結束",
        );
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    db.close();
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Failed to finalize persisted automation runs",
    );
}

export async function shutdownAutomationSessions(
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  dependencies: Partial<{
    finalizeOwnedSessions: typeof finalizeAllOwnedAutomationSessions;
    finalizePersistedRuns: typeof finalizePersistedActiveRuns;
  }> = {},
) {
  terminateAutomationTaskProcesses();
  const errors: unknown[] = [];
  const finalizeOwnedSessions =
    dependencies.finalizeOwnedSessions ?? finalizeAllOwnedAutomationSessions;
  const finalizePersistedRuns =
    dependencies.finalizePersistedRuns ?? finalizePersistedActiveRuns;
  try {
    await finalizeOwnedSessions();
  } catch (error) {
    errors.push(error);
  }
  try {
    await finalizePersistedRuns(ledgerDir, "App 關閉，人工操作未完成");
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(errors, "Failed to shut down automation sessions");
}

type CaptchaRetryExecutionResult = Awaited<
  ReturnType<typeof runAutomationTaskExecution>
>;

function processResultOf(execution: CaptchaRetryExecutionResult) {
  return "result" in execution ? execution.result : null;
}

function executionIdOf(execution: CaptchaRetryExecutionResult) {
  return "executionId" in execution ? execution.executionId : null;
}

function captchaOutcomeMessagesOf(execution: CaptchaRetryExecutionResult) {
  return processResultOf(execution)?.captchaOutcomeMessages ?? [];
}

function retryableCaptchaOutcomeOf(execution: CaptchaRetryExecutionResult) {
  return captchaOutcomeMessagesOf(execution)
    .map((message) => message.outcome)
    .findLast((outcome) => outcome.kind === "retryable") ?? null;
}

function recordCapturedChallenge(
  campaign: CaptchaRetryCampaign,
  executionId: string,
) {
  if (campaign.status === "ready") {
    return transitionCaptchaRetryCampaign(campaign, {
      kind: "challenge-captured",
      executionId,
    });
  }
  if (
    campaign.status === "awaiting-outcome" &&
    campaign.activeExecutionId === executionId
  ) {
    return campaign;
  }
  return campaign;
}

function recordTypedCaptchaMessages(
  campaign: CaptchaRetryCampaign,
  messages: readonly CaptchaRoundOutcomeMessage[],
) {
  let next = campaign;
  for (const message of messages) {
    if (message.outcome.kind === "captured") {
      next = recordCapturedChallenge(next, message.executionId);
      continue;
    }
    // No provider currently has an audited rejection probe. Keep this
    // terminal signal fail-closed until a provider registers evidence; it
    // must never advance the retry campaign on its own.
    if (
      message.outcome.kind === "retryable" &&
      message.outcome.reason === "provider-rejected"
    ) continue;
    if (next.status !== "awaiting-outcome") continue;
    // A resume process can have a new transport execution identity while it
    // is still completing the challenge captured by the previous process.
    // The authenticated socket has already proven the child identity; the
    // campaign identity remains the active round identity.
    const eventExecutionId = next.activeExecutionId;
    next = transitionCaptchaRetryCampaign(next, {
      kind: "round-outcome",
      executionId: eventExecutionId,
      outcome: message.outcome.kind === "retryable"
        ? { kind: "retryable", reason: "solver-exhausted" }
        : message.outcome.kind === "succeeded"
          ? { kind: "succeeded" }
          : message.outcome.kind === "cancelled"
            ? { kind: "cancelled" }
            : { kind: "failed", reason: "workflow-failed" },
    });
  }
  return next;
}

function markCaptchaCampaignCancelled(campaign: CaptchaRetryCampaign) {
  if (
    campaign.status === "completed" ||
    campaign.status === "failed" ||
    campaign.status === "cancelled" ||
    campaign.status === "exhausted"
  ) return campaign;
  return transitionCaptchaRetryCampaign(campaign, {
    kind: "cancelled",
    executionId: campaign.status === "awaiting-outcome"
      ? campaign.activeExecutionId
      : undefined,
  });
}

async function finalizeCaptchaRetryCampaign(
  taskDb: ReturnType<typeof openLedgerDatabase>,
  taskRunId: string,
  result: CaptchaRetryExecutionResult,
  ledgerDir: string,
  message: string,
) {
  const run = taskRunById(taskDb, taskRunId);
  if (!run) return { status: "failed" as const };
  const processResult = processResultOf(result);
  const fallback: AutomationTaskProcessResult = {
    exitCode: null,
    signal: null,
    error: new Error(message),
    logTail: run.logTail,
    resumeFailure: null,
    statementSummary: null,
    outputPersistenceWarnings: [],
    externalPrerequisiteIds: [],
    captchaOutcomeMessages: [],
  };
  const finalized = await finalizeAutomationTaskRun(
    {
      taskDb,
      taskId: run.taskId,
      taskKind: run.kind,
      taskRunId,
      logPath: run.logPath,
      ledgerDir,
    },
    {
      ...(processResult ?? fallback),
      exitCode: null,
      signal: null,
      error: new Error(message),
      logTail: processResult?.logTail ?? run.logTail,
    },
  );
  return finalized;
}

async function cleanUpCaptchaRetryRound(
  taskDb: ReturnType<typeof openLedgerDatabase>,
  taskRunId: string,
  reason: string,
  activeOwner?: OwnedAutomationSession | null,
) {
  const run = taskRunById(taskDb, taskRunId);
  if (!run) return { ok: false as const, message: "Missing automation task run." };
  const cleanup = (activeOwner ?? sessionFromRun(run))
    ? await finalizeAutomationSessionForRun(run, null, "exact", activeOwner)
    : null;
  if (cleanup?.cleanupFailed) {
    return {
      ok: false as const,
      message: cleanup.errorMessage ?? "CAPTCHA retry session cleanup failed.",
    };
  }
  const marker = `captcha-retry: restarting workflow (${reason})`;
  try {
    appendLog(run.logPath, marker + "\n");
  } catch {
    // The finalization path will retain the existing log-tail warning if the
    // log cannot be appended; a retry does not depend on this diagnostic.
  }
  updateTaskRun(taskDb, taskRunId, {
    status: "running",
    finishedAt: null,
    exitCode: null,
    signal: null,
    errorMessage: null,
    logTail: `${run.logTail}\n${marker}\n`.slice(-4_000),
  });
  return { ok: true as const };
}

export async function runAutomationTask(
  taskId: string,
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
  options: StartAutomationTaskOptions & {
    claimed?: boolean;
    resumeSession?: string;
  } = {},
) {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  validateScheduledAtUtc(options.scheduledAtUtc);
  if (!options.claimed) claimTask(taskId);

  let db: ReturnType<typeof openLedgerDatabase> | null = null;
  try {
    db = openLedgerDatabase(ledgerDir);
    const launchEnv = { ...automationProcessEnv() };
    // Verification actor and solver settings belong to this user operation.
    // Capture them once so a settings-file edit while a CAPTCHA campaign is
    // between rounds cannot silently change the next execution's policy.
    const launchVerificationSettings = { ...readAutomationSettings() };
    let campaign: CaptchaRetryCampaign = createCaptchaRetryCampaign();
    let taskRunId: string | null = null;
    const onRunCreated = (createdTaskRunId: string) => {
      taskRunId = createdTaskRunId;
      activeTaskRunIds.set(taskId, createdTaskRunId);
    };
    type RoutedExecution = {
      execution: CaptchaRetryExecutionResult;
      routing?: Awaited<ReturnType<typeof routeWaitingRunVerification>>;
    };
    const runExecution = async (
      executionOptions: Parameters<typeof runAutomationTaskExecution>[3],
    ): Promise<RoutedExecution> => {
      const execution = await runAutomationTaskExecution(
        task,
        db!,
        ledgerDir,
        {
          ...executionOptions,
          launchEnv,
          taskRunId: executionOptions.taskRunId ?? taskRunId ?? undefined,
          isCancellationRequested: () =>
            automationTaskCancellationRequested(taskId),
        },
        onRunCreated,
      );
      if (!("taskRunId" in execution) || execution.status !== "waiting_for_human") {
        return { execution };
      }

      let resumed: RoutedExecution | null = null;
      let routing: Awaited<ReturnType<typeof routeWaitingRunVerification>>;
      try {
        routing = await routeWaitingRunVerification({
          taskId,
          taskRunId: execution.taskRunId!,
          db: db!,
          scheduleResume: async (session) => {
            resumed = await runExecution({
              ...executionOptions,
              taskRunId: execution.taskRunId!,
              resumeSession: session,
            });
          },
          onChallengeCaptured: () => {
            const executionId = executionIdOf(execution);
            if (!executionId) return;
            campaign = recordCapturedChallenge(campaign, executionId);
            if (campaign.status === "awaiting-outcome") {
              updateTaskRun(db!, execution.taskRunId!, {
                attempt: campaign.activeRound,
                maxAttempts: campaign.maxRounds,
              });
            }
          },
          settings: launchVerificationSettings,
        });
      } catch (error) {
        await finalizeCaptchaRetryCampaign(
          db!,
          execution.taskRunId!,
          execution,
          ledgerDir,
          errorMessage(error),
        );
        return { execution, routing: { kind: "failed" } };
      }
      if (routing.kind === "resumed" && resumed) return resumed;
      return { execution, routing };
    };

    let executionOptions: Parameters<typeof runAutomationTaskExecution>[3] = {
      scheduledAtUtc: options.scheduledAtUtc,
      resumeSession: options.resumeSession,
    };

    while (true) {
      const routed = await runExecution(executionOptions);
      const execution = routed.execution;
      const typedMessages = captchaOutcomeMessagesOf(execution);
      campaign = recordTypedCaptchaMessages(campaign, typedMessages);
      if (campaign.consumedRounds > 0 && "taskRunId" in execution) {
        updateTaskRun(db, execution.taskRunId!, {
          attempt: campaign.status === "awaiting-outcome"
            ? campaign.activeRound
            : campaign.consumedRounds,
          maxAttempts: campaign.maxRounds,
        });
      }

      if (routed.routing?.kind === "failed") {
        return { status: "failed" as const };
      }
      if (execution.status === "cancelled") {
        if ("taskRunId" in execution) {
          await finalizeCaptchaRetryCampaign(
            db,
            execution.taskRunId!,
            execution,
            ledgerDir,
            "Automation task cancelled.",
          );
        }
        return { status: "failed" as const };
      }
      if (
        automationTaskCancellationRequested(taskId) &&
        "taskRunId" in execution
      ) {
        campaign = markCaptchaCampaignCancelled(campaign);
        await finalizeCaptchaRetryCampaign(
          db,
          execution.taskRunId!,
          execution,
          ledgerDir,
          "Automation task cancelled.",
        );
        return { status: "failed" as const };
      }
      if (routed.routing?.kind === "human") {
        if (campaign.status === "awaiting-outcome") {
          campaign = transitionCaptchaRetryCampaign(campaign, {
            kind: "round-outcome",
            executionId: campaign.activeExecutionId,
            outcome: { kind: "succeeded" },
          });
        }
        return { status: "waiting_for_human" as const };
      }

      const typedRetry = retryableCaptchaOutcomeOf(execution);
      const routeRetry = routed.routing?.kind === "retryable"
        ? "solver-exhausted" as const
        : typedRetry?.reason === "solver-exhausted"
          ? "solver-exhausted" as const
          : null;
      if (typedRetry?.reason === "provider-rejected") {
        if ("taskRunId" in execution) {
          await finalizeCaptchaRetryCampaign(
            db,
            execution.taskRunId!,
            execution,
            ledgerDir,
            "Provider CAPTCHA rejection proof is not enabled for this workflow.",
          );
        }
        return { status: "failed" as const };
      }
      if (routeRetry) {
        if (!("taskRunId" in execution)) return { status: "failed" as const };
        // A workflow-side reporter may have already delivered both the
        // capture and solver-exhausted events before its process exits. In
        // that case recordTypedCaptchaMessages has advanced the campaign to
        // ready (or exhausted); a host-side solver route still arrives in the
        // awaiting state and needs the transition below.
        if (campaign.status === "awaiting-outcome") {
          campaign = transitionCaptchaRetryCampaign(campaign, {
            kind: "round-outcome",
            executionId: campaign.activeExecutionId,
            outcome: { kind: "retryable", reason: routeRetry },
          });
        } else if (campaign.status !== "ready" && campaign.status !== "exhausted") {
          await finalizeCaptchaRetryCampaign(
            db,
            execution.taskRunId!,
            execution,
            ledgerDir,
            "CAPTCHA retry requested without a captured challenge.",
          );
          return { status: "failed" as const };
        }
        if (!isCaptchaRetryCampaignReady(campaign)) {
          if (campaign.status === "exhausted") {
            await finalizeCaptchaRetryCampaign(
              db,
              execution.taskRunId!,
              execution,
              ledgerDir,
              `CAPTCHA retry campaign exhausted after ${MAX_CAPTCHA_RETRY_ROUNDS} rounds.`,
            );
            return { status: "failed" as const };
          }
          return { status: "failed" as const };
        }
        const cleanup = await cleanUpCaptchaRetryRound(
          db,
          execution.taskRunId!,
          routeRetry,
          "owner" in execution ? execution.owner : null,
        );
        if (!cleanup.ok) {
          await finalizeCaptchaRetryCampaign(
            db,
            execution.taskRunId!,
            execution,
            ledgerDir,
            cleanup.message,
          );
          return { status: "failed" as const };
        }
        if (automationTaskCancellationRequested(taskId)) {
          campaign = markCaptchaCampaignCancelled(campaign);
          await finalizeCaptchaRetryCampaign(
            db,
            execution.taskRunId!,
            execution,
            ledgerDir,
            "Automation task cancelled.",
          );
          return { status: "failed" as const };
        }
        executionOptions = {
          scheduledAtUtc: options.scheduledAtUtc,
          taskRunId: execution.taskRunId!,
          attempt: campaign.nextRound,
          maxAttempts: MAX_CAPTCHA_RETRY_ROUNDS,
        };
        continue;
      }

      if (
        campaign.status === "awaiting-outcome" &&
        "taskRunId" in execution &&
        (execution.status === "completed" || execution.status === "partial")
      ) {
        campaign = transitionCaptchaRetryCampaign(campaign, {
          kind: "round-outcome",
          executionId: campaign.activeExecutionId,
          outcome: { kind: "succeeded" },
        });
      }
      return {
        status: "status" in execution
          ? execution.status === "captcha-retryable" ? "failed" : execution.status
          : "failed",
      };
    }
  } finally {
    activeTaskRunIds.delete(taskId);
    cancellationRequestedTaskIds.delete(taskId);
    db?.close();
  }
}
