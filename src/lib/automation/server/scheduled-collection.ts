import type { NotificationTarget } from "../../desktop/api.ts";
import type { AutomationPageModel } from "../types.ts";
import { userActionForFailure, userActionMessage, type UserAction } from "../workflow-failures.ts";
import type { AutomationRuntime } from "./automation-runtime.ts";
import type { AutomationTaskRun } from "./store.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, taskById } from "./tasks.ts";

export type ScheduledCollectionNotification = {
  title: string;
  body: string;
  target: NotificationTarget;
};

/** One source of a Scheduled Collection occurrence; `null` when it never produced a finished run. */
export type ScheduledCollectionResult = {
  taskId: string;
  run: AutomationTaskRun | null;
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

/**
 * Starts the occurrence's due sources and reports them together once every
 * started source has ended. A source already running from a manual sync is not
 * part of the occurrence; one that could not start counts as not synced.
 */
export async function startScheduledCollection(
  runtime: AutomationRuntime,
  occurrenceUtc: string,
  onCollectionFinished: (results: ScheduledCollectionResult[]) => void,
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
  const settled = new Map<string, AutomationTaskRun | null>();
  let included: string[] | null = null;
  const reportWhenComplete = () => {
    if (!included || included.some((taskId) => !settled.has(taskId))) return;
    const results = included.map((taskId) => ({ taskId, run: settled.get(taskId) ?? null }));
    included = null;
    if (results.length) onCollectionFinished(results);
  };
  const started = await runtime.runMany(due, {
    scheduledAtUtc: occurrenceUtc,
    onSettled: (taskId, run) => {
      settled.set(taskId, run);
      reportWhenComplete();
    },
  });
  included = due.filter((taskId) => started.results[taskId]?.status !== "already_running");
  for (const taskId of included) {
    if (started.results[taskId]?.status !== "started") settled.set(taskId, null);
  }
  reportWhenComplete();
  return started;
}

const MAX_NAMED_SOURCES = 3;

function sourceName(taskId: string, zh: boolean) {
  const group = AUTOMATION_CREDENTIAL_GROUPS.find(
    (candidate) => candidate.id === taskById(taskId)?.credentialGroupId,
  );
  if (!group) return taskId;
  return zh ? group.displayName["zh-TW"] : group.displayName.en;
}

function sourceList(taskIds: readonly string[], zh: boolean) {
  const names = taskIds.slice(0, MAX_NAMED_SOURCES).map((taskId) => sourceName(taskId, zh));
  const more = taskIds.length - names.length;
  if (zh) return names.join("、") + (more ? ` 等 ${taskIds.length} 個來源` : "");
  return names.join(", ") + (more ? ` and ${more} more` : "");
}

const noun = (count: number) => (count === 1 ? "source" : "sources");
const sources = (count: number) => `${count} ${noun(count)}`;

/**
 * The one notification a finished Scheduled Collection occurrence sends:
 * every source synced, some did not, or some need the person.
 */
export function scheduledCollectionNotification(
  results: readonly ScheduledCollectionResult[],
  locale: string,
): ScheduledCollectionNotification | null {
  if (!results.length) return null;
  const zh = locale === "zh-TW";
  const synced = results.filter(({ run }) => run?.status === "completed");
  const needsPerson: { taskId: string; action: UserAction }[] = [];
  const notSynced: string[] = [];
  for (const { taskId, run } of results) {
    if (run?.status === "completed") continue;
    const action = userActionForFailure(run?.appWorkflowOutcome?.errorCode);
    if (action) needsPerson.push({ taskId, action });
    else notSynced.push(taskId);
  }

  if (needsPerson.length) {
    const only = needsPerson.length === 1 ? needsPerson[0]! : null;
    const lead = only
      ? `${sourceName(only.taskId, zh)}${zh ? "：" : ": "}${userActionMessage(only.action, locale)}`
      : zh
        ? `${sourceList(needsPerson.map(({ taskId }) => taskId), zh)}需要你處理。`
        : `${sourceList(needsPerson.map(({ taskId }) => taskId), zh)} need your attention.`;
    const rest = !notSynced.length
      ? ""
      : zh
        ? `另有 ${notSynced.length} 個來源沒有同步成功。`
        : ` ${notSynced.length} more ${noun(notSynced.length)} did not sync.`;
    const target: NotificationTarget = !only
      ? { route: "automation", credentialGroupId: null }
      : only.action === "delete-financial-data"
        ? { route: "settings" }
        : { route: "automation", credentialGroupId: taskById(only.taskId)?.credentialGroupId ?? null };
    return { title: zh ? "自動同步需要你處理" : "Automatic sync needs you", body: lead + rest, target };
  }

  if (notSynced.length) {
    const names = sourceList(notSynced, zh);
    return {
      title: zh
        ? `自動同步完成，${notSynced.length} 個來源沒有同步成功`
        : `Automatic sync finished; ${sources(notSynced.length)} did not sync`,
      body: zh
        ? `${names}沒有同步成功，下次自動同步會再試。${synced.length ? `其他 ${synced.length} 個來源已同步。` : ""}`
        : `${names} did not sync. The next automatic sync tries again.${synced.length ? ` ${synced.length} other ${noun(synced.length)} synced.` : ""}`,
      target: { route: "automation", credentialGroupId: null },
    };
  }

  return {
    title: zh ? "自動同步完成" : "Automatic sync finished",
    body: zh ? `已同步 ${synced.length} 個來源。` : `Synced ${sources(synced.length)}.`,
    target: { route: "overview" },
  };
}
