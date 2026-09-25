import type { HumanAssistanceContract } from "./human-assistance.ts";
import type { WorkflowRunEvent } from "./workflow-executor.ts";

/**
 * A task owns the complete source operation. A crawler or sync task is only
 * successful after its workflow has collected and committed canonical data.
 */
export type AutomationTaskKind = "crawler" | "sync";

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
  | "preparing"
  | "running"
  | "waiting_for_human"
  | "retrying"
  | "cancelling"
  | "completed"
  | "partial"
  | "cancelled"
  | "interrupted"
  | "failed"
  | "locked"
  | "needs_setup";

/**
 * Renderer-neutral progress emitted by an automation lifecycle.  Display
 * strings stay in the renderer so a run record never becomes locale-specific.
 */
export type AutomationTaskProgress = {
  phaseCode: string | null;
  completed: number | null;
  total: number | null;
  percent: number | null;
  attempt: number;
  params?: Readonly<Record<string, string | number | boolean>>;
};

/**
 * Renderer-safe state for Cathay's optional Gmail Email OTP integration.
 * Tokens, message content, and OAuth implementation details stay in the
 * Electron main process.
 */
export type CathayGmailOtpStatus = {
  enabled: boolean;
  connectedEmail: string | null;
  needsAuthorization: boolean;
  connectionError?: CathayGmailOtpConnectionError;
};

export type CathayGmailOtpConnectionError =
  | "authorization-cancelled"
  | "authorization-failed"
  | "token-exchange-failed"
  | "gmail-profile-failed"
  | "credential-storage-failed";

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
  verificationActorKey?: string;
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
  /** The run whose live status/progress this row currently represents. */
  runId?: string | null;
  status: AutomationTaskStatus;
  attempt: number;
  maxAttempts: number;
  latestStartedAt: string | null;
  latestFinishedAt: string | null;
  logTail: string;
  errorMessage: string | null;
  logPath: string | null;
  /** Structured event detail is the primary view for typed workflow runs. */
  eventDisplayMode: "structured" | "legacy";
  events: readonly WorkflowRunEvent[];
  progressPercent: number | null;
  progressText: string;
  statementFailures: readonly { typeId: string; error?: string }[];
  humanSession: string | null;
  humanAssistanceContract: HumanAssistanceContract | null;
  forceTerminateAvailable?: boolean;
  isActive: boolean;
  ranToday: boolean;
  primaryAction: "Run" | "Run again" | "Locked" | "Cancel" | "Configure";
  canRun: boolean;
};

export type AutomationPageModel = {
  businessDate: string;
  active: boolean;
  activeTaskCount: number;
  parallelRunnableTaskIds: string[];
  credentials: Record<string, boolean>;
  credentialStates?: Record<string, "loading" | "ready" | "missing" | "read_failed">;
  externalPrerequisiteNotices: AutomationTaskPrerequisiteNotice[];
  tasks: AutomationTaskRow[];
  /** Optional for compatibility with non-desktop model consumers. */
  cathayGmailOtp?: CathayGmailOtpStatus;
};
