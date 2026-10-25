import type { AutomationPageModel } from "../types.ts";
import { userActionForFailure, userActionMessage, type UserAction } from "../workflow-failures.ts";
import type { AutomationRuntime } from "./automation-runtime.ts";
import type { AutomationTaskRun } from "./store.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, taskById } from "./tasks.ts";

export type ScheduledRunNotification = {
  credentialGroupId: string;
  action: UserAction;
  title: string;
  body: string;
};

const isSourceTask = (taskId: string) => Boolean(taskById(taskId)?.credentialGroupId);

/**
 * Sync all's selection, which leaves out a source that waits for a Canonical
 * Reset: its refused run already notified once, and every later run would be
 * refused the same way until the reset.
 */
export function scheduledCollectionTaskIds(model: Pick<AutomationPageModel, "parallelRunnableTaskIds">) {
  return model.parallelRunnableTaskIds.filter(isSourceTask);
}

export async function startScheduledCollection(
  runtime: AutomationRuntime,
  occurrenceUtc: string,
  onFinished: (run: AutomationTaskRun) => void,
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
  return runtime.runMany(due, { scheduledAtUtc: occurrenceUtc, onFinished });
}

export function scheduledRunNotification(
  run: AutomationTaskRun,
  locale: string,
): ScheduledRunNotification | null {
  if (!run.scheduledAtUtc) return null;
  const action = userActionForFailure(run.appWorkflowOutcome?.errorCode);
  const group = AUTOMATION_CREDENTIAL_GROUPS.find(
    (candidate) => candidate.id === taskById(run.taskId)?.credentialGroupId,
  );
  if (!action || !group) return null;
  return {
    credentialGroupId: group.id,
    action,
    title: locale === "zh-TW" ? group.displayName["zh-TW"] : group.displayName.en,
    body: userActionMessage(action, locale),
  };
}
