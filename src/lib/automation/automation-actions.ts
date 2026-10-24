import type { AutomationRuntimeSnapshot, OctopusBeakApi } from "../desktop/api.ts";
import type {
  AutomationActionKind,
  AutomationActionToken,
  createAutomationRuntimeController,
} from "./runtime-controller.ts";
import type { AutomationTaskStatus } from "./types.ts";

export type AutomationActionPort = Pick<
  OctopusBeakApi["automation"],
  "run" | "runMany" | "cancel" | "forceTerminate" | "runtimeSnapshot" | "fatalRuntimeSnapshot"
>;

/** An action that began: its tasks are pending until `settled` or the runtime shows them. */
export type AutomationActionStart<T> = Readonly<{
  taskIds: readonly string[];
  settled: Promise<T>;
}>;

export type AutomationRunStarted = Readonly<{ runId: string | null; error: string | null }>;
export type AutomationRunsStarted = Readonly<{
  /** Per-task refusals; the batch still started the others. */
  errors: Readonly<Record<string, string>>;
  /** The whole batch failed to start. */
  error: string | null;
}>;
export type AutomationStopRequested = Readonly<{ error: string | null }>;

/** A run that has not appeared in the runtime by then is read from it directly. */
const PREPARING_TIMEOUT_MS = 5_000;

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start, cancel and force-terminate Automation tasks through the runtime
 * controller's pending actions. A task already pending is refused (null), a
 * failed request releases its task, and each response's runtime goes to
 * `onSnapshot`, which must pass it through the controller's revision gate.
 */
export function createAutomationActions(input: Readonly<{
  controller: ReturnType<typeof createAutomationRuntimeController>;
  api: AutomationActionPort;
  onSnapshot(snapshot: AutomationRuntimeSnapshot): void;
}>) {
  const { controller, api, onSnapshot } = input;
  const preparingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  function clearPreparing(taskId: string) {
    const timeout = preparingTimeouts.get(taskId);
    if (timeout) clearTimeout(timeout);
    preparingTimeouts.delete(taskId);
  }

  const unsubscribe = controller.subscribe(() => {
    const pending = controller.pendingTaskIds();
    for (const taskId of [...preparingTimeouts.keys()]) {
      if (!pending.has(taskId)) clearPreparing(taskId);
    }
  });

  function schedulePreparing(taskId: string) {
    clearPreparing(taskId);
    preparingTimeouts.set(taskId, setTimeout(() => {
      preparingTimeouts.delete(taskId);
      void api.runtimeSnapshot()
        .then(onSnapshot)
        .catch((error) => {
          console.error("automation-runtime-preparing-timeout", error);
          void api.fatalRuntimeSnapshot();
        });
    }, PREPARING_TIMEOUT_MS));
  }

  function release(token: AutomationActionToken) {
    controller.failAction(token);
    clearPreparing(token.taskId);
  }

  function begin(taskIds: readonly string[], kind: AutomationActionKind) {
    const tokens: AutomationActionToken[] = [];
    for (const taskId of taskIds) {
      const token = controller.beginAction(taskId, kind);
      if (!token) continue;
      tokens.push(token);
      if (kind === "run") schedulePreparing(taskId);
    }
    return tokens;
  }

  function run(taskId: string): AutomationActionStart<AutomationRunStarted> | null {
    const [token] = begin([taskId], "run");
    if (!token) return null;
    const settled = api.run(taskId).then((result) => {
      controller.bindRun(token, result.runId);
      if (result.runtime) onSnapshot(result.runtime);
      return { runId: result.runId ?? null, error: null };
    }, (error: unknown) => {
      release(token);
      return { runId: null, error: message(error) };
    });
    return { taskIds: [taskId], settled };
  }

  function runMany(taskIds: readonly string[]): AutomationActionStart<AutomationRunsStarted> | null {
    const tokens = begin(taskIds, "run");
    if (tokens.length === 0) return null;
    const settled = api.runMany(tokens.map((token) => token.taskId)).then((result) => {
      for (const token of tokens) {
        const started = result.results[token.taskId];
        if (started?.status === "error") release(token);
        else if (started?.runId) controller.bindRun(token, started.runId);
      }
      if (result.runtime) onSnapshot(result.runtime);
      return { errors: result.errors ?? {}, error: null };
    }, (error: unknown) => {
      for (const token of tokens) release(token);
      return { errors: {}, error: message(error) };
    });
    return { taskIds: tokens.map((token) => token.taskId), settled };
  }

  function stop(
    taskId: string,
    kind: Exclude<AutomationActionKind, "run">,
    request: () => Promise<unknown>,
  ): AutomationActionStart<AutomationStopRequested> | null {
    const [token] = begin([taskId], kind);
    if (!token) return null;
    const settled = request().then(
      () => ({ error: null }),
      (error: unknown) => {
        release(token);
        return { error: message(error) };
      },
    );
    return { taskIds: [taskId], settled };
  }

  return {
    run,
    runMany,
    /** A run waiting for a person cannot clean up on its own, so it is force-terminated. */
    cancel(task: Readonly<{ id: string; status: AutomationTaskStatus }>) {
      return stop(task.id, "cancel", () => task.status === "waiting_for_human"
        ? api.forceTerminate(task.id)
        : api.cancel(task.id));
    },
    forceTerminate(taskId: string) {
      return stop(taskId, "force-terminate", () => api.forceTerminate(taskId));
    },
    dispose() {
      unsubscribe();
      for (const taskId of [...preparingTimeouts.keys()]) clearPreparing(taskId);
    },
  };
}
