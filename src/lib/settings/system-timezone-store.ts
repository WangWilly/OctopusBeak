import { writable } from "svelte/store";
import type { SystemSettingsDto } from "./system-settings.ts";
import { DEFAULT_SYSTEM_TIMEZONE } from "../time/timezone.ts";

export const systemTimezone = writable(DEFAULT_SYSTEM_TIMEZONE);
export const exchangeRateUpdateTime = writable("06:00");
export const scheduledCollection = writable({ enabled: false, time: "07:00" });
export const previewFeaturesEnabled = writable(false);
export const usageStatisticsEnabled = writable(false);
export const appUpdatesEnabled = writable(true);

export function applySystemSettings(settings: SystemSettingsDto) {
  systemTimezone.set(settings.systemTimezone);
  exchangeRateUpdateTime.set(settings.exchangeRateUpdateTime);
  scheduledCollection.set({
    enabled: settings.scheduledCollectionEnabled,
    time: settings.scheduledCollectionTime,
  });
  previewFeaturesEnabled.set(settings.previewFeaturesEnabled);
  usageStatisticsEnabled.set(settings.usageStatisticsEnabled);
  appUpdatesEnabled.set(settings.appUpdatesEnabled);
}
