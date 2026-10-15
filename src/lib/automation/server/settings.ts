import { existsSync, readFileSync } from "node:fs";
import { parseEnvText } from "./env-file.ts";
import {
  AUTOMATION_SETTINGS_PATH,
  migrateAutomationEnvFile,
  readAutomationSettingsFile,
  type AutomationSettingsFile,
} from "./config-files.ts";
import { AUTOMATION_CREDENTIAL_GROUPS } from "./tasks.ts";
import { PREVIEW_SOURCES } from "../../preview-sources/registry.ts";
import { previewVisibility } from "../../preview-sources/visibility.ts";
import { automationFlagEnabled } from "../statement-selection.ts";
import { systemSettings } from "../../settings/system-settings.ts";

export const AUTOMATION_ENV_PATH = ".env";

export function readAutomationEnvText(envPath = AUTOMATION_ENV_PATH) {
  return existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
}

export function envFlagEnabled(value: string | boolean | undefined) {
  return automationFlagEnabled(value);
}

export function readAutomationSettings(settingsPath = AUTOMATION_SETTINGS_PATH) {
  migrateAutomationEnvFile({ envPath: AUTOMATION_ENV_PATH, settingsPath });
  return readAutomationSettingsFile(settingsPath);
}

export function automationBusinessTimezone(settings: AutomationSettingsFile = readAutomationSettings()) {
  return systemSettings(settings).systemTimezone;
}

export function automationGroupEnabledStatus(
  settings: AutomationSettingsFile = readAutomationSettings(),
  env: Record<string, string | undefined> = process.env,
) {
  const legacy = parseEnvText(readAutomationEnvText());
  return Object.fromEntries(
    AUTOMATION_CREDENTIAL_GROUPS.map((group) => [
      group.id,
      envFlagEnabled(settings[group.enabledKey] ?? legacy[group.enabledKey] ?? env[group.enabledKey]),
    ]),
  );
}

export function offeredAutomationSources(settings: AutomationSettingsFile = readAutomationSettings()) {
  const offeredPreviewIds = new Set(currentPreviewVisibility(settings).sourceIds);
  const enabled = automationGroupEnabledStatus(settings);
  const credentialGroups = AUTOMATION_CREDENTIAL_GROUPS.filter((group) => !group.preview || offeredPreviewIds.has(group.id));
  return {
    credentialGroups,
    enabledGroups: Object.fromEntries(AUTOMATION_CREDENTIAL_GROUPS.map((group) => [
      group.id,
      credentialGroups.includes(group) && enabled[group.id] === true,
    ])),
  };
}

export function currentPreviewVisibility(settings: AutomationSettingsFile = readAutomationSettings()) {
  return previewVisibility({
    previewFeaturesEnabled: systemSettings(settings).previewFeaturesEnabled,
    enabledGroups: automationGroupEnabledStatus(settings),
    sources: PREVIEW_SOURCES,
  });
}
