import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnvText } from "./env-file.ts";
import {
  AUTOMATION_SETTINGS_PATH,
  migrateAutomationEnvFile,
  readAutomationSettingsFile,
  type AutomationSettingsFile,
} from "./config-files.ts";
import { AUTOMATION_CREDENTIAL_GROUPS } from "./tasks.ts";

export const AUTOMATION_ENV_PATH = resolve(".env");

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
  const value = settings.AUTOMATION_BUSINESS_TIMEZONE ?? process.env.AUTOMATION_BUSINESS_TIMEZONE;
  return typeof value === "string" && value.trim() ? value : "Asia/Taipei";
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
