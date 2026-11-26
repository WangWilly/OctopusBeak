import type { FinancialBridge } from "../pglite-rpc/pglite-financial-contracts.ts";
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
import type {
  SpendingPairingPrewarmInput,
  SpendingPairingPrewarmResult,
  SpendingPageReadResult,
  SpendingCandidatePageDto,
  SpendingCandidatePageRequest,
} from "$lib/spending/model.ts";
import type { SystemSettingsDto } from "$lib/settings/system-settings.ts";
import type { UsagePing } from "$lib/settings/usage-statistics.ts";
import type { AppUpdateRestartResult, AppUpdateView } from "$lib/settings/app-updates.ts";
import type { ErrorReportInput, ErrorReportPayload, ErrorReportResult } from "$lib/automation/error-report-contract.ts";
import type {
  DataReadOptions,
  DataInvalidationEvent,
  DataVersionSnapshot,
} from "$lib/shared-shell/data-version.ts";
import type { DashboardBlockKey } from "$lib/shared-shell/block-load-state.ts";
import type { LedgerResetPart, LedgerResetResult } from "$lib/settings/data-erasure.ts";
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

export type { LedgerResetPart, LedgerResetResult };

/** What clearing the sign-in data in Reset ledger would find and cost (ADR 0149). */
export type SignInDataStatus = Readonly<{
  /** `undecodable`: the Keychain cannot decrypt them, or the file is damaged; clearing replaces it. `unreachable`: a filesystem error; clearing fails. */
  credentials: "readable" | "undecodable" | "unreachable";
  clearRequiresFinancialDataDeletion: boolean;
}>;

/**
 * What an App Data Cleanup would free (ADR 0156), in bytes. `redundantBytes`
 * is the compaction's part and `temporaryBytes` the reclaim's. The run needs
 * `neededBytes` free without a backup, and `backup.neededBytes`, the backup's
 * need and the run's together, with one. `backup` is `unreadable` when the
 * room for one could not be read, and null when the ledger cannot be backed up.
 */
export type LedgerCleanupEstimateDto = Readonly<{
  redundantBytes: number;
  temporaryBytes: number;
  neededBytes: number;
  /** null when the free space could not be read. */
  freeBytes: number | null;
  backup: Readonly<{ kind: "room"; bytes: number; neededBytes: number }> | Readonly<{ kind: "unreadable" }> | null;
}>;

/** The running cleanup: the backup, step `index` of `count`, or table `index` of `count` being rewritten. */
export type LedgerCleanupProgressDto =
  | Readonly<{ phase: "backing-up" }>
  | Readonly<{ phase: "compacting" | "reclaiming"; index: number; count: number }>;

/** How a cleanup ended. `freedBytes` is how much the ledger's folder shrank. */
export type LedgerCleanupResultDto =
  | Readonly<{ status: "already-running" }>
  | Readonly<{ status: "done"; freedBytes: number }>
  /** The steps done before the stop stay done; cleaning up again goes on from there. */
  | Readonly<{ status: "stopped"; freedBytes: number }>
  /** The failing step rolled back; the steps before it stay done. */
  | Readonly<{ status: "failed"; freedBytes: number }>
  /** The backup could not be made, so nothing was removed. */
  | Readonly<{ status: "backup-failed" }>
  /** The redundant data is removed, but the disk had no room to return the space: about `remainingBytes` is left, and `neededBytes` more must be freed. */
  | Readonly<{ status: "no-room"; freedBytes: number; remainingBytes: number; neededBytes: number }>;

/** A cleanup that is running, or how the last one ended; a failure is still reported after a restart. */
export type LedgerCleanupStatusDto =
  | Readonly<{ running: true; progress: LedgerCleanupProgressDto | null }>
  | Readonly<{ running: false; last: LedgerCleanupResultDto | null }>;

/** The Cleanup Backup Settings shows; no path reaches the renderer. */
export type CleanupBackupDto = Readonly<{
  /** null when the backup could not be measured; it can still be deleted. */
  bytes: number | null;
  takenAt: string;
  expiresAt: string;
  /** False when the App has changed the ledger's versions since, so the backup can no longer be opened. */
  restorable: boolean;
}>;

/** How the last Cleanup Restore ended (ADR 0157); `takenAt` is the restored backup's time. No path reaches the renderer. */
export type CleanupRestoreOutcomeDto =
  | Readonly<{ status: "restored"; takenAt: string }>
  | Readonly<{ status: "failed" }>;

/** The part of Settings a notification or another page opens. */
export type SettingsFocus = "financial-data-deletion" | "sign-in-data" | "app-updates";

/** Where the App opens when the person clicks one of its notifications. */
export type NotificationTarget =
  | { route: "overview" }
  | { route: "settings"; focus: SettingsFocus }
  | { route: "automation"; credentialGroupId: string | null };

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

export type DataViewValueEvent = {
  requestId: string;
  subscriptionId: string;
  value: unknown;
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
    onValue: (value: unknown) => void,
    onError?: (error: DataViewErrorEvent) => void,
  ): Promise<() => Promise<void>>;
};

export type OctopusBeakApi = {
  display: {
    setScale(percent: number): void;
  };
  /** ADR 0083: automatic updates from GitHub Releases. */
  appUpdates: {
    view(): Promise<AppUpdateView>;
    /** Checks now unless a check or download is in flight or an update is waiting. */
    check(): Promise<AppUpdateView>;
    /** Starts downloading the update the last check found, or tries a failed download again. */
    download(): Promise<AppUpdateView>;
    /** Quits and installs a downloaded update; refused while a run is active. */
    restart(): Promise<AppUpdateRestartResult>;
    onChanged(listener: (view: AppUpdateView) => void): () => void;
  };
  /** ADR 0081: an Error report the person sends by hand from a failed run. */
  errorReports: {
    /** False when this build has no receiver, so the button is hidden. */
    available(): Promise<boolean>;
    /** Exactly what send() would post, with the note already masked. */
    preview(input: ErrorReportInput): Promise<ErrorReportPayload>;
    send(input: ErrorReportInput): Promise<ErrorReportResult>;
  };
  settings: {
    load(): Promise<SystemSettingsDto>;
    save(input: SystemSettingsDto): Promise<SystemSettingsDto>;
    /** The exact body the next usage ping would send (ADR 0078). */
    previewUsagePing(): Promise<UsagePing>;
    /** True once per install until the person answers the usage statistics question. */
    shouldAskUsageStatistics(): Promise<boolean>;
    answerUsageStatistics(enabled: boolean): Promise<SystemSettingsDto>;
    /**
     * Reset ledger: deletes the parts named, in a fixed order, with collection
     * stopped once for all of them, and says which finished. Refused while an
     * App Data Cleanup runs.
     */
    resetLedger(parts: readonly LedgerResetPart[]): Promise<LedgerResetResult>;
    /** Whether the stored Sign-in Details can be read, and whether clearing them would need a Canonical Reset (ADR 0149). */
    signInDataStatus(): Promise<SignInDataStatus>;
    /** About how much Clean up app data would free, and the room it and its backup need; may pause the App for seconds. */
    ledgerCleanupEstimate(): Promise<LedgerCleanupEstimateDto>;
    /** Compacts, then returns the space; resolves when it ends. Refused while the ledger is being reset. */
    cleanUpLedger(request: Readonly<{ backup: boolean; keepBackup: boolean }>): Promise<LedgerCleanupResultDto>;
    /** The running cleanup's progress, or how the last one ended. */
    ledgerCleanupStatus(): Promise<LedgerCleanupStatusDto>;
    /** Stops the running cleanup; its current step rolls back, or its current table finishes. */
    stopLedgerCleanup(): Promise<boolean>;
    /** The Cleanup Backup, if one exists. */
    cleanupBackup(): Promise<CleanupBackupDto | null>;
    /** Shows the Cleanup Backup in Finder. */
    revealCleanupBackup(): Promise<void>;
    /** Deletes the Cleanup Backup; resolves with what is left, which is nothing. Refused while a cleanup runs. */
    deleteCleanupBackup(): Promise<CleanupBackupDto | null>;
    /** Asks to put the Cleanup Backup in the ledger's place and restarts the App to do it. Refused while a cleanup or a reset runs. */
    restoreCleanupBackup(): Promise<void>;
    /** How the last restore ended, once; null when there is nothing new to say. */
    takeCleanupRestoreOutcome(): Promise<CleanupRestoreOutcomeDto | null>;
    /** Starts every enabled source, as scheduled collection would. */
    collectAllSources(): Promise<AutomationRunManyResult>;
  };
  /** The financial operations open to the renderer, typed by their contracts (ADR 0098), and the Spending desktop service's own calls. */
  spending: FinancialBridge<"spending"> & {
    loadCandidatePage(input: SpendingCandidatePageRequest, requestId: string): Promise<SpendingPageReadResult<SpendingCandidatePageDto>>;
    cancelCandidatePage(requestId: string): Promise<boolean>;
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
    takeNotificationTarget(): Promise<NotificationTarget | null>;
    onNotificationTargetRequested(listener: () => void): () => void;
    previewStructureReport(taskId: string): Promise<string | null>;
    openPreviewStructureReportIssue(taskId: string): Promise<{ ok: true }>;
  };
  /** Manual Assets (ADR 0087); the worker parses every command again before it runs. */
  manualAssets: FinancialBridge<"manualAssets">;
  data: {
    getVersion(): Promise<DataVersionSnapshot>;
    acknowledgeVersion(version: number): Promise<DataVersionSnapshot>;
    onInvalidated(listener: (event: DataInvalidationEvent) => void): () => void;
  };
  dataViews: DataViewsApi;
};
