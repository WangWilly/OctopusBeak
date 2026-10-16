import type { DeviceRegistrationSource } from "../types.ts";
import { cathayRegistrationService } from "./cathay-registration-service.ts";
import type { SourceDeviceRegistrationService } from "./source-device-registration.ts";
import { tdccRegistrationService } from "./tdcc-registration-service.ts";

const services: Readonly<Record<DeviceRegistrationSource, () => SourceDeviceRegistrationService>> = {
  tdcc: tdccRegistrationService,
  cathay: cathayRegistrationService,
};

export const deviceRegistrationStatus = (source: DeviceRegistrationSource) => services[source]().status();
export const startDeviceRegistration = (source: DeviceRegistrationSource) => services[source]().start();
export const submitDeviceRegistrationCode = (source: DeviceRegistrationSource, registrationId: string, code: string) =>
  services[source]().submitCode(registrationId, code);
export const cancelDeviceRegistration = (source: DeviceRegistrationSource, registrationId: string) =>
  services[source]().cancel(registrationId);
