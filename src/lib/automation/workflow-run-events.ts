import type { AutomationPersistencePort } from "./server/store.ts";
import type { WorkflowEventPort } from "./workflow-executor.ts";

export const WORKFLOW_RUN_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const WORKFLOW_RUN_EVENT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export function createOperationalWorkflowEventPort(
  persistence: Pick<AutomationPersistencePort, "appendRunEvent">,
): WorkflowEventPort {
  return { append: (event) => persistence.appendRunEvent(event) };
}

export function startWorkflowRunEventCleanup(
  persistence: Pick<AutomationPersistencePort, "pruneRunEvents">,
  options: Readonly<{
    now?: () => number;
    onError?: (error: unknown) => void;
  }> = {},
): () => void {
  const cleanup = () => {
    const cutoff = new Date((options.now?.() ?? Date.now()) - WORKFLOW_RUN_EVENT_RETENTION_MS);
    void persistence.pruneRunEvents(cutoff.toISOString())
      .catch((error) => options.onError?.(error));
  };
  cleanup();
  const timer = setInterval(cleanup, WORKFLOW_RUN_EVENT_CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
