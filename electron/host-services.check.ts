import assert from "node:assert/strict";
import test from "node:test";
import { createHostServices, type HostServiceDependencies, type HostSchedule } from "./host-services.ts";

/** Fake services that record every call, in order, into one log. */
function harness(run: HostServiceDependencies["run"] = { schedules: true, usagePing: true }) {
  const log: string[] = [];
  const schedule = (name: string): HostSchedule => {
    let running = false;
    return {
      start: () => { running = true; log.push(`${name}.start`); },
      stop: () => { running = false; log.push(`${name}.stop`); },
      reschedule: () => { log.push(`${name}.reschedule`); },
      pause: () => {
        const wasRunning = running;
        running = false;
        log.push(`${name}.pause`);
        return () => {
          if (wasRunning) running = true;
          log.push(`${name}.resume${wasRunning ? "" : " (idle)"}`);
        };
      },
    };
  };
  const services = createHostServices({
    exchangeRates: schedule("exchangeRates"),
    collection: schedule("collection"),
    usagePing: {
      start: () => log.push("usagePing.start"),
      stop: () => log.push("usagePing.stop"),
      check: () => log.push("usagePing.check"),
    },
    appUpdates: {
      start: () => log.push("appUpdates.start"),
      stop: () => log.push("appUpdates.stop"),
      applySettings: (settings) => log.push(`appUpdates.apply ${settings.enabled}/${settings.autoDownload}`),
    },
    run,
    startAfterReady: [() => {
      log.push("runEventCleanup.start");
      return () => log.push("runEventCleanup.stop");
    }],
    stopOnQuit: [() => log.push("browserStateCleanup.stop")],
  });
  return { services, log };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("nothing starts until recovery is ready, then every service starts once", async () => {
  const { services, log } = harness();
  const ready = deferred();
  services.startWhenReady(ready.promise);
  await settle();
  assert.deepEqual(log, [], "no schedule claims a run before recovery reconciles the active one");
  ready.resolve();
  await settle();
  assert.deepEqual(log, [
    "runEventCleanup.start",
    "exchangeRates.start",
    "collection.start",
    "usagePing.start",
    "appUpdates.start",
  ]);
});

test("a failed recovery starts nothing", async () => {
  const { services, log } = harness();
  const ready = deferred();
  services.startWhenReady(ready.promise);
  ready.reject(new Error("recovery failed"));
  await settle();
  assert.deepEqual(log, []);
});

test("a fixture launch runs no schedules and an unpackaged one never pings", async () => {
  const { services, log } = harness({ schedules: false, usagePing: false });
  services.startWhenReady(Promise.resolve());
  await settle();
  assert.deepEqual(log, ["runEventCleanup.start", "appUpdates.start"]);
});

test("quitting while recovery is still running keeps the services from starting afterwards", async () => {
  const { services, log } = harness();
  const ready = deferred();
  services.startWhenReady(ready.promise);
  services.stop();
  log.length = 0;
  ready.resolve();
  await settle();
  assert.deepEqual(log, [], "no timer starts in an app that is already quitting");
});

test("stop ends every service and cleanup, including those started after recovery", async () => {
  const { services, log } = harness();
  services.startWhenReady(Promise.resolve());
  await settle();
  log.length = 0;
  services.stop();
  assert.deepEqual(log, [
    "exchangeRates.stop",
    "collection.stop",
    "usagePing.stop",
    "appUpdates.stop",
    "browserStateCleanup.stop",
    "runEventCleanup.stop",
  ]);
  log.length = 0;
  services.stop();
  assert.equal(log.includes("runEventCleanup.stop"), false, "a started cleanup stops once");
});

test("a settings change reaches every service, with the update choices it carries", () => {
  const { services, log } = harness();
  services.settingsChanged({ appUpdatesEnabled: true, appUpdatesAutoDownload: false });
  assert.deepEqual(log, [
    "exchangeRates.reschedule",
    "collection.reschedule",
    "usagePing.check",
    "appUpdates.apply true/false",
  ]);
});

test("pausing the schedules pauses both, and resume restarts only those that were running", async () => {
  const { services, log } = harness();
  services.startWhenReady(Promise.resolve());
  await settle();
  log.length = 0;
  const resume = services.pauseSchedules();
  resume();
  assert.deepEqual(log, ["exchangeRates.pause", "collection.pause", "exchangeRates.resume", "collection.resume"]);

  const idle = harness({ schedules: false, usagePing: false });
  idle.services.pauseSchedules()();
  assert.deepEqual(idle.log, [
    "exchangeRates.pause",
    "collection.pause",
    "exchangeRates.resume (idle)",
    "collection.resume (idle)",
  ], "a fixture launch's idle schedules stay idle after a resume");
});
