/**
 * ADR 0083: the updater asks GitHub, never us, for the latest release. The release workflow writes this
 * file (scripts/update-feed.mjs); releases/latest skips drafts and prereleases.
 */
export const APP_UPDATE_FEED_URL =
  "https://github.com/WangWilly/OctopusBeak/releases/latest/download/update-feed-darwin-arm64.json";

export const APP_UPDATES_ENABLED_KEY = "APP_UPDATES_ENABLED";
export const APP_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** What the updater is doing, as Settings shows it. */
export type AppUpdateState =
  | { status: "off" }
  | { status: "unsupported"; reason: "development-build" | "read-only-volume" }
  /** checkedAt is null until the first check of this launch finds nothing. */
  | { status: "idle"; checkedAt: string | null }
  | { status: "checking" }
  | { status: "downloading" }
  | { status: "ready"; version: string }
  /** Silent: the next interval tries again. */
  | { status: "failed"; code: "check-failed" | "download-failed" };

/** The switch and requests from the App, then Squirrel.Mac's autoUpdater events. */
export type AppUpdateEvent =
  | { type: "enable" }
  | { type: "disable" }
  | { type: "check" }
  | { type: "update-available" }
  | { type: "update-not-available"; at: string }
  | { type: "update-downloaded"; version: string }
  | { type: "error"; readOnlyVolume: boolean };

/** What Electron's autoUpdater emits, as the adapter in electron/main.ts passes it on. */
export type AppUpdaterSignal =
  | { type: "checking-for-update" }
  | { type: "update-available" }
  | { type: "update-not-available" }
  | { type: "update-downloaded"; releaseName: string }
  | { type: "error"; message: string };

export type AppUpdateRestartResult =
  | { ok: true }
  | { ok: false; reason: "not-ready" | "run-active" };

export function initialAppUpdateState(input: { supported: boolean; enabled: boolean }): AppUpdateState {
  if (!input.supported) return { status: "unsupported", reason: "development-build" };
  return input.enabled ? { status: "idle", checkedAt: null } : { status: "off" };
}

export function reduceAppUpdate(state: AppUpdateState, event: AppUpdateEvent): AppUpdateState {
  // Neither moves: a development build has no updater, and the volume stays read-only for this launch.
  if (state.status === "unsupported") return state;
  switch (event.type) {
    case "enable":
      return state.status === "off" ? { status: "idle", checkedAt: null } : state;
    case "disable":
      // Squirrel.Mac has already staged a downloaded update; it installs at the next quit regardless.
      return state.status === "ready" ? state : { status: "off" };
    case "check":
      return state.status === "idle" || state.status === "failed" ? { status: "checking" } : state;
    case "update-available":
      return state.status === "checking" ? { status: "downloading" } : state;
    case "update-not-available":
      return state.status === "checking" ? { status: "idle", checkedAt: event.at } : state;
    case "update-downloaded":
      // A download already under way finishes after the switch turns off, and still installs at quit.
      return { status: "ready", version: event.version };
    case "error":
      if (state.status === "ready" || state.status === "off") return state;
      if (event.readOnlyVolume) return { status: "unsupported", reason: "read-only-volume" };
      if (state.status === "checking") return { status: "failed", code: "check-failed" };
      if (state.status === "downloading") return { status: "failed", code: "download-failed" };
      return state;
  }
}

/** The feed names each release "OctopusBeak <version>"; the version is what the notification shows. */
function versionFromReleaseName(releaseName: string): string {
  return releaseName.replace(/^OctopusBeak\s+v?/i, "").trim();
}

function updateEvent(signal: AppUpdaterSignal, now: Date): AppUpdateEvent {
  switch (signal.type) {
    case "checking-for-update":
      return { type: "check" };
    case "update-available":
      return signal;
    case "update-not-available":
      return { type: "update-not-available", at: now.toISOString() };
    case "update-downloaded":
      return { type: "update-downloaded", version: versionFromReleaseName(signal.releaseName) };
    case "error":
      // Squirrel.Mac's refusal to replace an app on a DMG or under App Translocation.
      return { type: "error", readOnlyVolume: /read-only volume/i.test(signal.message) };
  }
}

export type AppUpdaterDependencies = {
  /** False in development builds and under test fixtures: nothing is ever checked. */
  supported: boolean;
  enabled(): boolean;
  now(): Date;
  /** autoUpdater.checkForUpdates(); results come back through receive(). */
  checkForUpdates(): void;
  quitAndInstall(): void;
  hasActiveRun(): boolean;
  onChange(state: AppUpdateState): void;
  /** Called once when an update has downloaded. */
  onReady(version: string): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
  reportError(code: string): void;
};

export function createAppUpdater(deps: AppUpdaterDependencies) {
  let state = initialAppUpdateState({ supported: deps.supported, enabled: deps.enabled() });
  let started = false;
  let timer: unknown = null;

  function dispatch(event: AppUpdateEvent) {
    const previous = state;
    state = reduceAppUpdate(state, event);
    if (state === previous) return;
    deps.onChange(state);
    if (state.status === "ready" && previous.status !== "ready") deps.onReady(state.version);
    if (state.status === "failed") deps.reportError(`app-update-${state.code}`);
    if (state.status === "unsupported") deps.reportError(`app-update-${state.reason}`);
  }

  /** Checks now if nothing is in flight. Once an update is ready, checking again would download it twice. */
  function check() {
    if (!started) return;
    const previous = state.status;
    dispatch({ type: "check" });
    if (state.status !== "checking" || previous === "checking") return;
    try {
      deps.checkForUpdates();
    } catch {
      dispatch({ type: "error", readOnlyVolume: false });
    }
  }

  return {
    state: () => state,
    check,
    /** Never logs the signal: Squirrel.Mac's messages can hold paths. */
    receive(signal: AppUpdaterSignal) {
      dispatch(updateEvent(signal, deps.now()));
    },
    setEnabled(enabled: boolean) {
      dispatch({ type: enabled ? "enable" : "disable" });
      if (enabled) check();
    },
    /** Quitting installs the update; it waits until no run is active so none is cut short. */
    restart(): AppUpdateRestartResult {
      if (state.status !== "ready") return { ok: false, reason: "not-ready" };
      if (deps.hasActiveRun()) return { ok: false, reason: "run-active" };
      deps.quitAndInstall();
      return { ok: true };
    },
    start() {
      if (!deps.supported || started) return;
      started = true;
      check();
      timer = deps.setInterval(check, APP_UPDATE_CHECK_INTERVAL_MS);
    },
    stop() {
      started = false;
      if (timer !== null) deps.clearInterval(timer);
      timer = null;
    },
  };
}
