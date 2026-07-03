export type AutomationTaskKind = "crawler" | "sync" | "import";

export type AutomationTaskStatus =
  | "queued"
  | "running"
  | "waiting_for_human"
  | "retrying"
  | "completed"
  | "failed"
  | "locked";

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
