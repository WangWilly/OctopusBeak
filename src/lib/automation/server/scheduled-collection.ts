import type { AutomationPageModel } from "../types.ts";
import type { AutomationRuntime } from "./automation-runtime.ts";
import { isSourceTask, runAndSummarize, type CollectionResult } from "./collection-summary.ts";

/**
 * Sync all's selection, which leaves out a source that waits for a Canonical
 * Reset: its refused run already notified once, and every later run would be
 * refused the same way until the reset.
 */
export function scheduledCollectionTaskIds(model: Pick<AutomationPageModel, "parallelRunnableTaskIds">) {
  return model.parallelRunnableTaskIds.filter(isSourceTask);
}

/** Starts the occurrence's due sources and reports them together once they have all ended. */
export async function startScheduledCollection(
  runtime: AutomationRuntime,
  occurrenceUtc: string,
  onCollectionFinished: (results: CollectionResult[]) => void,
) {
  const { provider } = runtime;
  const model = await runtime.desktopModel();
  const due: string[] = [];
  for (const taskId of scheduledCollectionTaskIds(model.automation)) {
    const [attempted, succeeded] = await Promise.all([
      provider.automation.hasOccurrenceBeenAttempted(taskId, occurrenceUtc),
      provider.automation.hasSuccessfulTaskRunSince(taskId, occurrenceUtc),
    ]);
    if (!attempted && !succeeded) due.push(taskId);
  }
  return runAndSummarize(runtime, due, { scheduledAtUtc: occurrenceUtc }, onCollectionFinished);
}
