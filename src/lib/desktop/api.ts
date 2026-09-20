import type { AssetsPageDto } from "$lib/assets/types.ts";
import type {
  AutomationCredentialGroup,
  AutomationPageModel,
  AutomationTaskHistoryRow,
  CathayGmailOtpStatus,
} from "$lib/automation/types.ts";
import type { LiabilitiesPageDto } from "$lib/liabilities/types.ts";
import type { OverviewPageDto } from "$lib/overview/types.ts";
import type { SpendingCategory } from "$lib/spending/categories.ts";
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
} from "$lib/spending/model.ts";
import type {
  SpendingLoadInput,
  SpendingOverrideUpdate,
} from "$lib/spending/server/store.ts";
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

/**
 * Main-process-owned credential state safe to cross the worker boundary.
 * It contains no credential values, encrypted payloads, or certificate paths.
 */
export type AutomationCredentialStateDto = {
  revision: number;
  status: Readonly<Record<string, boolean>>;
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

export type AutomationCoreSnapshot = {
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
};

export type AutomationActionResult =
  | { started: string }
  | { resumed: string }
  | { cancelled: string }
  | { saved: true }
  | { ok: true }
  | { ok: true; closed: boolean };

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
    loadBlock(block: DashboardBlockKey, options?: DataReadOptions): Promise<DashboardBlockPayload>;
    rankPairingCandidates(input: SpendingPairingCandidatesInput): Promise<SpendingPairingCandidatesResult>;
    prewarmPairingCandidates(input: SpendingPairingPrewarmInput): Promise<SpendingPairingPrewarmResult>;
    confirmCandidate(input: SpendingConfirmActionInput): Promise<SpendingPurchaseActionResult>;
    denyCandidate(input: SpendingCandidateActionInput): Promise<SpendingPurchaseActionResult>;
    revokeLink(input: SpendingLinkActionInput): Promise<SpendingPurchaseActionResult>;
    updateItemCategory(input: { itemKey: string; category: SpendingCategory }): Promise<{ ok: true }>;
    updateTransactionOverride(input: SpendingOverrideUpdate): Promise<{ ok: true }>;
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
    run(taskId: string): Promise<{ started: string }>;
    runMany(taskIds: string[]): Promise<{ started: string[] }>;
    resume(taskId: string): Promise<{ resumed: string }>;
    cancel(taskId: string): Promise<{ cancelled: string }>;
    runHistory(): Promise<AutomationTaskHistoryRow[]>;
    openExternalPrerequisite(prerequisiteId: string): Promise<{ ok: true }>;
    viewerScreenshot(taskId: string): Promise<Uint8Array | null>;
    viewerInspect(taskId: string, point: { x: number; y: number }): Promise<ViewerInspectResult>;
    viewerInput(taskId: string, input: unknown): Promise<ViewerInputResult>;
    viewerCompletionCheck(taskId: string): Promise<{ verified: boolean; contract: HumanAssistanceContract | null }>;
    forceQuit(taskId: string): Promise<{ ok: true; closed: boolean }>;
  };
  data: {
    getVersion(): Promise<DataVersionSnapshot>;
    acknowledgeVersion(version: number): Promise<DataVersionSnapshot>;
    onInvalidated(listener: (event: DataInvalidationEvent) => void): () => void;
  };
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
  "spending:pairing-candidates",
  "spending:pairing-prewarm",
  "spending:confirmCandidate",
  "spending:denyCandidate",
  "spending:revokeLink",
  "spending:updateItemCategory",
  "spending:updateTransactionOverride",
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
  "automation:resume",
  "automation:cancel",
  "automation:runHistory",
  "automation:openExternalPrerequisite",
  "automation:viewerScreenshot",
  "automation:viewerInspect",
  "automation:viewerInput",
  "automation:viewerCompletionCheck",
  "automation:forceQuit",
  "data:getVersion",
  "data:acknowledgeVersion",
  "data:invalidated",
] as const;

export type OctopusBeakApiChannel = typeof octopusBeakApiChannels[number];
