import { writable } from "svelte/store";
import type { SystemSettingsDto } from "./system-settings.ts";
import { DEFAULT_SYSTEM_TIMEZONE } from "../time/timezone.ts";

export const systemTimezone = writable(DEFAULT_SYSTEM_TIMEZONE);
export const exchangeRateUpdateTime = writable("06:00");

export function applySystemSettings(settings: SystemSettingsDto) {
  systemTimezone.set(settings.systemTimezone);
  exchangeRateUpdateTime.set(settings.exchangeRateUpdateTime);
}
