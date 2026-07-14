import { execFileSync, spawn } from "node:child_process";
import { automationConfigEnv } from "./config-files.ts";
import { resolveLibrettoCommand } from "./desktop-command.ts";
import { readLibrettoSessionState } from "./libretto-session.ts";

export const WAITING_SESSION_TIMEOUT_MS = 20 * 60 * 1_000;
const TERM_GRACE_MS = 1_500;
const KILL_GRACE_MS = 300;

export type OwnedAutomationSession = {
  taskId: string;
  taskRunId: string;
  session: string;
  pid: number | null;
};

export type FinalizeSessionDeps = {
  closeSession(session: string): Promise<void>;
  isExpectedDaemon(pid: number, session: string): boolean;
  signalProcessGroup(pid: number, signal: NodeJS.Signals): void;
  wait(ms: number): Promise<void>;
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
  isExpectedDaemon,
  signalProcessGroup,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function ownAutomationSession(input: OwnedAutomationSession): void {
  const current = ownedByTask.get(input.taskId);
  ownedByTask.set(input.taskId, {
    ...input,
    pid: input.pid ?? (current?.session === input.session ? current.pid : null),
  });
}

export function ownedAutomationSession(taskId: string): OwnedAutomationSession | null {
  return ownedByTask.get(taskId) ?? null;
}

export function armAutomationSessionTimeout(
  taskId: string,
  onTimeout: () => void | Promise<void>,
  timerDeps: TimerDeps = defaultTimerDeps,
): void {
  const previous = timeoutByTask.get(taskId);
  if (previous !== undefined) clearTimerByTask.get(taskId)?.(previous);
  const timer = timerDeps.setTimer(() => {
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
  try {
    await deps.closeSession(owned.session);
  } catch (error) {
    closeError = error;
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
  if (!deps.isExpectedDaemon(pid, owned.session)) return;

  deps.signalProcessGroup(pid, "SIGTERM");
  await deps.wait(TERM_GRACE_MS);
  if (!deps.isExpectedDaemon(pid, owned.session)) return;

  deps.signalProcessGroup(pid, "SIGKILL");
  await deps.wait(KILL_GRACE_MS);
  if (deps.isExpectedDaemon(pid, owned.session)) {
    throw new Error(`Libretto session ${owned.session} daemon ${pid} remained after SIGKILL`);
  }
}

export async function finalizeOwnedAutomationSession(
  taskId: string,
  deps: FinalizeSessionDeps = defaultFinalizeDeps,
): Promise<void> {
  const owned = ownedByTask.get(taskId);
  if (!owned) return;
  disarmAutomationSessionTimeout(taskId);

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
    if (ownedByTask.get(taskId)?.session === owned.session) ownedByTask.delete(taskId);
  }
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

export async function closeLibrettoSession(session: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const command = resolveLibrettoCommand(
      ["close", "--session", session],
      automationConfigEnv(),
    );
    const child = spawn(command.command, command.args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: command.env,
    });
    let errorText = "";
    child.stderr.on("data", (chunk: Buffer) => {
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
}
