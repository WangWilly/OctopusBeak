import { randomUUID } from "node:crypto";
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
import type {
  TdccDeviceRegistrationStatus,
  TdccRegistrationFailure,
  TdccRegistrationStep,
} from "../types.ts";

export type TdccRegistrationServiceOptions = Readonly<{
  store: TdccSecretStore;
  fetch?: TdccClientOptions["fetch"];
  now?: () => Date;
  /** How long the host keeps a registration waiting for the person's code. */
  codeTimeoutMs?: number;
  createDevice?: () => TdccDeviceIdentity;
}>;

/** TDCC codes stay valid for a few minutes; a registration left longer is abandoned. */
const DEFAULT_CODE_TIMEOUT_MS = 10 * 60_000;

class RegistrationClosedError extends Error {
  readonly reason: "expired" | "cancelled";
  constructor(reason: "expired" | "cancelled") {
    super(`TDCC registration ${reason}.`);
    this.reason = reason;
  }
}

class NotTrustedAfterRegistrationError extends Error {}

class SignInDetailsMissingError extends Error {}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function failure(error: unknown): TdccRegistrationFailure {
  if (error instanceof RegistrationClosedError) return error.reason;
  if (error instanceof NotTrustedAfterRegistrationError) return "not-trusted";
  if (error instanceof SignInDetailsMissingError) return "sign-in-details-missing";
  if (!(error instanceof TdccError)) return "unavailable";
  switch (error.failure.reason) {
    case "otp-expired": return "code-expired";
    case "protocol-outdated": return "protocol-outdated";
    case "device-untrusted": return "not-trusted";
    case "rejected": return error.endpoint === "verifyOtp" ? "code-rejected" : "sign-in-rejected";
    default: return "unavailable";
  }
}

type Registration = {
  readonly id: string;
  readonly controller: AbortController;
  next: ReturnType<typeof deferred<TdccRegistrationStep>>;
  code: ReturnType<typeof deferred<string>> | null;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * Source device registration for TDCC (ADR 0041), run across IPC calls. The
 * host keeps the registration between calls; the one-time codes pass straight
 * to TDCC and are never stored. A registered device and its session are saved
 * only when TDCC trusts the device on a fresh sign-in.
 */
export function createTdccRegistrationService(options: TdccRegistrationServiceOptions) {
  const now = options.now ?? (() => new Date());
  const codeTimeoutMs = options.codeTimeoutMs ?? DEFAULT_CODE_TIMEOUT_MS;
  let active: Registration | null = null;
  let closed: Readonly<{ id: string; reason: TdccRegistrationFailure }> | null = null;

  const close = (registration: Registration, reason: "expired" | "cancelled") => {
    if (active !== registration) return;
    if (registration.timer) clearTimeout(registration.timer);
    active = null;
    closed = { id: registration.id, reason };
    registration.controller.abort();
    registration.code?.reject(new RegistrationClosedError(reason));
  };

  async function register(registration: Registration) {
    const secrets = options.store.read();
    if (!secrets.userId || !secrets.password) throw new SignInDetailsMissingError();
    const details = { userId: secrets.userId, password: secrets.password };
    const stored = secrets.device?.userId === details.userId ? secrets.device : null;
    const device: StoredTdccDevice = stored ?? { ...(options.createDevice ?? createTdccDeviceIdentity)(), userId: details.userId };
    const client = new TdccClient({
      identity: device,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      signal: registration.controller.signal,
      now,
    });
    const result = await registerTdccDevice({
      client,
      details,
      readOtp: (channel) => {
        const code = deferred<string>();
        registration.code = code;
        registration.timer = setTimeout(() => close(registration, "expired"), codeTimeoutMs);
        registration.timer.unref?.();
        registration.next.resolve({ status: "code-required", registrationId: registration.id, channel });
        return code.promise;
      },
    });
    if (result.kind === "registered") {
      await client.getInitialToken();
      if ((await client.login(details)).kind !== "trusted") throw new NotTrustedAfterRegistrationError();
    }
    if (active !== registration) throw new RegistrationClosedError("cancelled");
    options.store.write({ device, session: { ...client.exportSession(), issuedAt: now().toISOString() } });
    return result.kind === "registered" ? result.channels : [];
  }

  function launch(registration: Registration) {
    register(registration).then(
      (channels) => {
        if (active === registration) active = null;
        registration.next.resolve({ status: "registered", channels });
      },
      (error: unknown) => {
        if (active === registration) {
          active = null;
          if (registration.timer) clearTimeout(registration.timer);
        }
        registration.next.resolve({ status: "failed", reason: failure(error) });
      },
    );
  }

  return {
    status(): TdccDeviceRegistrationStatus {
      const secrets = options.store.read();
      return { registered: Boolean(secrets.userId && secrets.password && secrets.device?.userId === secrets.userId) };
    },

    /** Signs in and, when TDCC does not trust the device, sends the first code. Replaces any registration in progress. */
    async start(): Promise<TdccRegistrationStep> {
      if (active) close(active, "cancelled");
      const registration: Registration = {
        id: randomUUID(),
        controller: new AbortController(),
        next: deferred(),
        code: null,
        timer: null,
      };
      active = registration;
      launch(registration);
      return await registration.next.promise;
    },

    async submitCode(registrationId: string, code: string): Promise<TdccRegistrationStep> {
      const registration = active;
      if (!registration || registration.id !== registrationId || !registration.code) {
        return { status: "failed", reason: closed?.id === registrationId ? closed.reason : "not-found" };
      }
      if (registration.timer) clearTimeout(registration.timer);
      registration.timer = null;
      const pending = registration.code;
      registration.code = null;
      registration.next = deferred();
      pending.resolve(code);
      return await registration.next.promise;
    },

    cancel(registrationId: string) {
      if (active?.id === registrationId) close(active, "cancelled");
    },
  };
}

export type TdccRegistrationService = ReturnType<typeof createTdccRegistrationService>;

let configuredService: TdccRegistrationService | null = null;

function service(): TdccRegistrationService {
  if (configuredService) return configuredService;
  const codec = getAutomationCredentialCodec();
  if (!codec) throw new Error("Encrypted credential storage is unavailable.");
  configuredService = createTdccRegistrationService({ store: createTdccSecretStore(AUTOMATION_CREDENTIALS_PATH, codec) });
  return configuredService;
}

export const tdccDeviceRegistrationStatus = () => service().status();
export const startTdccDeviceRegistration = () => service().start();
export const submitTdccRegistrationCode = (registrationId: string, code: string) => service().submitCode(registrationId, code);
export const cancelTdccDeviceRegistration = (registrationId: string) => service().cancel(registrationId);
