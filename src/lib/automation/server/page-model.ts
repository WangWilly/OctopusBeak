import type { AutomationTask } from "./tasks.ts";
import type { AutomationTaskRun } from "./store.ts";
import type { AutomationTaskStatus } from "../types.ts";
import type { AutomationPageModel, AutomationTaskRow } from "../types.ts";
import { parseAutomationProgress, resumeFailureMessage, resumeSessionFromLog } from "./runner.ts";

function rowStatus(
  task: AutomationTask,
  run: AutomationTaskRun | undefined,
  gate: AutomationPageModel["importGate"],
  isActive: boolean,
  setupRequiredGroupIds: ReadonlySet<string>,
) {
  if (task.credentialGroupId && setupRequiredGroupIds.has(task.credentialGroupId)) return "needs_setup";
  if (task.kind === "import" && gate.locked) return "locked";
  if (run && resumeFailureMessage(run.logTail)) return "failed";
  if (isActive && !run) return "running";
  if (
    run &&
    !isActive &&
    (run.status === "running" || run.status === "retrying")
  ) {
    return "failed";
  }
  return run?.status ?? "queued";
}

function primaryAction(status: AutomationTaskStatus, isActive: boolean) {
  if (isActive) return "Cancel";
  if (status === "needs_setup") return "Configure";
  if (status === "locked") return "Locked";
  if (status === "failed") return "Run again";
  if (status === "waiting_for_human") return "Cancel";
  return "Run";
}

function progressText(status: AutomationTaskStatus, attempt: number, maxAttempts: number, progress: number | null) {
  if (progress !== null) return `${progress}%`;
  if (status === "running") return `Running attempt ${attempt}/${maxAttempts}`;
  if (status === "retrying") return `Retrying attempt ${attempt}/${maxAttempts}`;
  if (status === "waiting_for_human") return "Waiting for human";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "locked") return "Locked";
  return "Queued";
}

export function buildAutomationPageModel(input: {
  tasks: readonly AutomationTask[];
  latestRuns: Record<string, AutomationTaskRun>;
  activeTaskIds?: readonly string[];
  todayRunTaskIds?: readonly string[];
  credentials: Record<string, boolean>;
  importGate: AutomationPageModel["importGate"];
  setupRequiredGroupIds?: ReadonlySet<string>;
  active: boolean;
  businessDate: string;
}): AutomationPageModel {
  const activeTaskIds = new Set(input.activeTaskIds ?? []);
  const todayRunTaskIds = new Set(input.todayRunTaskIds ?? []);
  const setupRequiredGroupIds = input.setupRequiredGroupIds ?? new Set<string>();
  const tasks = input.tasks.map((task) => {
    const run = input.latestRuns[task.id];
    const isActive = activeTaskIds.has(task.id);
    const status = rowStatus(task, run, input.importGate, isActive, setupRequiredGroupIds);
    const action = primaryAction(status, isActive);
    const progressPercent = parseAutomationProgress(run?.logTail ?? "");
    const attempt = run?.attempt ?? 0;
    const maxAttempts = run?.maxAttempts ?? task.maxAttempts;
    return {
      id: task.id,
      label: task.label,
      script: task.script,
      kind: task.kind,
      credentialGroupId: task.credentialGroupId,
      credentialKeys: task.credentialKeys,
      dependencies: task.dependencies,
      status,
      attempt,
      maxAttempts,
      latestStartedAt: run?.startedAt ?? null,
      latestFinishedAt: run?.finishedAt ?? null,
      logTail: run?.logTail ?? "",
      errorMessage: run?.errorMessage ?? null,
      logPath: run?.logPath ?? null,
      progressPercent,
      progressText: progressText(status, attempt, maxAttempts, progressPercent),
      humanSession: status === "waiting_for_human" ? resumeSessionFromLog(run?.logTail ?? "") : null,
      isActive,
      ranToday: todayRunTaskIds.has(task.id),
      primaryAction: action,
      canRun: action === "Cancel" || (!isActive && action !== "Locked"),
    } satisfies AutomationTaskRow;
  });
  return {
    businessDate: input.businessDate,
    active: input.active || activeTaskIds.size > 0,
    activeTaskCount: activeTaskIds.size,
    parallelRunnableTaskIds: tasks
      .filter((task) =>
        task.canRun
        && task.primaryAction !== "Cancel"
        && task.primaryAction !== "Configure"
        && !task.isActive
        && task.credentialKeys.every((key) => input.credentials[key])
      )
      .map((task) => task.id),
    credentials: input.credentials,
    importGate: input.importGate,
    tasks,
  };
}
