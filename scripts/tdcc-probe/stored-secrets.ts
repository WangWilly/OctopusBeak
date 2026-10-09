import {
  TDCC_DEVICE_IDENTITY_KEY,
  TDCC_PASSWORD_KEY,
  TDCC_SESSION_KEY,
  TDCC_USER_ID_KEY,
  readAutomationCredentialsFile,
  writeAutomationCredentialsFile,
  type AutomationCredentialCodec,
} from "../../src/lib/automation/server/config-files.ts";
import type { TdccDeviceIdentity, TdccSession } from "../../src/workflows/tdcc-epassbook-client.ts";

/** A device identity is bound to the sign-in identifier it was registered for. */
export type StoredTdccDevice = TdccDeviceIdentity & Readonly<{ userId: string }>;
export type StoredTdccSession = TdccSession & Readonly<{ issuedAt: string }>;

export type StoredTdccSecrets = Readonly<{
  userId?: string;
  password?: string;
  device?: StoredTdccDevice;
  session?: StoredTdccSession;
}>;

export type TdccSecretStore = Readonly<{
  read(): StoredTdccSecrets;
  /** `session: null` forgets the stored session; omitted keys stay as they are. */
  write(update: Omit<StoredTdccSecrets, "session"> & { session?: StoredTdccSession | null }): void;
}>;

function parseRecord(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function parseDevice(text: string | undefined): StoredTdccDevice | undefined {
  const record = parseRecord(text);
  if (!record) return undefined;
  const { userId, deviceId, devType, devModel } = record;
  return isString(userId) && isString(deviceId) && isString(devType) && isString(devModel)
    ? { userId, deviceId, devType, devModel }
    : undefined;
}

function parseSession(text: string | undefined): StoredTdccSession | undefined {
  const record = parseRecord(text);
  if (!record || !isString(record.issuedAt)) return undefined;
  const nullableString = (value: unknown) => isString(value) ? value : null;
  return { tokenId: nullableString(record.tokenId), richUrl: nullableString(record.richUrl), issuedAt: record.issuedAt };
}

/** Reads and writes only the TDCC keys; every write re-reads the file so other keys are kept. */
export function createTdccSecretStore(credentialsPath: string, codec: AutomationCredentialCodec): TdccSecretStore {
  return {
    read() {
      const credentials = readAutomationCredentialsFile(credentialsPath, codec);
      return {
        userId: credentials[TDCC_USER_ID_KEY] || undefined,
        password: credentials[TDCC_PASSWORD_KEY] || undefined,
        device: parseDevice(credentials[TDCC_DEVICE_IDENTITY_KEY]),
        session: parseSession(credentials[TDCC_SESSION_KEY]),
      };
    },
    write(update) {
      const credentials = readAutomationCredentialsFile(credentialsPath, codec);
      if (update.userId !== undefined) credentials[TDCC_USER_ID_KEY] = update.userId;
      if (update.password !== undefined) credentials[TDCC_PASSWORD_KEY] = update.password;
      if (update.device !== undefined) credentials[TDCC_DEVICE_IDENTITY_KEY] = JSON.stringify(update.device);
      if (update.session === null) delete credentials[TDCC_SESSION_KEY];
      else if (update.session !== undefined) credentials[TDCC_SESSION_KEY] = JSON.stringify(update.session);
      writeAutomationCredentialsFile(credentialsPath, credentials, codec);
    },
  };
}
