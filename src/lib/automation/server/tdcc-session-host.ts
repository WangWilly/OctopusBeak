import {
  tdccConnection,
  type TdccIssuedSession,
  type TdccSessionLease,
  type TdccSignInLease,
} from "../../../workflows/tdcc-session.ts";
import type { StoredTdccDevice, StoredTdccSecrets, TdccSecretStore } from "./tdcc-secret-store.ts";

/** The device the stored sign-in identifier may use, or null when it must be registered first. */
function registeredDevice(secrets: StoredTdccSecrets): StoredTdccDevice | null {
  return secrets.userId && secrets.password && secrets.device?.userId === secrets.userId
    ? secrets.device
    : null;
}

/** The host side of one run's TdccSessionPort. */
export type TdccSessionHost = Readonly<{
  open(): TdccSessionLease;
  signInDetails(): TdccSignInLease;
  saveSession(session: TdccIssuedSession): void;
}>;

/**
 * Serves one run. A session is saved only while the device the run leased is
 * still the registered one, so a run that overlaps a new registration or a
 * changed sign-in identifier cannot overwrite the newer session.
 */
export function createTdccSessionHost(store: TdccSecretStore): TdccSessionHost {
  let leasedDeviceId: string | null = null;
  const current = () => {
    const secrets = store.read();
    const device = registeredDevice(secrets);
    return device && (leasedDeviceId === null || device.deviceId === leasedDeviceId)
      ? { password: secrets.password!, session: secrets.session, device }
      : null;
  };
  return {
    open() {
      const registered = current();
      if (!registered) return { status: "device-registration-required" };
      const { device, session } = registered;
      leasedDeviceId = device.deviceId;
      return {
        status: "ready",
        connection: tdccConnection(device.userId),
        device: { deviceId: device.deviceId, devType: device.devType, devModel: device.devModel },
        session: session ?? null,
      };
    },
    signInDetails() {
      const registered = leasedDeviceId === null ? null : current();
      return registered
        ? { status: "ready", details: { userId: registered.device.userId, password: registered.password } }
        : { status: "device-registration-required" };
    },
    saveSession(session) {
      if (leasedDeviceId !== null && current()) store.write({ session });
    },
  };
}
