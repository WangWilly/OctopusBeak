import type { SpendingPageReadResult } from "../spending/page-reader.ts";
import type { AssetsPageDto } from "$lib/assets/types.ts";
import type {
  AutomationCredentialGroup,
  AutomationPageModel,
  AutomationTaskHistoryRow,
  AutomationTaskProgress,
  TypedWorkflowOutcome,
  DeviceRegistrationSource,
  DeviceRegistrationStatus,
  DeviceRegistrationStep,
} from "$lib/automation/types.ts";
import type { LiabilitiesPageDto } from "$lib/liabilities/types.ts";
import type { OverviewPageDto } from "$lib/overview/types.ts";
import type {
  SpendingPairingCandidatesInput,
  SpendingPairingCandidatesResult,
  SpendingPairingPrewarmInput,
  SpendingPairingPrewarmResult,
  SpendingPageDto,
  SpendingCandidatePageDto,
  SpendingCandidatePageRequest,
  SpendingRecordPageDto,
  SpendingRecordPageRequest,
  SpendingPageActionRequest,
  SpendingPageActionResult,
  SpendingPurchaseCategoryRequest,
  SpendingPurchaseCategoryResult,
  SpendingMergeLogDto,
  SpendingMergeLogRequest,
  SpendingMerchantStatsDto,
  SpendingMerchantStatsRequest,
  SpendingMonthInsightDto,
  SpendingMonthInsightRequest,
  SpendingPendingOverviewDto,
  SpendingPendingOverviewRequest,
  SpendingStrongConfirmRequest,
  SpendingStrongConfirmResult,
} from "$lib/spending/model.ts";
import type {
  SpendingLoadInput,
} from "$lib/spending/contracts.ts";
import type { SystemSettingsDto } from "$lib/settings/system-settings.ts";
import type { UsagePing } from "$lib/settings/usage-statistics.ts";
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

export type OctopusBeakApi = {
  display: {
    setScale(percent: number): void;
  };
  settings: {
    load(): Promise<SystemSettingsDto>;
    save(input: SystemSettingsDto): Promise<SystemSettingsDto>;
    /** The exact body the next usage ping would send (ADR 0077). */
    previewUsagePing(): Promise<UsagePing>;
    /** True once per install until the person answers the usage statistics question. */
    shouldAskUsageStatistics(): Promise<boolean>;
    answerUsageStatistics(enabled: boolean): Promise<SystemSettingsDto>;
    deletePreviewData(): Promise<void>;
    /** Canonical Reset: every source's financial data. */
    deleteFinancialData(): Promise<void>;
    /** Sign-in Erasure: every source's sign-in details and sessions. */
    clearSignInData(): Promise<void>;
    /** Starts every enabled source, as scheduled collection would. */
    collectAllSources(): Promise<AutomationRunManyResult>;
  };
  spending: {
    loadRecordPage(input: SpendingRecordPageRequest): Promise<SpendingPageReadResult<SpendingRecordPageDto>>;
    loadCandidatePage(input: SpendingCandidatePageRequest, requestId: string): Promise<SpendingPageReadResult<SpendingCandidatePageDto>>;
    cancelCandidatePage(requestId: string): Promise<boolean>;
    applyPageAction(input: SpendingPageActionRequest): Promise<SpendingPageActionResult>;
    setPurchaseCategory(input: SpendingPurchaseCategoryRequest): Promise<SpendingPurchaseCategoryResult>;
    loadPendingOverview(input: SpendingPendingOverviewRequest): Promise<SpendingPageReadResult<SpendingPendingOverviewDto>>;
    loadMergeLog(input: SpendingMergeLogRequest): Promise<SpendingPageReadResult<SpendingMergeLogDto>>;
    loadMonthInsight(input: SpendingMonthInsightRequest): Promise<SpendingPageReadResult<SpendingMonthInsightDto>>;
    loadMerchantStats(input: SpendingMerchantStatsRequest): Promise<SpendingPageReadResult<SpendingMerchantStatsDto>>;
    confirmStrongCandidates(input: SpendingStrongConfirmRequest): Promise<SpendingStrongConfirmResult>;
    rankPairingCandidates(input: SpendingPairingCandidatesInput): Promise<SpendingPairingCandidatesResult>;
    prewarmPairingCandidates(input: SpendingPairingPrewarmInput): Promise<SpendingPairingPrewarmResult>;
  };
  automation: {
    loadBlock(block: DashboardBlockKey, options?: DataReadOptions): Promise<DashboardBlockPayload>;
    saveCredentials(updates: Record<string, string>): Promise<AutomationCredentialSaveResult>;
    deviceRegistrationStatus(source: DeviceRegistrationSource): Promise<DeviceRegistrationStatus>;
    startDeviceRegistration(source: DeviceRegistrationSource): Promise<DeviceRegistrationStep>;
    submitDeviceRegistrationCode(
      source: DeviceRegistrationSource,
      registrationId: string,
      code: string,
    ): Promise<DeviceRegistrationStep>;
    cancelDeviceRegistration(source: DeviceRegistrationSource, registrationId: string): Promise<void>;
    selectCertificateFile(locale: "en" | "zh-TW"): Promise<CertificateFileSelectionResult>;
    openSetupGuideLink(groupId: string, linkId: string, locale: "en" | "zh-TW"): Promise<{ ok: true }>;
    run(taskId: string): Promise<{ started: string; runId?: string; runtime?: AutomationRuntimeSnapshot }>;
    runMany(taskIds: string[]): Promise<AutomationRunManyResult>;
    cancel(taskId: string, expectedRunId?: string): Promise<{ cancelled: string }>;
    forceTerminate(taskId: string, expectedRunId?: string): Promise<{ cancelled: string }>;
    runHistory(): Promise<AutomationTaskHistoryRow[]>;
    openExternalPrerequisite(prerequisiteId: string): Promise<{ ok: true }>;
    runtimeSnapshot(): Promise<AutomationRuntimeSnapshot>;
    fatalRuntimeSnapshot(): Promise<void>;
    onRuntimeChanged(listener: (snapshot: AutomationRuntimeSnapshot) => void): () => void;
    takeSignInSettingsRequest(): Promise<string | null>;
    onSignInSettingsRequested(listener: () => void): () => void;
    previewStructureReport(taskId: string): Promise<string | null>;
    openPreviewStructureReportIssue(taskId: string): Promise<{ ok: true }>;
  };
  data: {
    getVersion(): Promise<DataVersionSnapshot>;
    acknowledgeVersion(version: number): Promise<DataVersionSnapshot>;
    onInvalidated(listener: (event: DataInvalidationEvent) => void): () => void;
  };
  dataViews: DataViewsApi;
};
