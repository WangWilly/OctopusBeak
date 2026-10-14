import { writable } from "svelte/store";
import type { SystemSettingsDto } from "./system-settings.ts";
import { DEFAULT_SYSTEM_TIMEZONE } from "../time/timezone.ts";

export const systemTimezone = writable(DEFAULT_SYSTEM_TIMEZONE);
export const exchangeRateUpdateTime = writable("06:00");
export const scheduledCollection = writable({ enabled: false, time: "07:00" });

export function applySystemSettings(settings: SystemSettingsDto) {
  systemTimezone.set(settings.systemTimezone);
  exchangeRateUpdateTime.set(settings.exchangeRateUpdateTime);
  scheduledCollection.set({
    enabled: settings.scheduledCollectionEnabled,
    time: settings.scheduledCollectionTime,
  });
}
