import { appendFileSync, closeSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { readLibrettoSessionState } from "./libretto-session.ts";
import {
  armAutomationSessionTimeout,
  claimAutomationSessionForCleanup,
  disarmAutomationSessionTimeout,
  finalizeExactOwnedAutomationSession,
  finalizeOwnedAutomationSession,
  ownAutomationSession,
  ownedAutomationSession,
  restoreAutomationSessionOwnership,
  type FinalizeSessionDeps,
  type OwnedAutomationSession,
  type TimerDeps,
} from "./session-lifecycle.ts";
import { updateTaskRun, type AutomationTaskRun } from "./store.ts";
import {
  createAutomationSecretBoundaryGate,
  secretBoundaryFailureMessage,
  type SecretBoundaryGate,
} from "./secret-boundary.ts";

const SESSION_LOG_PREFIX_BYTES = 4_000;

export type { FinalizeSessionDeps, OwnedAutomationSession, TimerDeps } from "./session-lifecycle.ts";

export type AutomationSessionDisposition = "retain" | "relinquish";

export type ForceQuitFinalizationDependencies = Partial<{
  readSessionState: typeof readLibrettoSessionState;
  claimSession: typeof claimAutomationSessionForCleanup;
  finalizeSession: typeof finalizeExactOwnedAutomationSession;
}>;

export type AutomationSessionCleanupResult = {
  session: string | null;
  pid: number | null;
  errorMessage: string | null;
  cleanupFailed: boolean;
};

export type ForceQuitAutomationSessionResult = AutomationSessionCleanupResult & {
  operationalError: unknown | null;
};

export function appendLog(
  logPath: string,
  chunk: string,
  secretGate: SecretBoundaryGate = createAutomationSecretBoundaryGate(),
) {
  const protectedChunk = secretGate.protectText("filesystem-log", chunk);
  if (protectedChunk.failure) {
    throw new Error(secretBoundaryFailureMessage(protectedChunk.failure));
  }
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, protectedChunk.value);
}

export function tail(value: string) {
  return value.slice(-4_000);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function appendCleanupError(
  message: string | null,
  cleanup: string,
  secretGate: SecretBoundaryGate = createAutomationSecretBoundaryGate(),
) {
  const suffix = "Session cleanup failed: " + cleanup;
  const protectedMessage = secretGate.protectText(
    "cleanup-error",
    message ? message + "\n" + suffix : suffix,
  );
  return protectedMessage.failure
    ? secretBoundaryFailureMessage(protectedMessage.failure)
    : protectedMessage.value;
}

export function automationCleanupFailureDetails(
  owner: OwnedAutomationSession,
  error: unknown,
  secretGate: SecretBoundaryGate = createAutomationSecretBoundaryGate(),
) {
  const protectedError = secretGate.protectText(
    "cleanup-error",
    errorMessage(error),
  );
  return {
    taskRunId: owner.taskRunId,
    sessionId: owner.session,
    retainedPid: owner.pid,
    error: protectedError.failure
      ? secretBoundaryFailureMessage(protectedError.failure)
      : protectedError.value,
  };
}

export function automationSessionFromLog(output: string) {
  return output.match(/automation-session:\s+([A-Za-z0-9._-]+)/i)?.[1] ?? null;
}

export function resumeSessionFromLog(output: string) {
  return output.match(/libretto resume --session\s+([\w-]+)/i)?.[1] ?? null;
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
    const session = automationSessionFromLog(output) ?? resumeSessionFromLog(output);
    if (session) return session;
  } catch {
    // The bounded log tail remains the recovery source when the log file is unavailable.
  }
  return automationSessionFromLog(run.logTail) ?? resumeSessionFromLog(run.logTail);
}

export function sessionPid(session: string) {
  try {
    return readLibrettoSessionState(session)?.pid ?? null;
  } catch {
    return null;
  }
}

export function automationSessionOwnerForRun(run: AutomationTaskRun): OwnedAutomationSession | null {
  const session = sessionFromRun(run);
  return session
    ? { taskId: run.taskId, taskRunId: run.taskRunId, session, pid: sessionPid(session) }
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
  const resumeFrom = options.resumeFrom;
  let claimError: unknown = null;
  const isResumeHandoff = Boolean(
    options.resumeSession
      && options.resumeSession === owner.session
      && resumeFrom?.status === "waiting_for_human"
      && resumeFrom.taskId === owner.taskId
      && resumeFrom.taskRunId !== taskRunId
      && sessionFromRun(resumeFrom) === owner.session
      && (!current
        || (current.taskRunId === resumeFrom.taskRunId && current.session === owner.session)),
  );
  if ((!options.resumeSession || isResumeHandoff) && (!current || isResumeHandoff)) {
    if (resumeFrom) {
      const claimRejected = new Error("Automation session registry claim rejected");
      let registryClaimed = false;
      db.exec("BEGIN");
      try {
        updateTaskRun(db, resumeFrom.taskRunId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          errorMessage: `Superseded by resume handoff: ${taskRunId}`,
          logTail: tail(`${resumeFrom.logTail}\nautomation-resume-handoff: ${taskRunId}\n`),
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
          if (registryClaimed) restoreAutomationSessionOwnership(owner, current ?? null);
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
    errorMessage: claimError && errorMessage(claimError) !== "Automation session registry claim rejected"
      ? `Automation session handoff failed: ${errorMessage(claimError)}`
      : "Automation session is still closing. Try again after cleanup finishes.",
  });
  return false;
}

export async function finalizeAutomationSession(
  owner: OwnedAutomationSession,
  workflowError: string | null,
  finalize: () => Promise<unknown> = async () => {
    if (!await finalizeExactOwnedAutomationSession(owner)) {
      throw new Error(`Automation session ownership changed for task: ${owner.taskId}`);
    }
  },
  secretGate: SecretBoundaryGate = createAutomationSecretBoundaryGate(),
) {
  try {
    await finalize();
    const protectedWorkflowError = workflowError === null
      ? null
      : secretGate.protectText("cleanup-error", workflowError);
    return {
      errorMessage: protectedWorkflowError === null
        ? null
        : protectedWorkflowError.failure
          ? secretBoundaryFailureMessage(protectedWorkflowError.failure)
          : protectedWorkflowError.value,
      cleanupFailed: false,
    };
  } catch (error) {
    console.error(
      "automation-session-cleanup-failed",
      automationCleanupFailureDetails(owner, error, secretGate),
    );
    return {
      errorMessage: appendCleanupError(workflowError, errorMessage(error), secretGate),
      cleanupFailed: true,
    };
  }
}

export async function finalizeAutomationSessionForRun(
  run: AutomationTaskRun,
  workflowError: string | null,
  mode: "exact" | "recovery",
  secretGate: SecretBoundaryGate = createAutomationSecretBoundaryGate(),
): Promise<AutomationSessionCleanupResult> {
  const owner = automationSessionOwnerForRun(run);
  if (!owner) {
    return {
      session: null,
      pid: null,
      errorMessage: appendCleanupError(
        workflowError,
        "Missing Libretto session identity",
        secretGate,
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
        secretGate,
      ),
      cleanupFailed: true,
    };
  }

  const result = await finalizeAutomationSession(owner, workflowError, async () => {
    const finalized = await finalizeExactOwnedAutomationSession(owner);
    if (!finalized) {
      throw new Error(`Automation session ownership changed for task: ${run.taskId}`);
    }
  }, secretGate);
  return { ...result, session: owner.session, pid: owner.pid };
}

export async function forceQuitAutomationSessionForRun(
  run: AutomationTaskRun,
  dependencies: ForceQuitFinalizationDependencies = {},
  secretGate: SecretBoundaryGate = createAutomationSecretBoundaryGate(),
): Promise<ForceQuitAutomationSessionResult> {
  const session = sessionFromRun(run);
  if (!session) throw new Error(`Missing Libretto resume session for automation task: ${run.taskId}`);
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
      throw new Error(`Automation session ownership changed for task: ${run.taskId}`);
    }
    let finalizeFailure: unknown = null;
    const cleanupResult = await finalizeAutomationSession(
      owner,
      "Browser session force quit.",
      async () => {
        try {
          if (!await deps.finalizeSession(owner)) {
            throw new Error(`Automation session ownership changed for task: ${run.taskId}`);
          }
        } catch (error) {
          finalizeFailure = error;
          throw error;
        }
      },
      secretGate,
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
        secretGate,
      ),
      cleanupFailed: true,
    };
  }
  return { ...result, operationalError };
}
