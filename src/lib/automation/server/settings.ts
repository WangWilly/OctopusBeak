import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnvText } from "./env-file.ts";
import { AUTOMATION_CREDENTIAL_GROUPS } from "./tasks.ts";

export const AUTOMATION_ENV_PATH = resolve(".env");

export function readAutomationEnvText(envPath = AUTOMATION_ENV_PATH) {
  return existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
}

export function envFlagEnabled(value: string | undefined) {
  if (value === undefined) return true;
  return !new Set(["0", "false", "no", "off", "disabled"]).has(value.trim().toLowerCase());
}

export function automationGroupEnabledStatus(
  envText: string,
  env: Record<string, string | undefined> = process.env,
) {
  const parsed = parseEnvText(envText);
  return Object.fromEntries(
    AUTOMATION_CREDENTIAL_GROUPS.map((group) => [
      group.id,
      envFlagEnabled(parsed[group.enabledKey] ?? env[group.enabledKey]),
    ]),
  );
}
