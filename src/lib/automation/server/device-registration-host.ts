import type { DeviceRegistrationSource } from "../types.ts";
import { cathayRegistrationService } from "./cathay-registration-service.ts";
import type { SourceDeviceRegistrationService } from "./source-device-registration.ts";
import { tdccRegistrationService } from "./tdcc-registration-service.ts";

const services: Readonly<Record<DeviceRegistrationSource, () => SourceDeviceRegistrationService>> = {
  tdcc: tdccRegistrationService,
  cathay: cathayRegistrationService,
};

const used = new Set<SourceDeviceRegistrationService>();
function service(source: DeviceRegistrationSource) {
  const registration = services[source]();
  used.add(registration);
  return registration;
}

export const deviceRegistrationStatus = (source: DeviceRegistrationSource) => service(source).status();
export const startDeviceRegistration = (source: DeviceRegistrationSource) => service(source).start();
export const submitDeviceRegistrationCode = (source: DeviceRegistrationSource, registrationId: string, code: string) =>
  service(source).submitCode(registrationId, code);
export const cancelDeviceRegistration = (source: DeviceRegistrationSource, registrationId: string) =>
  service(source).cancel(registrationId);
export const cancelAllDeviceRegistrations = () =>
  Promise.all([...used].map((registration) => registration.cancelActive()));
