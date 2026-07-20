import type { AssetsPageDto } from "$lib/assets/types.ts";
import type { AutomationCredentialGroup, AutomationPageModel, AutomationTaskHistoryRow } from "$lib/automation/types.ts";
import type {
  ConfirmExclusionInput,
  ConfirmRestoreInput,
  DataIssueCreateInput,
  DataIssueDetailDto,
  DataIssueListItemDto,
  ExclusionPreviewDto,
  PreviewExclusionInput,
  RestorePreviewDto,
} from "$lib/data-issues/types.ts";
import type { LiabilitiesPageDto } from "$lib/liabilities/types.ts";
import type { OverviewPageDto } from "$lib/overview/types.ts";
import type { SpendingCategory } from "$lib/spending/categories.ts";
import type { SpendingPageDto } from "$lib/spending/model.ts";
import type {
  SpendingLoadInput,
  SpendingOverrideUpdate,
} from "$lib/spending/server/store.ts";
import type { SystemSettingsDto } from "$lib/settings/system-settings.ts";

export type CredentialGroupDto = AutomationCredentialGroup & {
  enabled: boolean;
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
};

export type DataIssueDesktopService = {
  list(): DataIssueListItemDto[];
  create(input: DataIssueCreateInput): DataIssueDetailDto;
  load(dataIssueId: string): DataIssueDetailDto;
  startDiagnosis(dataIssueId: string): DataIssueDetailDto;
  previewExclusion(input: PreviewExclusionInput): ExclusionPreviewDto;
  confirmExclusion(input: ConfirmExclusionInput): DataIssueDetailDto;
  previewRestore(dataIssueId: string): RestorePreviewDto;
  confirmRestore(input: ConfirmRestoreInput): DataIssueDetailDto;
};

export function createDataIssueIpcHandlers(service: DataIssueDesktopService) {
  return {
    list: (_event: unknown) => service.list(),
    create: (_event: unknown, input: DataIssueCreateInput) => service.create(input),
    load: (_event: unknown, dataIssueId: string) => service.load(dataIssueId),
    startDiagnosis: (_event: unknown, dataIssueId: string) => service.startDiagnosis(dataIssueId),
    previewExclusion: (_event: unknown, input: PreviewExclusionInput) => service.previewExclusion(input),
    confirmExclusion: (_event: unknown, input: ConfirmExclusionInput) => service.confirmExclusion(input),
    previewRestore: (_event: unknown, dataIssueId: string) => service.previewRestore(dataIssueId),
    confirmRestore: (_event: unknown, input: ConfirmRestoreInput) => service.confirmRestore(input),
  };
}

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
    updateItemCategory(input: { itemKey: string; category: SpendingCategory }): Promise<{ ok: true }>;
    updateTransactionOverride(input: SpendingOverrideUpdate): Promise<{ ok: true }>;
  };
  automation: {
    load(): Promise<AutomationDesktopModel>;
    saveCredentials(updates: Record<string, string>): Promise<{ saved: true }>;
    run(taskId: string): Promise<{ started: string }>;
    runMany(taskIds: string[]): Promise<{ started: string[] }>;
    resume(taskId: string): Promise<{ resumed: string }>;
    cancel(taskId: string): Promise<{ cancelled: string }>;
    runHistory(): Promise<AutomationTaskHistoryRow[]>;
    viewerScreenshot(taskId: string): Promise<Uint8Array | null>;
    viewerInspect(taskId: string, point: { x: number; y: number }): Promise<ViewerInspectResult>;
    viewerInput(taskId: string, input: unknown): Promise<{ ok: true }>;
    forceQuit(taskId: string): Promise<{ ok: true; closed: boolean }>;
  };
  dataIssues: {
    list(): Promise<DataIssueListItemDto[]>;
    create(input: DataIssueCreateInput): Promise<DataIssueDetailDto>;
    load(dataIssueId: string): Promise<DataIssueDetailDto>;
    startDiagnosis(dataIssueId: string): Promise<DataIssueDetailDto>;
    previewExclusion(input: PreviewExclusionInput): Promise<ExclusionPreviewDto>;
    confirmExclusion(input: ConfirmExclusionInput): Promise<DataIssueDetailDto>;
    previewRestore(dataIssueId: string): Promise<RestorePreviewDto>;
    confirmRestore(input: ConfirmRestoreInput): Promise<DataIssueDetailDto>;
  };
};

export const octopusBeakApiChannels = [
  "settings:load",
  "settings:save",
  "overview:load",
  "assets:load",
  "liabilities:load",
  "spending:load",
  "spending:updateItemCategory",
  "spending:updateTransactionOverride",
  "automation:load",
  "automation:saveCredentials",
  "automation:run",
  "automation:runMany",
  "automation:resume",
  "automation:cancel",
  "automation:runHistory",
  "automation:viewerScreenshot",
  "automation:viewerInspect",
  "automation:viewerInput",
  "automation:forceQuit",
  "dataIssues:list",
  "dataIssues:create",
  "dataIssues:load",
  "dataIssues:startDiagnosis",
  "dataIssues:previewExclusion",
  "dataIssues:confirmExclusion",
  "dataIssues:previewRestore",
  "dataIssues:confirmRestore",
] as const;

export type OctopusBeakApiChannel = typeof octopusBeakApiChannels[number];
