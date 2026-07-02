import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { parseEnvText } from "./env-file.ts";
import {
  AUTOMATION_NON_SECRET_KEYS,
  AUTOMATION_SECRET_KEYS,
} from "./tasks.ts";

export type AutomationSettingValue = string | boolean;
export type AutomationSettingsFile = Record<string, AutomationSettingValue>;
export type AutomationCredentialsFile = Record<string, string>;

export const AUTOMATION_SETTINGS_PATH = "settings.json";
export const AUTOMATION_CREDENTIALS_PATH = "credentials.json";

const automationSettingKeys = new Set<string>(AUTOMATION_NON_SECRET_KEYS);
const automationSecretKeys = new Set<string>(AUTOMATION_SECRET_KEYS);
const automationKnownKeys = new Set<string>([
  ...AUTOMATION_NON_SECRET_KEYS,
  ...AUTOMATION_SECRET_KEYS,
]);

function readJsonRecord(path: string) {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function atomicWrite(path: string, text: string, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tempPath, text, { encoding: "utf8", mode });
  chmodSync(tempPath, mode);
  renameSync(tempPath, path);
}

function cleanSettings(record: Record<string, unknown>): AutomationSettingsFile {
  const result: AutomationSettingsFile = {};
  for (const [key, value] of Object.entries(record)) {
    if (!automationSettingKeys.has(key)) continue;
    if (typeof value === "boolean" || typeof value === "string") result[key] = value;
  }
  return result;
}

function cleanCredentials(record: Record<string, unknown>): AutomationCredentialsFile {
  const result: AutomationCredentialsFile = {};
  for (const [key, value] of Object.entries(record)) {
    if (!automationSecretKeys.has(key)) continue;
    if (typeof value === "string" && value.trim()) result[key] = value;
  }
  return result;
}

export function readAutomationSettingsFile(path = AUTOMATION_SETTINGS_PATH) {
  return cleanSettings(readJsonRecord(path));
}

export function readAutomationCredentialsFile(path = AUTOMATION_CREDENTIALS_PATH) {
  return cleanCredentials(readJsonRecord(path));
}

export function writeAutomationSettingsFile(path: string, settings: AutomationSettingsFile) {
  atomicWrite(path, `${JSON.stringify(cleanSettings(settings), null, 2)}\n`);
}

export function writeAutomationCredentialsFile(path: string, credentials: AutomationCredentialsFile) {
  atomicWrite(path, `${JSON.stringify(cleanCredentials(credentials), null, 2)}\n`);
}

export function writeAutomationSettings(settings: AutomationSettingsFile) {
  writeAutomationSettingsFile(AUTOMATION_SETTINGS_PATH, settings);
}

export function writeAutomationCredentials(credentials: AutomationCredentialsFile) {
  writeAutomationCredentialsFile(AUTOMATION_CREDENTIALS_PATH, credentials);
}

function envValueToSetting(key: string, value: string): AutomationSettingValue {
  if (key.endsWith("_ENABLED")) {
    return !new Set(["0", "false", "no", "off", "disabled"]).has(value.trim().toLowerCase());
  }
  return value;
}

export function splitAutomationUpdates(updates: Record<string, string>) {
  const settings: AutomationSettingsFile = {};
  const credentials: AutomationCredentialsFile = {};
  for (const [key, value] of Object.entries(updates)) {
    if (automationSettingKeys.has(key)) {
      settings[key] = envValueToSetting(key, value);
      continue;
    }
    if (automationSecretKeys.has(key) && value.trim()) credentials[key] = value;
  }
  return { settings, credentials };
}

export function settingsToEnv(settings: AutomationSettingsFile): Record<string, string> {
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [key, String(value)]),
  );
}

export function credentialStatusFromValues(
  credentials: AutomationCredentialsFile,
  keys: readonly string[],
): Record<string, boolean> {
  return Object.fromEntries(keys.map((key) => [key, Boolean(credentials[key]?.trim())]));
}

function withoutKnownAutomationLines(envText: string) {
  return `${envText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
      return !match || !automationKnownKeys.has(match[1]);
    })
    .filter((line, index, lines) => line || index < lines.length - 1)
    .join("\n")}\n`;
}

export function migrateAutomationEnvFile({
  envPath = ".env",
  settingsPath = AUTOMATION_SETTINGS_PATH,
  credentialsPath = AUTOMATION_CREDENTIALS_PATH,
}: {
  envPath?: string;
  settingsPath?: string;
  credentialsPath?: string;
} = {}) {
  if (!existsSync(envPath)) return;
  const envText = readFileSync(envPath, "utf8");
  const parsed = parseEnvText(envText);
  const existingSettings = readAutomationSettingsFile(settingsPath);
  const existingCredentials = readAutomationCredentialsFile(credentialsPath);
  const migrated = splitAutomationUpdates(parsed);

  const hasSettings = Object.keys(migrated.settings).length > 0 || existsSync(settingsPath);
  const hasCredentials = Object.keys(migrated.credentials).length > 0 || existsSync(credentialsPath);
  if (hasSettings) {
    writeAutomationSettingsFile(settingsPath, {
      ...migrated.settings,
      ...existingSettings,
    });
  }
  if (hasCredentials) {
    writeAutomationCredentialsFile(credentialsPath, {
      ...migrated.credentials,
      ...existingCredentials,
    });
  }
  if (Object.keys(migrated.settings).length > 0 || Object.keys(migrated.credentials).length > 0) {
    writeFileSync(envPath, withoutKnownAutomationLines(envText), { encoding: "utf8", mode: 0o600 });
  }
}

export function automationConfigEnv({
  baseEnv = process.env,
  settings = readAutomationSettingsFile(),
  credentials = readAutomationCredentialsFile(),
}: {
  baseEnv?: NodeJS.ProcessEnv;
  settings?: AutomationSettingsFile;
  credentials?: AutomationCredentialsFile;
} = {}) {
  const env = {
    ...baseEnv,
    ...settingsToEnv(settings),
    ...credentials,
  };
  if (env.NODE_ENV === "production") env.NODE_ENV = "development";
  return env;
}
