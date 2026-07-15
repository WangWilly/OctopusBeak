import { existsSync, readFileSync } from "node:fs";
import { parseEnvText } from "./env-file.ts";
import {
  AUTOMATION_SETTINGS_PATH,
  migrateAutomationEnvFile,
  readAutomationSettingsFile,
  type AutomationSettingsFile,
} from "./config-files.ts";
import { AUTOMATION_CREDENTIAL_GROUPS } from "./tasks.ts";
import { systemSettings } from "../../settings/system-settings.ts";

export const AUTOMATION_ENV_PATH = ".env";

export function readAutomationEnvText(envPath = AUTOMATION_ENV_PATH) {
  return existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
}

export function envFlagEnabled(value: string | boolean | undefined) {
  if (value === undefined) return true;
  if (typeof value === "boolean") return value;
  return !new Set(["0", "false", "no", "off", "disabled"]).has(value.trim().toLowerCase());
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
