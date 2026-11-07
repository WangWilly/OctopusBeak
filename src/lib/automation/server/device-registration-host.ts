import type { DeviceRegistrationSource } from "../types.ts";
import type { SourceDeviceRegistrationService } from "./source-device-registration.ts";

export function createDeviceRegistrationHost(
  services: Readonly<Record<DeviceRegistrationSource, SourceDeviceRegistrationService>>,
) {
  return Object.freeze({
    status: (source: DeviceRegistrationSource) => services[source].status(),
    start: (source: DeviceRegistrationSource) => services[source].start(),
    submitCode: (source: DeviceRegistrationSource, registrationId: string, code: string) =>
      services[source].submitCode(registrationId, code),
    cancel: (source: DeviceRegistrationSource, registrationId: string) => services[source].cancel(registrationId),
    cancelAll: () => Promise.all(Object.values(services).map((registration) => registration.cancelActive())),
  });
}
