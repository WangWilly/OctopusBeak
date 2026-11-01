import type { AutomationSettingsFile } from "../automation/server/config-files.ts";

/**
 * ADR 0083: the updater asks GitHub, never us, for the latest release. The release workflow writes this
 * file (scripts/update-feed.mjs); releases/latest skips drafts and prereleases.
 */
export const APP_UPDATE_FEED_URL =
  "https://github.com/WangWilly/OctopusBeak/releases/latest/download/update-feed-darwin-arm64.json";
/** A feed may only point at a release asset of this repository. */
export const APP_UPDATE_DOWNLOAD_PREFIX = "https://github.com/WangWilly/OctopusBeak/releases/download/";

export const APP_UPDATES_ENABLED_KEY = "APP_UPDATES_ENABLED";
export const APP_UPDATES_AUTO_DOWNLOAD_KEY = "APP_UPDATES_AUTO_DOWNLOAD";

/** On by default (ADR 0083): only an explicit "false" turns checking off. */
export function appUpdatesEnabled(settings: AutomationSettingsFile): boolean {
  return settings[APP_UPDATES_ENABLED_KEY] !== "false";
}

/** Off by default: the ZIP is about 430 MB, so it downloads only when the person asks or opts in. */
export function appUpdatesAutoDownload(settings: AutomationSettingsFile): boolean {
  return settings[APP_UPDATES_AUTO_DOWNLOAD_KEY] === "true";
}

export const APP_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The release the feed names, parsed at the boundary by parseAppUpdateFeed. */
export type AppRelease = Readonly<{
  version: string;
  name: string;
  pubDate: string;
  url: string;
  size: number;
  sha256: string;
}>;

const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/u;

/** Throws on anything but a schema-1 feed whose ZIP lives under downloadPrefix. */
export function parseAppUpdateFeed(value: unknown, downloadPrefix: string): AppRelease {
  if (typeof value !== "object" || value === null) throw new TypeError("feed is not an object");
  const feed = value as Record<string, unknown>;
  if (feed.schema !== 1) throw new TypeError("unknown feed schema");
  const { version, name, pubDate, url, size, sha256 } = feed;
  if (typeof version !== "string" || !RELEASE_VERSION.test(version)) throw new TypeError("bad version");
  if (typeof name !== "string") throw new TypeError("bad name");
  if (typeof pubDate !== "string" || Number.isNaN(Date.parse(pubDate))) throw new TypeError("bad pubDate");
  if (typeof url !== "string" || !url.startsWith(downloadPrefix) || !URL.canParse(url)) throw new TypeError("bad url");
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) throw new TypeError("bad size");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) throw new TypeError("bad sha256");
  return { version, name, pubDate, url, size, sha256 };
}

/** Only a strictly newer x.y.z is offered, so a feed can never move the App backward. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = RELEASE_VERSION.exec(candidate);
  const b = RELEASE_VERSION.exec(current);
  if (!a || !b) return false;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

export type AppUpdateUnsupportedReason = "development-build" | "not-in-applications";

/** Where checks go, or why this launch never checks. */
export type AppUpdateSupport =
  | {
    supported: true;
    feedUrl: string;
    downloadPrefix: string;
    /** False only for the development feed fixture, which stops before Squirrel.Mac. */
    squirrel: boolean;
  }
  | { supported: false; reason: AppUpdateUnsupportedReason };

const FIXTURE_FEED = /^http:\/\/127\.0\.0\.1:\d+\//u;

/**
 * A packaged build reads only the GitHub feed. An unpackaged build checks only when
 * OCTOPUSBEAK_UPDATE_FEED_FIXTURE names a feed on 127.0.0.1, so the flow can be driven without a release.
 */
export function appUpdateSupport(input: {
  packaged: boolean;
  testFixture: boolean;
  inApplicationsFolder: boolean;
  feedFixtureUrl: string | undefined;
}): AppUpdateSupport {
  if (!input.packaged) {
    const fixture = input.feedFixtureUrl && FIXTURE_FEED.exec(input.feedFixtureUrl);
    return fixture
      ? { supported: true, feedUrl: input.feedFixtureUrl!, downloadPrefix: fixture[0], squirrel: false }
      : { supported: false, reason: "development-build" };
  }
  if (input.testFixture) return { supported: false, reason: "development-build" };
  // Squirrel.Mac cannot replace an app it cannot write; this saves a 430 MB download that would not install.
  if (!input.inApplicationsFolder) return { supported: false, reason: "not-in-applications" };
  return { supported: true, feedUrl: APP_UPDATE_FEED_URL, downloadPrefix: APP_UPDATE_DOWNLOAD_PREFIX, squirrel: true };
}

export type AppUpdateFailureCode = "download-failed" | "verify-failed" | "install-failed";

/** What the updater is doing, as the sidebar and Settings show it. */
export type AppUpdateState =
  | { status: "off" }
  | { status: "unsupported"; reason: AppUpdateUnsupportedReason }
  /** checkedAt is null until the first check of this launch finds nothing. */
  | { status: "idle"; checkedAt: string | null }
  | { status: "checking" }
  | { status: "available"; release: AppRelease }
  /** The total is release.size; the download fails once more than that arrives. */
  | { status: "downloading"; release: AppRelease; received: number }
  /** The verified ZIP is being handed to Squirrel.Mac, which checks its signature. */
  | { status: "installing"; release: AppRelease }
  | { status: "ready"; version: string }
  /** Silent: the next interval checks again. */
  | { status: "failed"; code: "check-failed" }
  /** The sidebar offers to download again. */
  | { status: "failed"; code: AppUpdateFailureCode; release: AppRelease };

export type AppUpdateEvent =
  | { type: "enable" }
  | { type: "disable" }
  | { type: "check" }
  | { type: "up-to-date"; at: string }
  | { type: "found"; release: AppRelease }
  | { type: "check-failed" }
  | { type: "download" }
  | { type: "progress"; received: number }
  | { type: "verified" }
  | { type: "download-failed"; code: "download-failed" | "verify-failed" }
  | { type: "installed" }
  | { type: "install-failed"; readOnlyVolume: boolean };

/** What Squirrel.Mac's autoUpdater reports during the hand-off, as electron/main.ts passes it on. */
export type AppUpdaterSignal =
  | { type: "update-downloaded" }
  | { type: "error"; message: string };

export type AppUpdateView = { currentVersion: string; state: AppUpdateState };

export type AppUpdateRestartResult =
  | { ok: true }
  | { ok: false; reason: "not-ready" | "run-active" };

export function appUpdateNotification(version: string, locale: "zh-TW" | "en"): { title: string; body: string } {
  return locale === "zh-TW"
    ? { title: `新版 ${version} 已下載`, body: "重新啟動即可更新。" }
    : { title: `OctopusBeak ${version} downloaded`, body: "Restart to update." };
}

export function initialAppUpdateState(input: { support: AppUpdateSupport; enabled: boolean }): AppUpdateState {
  if (!input.support.supported) return { status: "unsupported", reason: input.support.reason };
  return input.enabled ? { status: "idle", checkedAt: null } : { status: "off" };
}

export function reduceAppUpdate(state: AppUpdateState, event: AppUpdateEvent): AppUpdateState {
  if (state.status === "unsupported") return state;
  switch (event.type) {
    case "enable":
      return state.status === "off" ? { status: "idle", checkedAt: null } : state;
    case "disable":
      // A download under way finishes and installs: the person already asked for it.
      return state.status === "downloading" || state.status === "installing" || state.status === "ready"
        ? state
        : { status: "off" };
    case "check":
      return state.status === "idle" || state.status === "failed" ? { status: "checking" } : state;
    case "up-to-date":
      return state.status === "checking" ? { status: "idle", checkedAt: event.at } : state;
    case "found":
      return state.status === "checking" ? { status: "available", release: event.release } : state;
    case "check-failed":
      return state.status === "checking" ? { status: "failed", code: "check-failed" } : state;
    case "download":
      return state.status === "available" || (state.status === "failed" && state.code !== "check-failed")
        ? { status: "downloading", release: state.release, received: 0 }
        : state;
    case "progress":
      return state.status === "downloading" ? { ...state, received: event.received } : state;
    case "verified":
      return state.status === "downloading" ? { status: "installing", release: state.release } : state;
    case "download-failed":
      return state.status === "downloading" ? { status: "failed", code: event.code, release: state.release } : state;
    case "installed":
      return state.status === "installing" ? { status: "ready", version: state.release.version } : state;
    case "install-failed":
      if (state.status !== "installing") return state;
      return event.readOnlyVolume
        ? { status: "unsupported", reason: "not-in-applications" }
        : { status: "failed", code: "install-failed", release: state.release };
  }
}

export type AppUpdateDownloadOutcome = "verified" | "download-failed" | "verify-failed";

export type AppUpdaterDependencies = {
  support: AppUpdateSupport;
  currentVersion: string;
  enabled(): boolean;
  autoDownload(): boolean;
  now(): Date;
  /** Reads and parses the feed; throws when it cannot. */
  fetchRelease(): Promise<AppRelease>;
  /** Streams the ZIP and checks its size and sha256. */
  download(release: AppRelease, onProgress: (received: number) => void): Promise<AppUpdateDownloadOutcome>;
  /** Hands the verified ZIP to Squirrel.Mac; its answer comes back through receive(). */
  install(release: AppRelease): void;
  quitAndInstall(): void;
  hasActiveRun(): boolean;
  onChange(state: AppUpdateState): void;
  /** Called once when an update is ready to install. */
  onReady(version: string): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
  reportError(code: string): void;
};

export function createAppUpdater(deps: AppUpdaterDependencies) {
  let state = initialAppUpdateState({ support: deps.support, enabled: deps.enabled() });
  let started = false;
  let timer: unknown = null;

  /** Returns the new state; an event that changes nothing publishes nothing. */
  function dispatch(event: AppUpdateEvent): AppUpdateState {
    const previous = state;
    state = reduceAppUpdate(state, event);
    if (state === previous) return state;
    deps.onChange(state);
    if (state.status === "ready" && previous.status !== "ready") deps.onReady(state.version);
    if (state.status === "failed") deps.reportError(`app-update-${state.code}`);
    if (state.status === "unsupported") deps.reportError(`app-update-${state.reason}`);
    return state;
  }

  async function download() {
    const previous = state;
    const downloading = dispatch({ type: "download" });
    if (downloading === previous || downloading.status !== "downloading") return;
    const release = downloading.release;
    let outcome: AppUpdateDownloadOutcome;
    try {
      outcome = await deps.download(release, (received) => dispatch({ type: "progress", received }));
    } catch {
      outcome = "download-failed";
    }
    const verified = dispatch(outcome === "verified" ? { type: "verified" } : { type: "download-failed", code: outcome });
    if (verified.status !== "installing") return;
    try {
      deps.install(release);
    } catch {
      dispatch({ type: "install-failed", readOnlyVolume: false });
    }
  }

  /** Checks now if nothing is in flight and no update is waiting. */
  async function check() {
    if (!started || (state.status !== "idle" && state.status !== "failed")) return;
    dispatch({ type: "check" });
    let event: AppUpdateEvent;
    try {
      const release = await deps.fetchRelease();
      event = isNewerVersion(release.version, deps.currentVersion)
        ? { type: "found", release }
        : { type: "up-to-date", at: deps.now().toISOString() };
    } catch {
      event = { type: "check-failed" };
    }
    if (dispatch(event).status === "available" && deps.autoDownload()) await download();
  }

  return {
    state: () => state,
    check,
    /** The person asked for the download, or for another try after a failure. */
    download,
    /** Never logs the signal: Squirrel.Mac's messages can hold paths. */
    receive(signal: AppUpdaterSignal) {
      dispatch(signal.type === "update-downloaded"
        ? { type: "installed" }
        // Squirrel.Mac's refusal to replace an app on a DMG or under App Translocation.
        : { type: "install-failed", readOnlyVolume: /read-only volume/i.test(signal.message) });
    },
    /** Called on every settings save; turning checking on checks, turning auto-download on downloads. */
    applySettings(settings: { enabled: boolean; autoDownload: boolean }) {
      const wasOff = state.status === "off";
      dispatch({ type: settings.enabled ? "enable" : "disable" });
      if (settings.enabled && wasOff) void check();
      else if (settings.enabled && settings.autoDownload && state.status === "available") void download();
    },
    /** Quitting installs the update; it waits until no run is active so none is cut short. */
    restart(): AppUpdateRestartResult {
      if (state.status !== "ready") return { ok: false, reason: "not-ready" };
      if (deps.hasActiveRun()) return { ok: false, reason: "run-active" };
      deps.quitAndInstall();
      return { ok: true };
    },
    start() {
      if (!deps.support.supported || started) return;
      started = true;
      void check();
      timer = deps.setInterval(() => void check(), APP_UPDATE_CHECK_INTERVAL_MS);
    },
    stop() {
      started = false;
      if (timer !== null) deps.clearInterval(timer);
      timer = null;
    },
  };
}
