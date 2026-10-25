import type { HumanAssistanceContract } from "./human-assistance.ts";
import type { WorkflowRunEvent } from "./run-event.ts";
import type { TypedWorkflowOutcome } from "./server/typed-workflow-outcome.ts";
import type { TakeoverPrompt } from "./sign-in-prompt.ts";
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
  | "needs_setup"
  | "reset_required";

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
  /** The Supported source name, or the task's own name when it has no source. */
  displayName: AutomationLocalizedText;
  kind: AutomationTaskKind;
  credentialGroupId?: string;
  /** The integration namespaces the task writes accounts under. */
  integrationNamespaces: readonly string[];
  credentialKeys: readonly string[];
  dependencies: readonly string[];
  externalPrerequisites?: readonly AutomationExternalPrerequisite[];
};

/**
 * A sync that signs the person out of the provider elsewhere discloses it. The
 * prompt the Source sign-in step confirms exists only beside that disclosure.
 */
export type SessionTakeover = Readonly<{
  notice: AutomationLocalizedText;
  prompt?: TakeoverPrompt;
}>;

/** What every Supported source, verified or preview, declares about its sign-in. */
export type SupportedSource = Readonly<{
  id: string;
  displayName: AutomationLocalizedText;
  searchAliases: readonly string[];
  credentialFields: readonly AutomationCredentialField[];
  setupGuide: AutomationSetupGuide;
  sessionTakeover?: SessionTakeover;
}>;

export type AutomationCredentialGroup = {
  id: string;
  label: string;
  displayName: AutomationLocalizedText;
  searchAliases: readonly string[];
  enabledKey: string;
  credentialKeys: readonly string[];
  credentialFields: readonly AutomationCredentialField[];
  setupGuide: AutomationSetupGuide;
  /** The disclosure alone: the prompt may hold a predicate and never crosses IPC. */
  sessionTakeover?: Pick<SessionTakeover, "notice">;
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
  /** The latest run's own status, before a source that needs setup takes over the row. */
  latestRunStatus: AutomationTaskStatus;
  attempt: number;
  maxAttempts: number;
  latestStartedAt: string | null;
  latestFinishedAt: string | null;
  appWorkflowOutcome: TypedWorkflowOutcome | null;
  events: readonly WorkflowRunEvent[];
  progressPercent: number | null;
  humanSession: string | null;
  humanAssistanceContract: HumanAssistanceContract | null;
  forceTerminateAvailable?: boolean;
  isActive: boolean;
  ranToday: boolean;
  /** Every credential the task needs has been read and is present. */
  credentialsReady: boolean;
  /** The source needs Statement Selection setup before it can run. */
  setupRequired: boolean;
  /** The store refuses this source's captures until a Canonical Reset (ADR 0062). */
  canonicalResetRequired: boolean;
  primaryAction: "Run" | "Run again" | "Locked" | "Cancel" | "Configure" | "Delete financial data";
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
