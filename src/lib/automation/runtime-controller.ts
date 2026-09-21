import type { AutomationRuntimeSnapshot } from "../desktop/api.ts";

export type AutomationActionKind = "run" | "resume" | "cancel" | "force-terminate";

export type AutomationActionToken = {
  token: string;
  taskId: string;
  kind: AutomationActionKind;
  runId: string | null;
  startedAt: number;
};

export type AutomationRuntimeAcceptResult = {
  accepted: boolean;
  sessionChanged: boolean;
  hadGap: boolean;
  snapshot: AutomationRuntimeSnapshot;
};

function tokenId() {
  return `automation-action-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * App-shell-owned runtime coordination. It survives route unmounts and is
 * deliberately independent of Svelte so all automation entry points can use
 * the same revision gate and pending-action semantics.
 */
export function createAutomationRuntimeController() {
  let current: AutomationRuntimeSnapshot | null = null;
  const pending = new Map<string, AutomationActionToken>();

  function acceptSnapshot(snapshot: AutomationRuntimeSnapshot): AutomationRuntimeAcceptResult {
    const previous = current;
    const sessionChanged = Boolean(previous && previous.sessionId !== snapshot.sessionId);
    const hadGap = Boolean(
      previous
      && previous.sessionId === snapshot.sessionId
      && snapshot.revision > previous.revision + 1,
    );
    if (
      previous
      && previous.sessionId === snapshot.sessionId
      && snapshot.revision <= previous.revision
    ) {
      return { accepted: false, sessionChanged: false, hadGap: false, snapshot: previous };
    }
    current = snapshot;
    reconcilePending(snapshot);
    return { accepted: true, sessionChanged, hadGap, snapshot };
  }

  function beginAction(taskId: string, kind: AutomationActionKind): AutomationActionToken | null {
    if (pending.has(taskId)) return null;
    const token: AutomationActionToken = {
      token: tokenId(),
      taskId,
      kind,
      runId: null,
      startedAt: performance.now(),
    };
    pending.set(taskId, token);
    return token;
  }

  function bindRun(token: AutomationActionToken, runId: string | null | undefined) {
    const currentToken = pending.get(token.taskId);
    if (!currentToken || currentToken.token !== token.token) return false;
    currentToken.runId = runId ?? null;
    return true;
  }

  function failAction(token: AutomationActionToken) {
    const currentToken = pending.get(token.taskId);
    if (!currentToken || currentToken.token !== token.token) return false;
    pending.delete(token.taskId);
    return true;
  }

  function reconcilePending(snapshot: AutomationRuntimeSnapshot) {
    const byTaskId = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
    for (const [taskId, token] of pending) {
      const task = byTaskId.get(taskId);
      if (!task) continue;
      if (token.kind === "run" || token.kind === "resume") {
        if (task.runId && ["preparing", "running", "retrying", "waiting_for_human", "cancelling", "completed", "partial", "failed", "cancelled", "interrupted"].includes(task.status)) {
          pending.delete(taskId);
        }
      } else if (token.kind === "cancel" || token.kind === "force-terminate") {
        if (["cancelling", "completed", "partial", "failed", "cancelled", "interrupted"].includes(task.status)) {
          pending.delete(taskId);
        }
      }
    }
  }

  function pendingTaskIds() {
    return new Set(pending.keys());
  }

  function snapshot() {
    return current;
  }

  return {
    acceptSnapshot,
    beginAction,
    bindRun,
    failAction,
    pendingTaskIds,
    snapshot,
  };
}

export type AutomationBlockRefreshReason =
  | "overtaken"
  | "route-entry"
  | "manual"
  | "session-resync";

/** Single-flight refresh with one trailing request for a newer trigger. */
export function createAutomationBlockRefreshCoordinator<T>(
  load: () => Promise<T>,
) {
  let inFlight: Promise<T> | null = null;
  let trailing = false;

  function refresh(_reason: AutomationBlockRefreshReason): Promise<T> {
    if (inFlight) {
      trailing = true;
      return inFlight;
    }
    const work = load();
    inFlight = work.then(async (value) => {
      if (!trailing) return value;
      trailing = false;
      return load();
    }).finally(() => {
      inFlight = null;
      trailing = false;
    });
    return inFlight;
  }

  return {
    refresh,
    isRefreshing: () => inFlight !== null,
  };
}

