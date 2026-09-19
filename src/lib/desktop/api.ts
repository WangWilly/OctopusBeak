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
  DataInvalidationEvent,
  DataVersionSnapshot,
} from "$lib/shared-shell/data-version.ts";

export type CredentialGroupDto = AutomationCredentialGroup & {
  enabled: boolean;
  selectedStatementTypeIds: readonly string[];
  statementSetupRequired: boolean;
  storedCredentialFileNames: Readonly<Record<string, string>>;
  invalidCredentialFileKeys: readonly string[];
  invalidCredentialFileReasons?: Readonly<Record<string, CertificateFileValidationReason>>;
};

export type CertificateFileValidationReason = "invalid-extension" | "missing-or-unreadable";

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
    load(): Promise<OverviewPageDto>;
  };
  assets: {
    load(): Promise<AssetsPageDto>;
  };
  liabilities: {
    load(): Promise<LiabilitiesPageDto>;
  };
  spending: {
    load(input?: SpendingLoadInput): Promise<SpendingPageDto>;
    confirmCandidate(input: SpendingConfirmActionInput): Promise<SpendingPurchaseActionResult>;
    denyCandidate(input: SpendingCandidateActionInput): Promise<SpendingPurchaseActionResult>;
    revokeLink(input: SpendingLinkActionInput): Promise<SpendingPurchaseActionResult>;
    updateItemCategory(input: { itemKey: string; category: SpendingCategory }): Promise<{ ok: true }>;
    updateTransactionOverride(input: SpendingOverrideUpdate): Promise<{ ok: true }>;
  };
  automation: {
    load(): Promise<AutomationDesktopModel>;
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
  "assets:load",
  "liabilities:load",
  "spending:load",
  "spending:confirmCandidate",
  "spending:denyCandidate",
  "spending:revokeLink",
  "spending:updateItemCategory",
  "spending:updateTransactionOverride",
  "automation:load",
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
