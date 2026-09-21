import type { AutomationRuntimeSnapshot } from "../desktop/api.ts";
import { isActiveAutomationRuntimeStatus } from "./runtime-status.ts";

export type AutomationRuntimeInvariantDetails = {
  code: "automation-unknown-active-task";
  sessionId: string;
  revision: number;
  taskId: string;
  runId: string | null;
};

export class AutomationRuntimeInvariantError extends Error {
  readonly details: AutomationRuntimeInvariantDetails;

  constructor(details: AutomationRuntimeInvariantDetails) {
    super(details.code);
    this.name = "AutomationRuntimeInvariantError";
    this.details = details;
  }
}

/** Validate only active runtime rows; terminal history is intentionally out of scope. */
export function assertKnownAutomationRuntimeTasks(
  runtime: AutomationRuntimeSnapshot,
  knownTaskIds: ReadonlySet<string>,
) {
  const unknown = runtime.tasks.find((task) =>
    isActiveAutomationRuntimeStatus(task.status) && !knownTaskIds.has(task.taskId),
  );
  if (!unknown) return runtime;
  throw new AutomationRuntimeInvariantError({
    code: "automation-unknown-active-task",
    sessionId: runtime.sessionId,
    revision: runtime.revision,
    taskId: unknown.taskId,
    runId: unknown.runId,
  });
}

