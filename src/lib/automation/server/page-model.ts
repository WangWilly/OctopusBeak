import type { AutomationTask } from "./tasks.ts";
import type { AutomationTaskRun, AutomationTaskStatus } from "./store.ts";

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
  primaryAction: "Run" | "Resume" | "Retry" | "Locked";
  canRun: boolean;
};

export type AutomationPageModel = {
  businessDate: string;
  active: boolean;
  credentials: Record<string, boolean>;
  importGate: ImportGate;
  tasks: AutomationTaskRow[];
};

function rowStatus(task: AutomationTask, run: AutomationTaskRun | undefined, gate: ImportGate) {
  if (task.kind === "import" && gate.locked) return "locked";
  return run?.status ?? "queued";
}

function primaryAction(status: AutomationTaskStatus) {
  if (status === "locked") return "Locked";
  if (status === "failed") return "Retry";
  if (status === "waiting_for_human") return "Resume";
  return "Run";
}

export function buildAutomationPageModel(input: {
  tasks: readonly AutomationTask[];
  latestRuns: Record<string, AutomationTaskRun>;
  credentials: Record<string, boolean>;
  importGate: ImportGate;
  active: boolean;
  businessDate: string;
}): AutomationPageModel {
  return {
    businessDate: input.businessDate,
    active: input.active,
    credentials: input.credentials,
    importGate: input.importGate,
    tasks: input.tasks.map((task) => {
      const run = input.latestRuns[task.id];
      const status = rowStatus(task, run, input.importGate);
      const action = primaryAction(status);
      return {
        ...task,
        status,
        attempt: run?.attempt ?? 0,
        latestStartedAt: run?.startedAt ?? null,
        latestFinishedAt: run?.finishedAt ?? null,
        logTail: run?.logTail ?? "",
        errorMessage: run?.errorMessage ?? null,
        logPath: run?.logPath ?? null,
        primaryAction: action,
        canRun: !input.active && action !== "Locked",
      };
    }),
  };
}
