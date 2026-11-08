import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { parseEnvText } from "./env-file.ts";
import {
  AUTOMATION_CREDENTIAL_KEYS,
  AUTOMATION_MANAGED_SECRET_KEYS,
  AUTOMATION_NON_SECRET_KEYS,
  AUTOMATION_SECRET_KEYS,
} from "./tasks.ts";

export type AutomationSettingValue = string | boolean;
export type AutomationSettingsFile = Record<string, AutomationSettingValue>;
export type AutomationCredentialsFile = Record<string, string>;

export const AUTOMATION_SETTINGS_FILE = "settings.json";
export const AUTOMATION_CREDENTIALS_FILE = "credentials.json";
export const AUTOMATION_CREDENTIALS_FORMAT = "octopusbeak.credentials.safeStorage.v1";

// TDCC sign-in details and its registered device identity and session token
// (ADR 0041). A TDCC run reaches them only through its host-owned session
// port, so they never reach a child workflow environment.
export const TDCC_USER_ID_KEY = "LIBRETTO_CLOUD_TDCC_USER_ID";
export const TDCC_PASSWORD_KEY = "LIBRETTO_CLOUD_TDCC_PASSWORD";
export const TDCC_DEVICE_IDENTITY_KEY = "LIBRETTO_CLOUD_TDCC_DEVICE_IDENTITY";
export const TDCC_SESSION_KEY = "LIBRETTO_CLOUD_TDCC_SESSION";
export const TDCC_HOST_KEYS = [
  TDCC_USER_ID_KEY,
  TDCC_PASSWORD_KEY,
  TDCC_DEVICE_IDENTITY_KEY,
  TDCC_SESSION_KEY,
] as const;

export const CATHAY_TRUSTED_DEVICE_USER_ID_KEY = "CATHAY_TRUSTED_DEVICE_USER_ID";

const HOST_ONLY_SECRET_KEYS = new Set<string>([
  ...TDCC_HOST_KEYS,
  CATHAY_TRUSTED_DEVICE_USER_ID_KEY,
]);

export type AutomationCredentialCodec = {
  encrypt(text: string): string;
  decrypt(payload: string): string;
};

type EncryptedAutomationCredentialsFile = {
  format: typeof AUTOMATION_CREDENTIALS_FORMAT;
  data: string;
};

export type AutomationSettingsStore = Readonly<{
  /** Absolute path of settings.json. */
  path: string;
  read(): AutomationSettingsFile;
  /**
   * Writes settings.json, then `alongside` (the credentials that belong with
   * these settings). If `alongside` throws, the previous settings.json is
   * restored and nothing is announced, so the pair lands together or not at all.
   */
  write(settings: AutomationSettingsFile, alongside?: () => void): void;
  /** Hears every write through this store, so no writer has to remember to announce one. */
  subscribe(listener: (settings: AutomationSettingsFile) => void): () => void;
}>;

export type AutomationCredentialStore = Readonly<{
  /** Absolute path of credentials.json. */
  path: string;
  codec: AutomationCredentialCodec;
  read(): AutomationCredentialsFile;
  write(credentials: AutomationCredentialsFile): void;
}>;

const automationSettingKeys = new Set<string>(AUTOMATION_NON_SECRET_KEYS);
const automationSecretKeys = new Set<string>([
  ...AUTOMATION_SECRET_KEYS,
  ...HOST_ONLY_SECRET_KEYS,
]);
const automationManagedSecretKeys = new Set<string>(
  AUTOMATION_MANAGED_SECRET_KEYS,
);
const automationUserSecretKeys = new Set<string>(
  AUTOMATION_CREDENTIAL_KEYS.filter(
    (key) => !automationSettingKeys.has(key),
  ),
);
const automationKnownKeys = new Set<string>([
  ...automationSettingKeys,
  ...automationUserSecretKeys,
]);

export const FUBON_CARD_IDENTITY_FINGERPRINT_SECRET_KEY =
  AUTOMATION_MANAGED_SECRET_KEYS[0];
export const CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY =
  FUBON_CARD_IDENTITY_FINGERPRINT_SECRET_KEY;

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
  // Worker threads share the pid, so each write gets its own temporary file.
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
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

function encryptedAutomationCredentialsFile(
  record: Record<string, unknown>,
): EncryptedAutomationCredentialsFile | null {
  if (record.format !== AUTOMATION_CREDENTIALS_FORMAT) return null;
  if (typeof record.data !== "string" || !record.data.trim()) {
    throw new Error(`${AUTOMATION_CREDENTIALS_FILE} encrypted envelope is invalid.`);
  }
  return {
    format: AUTOMATION_CREDENTIALS_FORMAT,
    data: record.data,
  };
}

function requireAutomationCredentialCodec(codec: AutomationCredentialCodec | null) {
  if (!codec) {
    throw new Error("Credential encryption is not configured. Refusing to read encrypted automation credentials.");
  }
  return codec;
}

function decodeCredentialsRecord(
  record: Record<string, unknown>,
  codec: AutomationCredentialCodec | null,
) {
  const encrypted = encryptedAutomationCredentialsFile(record);
  if (!encrypted) return record;
  const text = requireAutomationCredentialCodec(codec).decrypt(encrypted.data);
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${AUTOMATION_CREDENTIALS_FILE} encrypted payload must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function credentialsFileText(
  credentials: AutomationCredentialsFile,
  codec: AutomationCredentialCodec | null,
) {
  const cleaned = cleanCredentials(credentials);
  if (!codec) return `${JSON.stringify(cleaned, null, 2)}\n`;
  return `${JSON.stringify({
    format: AUTOMATION_CREDENTIALS_FORMAT,
    data: codec.encrypt(JSON.stringify(cleaned)),
  }, null, 2)}\n`;
}

function settingsFileText(settings: AutomationSettingsFile) {
  return `${JSON.stringify(cleanSettings(settings), null, 2)}\n`;
}

export function readAutomationSettingsFile(path: string) {
  return cleanSettings(readJsonRecord(path));
}

export function readAutomationCredentialsFile(
  path: string,
  codec: AutomationCredentialCodec | null,
) {
  return cleanCredentials(decodeCredentialsRecord(readJsonRecord(path), codec));
}

export function writeAutomationSettingsFile(path: string, settings: AutomationSettingsFile) {
  atomicWrite(path, settingsFileText(settings));
}

export function writeAutomationCredentialsFile(
  path: string,
  credentials: AutomationCredentialsFile,
  codec: AutomationCredentialCodec | null,
) {
  atomicWrite(path, credentialsFileText(credentials, codec));
}

export function createAutomationCredentialStore(
  path: string,
  codec: AutomationCredentialCodec,
): AutomationCredentialStore {
  return Object.freeze({
    path,
    codec,
    read: () => readAutomationCredentialsFile(path, codec),
    write: (credentials: AutomationCredentialsFile) => writeAutomationCredentialsFile(path, credentials, codec),
  });
}

type SettingsListener = (settings: AutomationSettingsFile) => void;

/**
 * The App's one settings.json. Reading never writes: main runs the Statement
 * Selection id migration once at startup, so the PGlite worker, which reads
 * the same file, is never a second writer.
 */
export function createAutomationSettingsStore(path: string): AutomationSettingsStore {
  const listeners = new Set<SettingsListener>();
  return Object.freeze({
    path,
    read: () => readAutomationSettingsFile(path),
    write(settings: AutomationSettingsFile, alongside?: () => void) {
      const previous = alongside && existsSync(path) ? readFileSync(path, "utf8") : null;
      writeAutomationSettingsFile(path, settings);
      if (alongside) {
        try {
          alongside();
        } catch (writeError) {
          try {
            if (previous === null) rmSync(path, { force: true });
            else atomicWrite(path, previous);
          } catch (rollbackError) {
            throw new AggregateError(
              [writeError, rollbackError],
              "Credential write failed and automation settings rollback also failed.",
            );
          }
          throw writeError;
        }
      }
      for (const listener of listeners) listener(settings);
    },
    subscribe(listener: SettingsListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

function validManagedFingerprintSecret(value: string | undefined) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

/**
 * Create device-owned identity secrets only with an encrypted credential
 * codec. The secret is intentionally never returned to callers.
 */
export function ensureAutomationManagedSecrets({
  credentialsPath,
  generateFingerprintSecret = () => randomBytes(32).toString("base64url"),
  codec,
}: {
  credentialsPath: string;
  generateFingerprintSecret?: () => string;
  codec: AutomationCredentialCodec | null;
}) {
  requireAutomationCredentialCodec(codec);
  const credentials = readAutomationCredentialsFile(credentialsPath, codec);
  const existing = credentials[FUBON_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
  if (existing !== undefined) {
    if (!validManagedFingerprintSecret(existing)) {
      throw new Error("Managed Fubon card identity secret is invalid.");
    }
    return { created: false as const };
  }

  const secret = generateFingerprintSecret();
  if (!validManagedFingerprintSecret(secret)) {
    throw new Error("Generated Fubon card identity secret is invalid.");
  }
  if (!automationManagedSecretKeys.has(FUBON_CARD_IDENTITY_FINGERPRINT_SECRET_KEY)) {
    throw new Error("Fubon card identity secret is not registered as managed.");
  }
  writeAutomationCredentialsFile(
    credentialsPath,
    {
      ...credentials,
      [FUBON_CARD_IDENTITY_FINGERPRINT_SECRET_KEY]: secret,
    },
    codec,
  );
  return { created: true as const };
}

export function migrateAutomationCredentialsFileEncryption(path: string, codec: AutomationCredentialCodec) {
  if (!existsSync(path)) return false;
  const record = readJsonRecord(path);
  if (encryptedAutomationCredentialsFile(record)) return false;
  const credentials = cleanCredentials(record);
  if (Object.keys(credentials).length === 0) return false;
  writeAutomationCredentialsFile(path, credentials, codec);
  return true;
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
    if (automationUserSecretKeys.has(key) && value.trim()) credentials[key] = value;
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
  envPath,
  settings,
  credentials,
}: Readonly<{
  envPath: string;
  settings: AutomationSettingsStore;
  credentials: AutomationCredentialStore;
}>) {
  if (!existsSync(envPath)) return;
  const envText = readFileSync(envPath, "utf8");
  const parsed = parseEnvText(envText);
  const existingSettings = readAutomationSettingsFile(settings.path);
  const existingCredentials = credentials.read();
  const migrated = splitAutomationUpdates(parsed);

  const hasSettings = Object.keys(migrated.settings).length > 0 || existsSync(settings.path);
  const hasCredentials = Object.keys(migrated.credentials).length > 0 || existsSync(credentials.path);
  if (hasSettings) {
    settings.write({
      ...migrated.settings,
      ...existingSettings,
    });
  }
  if (hasCredentials) {
    credentials.write({
      ...migrated.credentials,
      ...existingCredentials,
    });
  }
  if (Object.keys(migrated.settings).length > 0 || Object.keys(migrated.credentials).length > 0) {
    writeFileSync(envPath, withoutKnownAutomationLines(envText), { encoding: "utf8", mode: 0o600 });
  }
}

/**
 * Statement Selection ids renamed to their Collection product type id
 * (ADR 0060). A persisted selection keeps its order and any attached ids.
 */
const RENAMED_STATEMENT_SELECTION_IDS = [
  { key: "LIBRETTO_CLOUD_SINOPAC_STATEMENT_TYPES", from: "accounts", to: "deposit" },
  { key: "LIBRETTO_CLOUD_LINEBANK_STATEMENT_TYPES", from: "accounts", to: "deposit" },
  { key: "LIBRETTO_CLOUD_YUANTA_TRADE_STATEMENT_TYPES", from: "brokerage", to: "securities" },
] as const;

/**
 * Rewrites renamed Statement Selection ids in settings.json and returns what
 * it wrote; a migrated file is left unchanged and returns null.
 */
export function migrateStatementSelectionIds(settingsPath: string): AutomationSettingsFile | null {
  if (!existsSync(settingsPath)) return null;
  const settings = readAutomationSettingsFile(settingsPath);
  let changed = false;
  for (const { key, from, to } of RENAMED_STATEMENT_SELECTION_IDS) {
    const value = settings[key];
    if (typeof value !== "string") continue;
    const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
    if (!ids.includes(from)) continue;
    settings[key] = [...new Set(ids.map((id) => id === from ? to : id))].join(",");
    changed = true;
  }
  if (!changed) return null;
  writeAutomationSettingsFile(settingsPath, settings);
  return settings;
}

/**
 * A workflow's environment: the process's own variables (PATH and the like)
 * with every key settings.json or credentials.json owns taken from those
 * stores alone, so a variable set in the launching shell never stands in for
 * a setting or credential the App does not hold.
 */
export function automationConfigEnv({
  baseEnv,
  settings,
  credentials,
}: {
  baseEnv: NodeJS.ProcessEnv;
  settings: AutomationSettingsFile;
  credentials: AutomationCredentialsFile;
}) {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of [...automationSettingKeys, ...automationSecretKeys]) delete env[key];
  Object.assign(env, settingsToEnv(settings), credentials);
  for (const key of HOST_ONLY_SECRET_KEYS) delete env[key];
  if (env.NODE_ENV === "production") env.NODE_ENV = "development";
  return env;
}
