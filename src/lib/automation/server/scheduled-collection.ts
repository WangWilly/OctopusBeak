import type { AutomationPageModel } from "../types.ts";
import { userActionForFailure, userActionMessage } from "../workflow-failures.ts";
import { automationRunMany, loadAutomationDesktopModel } from "./desktop-api.ts";
import type { AutomationPersistenceProvider, AutomationTaskRun } from "./store.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, taskById } from "./tasks.ts";

export type ScheduledRunNotification = {
  credentialGroupId: string;
  title: string;
  body: string;
};

const isSourceTask = (taskId: string) => Boolean(taskById(taskId)?.credentialGroupId);

export function scheduledCollectionTaskIds(model: Pick<AutomationPageModel, "parallelRunnableTaskIds">) {
  return model.parallelRunnableTaskIds.filter(isSourceTask);
}

export async function startScheduledCollection(
  provider: AutomationPersistenceProvider,
  occurrenceUtc: string,
  onFinished: (run: AutomationTaskRun) => void,
) {
  const model = await loadAutomationDesktopModel(provider);
  const due: string[] = [];
  for (const taskId of scheduledCollectionTaskIds(model.automation)) {
    const [attempted, succeeded] = await Promise.all([
      provider.automation.hasOccurrenceBeenAttempted(taskId, occurrenceUtc),
      provider.automation.hasSuccessfulTaskRunSince(taskId, occurrenceUtc),
    ]);
    if (!attempted && !succeeded) due.push(taskId);
  }
  return automationRunMany(due, provider, { scheduledAtUtc: occurrenceUtc, onFinished });
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
    title: locale === "zh-TW" ? group.displayName["zh-TW"] : group.displayName.en,
    body: userActionMessage(action, locale),
  };
}
