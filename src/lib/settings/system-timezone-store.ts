import { derived, readable, writable, type Readable } from "svelte/store";
import type { SystemSettingsDto } from "./system-settings.ts";
import { DEFAULT_SYSTEM_TIMEZONE } from "../time/timezone.ts";
import { dateInTimeZone } from "../shared-ledger/twd-valuation.ts";

export const systemTimezone = writable(DEFAULT_SYSTEM_TIMEZONE);
/** A date in a time zone that moves forward at midnight while the app stays open. */
function dateIn(timeZone: Readable<string>) {
  return derived<Readable<string>, string>(timeZone, (zone, set) => {
    const update = () => set(dateInTimeZone(new Date(), zone));
    update();
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  });
}
/** The person's local date. */
export const localDate = dateIn(systemTimezone);
/** The ledger's Asia/Taipei date, the calendar Spending groups purchases by (ADR 0077). */
export const taipeiDate = dateIn(readable("Asia/Taipei"));
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
