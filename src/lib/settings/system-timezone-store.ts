import { derived, writable } from "svelte/store";
import type { SystemSettingsDto } from "./system-settings.ts";
import { DEFAULT_SYSTEM_TIMEZONE } from "../time/timezone.ts";
import { dateInTimeZone } from "../shared-ledger/twd-valuation.ts";

export const systemTimezone = writable(DEFAULT_SYSTEM_TIMEZONE);
/** The person's local date; it moves forward at midnight while the app stays open. */
export const localDate = derived<typeof systemTimezone, string>(systemTimezone, (timeZone, set) => {
  const update = () => set(dateInTimeZone(new Date(), timeZone));
  update();
  const timer = setInterval(update, 60_000);
  return () => clearInterval(timer);
});
export const exchangeRateUpdateTime = writable("06:00");
export const scheduledCollection = writable({ enabled: false, time: "07:00" });
export const previewFeaturesEnabled = writable(false);
export const usageStatisticsEnabled = writable(false);
export const appUpdatesEnabled = writable(true);
export const appUpdatesAutoDownload = writable(false);

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
  appUpdatesAutoDownload.set(settings.appUpdatesAutoDownload);
}
