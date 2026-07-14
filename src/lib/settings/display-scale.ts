import { writable } from "svelte/store";

export const DISPLAY_SCALE_MIN = 75;
export const DISPLAY_SCALE_MAX = 150;
export const DISPLAY_SCALE_STEP = 5;
export const DISPLAY_SCALE_DEFAULT = 100;
export const displayScaleStorageKey = "octopusbeak-display-scale";

type DisplayScaleStorage = Pick<Storage, "getItem" | "setItem">;
type DisplayScaleKeyEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "defaultPrevented"
>;
export type DisplayScaleAction = "decrease" | "increase" | "reset";

export const displayScale = writable(DISPLAY_SCALE_DEFAULT);

export function normalizeDisplayScale(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DISPLAY_SCALE_DEFAULT;
  const stepped = Math.round(numeric / DISPLAY_SCALE_STEP) * DISPLAY_SCALE_STEP;
  return Math.min(DISPLAY_SCALE_MAX, Math.max(DISPLAY_SCALE_MIN, stepped));
}

export function readStoredDisplayScale(storage = browserStorage()) {
  const stored = storage?.getItem(displayScaleStorageKey);
  return stored == null ? DISPLAY_SCALE_DEFAULT : normalizeDisplayScale(stored);
}

export function writeStoredDisplayScale(value: number, storage = browserStorage()) {
  storage?.setItem(displayScaleStorageKey, String(normalizeDisplayScale(value)));
}

export function applyDisplayScale(value: unknown, storage = browserStorage()) {
  const normalized = normalizeDisplayScale(value);
  displayScale.set(normalized);
  writeStoredDisplayScale(normalized, storage);
  if (typeof window !== "undefined") window.octopusBeak?.display?.setScale(normalized);
  return normalized;
}

export function displayScaleShortcut(event: DisplayScaleKeyEvent): DisplayScaleAction | null {
  if (event.defaultPrevented || event.altKey || (!event.metaKey && !event.ctrlKey)) return null;
  if (event.key === "-") return "decrease";
  if (event.key === "+" || event.key === "=") return "increase";
  if (event.key === "0") return "reset";
  return null;
}

function browserStorage(): DisplayScaleStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}
