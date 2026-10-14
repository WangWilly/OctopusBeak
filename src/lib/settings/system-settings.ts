import type { AutomationSettingsFile } from "../automation/server/config-files.ts";
import { automationFlagEnabled } from "../automation/statement-selection.ts";
import { DEFAULT_SYSTEM_TIMEZONE, isIanaTimezone } from "../time/timezone.ts";

export type SystemSettingsDto = {
  systemTimezone: string;
  exchangeRateUpdateTime: string;
  scheduledCollectionEnabled: boolean;
  scheduledCollectionTime: string;
};

const DAILY_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function validateSystemSettings(input: SystemSettingsDto): SystemSettingsDto {
  if (!isIanaTimezone(input.systemTimezone)) {
    throw new RangeError(`Invalid system time zone: ${input.systemTimezone}`);
  }
  if (!DAILY_TIME.test(input.exchangeRateUpdateTime)) {
    throw new RangeError(`Invalid exchange-rate update time: ${input.exchangeRateUpdateTime}`);
  }
  if (typeof input.scheduledCollectionEnabled !== "boolean") {
    throw new TypeError("Scheduled collection enabled must be a boolean.");
  }
  if (!DAILY_TIME.test(input.scheduledCollectionTime)) {
    throw new RangeError(`Invalid scheduled collection time: ${input.scheduledCollectionTime}`);
  }
  return input;
}

export function systemSettings(settings: AutomationSettingsFile = {}): SystemSettingsDto {
  return validateSystemSettings({
    systemTimezone: String(
      settings.SYSTEM_TIMEZONE ?? settings.AUTOMATION_BUSINESS_TIMEZONE ?? DEFAULT_SYSTEM_TIMEZONE,
    ),
    exchangeRateUpdateTime: String(settings.EXCHANGE_RATE_UPDATE_TIME ?? "06:00"),
    scheduledCollectionEnabled: automationFlagEnabled(settings.SCHEDULED_COLLECTION_ENABLED),
    scheduledCollectionTime: String(settings.SCHEDULED_COLLECTION_TIME ?? "07:00"),
  });
}

/** The settings-file entries that persist a validated value. */
export function systemSettingsFileEntries(value: SystemSettingsDto) {
  return {
    SYSTEM_TIMEZONE: value.systemTimezone,
    EXCHANGE_RATE_UPDATE_TIME: value.exchangeRateUpdateTime,
    SCHEDULED_COLLECTION_ENABLED: value.scheduledCollectionEnabled ? "true" : "false",
    SCHEDULED_COLLECTION_TIME: value.scheduledCollectionTime,
  };
}
