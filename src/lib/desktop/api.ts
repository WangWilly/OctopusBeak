import type { AssetsPageDto } from "$lib/assets/types.ts";
import type { AutomationCredentialGroup, AutomationPageModel } from "$lib/automation/types.ts";
import type { LiabilitiesPageDto } from "$lib/liabilities/types.ts";
import type { OverviewPageDto } from "$lib/overview/types.ts";

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
  | { saved: true }
  | { ok: true }
  | { ok: true; closed: boolean };

export type OctopusBeakApi = {
  overview: {
    load(): Promise<OverviewPageDto>;
  };
  assets: {
    load(): Promise<AssetsPageDto>;
  };
  liabilities: {
    load(): Promise<LiabilitiesPageDto>;
  };
  automation: {
    load(): Promise<AutomationDesktopModel>;
    saveCredentials(updates: Record<string, string>): Promise<{ saved: true }>;
    run(taskId: string): Promise<{ started: string }>;
    resume(taskId: string): Promise<{ resumed: string }>;
    viewerScreenshot(taskId: string): Promise<Uint8Array>;
    viewerInput(taskId: string, input: unknown): Promise<{ ok: true }>;
    forceQuit(taskId: string): Promise<{ ok: true; closed: boolean }>;
  };
};

export const octopusBeakApiChannels = [
  "overview:load",
  "assets:load",
  "liabilities:load",
  "automation:load",
  "automation:saveCredentials",
  "automation:run",
  "automation:resume",
  "automation:viewerScreenshot",
  "automation:viewerInput",
  "automation:forceQuit",
] as const;

export type OctopusBeakApiChannel = typeof octopusBeakApiChannels[number];
