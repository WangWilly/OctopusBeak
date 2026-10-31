import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  APP_UPDATE_DOWNLOAD_PREFIX,
  APP_UPDATE_FEED_URL,
  appUpdateNotification,
  appUpdateSupport,
  createAppUpdater,
  isNewerVersion,
  parseAppUpdateFeed,
  reduceAppUpdate,
  type AppRelease,
  type AppUpdateDownloadOutcome,
  type AppUpdateEvent,
  type AppUpdateState,
  type AppUpdateSupport,
} from "./app-updates.ts";

const READ_ONLY_MESSAGE =
  "Cannot update while running on a read-only volume. The application is on a read-only volume. Please move the application and try again.";

const SUPPORTED: AppUpdateSupport = {
  supported: true,
  feedUrl: APP_UPDATE_FEED_URL,
  downloadPrefix: APP_UPDATE_DOWNLOAD_PREFIX,
  squirrel: true,
};

function release(version: string): AppRelease {
  return {
    version,
    name: `OctopusBeak ${version}`,
    pubDate: "2026-10-31T04:00:00.000Z",
    url: `${APP_UPDATE_DOWNLOAD_PREFIX}v${version}/OctopusBeak-darwin-arm64-${version}.zip`,
    size: 1000,
    sha256: "a".repeat(64),
  };
}

const NEXT = release("0.11.0");

/** Lets every pending promise callback run, so an awaited fetch or download settles. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness(options: {
  support?: AppUpdateSupport;
  enabled?: boolean;
  autoDownload?: boolean;
  activeRun?: boolean;
  feed?: () => Promise<AppRelease>;
} = {}) {
  let activeRun = options.activeRun ?? false;
  let finishDownload: ((outcome: AppUpdateDownloadOutcome) => void) | null = null;
  let progress: ((received: number) => void) | null = null;
  const recorded = {
    checks: 0,
    downloads: [] as string[],
    installs: [] as string[],
    restarts: 0,
    ready: [] as string[],
    changes: [] as AppUpdateState[],
    errors: [] as string[],
    intervals: [] as { callback: () => void; ms: number }[],
    cleared: 0,
  };
  const updater = createAppUpdater({
    support: options.support ?? SUPPORTED,
    currentVersion: "0.10.0",
    enabled: () => options.enabled ?? true,
    autoDownload: () => options.autoDownload ?? false,
    now: () => new Date("2026-10-31T04:00:00Z"),
    fetchRelease: () => {
      recorded.checks += 1;
      return options.feed ? options.feed() : Promise.resolve(NEXT);
    },
    download: (target, onProgress) => {
      recorded.downloads.push(target.version);
      progress = onProgress;
      return new Promise((resolve) => (finishDownload = resolve));
    },
    install: (target) => recorded.installs.push(target.version),
    quitAndInstall: () => {
      recorded.restarts += 1;
    },
    hasActiveRun: () => activeRun,
    onChange: (state) => recorded.changes.push(state),
    onReady: (version) => recorded.ready.push(version),
    setInterval: (callback, ms) => {
      recorded.intervals.push({ callback, ms });
      return recorded.intervals.length;
    },
    clearInterval: () => {
      recorded.cleared += 1;
    },
    reportError: (code) => recorded.errors.push(code),
  });
  return {
    updater,
    recorded,
    setActiveRun: (value: boolean) => (activeRun = value),
    progress: (received: number) => progress!(received),
    finish: async (outcome: AppUpdateDownloadOutcome) => {
      finishDownload!(outcome);
      await settle();
    },
  };
}

test("the feed is parsed at the boundary and anything malformed is refused", () => {
  const feed = { schema: 1, ...NEXT };
  assert.deepEqual(parseAppUpdateFeed(feed, APP_UPDATE_DOWNLOAD_PREFIX), NEXT);
  for (const [field, value] of [
    ["schema", 2],
    ["version", "0.11"],
    ["version", "0.11.0-beta.1"],
    ["pubDate", "yesterday"],
    ["url", "https://example.com/OctopusBeak.zip"],
    ["url", "http://github.com/WangWilly/OctopusBeak/releases/download/v0.11.0/x.zip"],
    ["size", 0],
    ["size", "1000"],
    ["size", 1.5],
    ["sha256", "A".repeat(64)],
    ["sha256", "a".repeat(63)],
  ] as const) {
    assert.throws(() => parseAppUpdateFeed({ ...feed, [field]: value }, APP_UPDATE_DOWNLOAD_PREFIX), TypeError, `${field}=${value}`);
  }
  assert.throws(() => parseAppUpdateFeed(null, APP_UPDATE_DOWNLOAD_PREFIX));
  assert.throws(() => parseAppUpdateFeed([], APP_UPDATE_DOWNLOAD_PREFIX));
});

test("only a strictly newer x.y.z counts as newer", () => {
  assert.equal(isNewerVersion("0.11.0", "0.10.0"), true);
  assert.equal(isNewerVersion("0.10.1", "0.10.0"), true);
  assert.equal(isNewerVersion("1.0.0", "0.99.99"), true);
  assert.equal(isNewerVersion("0.10.10", "0.10.9"), true, "compared as numbers, not text");
  assert.equal(isNewerVersion("0.10.0", "0.10.0"), false);
  assert.equal(isNewerVersion("0.9.9", "0.10.0"), false);
  assert.equal(isNewerVersion("0.11.0-beta.1", "0.10.0"), false);
});

test("packaged builds read only the GitHub feed and ignore the development fixture", () => {
  const fixture = "http://127.0.0.1:4555/update-feed-darwin-arm64.json";
  assert.deepEqual(
    appUpdateSupport({ packaged: true, testFixture: false, inApplicationsFolder: true, feedFixtureUrl: fixture }),
    SUPPORTED,
  );
  assert.deepEqual(
    appUpdateSupport({ packaged: true, testFixture: false, inApplicationsFolder: false, feedFixtureUrl: fixture }),
    { supported: false, reason: "not-in-applications" },
  );
  assert.deepEqual(
    appUpdateSupport({ packaged: true, testFixture: true, inApplicationsFolder: true, feedFixtureUrl: fixture }),
    { supported: false, reason: "development-build" },
  );
  assert.deepEqual(
    appUpdateSupport({ packaged: false, testFixture: true, inApplicationsFolder: false, feedFixtureUrl: undefined }),
    { supported: false, reason: "development-build" },
  );
  assert.deepEqual(
    appUpdateSupport({ packaged: false, testFixture: true, inApplicationsFolder: false, feedFixtureUrl: fixture }),
    { supported: true, feedUrl: fixture, downloadPrefix: "http://127.0.0.1:4555/", squirrel: false },
  );
  assert.deepEqual(
    appUpdateSupport({
      packaged: false,
      testFixture: false,
      inApplicationsFolder: false,
      feedFixtureUrl: "https://example.com/update-feed-darwin-arm64.json",
    }),
    { supported: false, reason: "development-build" },
    "the fixture feed must be on 127.0.0.1",
  );
});

test("an unsupported launch never checks and says why", async () => {
  const { updater, recorded } = harness({ support: { supported: false, reason: "not-in-applications" } });
  updater.start();
  await updater.check();
  updater.applySettings({ enabled: true, autoDownload: true });
  await updater.download();
  assert.deepEqual(updater.state(), { status: "unsupported", reason: "not-in-applications" });
  assert.equal(recorded.checks, 0);
  assert.equal(recorded.intervals.length, 0);
});

test("nothing is checked before start, then once at start and every 6 hours", async () => {
  const { updater, recorded } = harness({ feed: () => Promise.resolve(release("0.10.0")) });
  await updater.check();
  assert.equal(recorded.checks, 0, "the runtime is not ready yet");
  updater.start();
  assert.deepEqual(updater.state(), { status: "checking" });
  await updater.check();
  assert.equal(recorded.checks, 1, "a check in flight is not started twice");
  await settle();
  assert.deepEqual(updater.state(), { status: "idle", checkedAt: "2026-10-31T04:00:00.000Z" });
  assert.deepEqual(recorded.intervals.map((interval) => interval.ms), [APP_UPDATE_CHECK_INTERVAL_MS]);
  assert.equal(APP_UPDATE_CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
  recorded.intervals[0]!.callback();
  await settle();
  assert.equal(recorded.checks, 2);
  updater.stop();
  assert.equal(recorded.cleared, 1);
  await updater.check();
  assert.equal(recorded.checks, 2, "a stopped updater does not check");
});

test("a feed naming the running or an older version offers nothing", async () => {
  for (const version of ["0.10.0", "0.9.9"]) {
    const { updater, recorded } = harness({ autoDownload: true, feed: () => Promise.resolve(release(version)) });
    updater.start();
    await settle();
    assert.equal(updater.state().status, "idle", version);
    assert.deepEqual(recorded.downloads, []);
  }
});

test("with auto-download off, a newer release waits at available until the person asks", async () => {
  const { updater, recorded, progress, finish } = harness();
  updater.start();
  await settle();
  assert.deepEqual(updater.state(), { status: "available", release: NEXT });
  assert.deepEqual(recorded.downloads, [], "a 430 MB download needs the person's request");
  recorded.intervals[0]!.callback();
  await settle();
  assert.equal(recorded.checks, 1, "an update waiting is not checked again");

  const downloading = updater.download();
  assert.deepEqual(updater.state(), { status: "downloading", release: NEXT, received: 0 });
  void updater.download();
  assert.deepEqual(recorded.downloads, ["0.11.0"], "a second request does not start a second download");
  progress(400);
  assert.deepEqual(updater.state(), { status: "downloading", release: NEXT, received: 400 });
  await finish("verified");
  await downloading;
  assert.deepEqual(updater.state(), { status: "installing", release: NEXT });
  assert.deepEqual(recorded.installs, ["0.11.0"], "the verified ZIP goes to Squirrel.Mac");
  updater.receive({ type: "update-downloaded" });
  assert.deepEqual(updater.state(), { status: "ready", version: "0.11.0" });
  assert.deepEqual(recorded.ready, ["0.11.0"]);
  updater.receive({ type: "update-downloaded" });
  assert.deepEqual(recorded.ready, ["0.11.0"], "one notification per update");
});

test("with auto-download on, a newer release downloads by itself", async () => {
  const { updater, recorded } = harness({ autoDownload: true });
  updater.start();
  await settle();
  assert.deepEqual(updater.state(), { status: "downloading", release: NEXT, received: 0 });
  assert.deepEqual(recorded.downloads, ["0.11.0"]);
});

test("turning auto-download on while an update waits starts it", async () => {
  const { updater, recorded } = harness();
  updater.start();
  await settle();
  updater.applySettings({ enabled: true, autoDownload: false });
  assert.deepEqual(recorded.downloads, []);
  updater.applySettings({ enabled: true, autoDownload: true });
  assert.deepEqual(recorded.downloads, ["0.11.0"]);
});

test("a ZIP whose checksum does not match is never installed, and the sidebar can retry", async () => {
  const { updater, recorded, finish } = harness();
  updater.start();
  await settle();
  void updater.download();
  await finish("verify-failed");
  assert.deepEqual(updater.state(), { status: "failed", code: "verify-failed", release: NEXT });
  assert.deepEqual(recorded.installs, []);
  void updater.download();
  assert.deepEqual(updater.state(), { status: "downloading", release: NEXT, received: 0 });
  await finish("download-failed");
  assert.deepEqual(updater.state(), { status: "failed", code: "download-failed", release: NEXT });
  assert.deepEqual(recorded.errors, ["app-update-verify-failed", "app-update-download-failed"]);
});

test("a failed check is silent and the next interval tries again", async () => {
  const { updater, recorded } = harness({ feed: () => Promise.reject(new Error("offline at /Users/someone")) });
  updater.start();
  await settle();
  assert.deepEqual(updater.state(), { status: "failed", code: "check-failed" });
  await updater.download();
  assert.deepEqual(updater.state(), { status: "failed", code: "check-failed" }, "nothing to retry without a release");
  recorded.intervals[0]!.callback();
  await settle();
  assert.equal(recorded.checks, 2);
  assert.ok(recorded.errors.every((code) => !code.includes("/")), "no message or path reaches the log");
});

test("Squirrel.Mac's read-only refusal stops updates for this launch; other refusals can retry", async () => {
  const readOnly = harness();
  readOnly.updater.start();
  await settle();
  void readOnly.updater.download();
  await readOnly.finish("verified");
  readOnly.updater.receive({ type: "error", message: READ_ONLY_MESSAGE });
  assert.deepEqual(readOnly.updater.state(), { status: "unsupported", reason: "not-in-applications" });
  assert.deepEqual(readOnly.recorded.errors, ["app-update-not-in-applications"]);

  const refused = harness();
  refused.updater.start();
  await settle();
  void refused.updater.download();
  await refused.finish("verified");
  refused.updater.receive({ type: "error", message: "Code signature did not match at /Applications/OctopusBeak.app" });
  assert.deepEqual(refused.updater.state(), { status: "failed", code: "install-failed", release: NEXT });
  assert.deepEqual(refused.recorded.errors, ["app-update-install-failed"]);
});

test("turning checks off drops a waiting update, but a download under way finishes", async () => {
  const waiting = harness();
  waiting.updater.start();
  await settle();
  waiting.updater.applySettings({ enabled: false, autoDownload: false });
  assert.deepEqual(waiting.updater.state(), { status: "off" });

  const downloading = harness();
  downloading.updater.start();
  await settle();
  void downloading.updater.download();
  downloading.updater.applySettings({ enabled: false, autoDownload: false });
  assert.equal(downloading.updater.state().status, "downloading");
  await downloading.finish("verified");
  downloading.updater.receive({ type: "update-downloaded" });
  assert.deepEqual(downloading.updater.state(), { status: "ready", version: "0.11.0" });
  downloading.updater.applySettings({ enabled: false, autoDownload: false });
  assert.deepEqual(downloading.updater.state(), { status: "ready", version: "0.11.0" });
});

test("the switch stops checking, turning it on checks at once, and a late answer changes nothing", async () => {
  let answer: (value: AppRelease) => void = () => {};
  const { updater, recorded } = harness({
    enabled: false,
    feed: () => new Promise((resolve) => (answer = resolve)),
  });
  assert.deepEqual(updater.state(), { status: "off" });
  updater.start();
  recorded.intervals[0]!.callback();
  assert.equal(recorded.checks, 0, "off by the switch");
  updater.applySettings({ enabled: true, autoDownload: false });
  assert.equal(recorded.checks, 1);
  updater.applySettings({ enabled: true, autoDownload: false });
  assert.equal(recorded.checks, 1, "saving other settings with the switch on does not check");
  updater.applySettings({ enabled: false, autoDownload: false });
  answer(NEXT);
  await settle();
  assert.deepEqual(updater.state(), { status: "off" });
});

test("restart installs only a ready update and never while a run is active", async () => {
  const { updater, recorded, setActiveRun, finish } = harness({ activeRun: true });
  updater.start();
  await settle();
  assert.deepEqual(updater.restart(), { ok: false, reason: "not-ready" });
  void updater.download();
  await finish("verified");
  updater.receive({ type: "update-downloaded" });
  assert.deepEqual(updater.restart(), { ok: false, reason: "run-active" });
  assert.equal(recorded.restarts, 0, "a run in progress is not cut short");
  setActiveRun(false);
  assert.deepEqual(updater.restart(), { ok: true });
  assert.equal(recorded.restarts, 1);
});

test("a hand-off that throws becomes a failed install", async () => {
  const errors: string[] = [];
  const throwing = createAppUpdater({
    support: SUPPORTED,
    currentVersion: "0.10.0",
    enabled: () => true,
    autoDownload: () => true,
    now: () => new Date(),
    fetchRelease: () => Promise.resolve(NEXT),
    download: () => Promise.resolve("verified"),
    install: () => {
      throw new Error("Could not get code signature for running application");
    },
    quitAndInstall: () => {},
    hasActiveRun: () => false,
    onChange: () => {},
    onReady: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    reportError: (code) => errors.push(code),
  });
  throwing.start();
  await settle();
  assert.deepEqual(throwing.state(), { status: "failed", code: "install-failed", release: NEXT });
  assert.deepEqual(errors, ["app-update-install-failed"]);
});

test("the reducer's outcome for every state and event", () => {
  const states: Record<string, AppUpdateState> = {
    off: { status: "off" },
    unsupported: { status: "unsupported", reason: "development-build" },
    idle: { status: "idle", checkedAt: null },
    checking: { status: "checking" },
    available: { status: "available", release: NEXT },
    downloading: { status: "downloading", release: NEXT, received: 10 },
    installing: { status: "installing", release: NEXT },
    ready: { status: "ready", version: "0.11.0" },
    "check-failed": { status: "failed", code: "check-failed" },
    "verify-failed": { status: "failed", code: "verify-failed", release: NEXT },
  };
  const events: Record<string, AppUpdateEvent> = {
    enable: { type: "enable" },
    disable: { type: "disable" },
    check: { type: "check" },
    "up-to-date": { type: "up-to-date", at: "2026-10-31T04:00:00.000Z" },
    found: { type: "found", release: NEXT },
    "check-failed": { type: "check-failed" },
    download: { type: "download" },
    progress: { type: "progress", received: 500 },
    verified: { type: "verified" },
    "download-failed": { type: "download-failed", code: "verify-failed" },
    installed: { type: "installed" },
    "install-failed": { type: "install-failed", readOnlyVolume: false },
    "read-only": { type: "install-failed", readOnlyVolume: true },
  };
  const label = (state: AppUpdateState) => state.status === "failed" ? state.code : state.status;
  const table = Object.fromEntries(Object.entries(states).map(([name, state]) => [
    name,
    Object.fromEntries(Object.entries(events).map(([eventName, event]) => [eventName, label(reduceAppUpdate(state, event))])),
  ]));
  const row = (outcomes: string[]) => Object.fromEntries(Object.keys(events).map((name, index) => [name, outcomes[index]]));
  assert.deepEqual(table, {
    off: row(["idle", "off", "off", "off", "off", "off", "off", "off", "off", "off", "off", "off", "off"]),
    unsupported: row(Array(13).fill("unsupported")),
    idle: row(["idle", "off", "checking", "idle", "idle", "idle", "idle", "idle", "idle", "idle", "idle", "idle", "idle"]),
    checking: row(["checking", "off", "checking", "idle", "available", "check-failed", "checking", "checking", "checking", "checking", "checking", "checking", "checking"]),
    available: row(["available", "off", "available", "available", "available", "available", "downloading", "available", "available", "available", "available", "available", "available"]),
    downloading: row(["downloading", "downloading", "downloading", "downloading", "downloading", "downloading", "downloading", "downloading", "installing", "verify-failed", "downloading", "downloading", "downloading"]),
    installing: row(["installing", "installing", "installing", "installing", "installing", "installing", "installing", "installing", "installing", "installing", "ready", "install-failed", "unsupported"]),
    ready: row(Array(13).fill("ready")),
    "check-failed": row(["check-failed", "off", "checking", "check-failed", "check-failed", "check-failed", "check-failed", "check-failed", "check-failed", "check-failed", "check-failed", "check-failed", "check-failed"]),
    "verify-failed": row(["verify-failed", "off", "checking", "verify-failed", "verify-failed", "verify-failed", "downloading", "verify-failed", "verify-failed", "verify-failed", "verify-failed", "verify-failed", "verify-failed"]),
  });
  assert.deepEqual(
    reduceAppUpdate(states.downloading!, events.progress!),
    { status: "downloading", release: NEXT, received: 500 },
    "progress moves only the received count",
  );
  assert.deepEqual(
    reduceAppUpdate(states.available!, events.progress!),
    states.available,
    "progress outside a download changes nothing",
  );
});

test("the ready notification names the version in the person's language", () => {
  assert.deepEqual(appUpdateNotification("0.11.0", "zh-TW"), { title: "新版 0.11.0 已下載", body: "重新啟動即可更新。" });
  assert.deepEqual(appUpdateNotification("0.11.0", "en"), { title: "OctopusBeak 0.11.0 downloaded", body: "Restart to update." });
});
