import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
import { dirname } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import {
  cdpEndpointForSession,
  readLibrettoSessionState,
} from "./libretto-session.ts";
import {
  armAutomationSessionTimeout,
  claimAutomationSessionForCleanup,
  disarmAutomationSessionTimeout,
  finalizeExactOwnedAutomationSession,
  finalizeOwnedAutomationSession,
  isAutomationSessionCleanupPending,
  isExpectedLibrettoDaemon,
  ownAutomationSession,
  ownedAutomationSession,
  restoreAutomationSessionOwnership,
  type FinalizeSessionDeps,
  type OwnedAutomationSession,
  type TimerDeps,
} from "./session-lifecycle.ts";
import { taskRunById, updateTaskRun, type AutomationTaskRun } from "./store.ts";

const SESSION_LOG_PREFIX_BYTES = 4_000;

export type {
  FinalizeSessionDeps,
  OwnedAutomationSession,
  TimerDeps,
} from "./session-lifecycle.ts";

export type AutomationSessionDisposition = "retain" | "relinquish";

export type ForceQuitFinalizationDependencies = Partial<{
  readSessionState: typeof readLibrettoSessionState;
  claimSession: typeof claimAutomationSessionForCleanup;
  finalizeSession: typeof finalizeExactOwnedAutomationSession;
}>;

export type LiveAutomationSessionDependencies = Partial<{
  readSessionState: typeof readLibrettoSessionState;
  endpointForSession: typeof cdpEndpointForSession;
  isExpectedDaemon: typeof isExpectedLibrettoDaemon;
  probeEndpoint: (endpoint: string) => Promise<boolean>;
}>;

export type AutomationSessionCleanupResult = {
  session: string | null;
  pid: number | null;
  errorMessage: string | null;
  cleanupFailed: boolean;
};

export type ForceQuitAutomationSessionResult =
  AutomationSessionCleanupResult & {
    operationalError: unknown | null;
  };

export function appendLog(logPath: string, chunk: string) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, chunk);
}

export function tail(value: string) {
  return value.slice(-4_000);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function appendCleanupError(message: string | null, cleanup: string) {
  const suffix = "Session cleanup failed: " + cleanup;
  return message ? message + "\n" + suffix : suffix;
}

export function automationCleanupFailureDetails(
  owner: OwnedAutomationSession,
  error: unknown,
) {
  return {
    taskRunId: owner.taskRunId,
    sessionId: owner.session,
    retainedPid: owner.pid,
    error: errorMessage(error),
  };
}

export function automationSessionFromLog(output: string) {
  return output.match(/automation-session:\s+([A-Za-z0-9._-]+)/i)?.[1] ?? null;
}

export function resumeSessionFromLog(output: string) {
  const match = output.match(
    /libretto resume --session\s+([\w-]+)|Resume requested for session\s+["']?([\w-]+)/i,
  );
  return match?.[1] ?? match?.[2] ?? null;
}

export function sessionFromRun(run: AutomationTaskRun) {
  try {
    const buffer = Buffer.alloc(SESSION_LOG_PREFIX_BYTES);
    const descriptor = openSync(run.logPath, "r");
    let length: number;
    try {
      length = readSync(descriptor, buffer, 0, SESSION_LOG_PREFIX_BYTES, 0);
    } finally {
      closeSync(descriptor);
    }
    const output = buffer.toString("utf8", 0, length);
    const session =
      automationSessionFromLog(output) ?? resumeSessionFromLog(output);
    if (session) return session;
  } catch {
    // The bounded log tail remains the recovery source when the log file is unavailable.
  }
  return (
    automationSessionFromLog(run.logTail) ?? resumeSessionFromLog(run.logTail)
  );
}

export function sessionPid(session: string) {
  try {
    return readLibrettoSessionState(session)?.pid ?? null;
  } catch {
    return null;
  }
}

function isLoopbackHttpEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

async function probeCdpEndpoint(endpoint: string) {
  if (!isLoopbackHttpEndpoint(endpoint)) return false;
  try {
    const response = await fetch(new URL("/json/version", endpoint), {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function isLiveOwnedAutomationSession(
  owner: Pick<OwnedAutomationSession, "session" | "pid">,
  dependencies: LiveAutomationSessionDependencies = {},
) {
  const deps = {
    readSessionState: readLibrettoSessionState,
    endpointForSession: cdpEndpointForSession,
    isExpectedDaemon: isExpectedLibrettoDaemon,
    probeEndpoint: probeCdpEndpoint,
    ...dependencies,
  };
  let state: ReturnType<typeof readLibrettoSessionState>;
  try {
    state = deps.readSessionState(owner.session);
  } catch {
    return false;
  }
  if (
    !state ||
    state.session !== owner.session ||
    state.status !== "paused" ||
    !state.pid ||
    owner.pid !== state.pid
  )
    return false;
  try {
    if (!deps.isExpectedDaemon(state.pid, owner.session)) return false;
  } catch {
    return false;
  }
  let endpoint: string | null;
  try {
    endpoint = deps.endpointForSession(owner.session);
  } catch {
    return false;
  }
  if (!endpoint || !isLoopbackHttpEndpoint(endpoint)) return false;
  try {
    return await deps.probeEndpoint(endpoint);
  } catch {
    return false;
  }
}

export function automationSessionOwnerForRun(
  run: AutomationTaskRun,
): OwnedAutomationSession | null {
  const session = sessionFromRun(run);
  return session
    ? {
        taskId: run.taskId,
        taskRunId: run.taskRunId,
        session,
        pid: sessionPid(session),
      }
    : null;
}

export function refreshAutomationSession(owner: OwnedAutomationSession) {
  return ownAutomationSession({ ...owner, pid: sessionPid(owner.session) });
}

export function ownedAutomationSessionForTask(taskId: string) {
  return ownedAutomationSession(taskId);
}

export function armAutomationSessionDispositionTimeout(
  taskId: string,
  onTimeout: () => void | Promise<void>,
  timerDeps?: TimerDeps,
) {
  return armAutomationSessionTimeout(taskId, onTimeout, timerDeps);
}

export function disarmAutomationSessionDispositionTimeout(taskId: string) {
  return disarmAutomationSessionTimeout(taskId);
}

export async function relinquishAutomationSessionForTask(
  taskId: string,
  deps?: FinalizeSessionDeps,
) {
  return finalizeOwnedAutomationSession(taskId, deps);
}

export function claimAutomationTaskRunSession(
  db: ReturnType<typeof openLedgerDatabase>,
  taskRunId: string,
  owner: OwnedAutomationSession,
  options: { resumeSession?: string; resumeFrom?: AutomationTaskRun } = {},
) {
  const current = ownedAutomationSession(owner.taskId);
  const currentRun = current ? taskRunById(db, current.taskRunId) : null;
  const currentRunIsTerminal =
    currentRun?.status === "completed" ||
    currentRun?.status === "partial" ||
    currentRun?.status === "failed";
  const currentHasExpectedDaemon = Boolean(
    current?.pid !== null &&
    current?.pid !== undefined &&
    isExpectedLibrettoDaemon(current.pid, current.session),
  );
  const mayReplaceTerminalOwner = Boolean(
    current &&
    currentRunIsTerminal &&
    !isAutomationSessionCleanupPending(current.session) &&
    !currentHasExpectedDaemon,
  );
  const resumeFrom = options.resumeFrom;
  let claimError: unknown = null;
  const isResumeHandoff = Boolean(
    options.resumeSession &&
    options.resumeSession === owner.session &&
    resumeFrom?.status === "waiting_for_human" &&
    resumeFrom.taskId === owner.taskId &&
    resumeFrom.taskRunId !== taskRunId &&
    sessionFromRun(resumeFrom) === owner.session &&
    (!current ||
      (current.taskRunId === resumeFrom.taskRunId &&
        current.session === owner.session)),
  );
  if (
    (!options.resumeSession || isResumeHandoff) &&
    (!current || isResumeHandoff || mayReplaceTerminalOwner)
  ) {
    if (resumeFrom) {
      const claimRejected = new Error(
        "Automation session registry claim rejected",
      );
      let registryClaimed = false;
      db.exec("BEGIN");
      try {
        updateTaskRun(db, resumeFrom.taskRunId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          errorMessage: `Superseded by resume handoff: ${taskRunId}`,
          logTail: tail(
            `${resumeFrom.logTail}\nautomation-resume-handoff: ${taskRunId}\n`,
          ),
        });
        if (!ownAutomationSession(owner)) throw claimRejected;
        registryClaimed = true;
        db.exec("COMMIT");
        disarmAutomationSessionTimeout(owner.taskId);
        return true;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } finally {
          if (registryClaimed)
            restoreAutomationSessionOwnership(owner, current ?? null);
        }
        claimError = error;
      }
    } else if (ownAutomationSession(owner)) {
      disarmAutomationSessionTimeout(owner.taskId);
      return true;
    }
  }
  updateTaskRun(db, taskRunId, {
    status: "failed",
    finishedAt: new Date().toISOString(),
    exitCode: null,
    signal: null,
    errorMessage:
      claimError &&
      errorMessage(claimError) !== "Automation session registry claim rejected"
        ? `Automation session handoff failed: ${errorMessage(claimError)}`
        : "Automation session is still closing. Try again after cleanup finishes.",
  });
  return false;
}

export async function finalizeAutomationSession(
  owner: OwnedAutomationSession,
  workflowError: string | null,
  finalize: () => Promise<unknown> = async () => {
    if (!(await finalizeExactOwnedAutomationSession(owner))) {
      throw new Error(
        `Automation session ownership changed for task: ${owner.taskId}`,
      );
    }
  },
) {
  try {
    await finalize();
    return { errorMessage: workflowError, cleanupFailed: false };
  } catch (error) {
    console.error(
      "automation-session-cleanup-failed",
      automationCleanupFailureDetails(owner, error),
    );
    return {
      errorMessage: appendCleanupError(workflowError, errorMessage(error)),
      cleanupFailed: true,
    };
  }
}

export async function finalizeAutomationSessionForRun(
  run: AutomationTaskRun,
  workflowError: string | null,
  mode: "exact" | "recovery",
): Promise<AutomationSessionCleanupResult> {
  const owner = automationSessionOwnerForRun(run);
  if (!owner) {
    return {
      session: null,
      pid: null,
      errorMessage: appendCleanupError(
        workflowError,
        "Missing Libretto session identity",
      ),
      cleanupFailed: true,
    };
  }

  if (mode === "recovery" && !ownAutomationSession(owner)) {
    return {
      session: owner.session,
      pid: owner.pid,
      errorMessage: appendCleanupError(
        workflowError,
        `Automation session ownership changed for task: ${run.taskId}`,
      ),
      cleanupFailed: true,
    };
  }

  const result = await finalizeAutomationSession(
    owner,
    workflowError,
    async () => {
      const finalized = await finalizeExactOwnedAutomationSession(owner);
      if (!finalized) {
        throw new Error(
          `Automation session ownership changed for task: ${run.taskId}`,
        );
      }
    },
  );
  return { ...result, session: owner.session, pid: owner.pid };
}

export async function forceQuitAutomationSessionForRun(
  run: AutomationTaskRun,
  dependencies: ForceQuitFinalizationDependencies = {},
): Promise<ForceQuitAutomationSessionResult> {
  const session = sessionFromRun(run);
  if (!session)
    throw new Error(
      `Missing Libretto resume session for automation task: ${run.taskId}`,
    );
  const deps = {
    readSessionState: readLibrettoSessionState,
    claimSession: claimAutomationSessionForCleanup,
    finalizeSession: finalizeExactOwnedAutomationSession,
    ...dependencies,
  };
  let owner: OwnedAutomationSession = {
    taskId: run.taskId,
    taskRunId: run.taskRunId,
    session,
    pid: null,
  };
  let operationalError: unknown | null = null;
  let result: AutomationSessionCleanupResult;
  try {
    owner = { ...owner, pid: deps.readSessionState(session)?.pid ?? null };
    if (!deps.claimSession(owner)) {
      throw new Error(
        `Automation session ownership changed for task: ${run.taskId}`,
      );
    }
    let finalizeFailure: unknown = null;
    const cleanupResult = await finalizeAutomationSession(
      owner,
      "Browser session force quit.",
      async () => {
        try {
          if (!(await deps.finalizeSession(owner))) {
            throw new Error(
              `Automation session ownership changed for task: ${run.taskId}`,
            );
          }
        } catch (error) {
          finalizeFailure = error;
          throw error;
        }
      },
    );
    operationalError = finalizeFailure;
    result = { ...cleanupResult, session, pid: owner.pid };
  } catch (error) {
    operationalError = error;
    result = {
      session,
      pid: owner.pid,
      errorMessage: appendCleanupError(
        "Browser session force quit.",
        errorMessage(error),
      ),
      cleanupFailed: true,
    };
  }
  return { ...result, operationalError };
}
