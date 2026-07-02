import type { AutomationTask } from "./server/tasks.ts";
import type { AutomationTaskRun, AutomationTaskStatus } from "./server/store.ts";

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
  primaryAction: "Run" | "Run again" | "Resume" | "Locked" | "Running";
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
