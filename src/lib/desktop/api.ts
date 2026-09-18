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
import type { FinancialQueryCutoff } from "$lib/shared-ledger/server/financial-query.ts";
import type {
  OverviewPrimarySection,
  OverviewSecondarySection,
} from "$lib/overview/types.ts";
import type {
  AssetsPrimarySection,
  AssetsSecondarySection,
} from "$lib/assets/types.ts";
import type {
  LiabilitiesPrimarySection,
  LiabilitiesSecondarySection,
} from "$lib/liabilities/types.ts";
import type {
  SpendingPrimarySection,
  SpendingSecondarySection,
} from "$lib/spending/model.ts";
import type { SystemSettingsDto } from "$lib/settings/system-settings.ts";
import type {
  HumanAssistanceContract,
  VerificationInteractionMode,
} from "$lib/automation/human-assistance.ts";

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

export type FinancialFreshnessEvent = Readonly<{
  knowledgePoint: number;
}>;

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

export type FinancialPageLoadInput = Readonly<{
  cutoff?: FinancialQueryCutoff;
}>;

/**
 * Renderer-owned, non-financial identity for one queued page-read generation.
 * The desktop boundary treats it as opaque and never uses it as ledger data.
 */
export type FinancialPageRequestOptions = Readonly<{
  requestToken?: string;
}>;

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
    load(input?: FinancialPageLoadInput, options?: FinancialPageRequestOptions): Promise<OverviewPageDto>;
    loadSection(section: "primary", input?: FinancialPageLoadInput, options?: FinancialPageRequestOptions): Promise<OverviewPrimarySection>;
    loadSection(section: "secondary", input?: FinancialPageLoadInput, options?: FinancialPageRequestOptions): Promise<OverviewSecondarySection>;
  };
  assets: {
    load(input?: FinancialPageLoadInput, options?: FinancialPageRequestOptions): Promise<AssetsPageDto>;
    loadSection(section: "primary", input?: FinancialPageLoadInput, options?: FinancialPageRequestOptions): Promise<AssetsPrimarySection>;
    loadSection(section: "secondary", input?: FinancialPageLoadInput, options?: FinancialPageRequestOptions): Promise<AssetsSecondarySection>;
  };
  liabilities: {
    load(input?: FinancialPageLoadInput, options?: FinancialPageRequestOptions): Promise<LiabilitiesPageDto>;
    loadSection(section: "primary", input?: FinancialPageLoadInput, options?: FinancialPageRequestOptions): Promise<LiabilitiesPrimarySection>;
    loadSection(section: "secondary", input?: FinancialPageLoadInput, options?: FinancialPageRequestOptions): Promise<LiabilitiesSecondarySection>;
  };
  financial: {
    cancel(requestToken: string): Promise<void>;
  };
  financialFreshness: {
    subscribe(listener: (event: FinancialFreshnessEvent) => void): () => void;
    subscribeRecovery(listener: () => void): () => void;
    latestKnowledgePoint(): Promise<number>;
  };
  spending: {
    load(input?: SpendingLoadInput, options?: FinancialPageRequestOptions): Promise<SpendingPageDto>;
    loadSection(section: "primary", input?: SpendingLoadInput, options?: FinancialPageRequestOptions): Promise<SpendingPrimarySection>;
    loadSection(section: "secondary", input?: SpendingLoadInput, options?: FinancialPageRequestOptions): Promise<SpendingSecondarySection>;
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
};

export const octopusBeakApiChannels = [
  "settings:load",
  "settings:save",
  "overview:load",
  "overview:section:load",
  "assets:load",
  "assets:section:load",
  "liabilities:load",
  "liabilities:section:load",
  "financialFreshness:changed",
  "financialFreshness:latestKnowledgePoint",
  "financialFreshness:reconnected",
  "financial:cancel",
  "spending:load",
  "spending:section:load",
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
] as const;

export type OctopusBeakApiChannel = typeof octopusBeakApiChannels[number];
