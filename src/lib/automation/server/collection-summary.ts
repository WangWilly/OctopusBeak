import type { AutomationRunManyResult, NotificationTarget } from "../../desktop/api.ts";
import { userActionForFailure, userActionMessage, type UserAction } from "../workflow-failures.ts";
import type { AutomationRuntime } from "./automation-runtime.ts";
import type { StartAutomationTaskOptions } from "./runner.ts";
import type { AutomationTaskRun } from "./store.ts";
import { AUTOMATION_CREDENTIAL_GROUPS, taskById } from "./tasks.ts";

/** What started a batch of source syncs: Scheduled Collection or the person. */
export type CollectionTrigger = "scheduled" | "manual";

export type CollectionNotification = {
  title: string;
  body: string;
  target: NotificationTarget;
};

/** One source of a sync batch; `null` when it never produced a finished run. */
export type CollectionResult = {
  taskId: string;
  run: AutomationTaskRun | null;
};

export const isSourceTask = (taskId: string) => Boolean(taskById(taskId)?.credentialGroupId);

/**
 * Starts the tasks and reports their sources together once every started one
 * has ended. A source that was already running belongs to the batch that
 * started it; one that could not start counts as not synced. Tasks without a
 * source, such as exchange rates, are never reported.
 */
export async function runAndSummarize(
  runtime: Pick<AutomationRuntime, "runMany">,
  taskIds: readonly string[],
  runOptions: Omit<StartAutomationTaskOptions, "onSettled">,
  onFinished: (results: CollectionResult[]) => void,
): Promise<AutomationRunManyResult> {
  const settled = new Map<string, AutomationTaskRun | null>();
  let included: string[] | null = null;
  const reportWhenComplete = () => {
    if (!included || included.some((taskId) => !settled.has(taskId))) return;
    const results = included.map((taskId) => ({ taskId, run: settled.get(taskId) ?? null }));
    included = null;
    if (results.length) onFinished(results);
  };
  const started = await runtime.runMany([...taskIds], {
    ...runOptions,
    onSettled: (taskId, run) => {
      settled.set(taskId, run);
      reportWhenComplete();
    },
  });
  included = [...new Set(taskIds)].filter((taskId) =>
    isSourceTask(taskId) && started.results[taskId] && started.results[taskId]!.status !== "already_running");
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
 * The one notification a finished sync batch sends: every source synced, some
 * did not, or some need the person.
 */
export function collectionNotification(
  results: readonly CollectionResult[],
  trigger: CollectionTrigger,
  locale: string,
): CollectionNotification | null {
  if (!results.length) return null;
  const zh = locale === "zh-TW";
  const scheduled = trigger === "scheduled";
  const label = zh ? (scheduled ? "自動同步" : "同步") : (scheduled ? "Automatic sync" : "Sync");
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
    return { title: zh ? `${label}需要你處理` : `${label} needs you`, body: lead + rest, target };
  }

  if (notSynced.length) {
    const names = sourceList(notSynced, zh);
    return {
      title: zh
        ? `${label}完成，${notSynced.length} 個來源沒有同步成功`
        : `${label} finished; ${sources(notSynced.length)} did not sync`,
      body: zh
        ? `${names}沒有同步成功，${scheduled ? "下次自動同步會再試" : "原因可到執行紀錄查看"}。${synced.length ? `其他 ${synced.length} 個來源已同步。` : ""}`
        : `${names} did not sync. ${scheduled ? "The next automatic sync tries again." : "Run history shows why."}${synced.length ? ` ${synced.length} other ${noun(synced.length)} synced.` : ""}`,
      target: { route: "automation", credentialGroupId: null },
    };
  }

  return {
    title: zh ? `${label}完成` : `${label} finished`,
    body: zh ? `已同步 ${synced.length} 個來源。` : `Synced ${sources(synced.length)}.`,
    target: { route: "overview" },
  };
}
