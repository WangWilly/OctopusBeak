import type { Page } from "playwright";
import {
  CathayDeviceRegistrationError,
  registerCathayTrustedDevice,
} from "../../../workflows/cathay-device-registration.ts";
import type { CathayCredentials } from "../../../workflows/cathay-statements.ts";
import {
  CATHAY_TRUSTED_DEVICE_USER_ID_KEY,
  type AutomationCredentialStore,
} from "./config-files.ts";
import { sourceDeviceLocks, type SourceDeviceLock } from "./source-device-lock.ts";
import {
  createSourceDeviceRegistrationService,
  DeviceRegistrationError,
} from "./source-device-registration.ts";

export type CathaySecretStore = Readonly<{
  read(): Readonly<{ details: CathayCredentials | null; trustedUserId: string | null }>;
  markTrusted(userId: string): void;
}>;

export function createCathaySecretStore(store: AutomationCredentialStore): CathaySecretStore {
  return {
    read() {
      const credentials = store.read();
      const userId = credentials.LIBRETTO_CLOUD_CATHAY_USER_ID?.trim();
      const account = credentials.LIBRETTO_CLOUD_CATHAY_ACCOUNT?.trim();
      const password = credentials.LIBRETTO_CLOUD_CATHAY_PASSWORD?.trim();
      return {
        details: userId && account && password
          ? { cathay_user_id: userId, cathay_account: account, cathay_password: password }
          : null,
        // Compared with the trimmed sign-in ID, so a device trusted before trimming still matches.
        trustedUserId: credentials[CATHAY_TRUSTED_DEVICE_USER_ID_KEY]?.trim() || null,
      };
    },
    markTrusted(userId) {
      const credentials = store.read();
      credentials[CATHAY_TRUSTED_DEVICE_USER_ID_KEY] = userId;
      store.write(credentials);
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
