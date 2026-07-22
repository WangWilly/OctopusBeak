export type AutomationTaskKind = "crawler" | "sync" | "import";

export type AutomationTaskStatus =
  | "queued"
  | "running"
  | "waiting_for_human"
  | "retrying"
  | "completed"
  | "failed"
  | "locked"
  | "needs_setup";

export type AutomationTaskSummary = {
  id: string;
  label: string;
  script: string;
  kind: AutomationTaskKind;
  credentialGroupId?: string;
  credentialKeys: readonly string[];
  dependencies: readonly string[];
};

export type AutomationCredentialGroup = {
  id: string;
  label: string;
  enabledKey: string;
  credentialKeys: readonly string[];
  statementSelectionKey?: string;
  statementTypes?: readonly StatementTypeCapability[];
};

export type StatementTypeCapability = { id: string };

export type AutomationTaskHistoryRow = {
  taskRunId: string;
  taskId: string;
  script: string;
  kind: AutomationTaskKind;
  status: AutomationTaskStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  errorMessage: string | null;
  logPath: string;
};

type ImportGate = {
  locked: boolean;
  missingTaskIds: readonly string[];
};

export type AutomationTaskRow = AutomationTaskSummary & {
  status: AutomationTaskStatus;
  attempt: number;
  maxAttempts: number;
  latestStartedAt: string | null;
  latestFinishedAt: string | null;
  logTail: string;
  errorMessage: string | null;
  logPath: string | null;
  progressPercent: number | null;
  progressText: string;
  humanSession: string | null;
  isActive: boolean;
  ranToday: boolean;
  primaryAction: "Run" | "Run again" | "Resume" | "Locked" | "Cancel" | "Configure";
  canRun: boolean;
};

export type AutomationPageModel = {
  businessDate: string;
  active: boolean;
  activeTaskCount: number;
  parallelRunnableTaskIds: string[];
  credentials: Record<string, boolean>;
  importGate: ImportGate;
  tasks: AutomationTaskRow[];
};
