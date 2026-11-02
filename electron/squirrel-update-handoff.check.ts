import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { AppRelease, AppUpdaterSignal, AppUpdateSupport } from "../src/lib/settings/app-updates.ts";
import { createSquirrelHandoff } from "./squirrel-update-handoff.ts";

const RELEASE = { version: "1.2.3", size: 10, sha256: "abc" } as unknown as AppRelease;
const SQUIRREL: AppUpdateSupport = { supported: true, feedUrl: "https://feed", downloadPrefix: "https://dl/", squirrel: true };
const FIXTURE: AppUpdateSupport = { supported: true, feedUrl: "http://fixture", downloadPrefix: "http://fixture/", squirrel: false };

function harness(support: AppUpdateSupport, options: Readonly<{ start?: () => Promise<{ feedUrl: string; close(): void }>; rehearse?: () => Promise<boolean> }> = {}) {
  const calls: string[] = [];
  const signals: AppUpdaterSignal[] = [];
  let closed = 0;
  const updater = Object.assign(new EventEmitter(), {
    setFeedURL: (input: { url: string; serverType: "default" }) => { calls.push(`feed ${input.url} ${input.serverType}`); },
    checkForUpdates: () => { calls.push("check"); },
    quitAndInstall: () => { calls.push("quit"); },
  });
  const handoff = createSquirrelHandoff({
    support,
    autoUpdater: updater,
    zipPath: (release) => `/updates/OctopusBeak-${release.version}.zip`,
    start: options.start ?? (async (zipPath) => {
      calls.push(`start ${zipPath}`);
      return { feedUrl: "http://127.0.0.1:1/token/feed.json", close: () => { closed += 1; } };
    }),
    rehearse: options.rehearse ?? (async () => true),
    receive: (signal) => signals.push(signal),
    reportError: (code) => calls.push(`report ${code}`),
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { handoff, updater, calls, signals, closed: () => closed, settle };
}

test("Squirrel.Mac reads only the localhost hand-off feed, then checks", async () => {
  const { handoff, calls, signals, settle } = harness(SQUIRREL);
  handoff.install(RELEASE);
  await settle();
  assert.deepEqual(calls, ["start /updates/OctopusBeak-1.2.3.zip", "feed http://127.0.0.1:1/token/feed.json default", "check"]);
  assert.deepEqual(signals, [], "the answer comes from Squirrel's events");
});

test("each Squirrel answer closes the hand-off server and reaches the updater", async () => {
  for (const [event, args, expected] of [
    ["update-downloaded", [], { type: "update-downloaded" }],
    ["update-not-available", [], { type: "error", message: "hand-off answered no update" }],
    ["error", [new Error("signature")], { type: "error", message: "signature" }],
  ] as const) {
    const { handoff, updater, signals, closed, settle } = harness(SQUIRREL);
    handoff.install(RELEASE);
    await settle();
    updater.emit(event, ...args);
    assert.equal(closed(), 1, `${event} closes the hand-off server`);
    assert.deepEqual(signals, [expected]);
  }
});

test("a hand-off that cannot start reports an error", async () => {
  const { handoff, signals, calls, settle } = harness(SQUIRREL, { start: () => Promise.reject(new Error("no zip")) });
  handoff.install(RELEASE);
  await settle();
  assert.deepEqual(signals, [{ type: "error", message: "hand-off" }]);
  assert.deepEqual(calls, [], "Squirrel is never pointed at a feed");
});

test("without Squirrel the hand-off is rehearsed, closed, and answered directly", async () => {
  for (const [served, expected] of [
    [true, { type: "update-downloaded" }],
    [false, { type: "error", message: "fixture hand-off" }],
  ] as const) {
    const { handoff, updater, signals, closed, calls, settle } = harness(FIXTURE, { rehearse: async () => served });
    handoff.install(RELEASE);
    await settle();
    await settle();
    assert.deepEqual(signals, [expected]);
    assert.equal(closed(), 1);
    assert.equal(updater.listenerCount("update-downloaded"), 0, "no Squirrel listeners without Squirrel");
    assert.equal(calls.some((call) => call.startsWith("feed")), false);
  }
});

test("only a Squirrel build restarts to install", () => {
  const squirrel = harness(SQUIRREL);
  squirrel.handoff.quitAndInstall();
  assert.deepEqual(squirrel.calls, ["quit"]);
  const fixture = harness(FIXTURE);
  fixture.handoff.quitAndInstall();
  assert.deepEqual(fixture.calls, ["report app-update-fixture-restart-skipped"]);
});
