import { get, writable, type Readable } from "svelte/store";
import type { OnboardingWorkflowToken } from "../onboarding/controller.ts";
import type { AutomationPageState } from "./automation-page-state.ts";
import type { AutomationTaskRow } from "./types.ts";

/** What the run flows read of a task row. */
export type RunTask = Pick<AutomationTaskRow, "id" | "isActive" | "canRun" | "credentialGroupId" | "status">;

/** The page state's intents the dashboard's run flows use. */
export type RunActionsState = Pick<
  AutomationPageState,
  "subscribe" | "run" | "runMany" | "cancel" | "cancelAll" | "forceTerminate" | "reload"
>;

/** The onboarding hand-offs around a workflow start; the onboarding page wires them (ADR 0037). */
export type RunActionsOnboarding = Readonly<{
  starting(taskId: string, credentialGroupId: string | null): OnboardingWorkflowToken | null;
  started(token: OnboardingWorkflowToken | null, run: Readonly<{ taskId: string; runId: string | null }>): void;
  startFailed(token: OnboardingWorkflowToken | null, message: string): void;
}>;

/** The words the person sees, in the page's language. */
export type RunActionsMessages<Task extends RunTask> = Readonly<{
  registrationBlocksSync(): string;
  taskLabel(task: Task): string;
}>;

export type RunActions<Task extends RunTask> = Readonly<{
  /** The last action's failure for the person, or "" while there is none. */
  actionError: Readable<string>;
  setError(message: string): void;
  runTask(task: Task): Promise<void>;
  runAll(tasks: readonly Task[]): Promise<void>;
  /** Stop every given task; the caller has already asked the person. */
  stopAll(tasks: readonly Task[]): Promise<void>;
  cancel(task: Task): Promise<void>;
  forceTerminate(task: Task): Promise<void>;
}>;

/** The host refuses a start while a device registration holds the source's sign-in. */
const REGISTRATION_IN_PROGRESS = "Device registration is in progress";

/**
 * The Automation dashboard's run flows: whether a task may start, the
 * onboarding hand-offs around a start, the failure the person reads, and the
 * reload once an action settles. The dashboard asks for confirmation and shows
 * `actionError`; the page state performs each action.
 */
export function createRunActions<Task extends RunTask>(input: Readonly<{
  state: RunActionsState;
  onboarding: RunActionsOnboarding;
  /** True while a device registration blocks this task's source. */
  registering(task: Task): boolean;
  messages: RunActionsMessages<Task>;
}>): RunActions<Task> {
  const { state, onboarding, messages } = input;
  const actionError = writable("");

  const startFailure = (message: string) =>
    message.includes(REGISTRATION_IN_PROGRESS) ? messages.registrationBlocksSync() : message;

  async function settleStop(settled: Promise<Readonly<{ error: string | null }>>) {
    actionError.set("");
    const { error } = await settled;
    if (error !== null) actionError.set(error);
    else await state.reload();
  }

  return Object.freeze({
    actionError: { subscribe: actionError.subscribe },
    setError: (message: string) => actionError.set(message),

    async runTask(task: Task) {
      if (get(state).pendingTaskIds.has(task.id) || task.isActive || !task.canRun) return;
      if (input.registering(task)) {
        actionError.set(messages.registrationBlocksSync());
        return;
      }
      const start = state.run(task.id);
      if (!start) return;
      const token = onboarding.starting(task.id, task.credentialGroupId ?? null);
      actionError.set("");
      const result = await start.settled;
      if (result.error !== null) {
        onboarding.startFailed(token, result.error);
        actionError.set(startFailure(result.error));
        return;
      }
      onboarding.started(token, { taskId: task.id, runId: result.runId });
      await state.reload();
    },

    async runAll(tasks: readonly Task[]) {
      if (!tasks.length) return;
      const start = state.runMany(tasks.map((task) => task.id));
      if (!start) return;
      actionError.set("");
      const result = await start.settled;
      if (result.error !== null) {
        actionError.set(result.error);
        return;
      }
      actionError.set(Object.entries(result.errors)
        .map(([taskId, message]) => `${messages.taskLabel(tasks.find((task) => task.id === taskId) ?? tasks[0]!)}: ${startFailure(message)}`)
        .join("\n"));
      await state.reload();
    },

    async stopAll(tasks: readonly Task[]) {
      if (!tasks.length) return;
      const results = await Promise.all(state.cancelAll(tasks).map((stop) => stop.settled));
      actionError.set(results.flatMap((result) => result.error === null ? [] : [result.error]).join("\n"));
      await state.reload();
    },

    async cancel(task: Task) {
      const stop = state.cancel(task);
      if (stop) await settleStop(stop.settled);
    },

    async forceTerminate(task: Task) {
      const stop = state.forceTerminate(task.id);
      if (stop) await settleStop(stop.settled);
    },
  });
}
