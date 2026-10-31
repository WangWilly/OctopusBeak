import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  createAppUpdater,
  reduceAppUpdate,
  type AppUpdateEvent,
  type AppUpdateState,
} from "./app-updates.ts";

const READ_ONLY_MESSAGE =
  "Cannot update while running on a read-only volume. The application is on a read-only volume. Please move the application and try again.";

function harness(options: { supported?: boolean; enabled?: boolean; activeRun?: boolean } = {}) {
  let activeRun = options.activeRun ?? false;
  const recorded = {
    checks: 0,
    installs: 0,
    ready: [] as string[],
    changes: [] as AppUpdateState[],
    errors: [] as string[],
    intervals: [] as { callback: () => void; ms: number }[],
    cleared: 0,
  };
  const updater = createAppUpdater({
    supported: options.supported ?? true,
    enabled: () => options.enabled ?? true,
    now: () => new Date("2026-10-31T04:00:00Z"),
    checkForUpdates: () => {
      recorded.checks += 1;
    },
    quitAndInstall: () => {
      recorded.installs += 1;
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
  return { updater, recorded, setActiveRun: (value: boolean) => (activeRun = value) };
}

test("a development build never checks and says so", () => {
  const { updater, recorded } = harness({ supported: false });
  updater.start();
  updater.check();
  updater.setEnabled(true);
  updater.receive({ type: "update-downloaded", releaseName: "OctopusBeak 0.11.0" });
  assert.deepEqual(updater.state(), { status: "unsupported", reason: "development-build" });
  assert.equal(recorded.checks, 0);
  assert.equal(recorded.intervals.length, 0);
  assert.deepEqual(recorded.ready, []);
});

test("nothing is checked before start, then once at start and every 6 hours", () => {
  const { updater, recorded } = harness();
  updater.check();
  assert.equal(recorded.checks, 0, "the runtime is not ready yet");
  assert.deepEqual(updater.state(), { status: "idle", checkedAt: null });
  updater.start();
  assert.equal(recorded.checks, 1);
  assert.deepEqual(updater.state(), { status: "checking" });
  assert.deepEqual(recorded.intervals.map((interval) => interval.ms), [APP_UPDATE_CHECK_INTERVAL_MS]);
  assert.equal(APP_UPDATE_CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);

  updater.receive({ type: "checking-for-update" });
  updater.check();
  assert.equal(recorded.checks, 1, "a check in flight is not started twice");

  updater.receive({ type: "update-not-available" });
  assert.deepEqual(updater.state(), { status: "idle", checkedAt: "2026-10-31T04:00:00.000Z" });
  recorded.intervals[0]!.callback();
  assert.equal(recorded.checks, 2);
  updater.stop();
  assert.equal(recorded.cleared, 1);
  updater.check();
  assert.equal(recorded.checks, 2, "a stopped updater does not check");
});

test("an available update downloads and becomes ready once, and is never checked again", () => {
  const { updater, recorded } = harness();
  updater.start();
  updater.receive({ type: "update-available" });
  assert.deepEqual(updater.state(), { status: "downloading" });
  updater.check();
  assert.equal(recorded.checks, 1, "no check while downloading");
  updater.receive({ type: "update-downloaded", releaseName: "OctopusBeak 0.11.0" });
  assert.deepEqual(updater.state(), { status: "ready", version: "0.11.0" });
  assert.deepEqual(recorded.ready, ["0.11.0"]);
  recorded.intervals[0]!.callback();
  updater.check();
  updater.receive({ type: "update-downloaded", releaseName: "OctopusBeak 0.11.0" });
  assert.equal(recorded.checks, 1, "checking again would download the update a second time");
  assert.deepEqual(recorded.ready, ["0.11.0"], "one notification per download");
});

test("failures are silent and retried at the next check, logged only as a code", () => {
  const { updater, recorded } = harness();
  updater.start();
  updater.receive({ type: "error", message: "The network connection was lost at /Users/someone/Library" });
  assert.deepEqual(updater.state(), { status: "failed", code: "check-failed" });
  recorded.intervals[0]!.callback();
  assert.equal(recorded.checks, 2);
  updater.receive({ type: "update-available" });
  updater.receive({ type: "error", message: "Download failed" });
  assert.deepEqual(updater.state(), { status: "failed", code: "download-failed" });
  assert.deepEqual(recorded.errors, ["app-update-check-failed", "app-update-download-failed"]);
  assert.ok(recorded.errors.every((code) => !code.includes("/")), "no message or path reaches the log");
});

test("a read-only volume stops the updater for this launch", () => {
  const { updater, recorded } = harness();
  updater.start();
  updater.receive({ type: "error", message: READ_ONLY_MESSAGE });
  assert.deepEqual(updater.state(), { status: "unsupported", reason: "read-only-volume" });
  recorded.intervals[0]!.callback();
  updater.setEnabled(false);
  updater.setEnabled(true);
  assert.equal(recorded.checks, 1);
  assert.deepEqual(updater.state(), { status: "unsupported", reason: "read-only-volume" });
  assert.deepEqual(recorded.errors, ["app-update-read-only-volume"]);
});

test("the switch stops checking, and turning it on checks at once", () => {
  const { updater, recorded } = harness({ enabled: false });
  assert.deepEqual(updater.state(), { status: "off" });
  updater.start();
  recorded.intervals[0]!.callback();
  assert.equal(recorded.checks, 0, "off by the switch");
  updater.setEnabled(true);
  assert.equal(recorded.checks, 1);
  assert.deepEqual(updater.state(), { status: "checking" });
  updater.setEnabled(false);
  assert.deepEqual(updater.state(), { status: "off" });
  updater.receive({ type: "update-not-available" });
  updater.receive({ type: "error", message: "late" });
  assert.deepEqual(updater.state(), { status: "off" }, "a late answer to an earlier check changes nothing");
});

test("an update already downloaded stays ready when the switch turns off", () => {
  const { updater } = harness();
  updater.start();
  updater.receive({ type: "update-available" });
  updater.setEnabled(false);
  assert.deepEqual(updater.state(), { status: "off" });
  updater.receive({ type: "update-downloaded", releaseName: "OctopusBeak 0.11.0" });
  assert.deepEqual(updater.state(), { status: "ready", version: "0.11.0" }, "a download in flight still installs at quit");
  updater.setEnabled(false);
  assert.deepEqual(updater.state(), { status: "ready", version: "0.11.0" });
});

test("restart installs only a ready update and never while a run is active", () => {
  const { updater, recorded, setActiveRun } = harness({ activeRun: true });
  updater.start();
  assert.deepEqual(updater.restart(), { ok: false, reason: "not-ready" });
  updater.receive({ type: "update-available" });
  updater.receive({ type: "update-downloaded", releaseName: "OctopusBeak 0.11.0" });
  assert.deepEqual(updater.restart(), { ok: false, reason: "run-active" });
  assert.equal(recorded.installs, 0, "a run in progress is not cut short");
  setActiveRun(false);
  assert.deepEqual(updater.restart(), { ok: true });
  assert.equal(recorded.installs, 1);
});

test("a check that throws becomes a silent failure", () => {
  const errors: string[] = [];
  const throwing = createAppUpdater({
    supported: true,
    enabled: () => true,
    now: () => new Date(),
    checkForUpdates: () => {
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
  assert.deepEqual(throwing.state(), { status: "failed", code: "check-failed" });
  assert.deepEqual(errors, ["app-update-check-failed"]);
});

test("every change is published, and an ignored event publishes nothing", () => {
  const { updater, recorded } = harness();
  updater.start();
  updater.receive({ type: "update-downloaded", releaseName: "OctopusBeak 0.11.0" });
  updater.receive({ type: "update-not-available" });
  assert.deepEqual(recorded.changes, [{ status: "checking" }, { status: "ready", version: "0.11.0" }]);
});

test("the reducer covers every state and event", () => {
  const states: AppUpdateState[] = [
    { status: "off" },
    { status: "unsupported", reason: "development-build" },
    { status: "unsupported", reason: "read-only-volume" },
    { status: "idle", checkedAt: null },
    { status: "checking" },
    { status: "downloading" },
    { status: "ready", version: "0.11.0" },
    { status: "failed", code: "check-failed" },
  ];
  const events: AppUpdateEvent[] = [
    { type: "enable" },
    { type: "disable" },
    { type: "check" },
    { type: "update-available" },
    { type: "update-not-available", at: "2026-10-31T04:00:00.000Z" },
    { type: "update-downloaded", version: "0.12.0" },
    { type: "error", readOnlyVolume: false },
    { type: "error", readOnlyVolume: true },
  ];
  const table = Object.fromEntries(states.map((state) => [
    state.status === "unsupported" ? `unsupported:${state.reason}` : state.status,
    events.map((event) => reduceAppUpdate(state, event).status),
  ]));
  assert.deepEqual(table, {
    off: ["idle", "off", "off", "off", "off", "ready", "off", "off"],
    "unsupported:development-build": Array(8).fill("unsupported"),
    "unsupported:read-only-volume": Array(8).fill("unsupported"),
    idle: ["idle", "off", "checking", "idle", "idle", "ready", "idle", "unsupported"],
    checking: ["checking", "off", "checking", "downloading", "idle", "ready", "failed", "unsupported"],
    downloading: ["downloading", "off", "downloading", "downloading", "downloading", "ready", "failed", "unsupported"],
    ready: ["ready", "ready", "ready", "ready", "ready", "ready", "ready", "ready"],
    failed: ["failed", "off", "checking", "failed", "failed", "ready", "failed", "unsupported"],
  });
});
