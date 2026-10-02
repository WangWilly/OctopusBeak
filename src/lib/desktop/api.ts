import type { SpendingPageReadResult } from "../spending/page-reader.ts";
import type { AssetsPageDto } from "$lib/assets/types.ts";
import type {
  AutomationCredentialGroup,
  AutomationPageModel,
  AutomationTaskHistoryRow,
  AutomationTaskProgress,
  TypedWorkflowOutcome,
  CathayGmailOtpStatus,
} from "$lib/automation/types.ts";
import type { LiabilitiesPageDto } from "$lib/liabilities/types.ts";
import type { OverviewPageDto } from "$lib/overview/types.ts";
import type {
  SpendingCandidateActionInput,
  SpendingConfirmActionInput,
  SpendingPairingCandidatesInput,
  SpendingPairingCandidatesResult,
  SpendingPairingPrewarmInput,
  SpendingPairingPrewarmResult,
  SpendingLinkActionInput,
  SpendingPageDto,
  SpendingPurchaseActionResult,
  SpendingCandidatePageDto,
  SpendingCandidatePageRequest,
  SpendingRecordPageDto,
  SpendingRecordPageRequest,
  SpendingPageActionRequest,
  SpendingPageActionResult,
} from "$lib/spending/model.ts";
import type {
  SpendingLoadInput,
} from "$lib/spending/contracts.ts";
import type { SystemSettingsDto } from "$lib/settings/system-settings.ts";
import type {
  HumanAssistanceContract,
  VerificationInteractionMode,
} from "$lib/automation/human-assistance.ts";
import type {
  DataReadOptions,
  DataInvalidationEvent,
  DataVersionSnapshot,
} from "$lib/shared-shell/data-version.ts";
import type { DashboardBlockKey } from "$lib/shared-shell/block-load-state.ts";
import type { DashboardBlockPayload } from "$lib/shared-shell/dashboard-blocks.ts";

export type CredentialGroupDto = AutomationCredentialGroup & {
  enabled: boolean;
  selectedStatementTypeIds: readonly string[];
  statementSetupRequired: boolean;
  storedCredentialFileNames: Readonly<Record<string, string>>;
  invalidCredentialFileKeys: readonly string[];
  invalidCredentialFileReasons?: Readonly<Record<string, CertificateFileValidationReason>>;
};

export type CertificateFileValidationReason = "invalid-extension" | "missing-or-unreadable";

export type AutomationCredentialStatus = "loading" | "ready" | "missing" | "read_failed";

export type AutomationRuntimeTaskStatus =
  | "queued"
  | "preparing"
  | "running"
  | "retrying"
  | "waiting_for_human"
  | "cancelling"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";

export type AutomationRuntimeTaskSnapshot = {
  taskId: string;
  runId: string | null;
  status: AutomationRuntimeTaskStatus;
  attempt: number;
  maxAttempts: number;
  progress: AutomationTaskProgress;
  appWorkflowOutcome: TypedWorkflowOutcome | null;
  cancellationRequestedAt?: string | null;
  forceTerminateAvailable?: boolean;
  updatedAt: string;
};

export type AutomationRuntimeSnapshot = {
  sessionId: string;
  revision: number;
  tasks: readonly AutomationRuntimeTaskSnapshot[];
};

/**
 * Version of the runtime snapshot captured while an automation block was
 * projected.  The block may be stale by the time it reaches the renderer;
 * keeping the exact capture here lets the renderer distinguish that case
 * without treating ordinary progress events as a reason to reload the block.
 */
export type AutomationRuntimeBlockVersion = {
  runtimeSessionId: string;
  runtimeRevision: number;
};

/**
 * Main-process-owned credential state safe to cross the worker boundary.
 * It contains no credential values, encrypted payloads, or certificate paths.
 */
export type AutomationCredentialStateDto = {
  revision: number;
  status: Readonly<Record<string, boolean>>;
  states?: Readonly<Record<string, AutomationCredentialStatus>>;
  fileNames: Readonly<Record<string, string>>;
  invalidFileKeys: readonly string[];
  invalidFileReasons: Readonly<Record<string, CertificateFileValidationReason>>;
  /** Main-process-derived, renderer-safe Gmail connection state only. */
  cathayGmailOtp?: CathayGmailOtpStatus;
};

export type AutomationCredentialGroupCoreDto = Omit<
  CredentialGroupDto,
  "storedCredentialFileNames" | "invalidCredentialFileKeys" | "invalidCredentialFileReasons"
>;

export type AutomationCoreSnapshot = AutomationRuntimeBlockVersion & {
  automation: AutomationPageModel;
  /** Group metadata only; credential-derived fields are empty until details. */
  credentialGroups: CredentialGroupDto[];
};

export type CertificateFileSelectionResult =
  | { cancelled: true }
  | { cancelled: false; path: string; filename: string }
  | { cancelled: false; error: CertificateFileValidationReason };

export type AutomationCredentialSaveResult =
  | { saved: true }
  | {
    saved: false;
    error: "invalid-certificate-file";
    credentialKey: string;
    reason: CertificateFileValidationReason;
  };

export type AutomationDesktopModel = {
  automation: AutomationPageModel;
  credentialGroups: CredentialGroupDto[];
  runtimeSessionId?: string;
  runtimeRevision?: number;
};

export type AutomationActionResult =
  | { started: string; runId?: string; runtime?: AutomationRuntimeSnapshot }
  | { resumed: string; runId?: string; runtime?: AutomationRuntimeSnapshot }
  | { cancelled: string }
  | { saved: true }
  | { ok: true }
  | { ok: true; closed: boolean };

export type AutomationRunManyTaskResult = {
  status: "started" | "already_running" | "error";
  runId?: string;
  error?: string;
};

export type AutomationRunManyResult = {
  started: string[];
  errors?: Readonly<Record<string, string>>;
  results: Readonly<Record<string, AutomationRunManyTaskResult>>;
  runtime?: AutomationRuntimeSnapshot;
};

export type ViewerInspectResult = {
  editable: boolean;
  rect: { x: number; y: number; width: number; height: number } | null;
  targetId?: string | null;
  contractVersion?: number;
  modes?: readonly VerificationInteractionMode[];
};

export type ViewerInputResult = {
  ok: true;
  contract: HumanAssistanceContract | null;
  resumed: boolean;
};

export type DataViewErrorCode =
  | "invalid-request"
  | "duplicate-subscription"
  | "subscription-failed"
  | "worker-unavailable"
  | "worker-disabled";

export type DataViewSubscribeRequest = {
  requestId: string;
  view: string;
  params: object;
};

export type DataViewUnsubscribeRequest = {
  requestId: string;
  subscriptionId: string;
};

export type DataViewSubscribeResult =
  | { ok: true; subscriptionId: string }
  | { ok: false; code: DataViewErrorCode; message: string };

export type DataViewUnsubscribeResult =
  | { ok: true }
  | { ok: false; code: DataViewErrorCode; message: string };

export type DataViewRowsEvent = {
  requestId: string;
  subscriptionId: string;
  rows: unknown[];
};

export type DataViewErrorEvent = {
  requestId: string;
  subscriptionId?: string;
  code: DataViewErrorCode;
  message: string;
};

export type DataViewsApi = {
  /** Whether the staged PGlite data-view bridge is active for this session. */
  enabled(): Promise<boolean>;
  subscribe(
    view: string,
    params: object,
    onRows: (rows: unknown[]) => void,
    onError?: (error: DataViewErrorEvent) => void,
  ): Promise<() => Promise<void>>;
};

export function displayScaleZoomFactor(percent: number) {
  if (!Number.isFinite(percent)) throw new TypeError("Display scale must be finite.");
  return Math.min(1.5, Math.max(0.75, percent / 100));
}

export type OctopusBeakApi = {
  display: {
    setScale(percent: number): void;
  };
  settings: {
    load(): Promise<SystemSettingsDto>;
    save(input: SystemSettingsDto): Promise<SystemSettingsDto>;
  };
  overview: {
    load(options?: DataReadOptions): Promise<OverviewPageDto>;
    loadBlock(block: DashboardBlockKey, options?: DataReadOptions): Promise<DashboardBlockPayload>;
  };
  assets: {
    load(options?: DataReadOptions): Promise<AssetsPageDto>;
    loadBlock(block: DashboardBlockKey, options?: DataReadOptions): Promise<DashboardBlockPayload>;
  };
  liabilities: {
    load(options?: DataReadOptions): Promise<LiabilitiesPageDto>;
    loadBlock(block: DashboardBlockKey, options?: DataReadOptions): Promise<DashboardBlockPayload>;
  };
  spending: {
    load(input?: SpendingLoadInput, options?: DataReadOptions): Promise<SpendingPageDto>;
    loadRecordPage(input: SpendingRecordPageRequest): Promise<SpendingPageReadResult<SpendingRecordPageDto>>;
    loadCandidatePage(input: SpendingCandidatePageRequest, requestId: string): Promise<SpendingPageReadResult<SpendingCandidatePageDto>>;
    cancelCandidatePage(requestId: string): Promise<boolean>;
    applyPageAction(input: SpendingPageActionRequest): Promise<SpendingPageActionResult>;
    loadBlock(block: DashboardBlockKey, options?: DataReadOptions): Promise<DashboardBlockPayload>;
    rankPairingCandidates(input: SpendingPairingCandidatesInput): Promise<SpendingPairingCandidatesResult>;
    prewarmPairingCandidates(input: SpendingPairingPrewarmInput): Promise<SpendingPairingPrewarmResult>;
    confirmCandidate(input: SpendingConfirmActionInput): Promise<SpendingPurchaseActionResult>;
    denyCandidate(input: SpendingCandidateActionInput): Promise<SpendingPurchaseActionResult>;
    revokeLink(input: SpendingLinkActionInput): Promise<SpendingPurchaseActionResult>;
  };
  automation: {
    loadBlock(block: DashboardBlockKey, options?: DataReadOptions): Promise<DashboardBlockPayload>;
    saveCredentials(updates: Record<string, string>): Promise<AutomationCredentialSaveResult>;
    cathayGmailOtpStatus(): Promise<CathayGmailOtpStatus>;
    enableCathayGmailOtp(): Promise<CathayGmailOtpStatus>;
    setCathayGmailOtpEnabled(enabled: boolean): Promise<CathayGmailOtpStatus>;
    disconnectCathayGmailOtp(): Promise<CathayGmailOtpStatus>;
    selectCertificateFile(locale: "en" | "zh-TW"): Promise<CertificateFileSelectionResult>;
    openSetupGuideLink(groupId: string, linkId: string, locale: "en" | "zh-TW"): Promise<{ ok: true }>;
    run(taskId: string): Promise<{ started: string; runId?: string; runtime?: AutomationRuntimeSnapshot }>;
    runMany(taskIds: string[]): Promise<AutomationRunManyResult>;
    resumeHumanAssistance(taskId: string): Promise<{ resumed: string; runId?: string; runtime?: AutomationRuntimeSnapshot }>;
    cancel(taskId: string): Promise<{ cancelled: string }>;
    forceTerminate(taskId: string): Promise<{ cancelled: string }>;
    runHistory(): Promise<AutomationTaskHistoryRow[]>;
    openExternalPrerequisite(prerequisiteId: string): Promise<{ ok: true }>;
    viewerScreenshot(taskId: string): Promise<Uint8Array | null>;
    viewerInspect(taskId: string, point: { x: number; y: number }): Promise<ViewerInspectResult>;
    viewerInput(taskId: string, input: unknown): Promise<ViewerInputResult>;
    viewerCompletionCheck(taskId: string): Promise<{ verified: boolean; contract: HumanAssistanceContract | null }>;
    runtimeSnapshot(): Promise<AutomationRuntimeSnapshot>;
    fatalRuntimeSnapshot(): Promise<void>;
    onRuntimeChanged(listener: (snapshot: AutomationRuntimeSnapshot) => void): () => void;
  };
  data: {
    getVersion(): Promise<DataVersionSnapshot>;
    acknowledgeVersion(version: number): Promise<DataVersionSnapshot>;
    onInvalidated(listener: (event: DataInvalidationEvent) => void): () => void;
  };
  dataViews: DataViewsApi;
};

export const octopusBeakApiChannels = [
  "settings:load",
  "settings:save",
  "overview:load",
  "overview:block",
  "assets:load",
  "assets:block",
  "liabilities:load",
  "liabilities:block",
  "spending:load",
  "spending:block",
  "spending:record-page",
  "spending:candidate-page",
  "spending:candidate-page-cancel",
  "spending:page-action",
  "spending:pairing-candidates",
  "spending:pairing-prewarm",
  "spending:confirmCandidate",
  "spending:denyCandidate",
  "spending:revokeLink",
  "automation:block",
  "automation:saveCredentials",
  "automation:cathayGmailOtpStatus",
  "automation:enableCathayGmailOtp",
  "automation:setCathayGmailOtpEnabled",
  "automation:disconnectCathayGmailOtp",
  "automation:selectCertificateFile",
  "automation:openSetupGuideLink",
  "automation:run",
  "automation:runMany",
  "automation:resumeHumanAssistance",
  "automation:cancel",
  "automation:forceTerminate",
  "automation:runHistory",
  "automation:openExternalPrerequisite",
  "automation:viewerScreenshot",
  "automation:viewerInspect",
  "automation:viewerInput",
  "automation:viewerCompletionCheck",
  "automation:runtimeSnapshot",
  "automation:fatalRuntimeSnapshot",
  "automation:runtime-changed",
  "data:getVersion",
  "data:acknowledgeVersion",
  "data:invalidated",
  "data-views:subscribe",
  "data-views:enabled",
  "data-views:unsubscribe",
  "data-views:rows",
  "data-views:error",
] as const;

export type OctopusBeakApiChannel = typeof octopusBeakApiChannels[number];
