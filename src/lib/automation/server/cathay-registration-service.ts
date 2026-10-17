import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import {
  CathayDeviceRegistrationError,
  registerCathayTrustedDevice,
} from "../../../workflows/cathay-device-registration.ts";
import type { CathayCredentials } from "../../../workflows/cathay-statements.ts";
import { createAppWorkflowBrowserPort } from "./app-browser-host.ts";
import {
  AUTOMATION_CREDENTIALS_PATH,
  CATHAY_TRUSTED_DEVICE_USER_ID_KEY,
  getAutomationCredentialCodec,
  readAutomationCredentialsFile,
  writeAutomationCredentialsFile,
  type AutomationCredentialCodec,
} from "./config-files.ts";
import { DEVICE_REGISTRATION_TASK_IDS, sourceDeviceLocks, type SourceDeviceLock } from "./source-device-lock.ts";
import {
  createSourceDeviceRegistrationService,
  DeviceRegistrationError,
  type SourceDeviceRegistrationService,
} from "./source-device-registration.ts";

export type CathaySignInDetails = Required<CathayCredentials>;

export type CathaySecretStore = Readonly<{
  read(): Readonly<{ details: CathaySignInDetails | null; trustedUserId: string | null }>;
  markTrusted(userId: string): void;
}>;

export function createCathaySecretStore(credentialsPath: string, codec: AutomationCredentialCodec): CathaySecretStore {
  return {
    read() {
      const credentials = readAutomationCredentialsFile(credentialsPath, codec);
      const userId = credentials.LIBRETTO_CLOUD_CATHAY_USER_ID;
      const account = credentials.LIBRETTO_CLOUD_CATHAY_ACCOUNT;
      const password = credentials.LIBRETTO_CLOUD_CATHAY_PASSWORD;
      return {
        details: userId && account && password
          ? { cathay_user_id: userId, cathay_account: account, cathay_password: password }
          : null,
        trustedUserId: credentials[CATHAY_TRUSTED_DEVICE_USER_ID_KEY] || null,
      };
    },
    markTrusted(userId) {
      const credentials = readAutomationCredentialsFile(credentialsPath, codec);
      credentials[CATHAY_TRUSTED_DEVICE_USER_ID_KEY] = userId;
      writeAutomationCredentialsFile(credentialsPath, credentials, codec);
    },
  };
}

export type CathayRegistrationServiceOptions = Readonly<{
  store: CathaySecretStore;
  withCathayTaskPage<T>(signal: AbortSignal, run: (page: Page) => Promise<T>): Promise<T>;
  codeTimeoutMs?: number;
  deviceLock?: SourceDeviceLock;
}>;

export function createCathayRegistrationService(options: CathayRegistrationServiceOptions) {
  return createSourceDeviceRegistrationService({
    lock: options.deviceLock ?? sourceDeviceLocks.cathay,
    ...(options.codeTimeoutMs === undefined ? {} : { codeTimeoutMs: options.codeTimeoutMs }),
    failure: (error) => error instanceof CathayDeviceRegistrationError ? error.reason : "unavailable",
    status() {
      const { details, trustedUserId } = options.store.read();
      return { registered: Boolean(details && trustedUserId === details.cathay_user_id) };
    },
    async register({ signal, readCode }) {
      const { details } = options.store.read();
      if (!details) throw new DeviceRegistrationError("sign-in-details-missing");
      const result = await options.withCathayTaskPage(signal, (page) =>
        registerCathayTrustedDevice(page, { credentials: details, readCode, signal }));
      signal.throwIfAborted();
      options.store.markTrusted(details.cathay_user_id);
      return result.kind === "registered" ? [result.channel] : [];
    },
  });
}

let configuredService: SourceDeviceRegistrationService | null = null;

export function cathayRegistrationService(): SourceDeviceRegistrationService {
  if (configuredService) return configuredService;
  const codec = getAutomationCredentialCodec();
  if (!codec) throw new Error("Encrypted credential storage is unavailable.");
  configuredService = createCathayRegistrationService({
    store: createCathaySecretStore(AUTOMATION_CREDENTIALS_PATH, codec),
    withCathayTaskPage: (signal, run) => createAppWorkflowBrowserPort({
      taskId: DEVICE_REGISTRATION_TASK_IDS.cathay,
      taskRunId: `device-registration-${randomUUID()}`,
      signal,
      userDataDirectory: process.env.OCTOPUSBEAK_USER_DATA ?? process.cwd(),
      browserProfile: "cathay-login",
    }).withPage(run),
  });
  return configuredService;
}
