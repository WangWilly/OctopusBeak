import type { AutomationRuntimeSnapshot } from "../desktop/api.ts";
import {
  createAutomationActions,
  type AutomationActionPort,
  type AutomationActionStart,
  type AutomationStopRequested,
} from "./automation-actions.ts";
import {
  createAutomationRuntimeController,
  type AutomationActionToken,
  type AutomationRuntimeAcceptResult,
} from "./runtime-controller.ts";
import { mergeAutomationRuntime } from "./runtime-sync.ts";
import { isActiveAutomationRuntimeStatus } from "./task-row.ts";
import type { AutomationPageModel, AutomationTaskStatus } from "./types.ts";

/**
 * Why the state asks the shell to load the Automation blocks again: a timed
 * refresh while work is active, a missed or foreign runtime revision, or a
 * caller that just finished an action.
 */
export type AutomationReloadReason = "poll" | "session-resync" | "manual";

export type AutomationPageStateValue = Readonly<{
  runtime: AutomationRuntimeSnapshot | null;
  pendingActions: readonly AutomationActionToken[];
  pendingTaskIds: ReadonlySet<string>;
  /** The page model the shell last loaded, before the runtime is merged; null before the first load. */
  model: AutomationPageModel | null;
  /** The page model the shell last loaded, merged with the runtime and the pending actions; null before the first load. */
  live: AutomationPageModel | null;
  /** A task runs or an action waits for the runtime, so the blocks are refreshed on a timer. */
  active: boolean;
}>;

type StopTask = Readonly<{ id: string; status: AutomationTaskStatus }>;

/**
 * The renderer's one owner of Automation task state. It gates runtime
 * snapshots, holds pending actions, merges both over the loaded page model,
 * and refreshes the blocks while work is active. The shell keeps loading the
 * blocks; every view reads this state and acts through its intents.
 */
export function createAutomationPageState(input: Readonly<{
  api: AutomationActionPort;
  requestReload(reason: AutomationReloadReason): void | Promise<void>;
  pollIntervalMs?: number;
}>) {
  const pollIntervalMs = input.pollIntervalMs ?? 2_000;
  const controller = createAutomationRuntimeController();
  const subscribers = new Set<(value: AutomationPageStateValue) => void>();
  let model: AutomationPageModel | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let value = compute();

  function compute(): AutomationPageStateValue {
    const runtime = controller.snapshot();
    const pendingActions = controller.pendingActions();
    const live = model ? mergeAutomationRuntime(model, runtime, pendingActions) : null;
    const running = live
      ? live.active
      : runtime?.tasks.some((task) => isActiveAutomationRuntimeStatus(task.status)) ?? false;
    return {
      runtime,
      pendingActions,
      pendingTaskIds: new Set(pendingActions.map((action) => action.taskId)),
      model,
      live,
      active: running || pendingActions.length > 0,
    };
  }

  function publish() {
    value = compute();
    if (value.active && !pollTimer) pollTimer = setInterval(() => input.requestReload("poll"), pollIntervalMs);
    else if (!value.active && pollTimer) stopPolling();
    for (const subscriber of [...subscribers]) subscriber(value);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function acceptSnapshot(snapshot: AutomationRuntimeSnapshot): AutomationRuntimeAcceptResult {
    const result = controller.acceptSnapshot(snapshot);
    if (result.accepted && (result.hadGap || result.sessionChanged)) input.requestReload("session-resync");
    return result;
  }

  const unsubscribeController = controller.subscribe(publish);
  const actions = createAutomationActions({ controller, api: input.api, onSnapshot: acceptSnapshot });

  return {
    /** Svelte store contract: the current value now, then every change. */
    subscribe(run: (value: AutomationPageStateValue) => void) {
      subscribers.add(run);
      run(value);
      return () => {
        subscribers.delete(run);
      };
    },
    /** The page model the shell loaded (the list block, or the fallback before it settles). */
    setModel(next: AutomationPageModel | null) {
      if (next === model) return;
      model = next;
      publish();
    },
    acceptSnapshot,
    run: actions.run,
    runMany: actions.runMany,
    cancel: actions.cancel,
    forceTerminate: actions.forceTerminate,
    /** Stops every given task through the same pending rule as a single cancel; already pending tasks are skipped. */
    cancelAll(tasks: readonly StopTask[]): readonly AutomationActionStart<AutomationStopRequested>[] {
      return tasks.flatMap((task) => actions.cancel(task) ?? []);
    },
    async reload() {
      await input.requestReload("manual");
    },
    dispose() {
      stopPolling();
      actions.dispose();
      unsubscribeController();
      subscribers.clear();
    },
  };
}

export type AutomationPageState = ReturnType<typeof createAutomationPageState>;
