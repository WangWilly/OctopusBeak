import type { HumanAssistanceContract } from "./human-assistance.ts";

export type AutomationTaskKind = "crawler" | "sync" | "import";

export type AutomationLocalizedText = {
  en: string;
  "zh-TW": string;
};

export type AutomationCredentialRedaction = "none" | "partial" | "full";

export type AutomationCredentialField = {
  key: string;
  label: AutomationLocalizedText;
  input: "text" | "password" | "certificate-file";
  redaction: AutomationCredentialRedaction;
};

export type AutomationSetupGuideLink = {
  id: string;
  label: AutomationLocalizedText;
  url: string;
  englishUrl?: string;
  allowedHosts: readonly string[];
};

export type AutomationSetupGuide = {
  summary: AutomationLocalizedText;
  requirements: readonly AutomationLocalizedText[];
  steps: readonly AutomationLocalizedText[];
  links: readonly AutomationSetupGuideLink[];
  extra?: {
    title: AutomationLocalizedText;
    steps: readonly AutomationLocalizedText[];
  };
};

export type AutomationExternalPrerequisite = {
  id: string;
  provider: string;
  component: string;
  downloadUrl: string;
  allowedHosts: readonly string[];
  instructions: {
    en: string;
    "zh-TW": string;
  };
};

export type AutomationTaskStatus =
  | "queued"
  | "running"
  | "waiting_for_human"
  | "retrying"
  | "completed"
  | "partial"
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
  externalPrerequisites?: readonly AutomationExternalPrerequisite[];
};

export type AutomationCredentialGroup = {
  id: string;
  label: string;
  displayName: AutomationLocalizedText;
  searchAliases: readonly string[];
  enabledKey: string;
  credentialKeys: readonly string[];
  credentialFields: readonly AutomationCredentialField[];
  setupGuide: AutomationSetupGuide;
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

type ImportWarning = { taskId: string; failedTypeIds: readonly string[] };

type ImportGate = {
  locked: boolean;
  missingTaskIds: readonly string[];
  warnings: readonly ImportWarning[];
};

export type AutomationTaskPrerequisiteNotice = {
  noticeId: string;
  taskId: string;
  prerequisiteId: string;
  latestTaskRunId: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  latestErrorMessage: string | null;
  resolvedAt: string | null;
  resolvedByTaskRunId: string | null;
  prerequisite: AutomationExternalPrerequisite;
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
  statementFailures: readonly { typeId: string; error?: string }[];
  humanSession: string | null;
  humanAssistanceContract: HumanAssistanceContract | null;
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
  externalPrerequisiteNotices: AutomationTaskPrerequisiteNotice[];
  tasks: AutomationTaskRow[];
};
