export type TdccDeviceUser = "sync" | "registration";

export const TDCC_SYNC_TASK_ID = "sync-tdcc";

/** Thrown when a sync-tdcc run cannot start because a Source device registration holds the device. */
export class TdccDeviceBusyError extends Error {
  readonly holder: TdccDeviceUser;
  constructor(holder: TdccDeviceUser) {
    super(holder === "registration"
      ? "TDCC device registration is in progress. Finish or cancel it before syncing TDCC."
      : "A TDCC sync is running. Wait for it to finish before registering this device.");
    this.name = "TdccDeviceBusyError";
    this.holder = holder;
  }
}

/**
 * A sync-tdcc run and a TDCC Source device registration both sign in with
 * this installation's device identity, and each fresh sign-in replaces the
 * other's session (ADR 0041), so only one of them may hold the device.
 */
export function createTdccDeviceLock() {
  let holder: TdccDeviceUser | null = null;
  return {
    /** Holds the device for `user`, or returns the other user that holds it. */
    claim(user: TdccDeviceUser): TdccDeviceUser | null {
      if (holder !== null && holder !== user) return holder;
      holder = user;
      return null;
    },
    release(user: TdccDeviceUser) {
      if (holder === user) holder = null;
    },
    holder: () => holder,
  };
}

export type TdccDeviceLock = ReturnType<typeof createTdccDeviceLock>;

export const tdccDeviceLock = createTdccDeviceLock();
