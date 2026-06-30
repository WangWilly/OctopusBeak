import type { AutomationTask } from "./tasks.ts";
import type { AutomationTaskRun, AutomationTaskStatus } from "./store.ts";
import { parseAutomationProgress, resumeFailureMessage, resumeSessionFromLog } from "./runner.ts";

type ImportGate = {
  locked: boolean;
  missingTaskIds: readonly string[];
};

export type AutomationTaskRow = AutomationTask & {
  status: AutomationTaskStatus;
  attempt: number;
  latestStartedAt: string | null;
  latestFinishedAt: string | null;
  logTail: string;
  errorMessage: string | null;
  logPath: string | null;
  progressPercent: number | null;
  progressText: string;
  humanSession: string | null;
  isActive: boolean;
  primaryAction: "Run" | "Resume" | "Retry" | "Locked" | "Running" | "Retrying";
  canRun: boolean;
};

export type AutomationPageModel = {
  businessDate: string;
  active: boolean;
  activeTaskCount: number;
  credentials: Record<string, boolean>;
  importGate: ImportGate;
  tasks: AutomationTaskRow[];
};

function rowStatus(
  task: AutomationTask,
  run: AutomationTaskRun | undefined,
  gate: ImportGate,
  isActive: boolean,
) {
  if (task.kind === "import" && gate.locked) return "locked";
  if (run && resumeFailureMessage(run.logTail)) return "failed";
  if (isActive && !run) return "running";
  return run?.status ?? "queued";
}

function primaryAction(status: AutomationTaskStatus) {
  if (status === "locked") return "Locked";
  if (status === "running") return "Running";
  if (status === "retrying") return "Retrying";
  if (status === "failed") return "Retry";
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
  importGate: ImportGate;
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
      return {
        ...task,
        status,
        attempt,
        latestStartedAt: run?.startedAt ?? null,
        latestFinishedAt: run?.finishedAt ?? null,
        logTail: run?.logTail ?? "",
        errorMessage: run?.errorMessage ?? null,
        logPath: run?.logPath ?? null,
        progressPercent,
        progressText: progressText(status, attempt, run?.maxAttempts ?? task.maxAttempts, progressPercent),
        humanSession: status === "waiting_for_human" ? resumeSessionFromLog(run?.logTail ?? "") : null,
        isActive,
        primaryAction: action,
        canRun: !isActive && action !== "Locked",
      };
    }),
  };
}
