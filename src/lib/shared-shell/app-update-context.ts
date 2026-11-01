import type { Readable } from "svelte/store";
import type { AppUpdateRestartResult, AppUpdateView } from "$lib/settings/app-updates.ts";

/** The route root subscribes once to the updater and shares it with the sidebar and Settings. */
export type AppUpdateUiContext = Readonly<{
  view: Readable<AppUpdateView | null>;
  /** Restart to update waits until no run is active; the main process refuses it too. */
  runActive: Readable<boolean>;
  check(): Promise<void>;
  download(): Promise<void>;
  restart(): Promise<AppUpdateRestartResult>;
}>;

export const APP_UPDATE_CONTEXT_KEY = Symbol("octopus-beak.app-update-context");

/** Whole percent for the progress bar; a download reports only whole-percent steps. */
export function downloadPercent(received: number, total: number) {
  return Math.min(100, Math.floor((received / total) * 100));
}

export function megabytes(bytes: number) {
  return (bytes / 1_000_000).toFixed(0);
}
