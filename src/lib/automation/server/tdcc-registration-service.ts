import {
  createTdccDeviceIdentity,
  TdccClient,
  TdccError,
  type TdccClientOptions,
  type TdccDeviceIdentity,
} from "../../../workflows/tdcc-epassbook-client.ts";
import { registerTdccDevice } from "../../../workflows/tdcc-device-registration.ts";
import { AUTOMATION_CREDENTIALS_PATH, getAutomationCredentialCodec } from "./config-files.ts";
import { createTdccSecretStore, type StoredTdccDevice, type TdccSecretStore } from "./tdcc-secret-store.ts";
import { sourceDeviceLocks, type SourceDeviceLock } from "./source-device-lock.ts";
import {
  createSourceDeviceRegistrationService,
  DeviceRegistrationError,
  type SourceDeviceRegistrationService,
} from "./source-device-registration.ts";
import type { DeviceRegistrationFailure } from "../types.ts";

export type TdccRegistrationServiceOptions = Readonly<{
  store: TdccSecretStore;
  fetch?: TdccClientOptions["fetch"];
  now?: () => Date;
  /** How long the host keeps a registration waiting for the person's code. */
  codeTimeoutMs?: number;
  createDevice?: () => TdccDeviceIdentity;
  deviceLock?: SourceDeviceLock;
}>;

function failure(error: unknown): DeviceRegistrationFailure {
  if (!(error instanceof TdccError)) return "unavailable";
  switch (error.failure.reason) {
    case "otp-expired": return "code-expired";
    case "protocol-outdated": return "protocol-outdated";
    case "device-untrusted": return "not-trusted";
    case "rejected": return error.endpoint === "verifyOtp" ? "code-rejected" : "sign-in-rejected";
    default: return "unavailable";
  }
}

export function createTdccRegistrationService(options: TdccRegistrationServiceOptions) {
  const now = options.now ?? (() => new Date());
  return createSourceDeviceRegistrationService({
    lock: options.deviceLock ?? sourceDeviceLocks.tdcc,
    ...(options.codeTimeoutMs === undefined ? {} : { codeTimeoutMs: options.codeTimeoutMs }),
    failure,
    status() {
      const secrets = options.store.read();
      return { registered: Boolean(secrets.userId && secrets.password && secrets.device?.userId === secrets.userId) };
    },
    async register({ signal, readCode }) {
      const secrets = options.store.read();
      if (!secrets.userId || !secrets.password) throw new DeviceRegistrationError("sign-in-details-missing");
      const details = { userId: secrets.userId, password: secrets.password };
      const stored = secrets.device?.userId === details.userId ? secrets.device : null;
      const device: StoredTdccDevice = stored ?? { ...(options.createDevice ?? createTdccDeviceIdentity)(), userId: details.userId };
      const client = new TdccClient({
        identity: device,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        signal,
        now,
      });
      const result = await registerTdccDevice({ client, details, readOtp: readCode });
      if (result.kind === "registered") {
        await client.getInitialToken();
        if ((await client.login(details)).kind !== "trusted") throw new DeviceRegistrationError("not-trusted");
      }
      signal.throwIfAborted();
      options.store.write({ device, session: { ...client.exportSession(), issuedAt: now().toISOString() } });
      return result.kind === "registered" ? result.channels : [];
    },
  });
}

let configuredService: SourceDeviceRegistrationService | null = null;
let fixtureFetch: TdccClientOptions["fetch"] | undefined;

/** Development CDP fixture only: answer registration from a scripted TDCC instead of the network. */
export function useTdccRegistrationFixture(fetch: NonNullable<TdccClientOptions["fetch"]>) {
  fixtureFetch = fetch;
  configuredService = null;
}

export function tdccRegistrationService(): SourceDeviceRegistrationService {
  if (configuredService) return configuredService;
  const codec = getAutomationCredentialCodec();
  if (!codec) throw new Error("Encrypted credential storage is unavailable.");
  configuredService = createTdccRegistrationService({
    store: createTdccSecretStore(AUTOMATION_CREDENTIALS_PATH, codec),
    ...(fixtureFetch ? { fetch: fixtureFetch } : {}),
  });
  return configuredService;
}
