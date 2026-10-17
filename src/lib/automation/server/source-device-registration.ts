import { randomUUID } from "node:crypto";
import type {
  DeviceRegistrationChannel,
  DeviceRegistrationFailure,
  DeviceRegistrationStatus,
  DeviceRegistrationStep,
} from "../types.ts";
import type { SourceDeviceLock } from "./source-device-lock.ts";

const DEFAULT_CODE_TIMEOUT_MS = 10 * 60_000;

export class DeviceRegistrationError extends Error {
  readonly reason: DeviceRegistrationFailure;
  constructor(reason: DeviceRegistrationFailure) {
    super(`Device registration failed: ${reason}.`);
    this.name = "DeviceRegistrationError";
    this.reason = reason;
  }
}

export type DeviceRegistrationPorts = Readonly<{
  signal: AbortSignal;
  readCode(channel: DeviceRegistrationChannel): Promise<string>;
}>;

export type SourceDeviceRegistrationOptions = Readonly<{
  lock: SourceDeviceLock;
  codeTimeoutMs?: number;
  status(): DeviceRegistrationStatus;
  register(ports: DeviceRegistrationPorts): Promise<readonly DeviceRegistrationChannel[]>;
  failure?(error: unknown): DeviceRegistrationFailure;
}>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Registration = {
  readonly id: string;
  readonly controller: AbortController;
  next: ReturnType<typeof deferred<DeviceRegistrationStep>>;
  code: ReturnType<typeof deferred<string>> | null;
  timer: ReturnType<typeof setTimeout> | null;
  closedReason: "expired" | "cancelled" | null;
};

export function createSourceDeviceRegistrationService(options: SourceDeviceRegistrationOptions) {
  const codeTimeoutMs = options.codeTimeoutMs ?? DEFAULT_CODE_TIMEOUT_MS;
  let active: Registration | null = null;
  let closed: Readonly<{ id: string; reason: DeviceRegistrationFailure }> | null = null;

  const settle = (registration: Registration) => {
    if (registration.timer) clearTimeout(registration.timer);
    registration.timer = null;
    if (active !== registration) return;
    active = null;
    options.lock.release("registration");
  };

  const close = (registration: Registration, reason: "expired" | "cancelled") => {
    if (active !== registration) return;
    registration.closedReason = reason;
    settle(registration);
    closed = { id: registration.id, reason };
    registration.controller.abort();
    registration.code?.reject(new DeviceRegistrationError(reason));
  };

  const failure = (registration: Registration, error: unknown): DeviceRegistrationFailure => {
    if (registration.closedReason) return registration.closedReason;
    if (error instanceof DeviceRegistrationError) return error.reason;
    return options.failure?.(error) ?? "unavailable";
  };

  function launch(registration: Registration) {
    options.register({
      signal: registration.controller.signal,
      readCode: (channel) => {
        const code = deferred<string>();
        registration.code = code;
        registration.timer = setTimeout(() => close(registration, "expired"), codeTimeoutMs);
        registration.timer.unref?.();
        registration.next.resolve({ status: "code-required", registrationId: registration.id, channel });
        return code.promise;
      },
    }).then(
      (channels) => {
        settle(registration);
        registration.next.resolve({ status: "registered", channels });
      },
      (error: unknown) => {
        settle(registration);
        registration.next.resolve({ status: "failed", reason: failure(registration, error) });
      },
    );
  }

  return {
    status: () => options.status(),

    async start(): Promise<DeviceRegistrationStep> {
      if (active) close(active, "cancelled");
      if (options.lock.claim("registration")) return { status: "failed", reason: "sync-running" };
      const registration: Registration = {
        id: randomUUID(),
        controller: new AbortController(),
        next: deferred(),
        code: null,
        timer: null,
        closedReason: null,
      };
      active = registration;
      launch(registration);
      return await registration.next.promise;
    },

    async submitCode(registrationId: string, code: string): Promise<DeviceRegistrationStep> {
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

export type SourceDeviceRegistrationService = ReturnType<typeof createSourceDeviceRegistrationService>;
