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
) {
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

function primaryAction(status: AutomationTaskStatus) {
  if (status === "locked") return "Locked";
  if (status === "running") return "Running";
  if (status === "failed") return "Run again";
  if (status === "waiting_for_human") return "Resume";
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
  credentials: Record<string, boolean>;
  importGate: AutomationPageModel["importGate"];
  active: boolean;
  businessDate: string;
}): AutomationPageModel {
  const activeTaskIds = new Set(input.activeTaskIds ?? []);
  return {
    businessDate: input.businessDate,
    active: input.active || activeTaskIds.size > 0,
    activeTaskCount: activeTaskIds.size,
    credentials: input.credentials,
    importGate: input.importGate,
    tasks: input.tasks.map((task) => {
      const run = input.latestRuns[task.id];
      const isActive = activeTaskIds.has(task.id);
      const status = rowStatus(task, run, input.importGate, isActive);
      const action = primaryAction(status);
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
        primaryAction: action,
        canRun: !isActive && action !== "Locked",
      } satisfies AutomationTaskRow;
    }),
  };
}
