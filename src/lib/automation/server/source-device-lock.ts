import type { DeviceRegistrationSource } from "../types.ts";

export type SourceDeviceUser = "sync" | "registration";

export const DEVICE_REGISTRATION_TASK_IDS = {
  tdcc: "sync-tdcc",
  cathay: "cathay-all-statements",
} as const satisfies Record<DeviceRegistrationSource, string>;

export class SourceDeviceBusyError extends Error {
  readonly source: DeviceRegistrationSource;
  readonly holder: SourceDeviceUser;
  constructor(source: DeviceRegistrationSource, holder: SourceDeviceUser) {
    super(holder === "registration"
      ? "Device registration is in progress for this source. Finish or cancel it before syncing."
      : "A sync is running for this source. Wait for it to finish before registering this device.");
    this.name = "SourceDeviceBusyError";
    this.source = source;
    this.holder = holder;
  }
}

export function createSourceDeviceLock() {
  let holder: SourceDeviceUser | null = null;
  return {
    claim(user: SourceDeviceUser): SourceDeviceUser | null {
      if (holder !== null && holder !== user) return holder;
      holder = user;
      return null;
    },
    release(user: SourceDeviceUser) {
      if (holder === user) holder = null;
    },
    holder: () => holder,
  };
}

export type SourceDeviceLock = ReturnType<typeof createSourceDeviceLock>;

export const sourceDeviceLocks: Readonly<Record<DeviceRegistrationSource, SourceDeviceLock>> = {
  tdcc: createSourceDeviceLock(),
  cathay: createSourceDeviceLock(),
};

export function sourceDeviceForTask(
  taskId: string,
): Readonly<{ source: DeviceRegistrationSource; lock: SourceDeviceLock }> | null {
  for (const [source, deviceTaskId] of Object.entries(DEVICE_REGISTRATION_TASK_IDS)) {
    if (deviceTaskId === taskId) {
      const registrationSource = source as DeviceRegistrationSource;
      return { source: registrationSource, lock: sourceDeviceLocks[registrationSource] };
    }
  }
  return null;
}
