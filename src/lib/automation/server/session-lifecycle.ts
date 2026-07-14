import { execFileSync, spawn } from "node:child_process";
import { automationConfigEnv } from "./config-files.ts";
import { resolveLibrettoCommand } from "./desktop-command.ts";
import { readLibrettoSessionState } from "./libretto-session.ts";

export const WAITING_SESSION_TIMEOUT_MS = 20 * 60 * 1_000;
const TERM_GRACE_MS = 1_500;
const KILL_GRACE_MS = 300;
const CLOSE_TIMEOUT_MS = 1_000;

export type OwnedAutomationSession = {
  taskId: string;
  taskRunId: string;
  session: string;
  pid: number | null;
};

export type FinalizeSessionDeps = {
  closeSession(session: string): Promise<void>;
  terminateCloseSession?(session: string): void | Promise<void>;
  startCloseSession?(session: string): CloseSessionHandle;
  isExpectedDaemon(pid: number, session: string): boolean;
  signalProcessGroup(pid: number, signal: NodeJS.Signals): void;
  wait(ms: number): Promise<void>;
  timerDeps?: TimerDeps;
};

type CloseSessionHandle = {
  completion: Promise<void>;
  terminate(): Promise<void>;
};

export type TimerDeps = {
  setTimer(callback: () => void, ms: number): NodeJS.Timeout | number;
  clearTimer(timer: NodeJS.Timeout | number): void;
};

const ownedByTask = new Map<string, OwnedAutomationSession>();
const closingBySession = new Map<string, Promise<void>>();
const timeoutByTask = new Map<string, NodeJS.Timeout | number>();
const clearTimerByTask = new Map<string, TimerDeps["clearTimer"]>();

const defaultTimerDeps: TimerDeps = {
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (timer) => clearTimeout(timer),
};

function processCommand(pid: number) {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function isExpectedDaemon(pid: number, session: string) {
  const command = processCommand(pid);
  return command.includes("libretto/dist/cli/core/daemon/daemon.js")
    && command.includes('\"session\":\"' + session + '\"');
}

export function signalProcessGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    try {
      process.kill(pid, signal);
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code !== "ESRCH") throw fallbackError;
    }
  }
}

const defaultFinalizeDeps: FinalizeSessionDeps = {
  closeSession: closeLibrettoSession,
  startCloseSession: startLibrettoClose,
  isExpectedDaemon,
  signalProcessGroup,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

async function settleWithin<T>(
  promise: Promise<T>,
  ms: number,
  timerDeps: TimerDeps,
): Promise<{ timedOut: true } | { timedOut: false; value?: T; error?: unknown }> {
  let timer: NodeJS.Timeout | number | undefined;
  const result = await Promise.race([
    promise.then(
      (value) => ({ timedOut: false as const, value }),
      (error: unknown) => ({ timedOut: false as const, error }),
    ),
    new Promise<{ timedOut: true }>((resolve) => {
      timer = timerDeps.setTimer(() => resolve({ timedOut: true }), ms);
    }),
  ]);
  if (timer !== undefined) timerDeps.clearTimer(timer);
  return result;
}

function isExactOwner(
  current: OwnedAutomationSession | undefined,
  expected: Pick<OwnedAutomationSession, "taskId" | "taskRunId" | "session">,
) {
  return current?.taskId === expected.taskId
    && current.taskRunId === expected.taskRunId
    && current.session === expected.session;
}

export function ownAutomationSession(input: OwnedAutomationSession): boolean {
  const current = ownedByTask.get(input.taskId);
  if (closingBySession.has(input.session) && !isExactOwner(current, input)) return false;
  ownedByTask.set(input.taskId, {
    ...input,
    pid: input.pid ?? (current?.session === input.session ? current.pid : null),
  });
  return true;
}

export function claimAutomationSessionForCleanup(input: OwnedAutomationSession): boolean {
  const current = ownedByTask.get(input.taskId);
  if (current && !isExactOwner(current, input)) return false;
  return ownAutomationSession(input);
}

export function ownedAutomationSession(taskId: string): OwnedAutomationSession | null {
  return ownedByTask.get(taskId) ?? null;
}

export function restoreAutomationSessionOwnership(
  expected: Pick<OwnedAutomationSession, "taskId" | "taskRunId" | "session">,
  previous: OwnedAutomationSession | null,
): boolean {
  if (!isExactOwner(ownedByTask.get(expected.taskId), expected)) return false;
  if (previous) ownedByTask.set(expected.taskId, previous);
  else ownedByTask.delete(expected.taskId);
  return true;
}

export function armAutomationSessionTimeout(
  taskId: string,
  onTimeout: () => void | Promise<void>,
  timerDeps: TimerDeps = defaultTimerDeps,
): void {
  const previous = timeoutByTask.get(taskId);
  if (previous !== undefined) clearTimerByTask.get(taskId)?.(previous);
  let timer: NodeJS.Timeout | number;
  timer = timerDeps.setTimer(() => {
    if (timeoutByTask.get(taskId) !== timer) return;
    timeoutByTask.delete(taskId);
    clearTimerByTask.delete(taskId);
    void onTimeout();
  }, WAITING_SESSION_TIMEOUT_MS);
  timeoutByTask.set(taskId, timer);
  clearTimerByTask.set(taskId, timerDeps.clearTimer);
}

export function disarmAutomationSessionTimeout(taskId: string): void {
  const timer = timeoutByTask.get(taskId);
  if (timer === undefined) return;
  clearTimerByTask.get(taskId)?.(timer);
  timeoutByTask.delete(taskId);
  clearTimerByTask.delete(taskId);
}

async function closeOwnedSession(
  owned: OwnedAutomationSession,
  deps: FinalizeSessionDeps,
): Promise<void> {
  let pid = owned.pid;
  let readError: unknown = null;
  if (pid === null) {
    try {
      pid = readLibrettoSessionState(owned.session)?.pid ?? null;
    } catch (error) {
      readError = error;
    }
  }
  let closeError: unknown = null;
  const closeHandle = deps.startCloseSession?.(owned.session) ?? {
    completion: deps.closeSession(owned.session),
    terminate: async () => { await deps.terminateCloseSession?.(owned.session); },
  };
  const timerDeps = deps.timerDeps ?? defaultTimerDeps;
  const closeResult = await settleWithin(closeHandle.completion, CLOSE_TIMEOUT_MS, timerDeps);
  let helperTerminationError: Error | null = null;
  if (closeResult.timedOut) {
    const termination = await settleWithin(
      closeHandle.terminate(),
      KILL_GRACE_MS,
      timerDeps,
    );
    if (termination.timedOut) {
      helperTerminationError = new Error(
        `Libretto close helper remained after ${KILL_GRACE_MS}ms termination deadline`,
      );
    }
    closeError = termination.timedOut
      ? helperTerminationError
      : termination.error ?? new Error(`Libretto close timed out after ${CLOSE_TIMEOUT_MS}ms`);
  } else {
    closeError = closeResult.error ?? null;
  }

  if (pid === null) {
    if (closeError) {
      const readContext = readError ? ` state read: ${String(readError)};` : "";
      throw new Error(
        `Could not close Libretto session ${owned.session}:${readContext} graceful close: ${String(closeError)}`,
      );
    }
    return;
  }
  let daemonError: Error | null = null;
  if (deps.isExpectedDaemon(pid, owned.session)) {
    deps.signalProcessGroup(pid, "SIGTERM");
    await deps.wait(TERM_GRACE_MS);
    if (deps.isExpectedDaemon(pid, owned.session)) {
      deps.signalProcessGroup(pid, "SIGKILL");
      await deps.wait(KILL_GRACE_MS);
      if (deps.isExpectedDaemon(pid, owned.session)) {
        daemonError = new Error(
          `Libretto session ${owned.session} daemon ${pid} remained after SIGKILL`,
        );
      }
    }
  }
  if (helperTerminationError && daemonError) {
    throw new AggregateError([helperTerminationError, daemonError], helperTerminationError.message);
  }
  if (helperTerminationError) throw helperTerminationError;
  if (daemonError) throw daemonError;
}

export async function finalizeOwnedAutomationSession(
  taskId: string,
  deps: FinalizeSessionDeps = defaultFinalizeDeps,
): Promise<void> {
  const owned = ownedByTask.get(taskId);
  if (!owned) return;
  await finalizeExactOwnedAutomationSession(owned, deps);
}

export async function finalizeExactOwnedAutomationSession(
  expected: Pick<OwnedAutomationSession, "taskId" | "taskRunId" | "session">,
  deps: FinalizeSessionDeps = defaultFinalizeDeps,
): Promise<boolean> {
  const owned = ownedByTask.get(expected.taskId);
  if (!owned || !isExactOwner(owned, expected)) return false;
  disarmAutomationSessionTimeout(expected.taskId);

  let closing = closingBySession.get(owned.session);
  if (!closing) {
    closing = closeOwnedSession(owned, deps).finally(() => {
      closingBySession.delete(owned.session);
    });
    closingBySession.set(owned.session, closing);
  }
  try {
    await closing;
  } finally {
    if (isExactOwner(ownedByTask.get(expected.taskId), expected)) {
      ownedByTask.delete(expected.taskId);
    }
  }
  return true;
}

export async function finalizeAllOwnedAutomationSessions(
  deps: FinalizeSessionDeps = defaultFinalizeDeps,
): Promise<void> {
  const results = await Promise.allSettled(
    Array.from(ownedByTask.keys(), (taskId) => finalizeOwnedAutomationSession(taskId, deps)),
  );
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, "Failed to finalize owned Libretto sessions");
}

function startLibrettoClose(session: string): CloseSessionHandle {
  let child: ReturnType<typeof spawn>;
  const completion = new Promise<void>((resolve, reject) => {
    const command = resolveLibrettoCommand(
      ["close", "--session", session],
      automationConfigEnv(),
    );
    child = spawn(command.command, command.args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: command.env,
    });
    let errorText = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      errorText = (errorText + chunk.toString("utf8")).slice(-4_000);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0 || /no browser (?:is )?running/i.test(errorText)) {
        resolve();
        return;
      }
      reject(new Error(errorText || `libretto close exited with code ${exitCode}`));
    });
  });
  return {
    completion,
    async terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await completion.catch(() => {});
    },
  };
}

export async function closeLibrettoSession(session: string): Promise<void> {
  await startLibrettoClose(session).completion;
}
