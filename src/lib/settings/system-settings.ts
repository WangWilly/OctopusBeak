import type { AutomationSettingsFile } from "../automation/server/config-files.ts";
import { DEFAULT_SYSTEM_TIMEZONE, isIanaTimezone } from "../time/timezone.ts";

export type SystemSettingsDto = {
  systemTimezone: string;
  exchangeRateUpdateTime: string;
};

export function validateSystemSettings(input: SystemSettingsDto): SystemSettingsDto {
  if (!isIanaTimezone(input.systemTimezone)) {
    throw new RangeError(`Invalid system time zone: ${input.systemTimezone}`);
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.exchangeRateUpdateTime)) {
    throw new RangeError(`Invalid exchange-rate update time: ${input.exchangeRateUpdateTime}`);
  }
  return input;
}

export function systemSettings(settings: AutomationSettingsFile = {}): SystemSettingsDto {
  return validateSystemSettings({
    systemTimezone: String(
      settings.SYSTEM_TIMEZONE ?? settings.AUTOMATION_BUSINESS_TIMEZONE ?? DEFAULT_SYSTEM_TIMEZONE,
    ),
    exchangeRateUpdateTime: String(settings.EXCHANGE_RATE_UPDATE_TIME ?? "06:00"),
  });
}
