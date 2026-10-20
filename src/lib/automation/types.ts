import type { HumanAssistanceContract } from "./human-assistance.ts";
import type { WorkflowRunEvent } from "./workflow-executor.ts";
import type { TypedWorkflowOutcome } from "./server/typed-workflow-outcome.ts";
export type { TypedWorkflowOutcome } from "./server/typed-workflow-outcome.ts";

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
  /** The run event code the workflow records when this component is missing. */
  unavailableEventCode: string;
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

export const DEVICE_REGISTRATION_SOURCES = ["tdcc", "cathay"] as const;
export type DeviceRegistrationSource = typeof DEVICE_REGISTRATION_SOURCES[number];

export function deviceRegistrationSource(groupId: string | null | undefined): DeviceRegistrationSource | null {
  return (DEVICE_REGISTRATION_SOURCES as readonly (string | null | undefined)[]).includes(groupId)
    ? groupId as DeviceRegistrationSource
    : null;
}

export type DeviceRegistrationChannel = "email" | "sms";

export type DeviceRegistrationFailure =
  | "sign-in-details-missing"
  | "sign-in-rejected"
  | "code-rejected"
  | "code-expired"
  | "not-trusted"
  | "protocol-outdated"
  | "unavailable"
  | "expired"
  | "cancelled"
  | "not-found"
  | "sync-running";

export type DeviceRegistrationStep =
  | Readonly<{ status: "code-required"; registrationId: string; channel: DeviceRegistrationChannel }>
  | Readonly<{ status: "registered"; channels: readonly DeviceRegistrationChannel[] }>
  | Readonly<{ status: "failed"; reason: DeviceRegistrationFailure }>;

export type DeviceRegistrationStatus = Readonly<{ registered: boolean }>;

export type AutomationTaskSummary = {
  id: string;
  label: string;
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
  sessionTakeoverNotice?: AutomationLocalizedText;
  preview?: true;
  statementSelectionKey?: string;
  statementTypes?: readonly StatementTypeCapability[];
};

export type StatementTypeCapability = {
  id: string;
  /** An Attached Preview Product (ADR 0051): offered only while Preview features are on, never selected by default. */
  preview?: true;
};

export type AutomationTaskHistoryRow = {
  taskRunId: string;
  taskId: string;
  kind: AutomationTaskKind;
  status: AutomationTaskStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  appWorkflowOutcome: TypedWorkflowOutcome | null;
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
  /** Structured progress for the current run, kept renderer-local for labels. */
  workflowProgress?: AutomationTaskProgress | null;
  status: AutomationTaskStatus;
  attempt: number;
  maxAttempts: number;
  latestStartedAt: string | null;
  latestFinishedAt: string | null;
  appWorkflowOutcome: TypedWorkflowOutcome | null;
  events: readonly WorkflowRunEvent[];
  progressPercent: number | null;
  progressText: string;
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
};
