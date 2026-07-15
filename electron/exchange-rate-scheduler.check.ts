import assert from "node:assert/strict";
import test from "node:test";
import type { SystemSettingsDto } from "../src/lib/settings/system-settings.ts";
import {
  createExchangeRateScheduler,
  exchangeRateSchedule,
} from "./exchange-rate-scheduler.ts";

const taipei: SystemSettingsDto = {
  systemTimezone: "Asia/Taipei",
  exchangeRateUpdateTime: "06:00",
};

test("schedule selects today's occurrence before and after 06:00 in Taipei", () => {
  assert.deepEqual(exchangeRateSchedule(new Date("2026-07-15T21:59:00Z"), taipei), {
    latestOccurrenceUtc: "2026-07-14T22:00:00.000Z",
    nextOccurrenceUtc: "2026-07-15T22:00:00.000Z",
  });
  assert.deepEqual(exchangeRateSchedule(new Date("2026-07-15T22:01:00Z"), taipei), {
    latestOccurrenceUtc: "2026-07-15T22:00:00.000Z",
    nextOccurrenceUtc: "2026-07-16T22:00:00.000Z",
  });
});

test("schedule keeps 06:00 local across New York DST", () => {
  const settings: SystemSettingsDto = {
    systemTimezone: "America/New_York",
    exchangeRateUpdateTime: "06:00",
  };
  assert.deepEqual(exchangeRateSchedule(new Date("2026-03-07T12:00:00Z"), settings), {
    latestOccurrenceUtc: "2026-03-07T11:00:00.000Z",
    nextOccurrenceUtc: "2026-03-08T10:00:00.000Z",
  });
  assert.deepEqual(exchangeRateSchedule(new Date("2026-11-01T12:00:00Z"), settings), {
    latestOccurrenceUtc: "2026-11-01T11:00:00.000Z",
    nextOccurrenceUtc: "2026-11-02T11:00:00.000Z",
  });
});

test("schedule advances past New York DST gaps and overlaps", () => {
  assert.deepEqual(exchangeRateSchedule(new Date("2026-03-08T06:00:00Z"), {
    systemTimezone: "America/New_York",
    exchangeRateUpdateTime: "02:30",
  }), {
    latestOccurrenceUtc: "2026-03-07T07:30:00.000Z",
    nextOccurrenceUtc: "2026-03-08T07:00:00.000Z",
  });
  assert.deepEqual(exchangeRateSchedule(new Date("2026-11-01T06:30:00Z"), {
    systemTimezone: "America/New_York",
    exchangeRateUpdateTime: "01:30",
  }), {
    latestOccurrenceUtc: "2026-10-31T05:30:00.000Z",
    nextOccurrenceUtc: "2026-11-01T07:00:00.000Z",
  });
});

type Timer = { callback: () => void; ms: number };

function harness(overrides: Partial<Parameters<typeof createExchangeRateScheduler>[0]> = {}) {
  let currentNow = new Date("2026-07-15T23:00:00Z");
  const timers: Timer[] = [];
  const cleared: Timer[] = [];
  const starts: string[] = [];
  const errors: unknown[] = [];
  const deps: Parameters<typeof createExchangeRateScheduler>[0] = {
    now: () => currentNow,
    setTimer: (callback, ms) => {
      const timer = { callback, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => cleared.push(timer as Timer),
    readSettings: () => taipei,
    hasSuccessSince: () => false,
    isTaskActive: () => false,
    startTask: (scheduledAtUtc) => { starts.push(scheduledAtUtc); },
    reportError: (error) => errors.push(error),
    ...overrides,
  };
  return {
    scheduler: createExchangeRateScheduler(deps),
    timers,
    cleared,
    starts,
    errors,
    setNow: (value: string) => { currentNow = new Date(value); },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("startup catch-up starts once with the missed occurrence", async () => {
  const h = harness();
  h.scheduler.start();
  await settle();
  assert.deepEqual(h.starts, ["2026-07-15T22:00:00.000Z"]);
  assert.equal(h.timers.length, 1);
});

test("startup catch-up lookup does not block startup", async () => {
  let lookedUp = false;
  const h = harness({ hasSuccessSince: () => { lookedUp = true; return false; } });
  h.scheduler.start();
  assert.equal(lookedUp, false);
  await settle();
  assert.equal(lookedUp, true);
});

test("a manual success after the occurrence suppresses startup catch-up", async () => {
  const h = harness({ hasSuccessSince: () => true });
  h.scheduler.start();
  await settle();
  assert.deepEqual(h.starts, []);
  assert.equal(h.timers.length, 1);
});

test("a failed prior run does not satisfy the next startup", async () => {
  let successful = false;
  const starts: string[] = [];
  const overrides = {
    hasSuccessSince: () => successful,
    startTask: (scheduledAtUtc: string) => { starts.push(scheduledAtUtc); },
  };
  const first = harness(overrides);
  first.scheduler.start();
  await settle();
  first.scheduler.stop();
  const second = harness(overrides);
  second.scheduler.start();
  await settle();
  assert.deepEqual(starts, ["2026-07-15T22:00:00.000Z", "2026-07-15T22:00:00.000Z"]);
});

test("an active exchange-rate task suppresses a duplicate start", async () => {
  const h = harness({ isTaskActive: () => true });
  h.scheduler.start();
  await settle();
  assert.deepEqual(h.starts, []);
});

test("stop cancels a due check waiting on success lookup", async () => {
  const success = deferred<boolean>();
  let activeChecks = 0;
  const h = harness({
    hasSuccessSince: () => success.promise,
    isTaskActive: () => { activeChecks += 1; return false; },
  });
  h.scheduler.start();
  await settle();
  h.scheduler.stop();
  success.resolve(false);
  await settle();
  assert.equal(activeChecks, 0);
  assert.deepEqual(h.starts, []);
});

test("reschedule cancels a due check waiting on success lookup", async () => {
  const success = deferred<boolean>();
  let lookups = 0;
  const h = harness({
    hasSuccessSince: () => lookups++ === 0 ? success.promise : true,
  });
  h.scheduler.start();
  await settle();
  h.scheduler.reschedule();
  success.resolve(false);
  await settle();
  assert.deepEqual(h.starts, []);
});

test("reschedule cancels a due check waiting on active-task lookup", async () => {
  const active = deferred<boolean>();
  let activeChecks = 0;
  const h = harness({
    isTaskActive: () => activeChecks++ === 0 ? active.promise : true,
  });
  h.scheduler.start();
  await settle();
  h.scheduler.reschedule();
  active.resolve(false);
  await settle();
  assert.deepEqual(h.starts, []);
});

test("stop cancels a due check waiting on active-task lookup", async () => {
  const active = deferred<boolean>();
  const h = harness({ isTaskActive: () => active.promise });
  h.scheduler.start();
  await settle();
  h.scheduler.stop();
  active.resolve(false);
  await settle();
  assert.deepEqual(h.starts, []);
});

test("the next occurrence fires once and arms the following day", async () => {
  let lookups = 0;
  const h = harness({ hasSuccessSince: () => lookups++ === 0 });
  h.setNow("2026-07-15T21:00:00Z");
  h.scheduler.start();
  await settle();
  assert.equal(h.timers.length, 1);
  h.setNow("2026-07-15T22:00:00Z");
  h.timers[0].callback();
  h.timers[0].callback();
  await settle();
  assert.deepEqual(h.starts, ["2026-07-15T22:00:00.000Z"]);
  assert.equal(h.timers.length, 2);
  assert.equal(h.timers[1].ms, 86_400_000);
});

test("reschedule clears the old timer and uses changed settings", () => {
  let settings = taipei;
  const h = harness({ readSettings: () => settings });
  h.setNow("2026-07-15T21:00:00Z");
  h.scheduler.start();
  const oldTimer = h.timers[0];
  settings = { systemTimezone: "America/New_York", exchangeRateUpdateTime: "07:30" };
  h.scheduler.reschedule();
  assert.deepEqual(h.cleared, [oldTimer]);
  assert.equal(h.timers.length, 2);
  assert.equal(h.timers[1].ms, Date.parse("2026-07-16T11:30:00.000Z") - Date.parse("2026-07-15T21:00:00Z"));
});

test("reschedule runs a newly due occurrence exactly once", async () => {
  let settings: SystemSettingsDto = {
    systemTimezone: "Asia/Taipei",
    exchangeRateUpdateTime: "10:00",
  };
  const newlyDue = "2026-07-15T00:00:00.000Z";
  const h = harness({
    readSettings: () => settings,
    hasSuccessSince: (occurrenceUtc) => occurrenceUtc !== newlyDue,
  });
  h.setNow("2026-07-15T01:00:00.000Z");
  h.scheduler.start();
  await settle();

  settings = { ...settings, exchangeRateUpdateTime: "08:00" };
  h.scheduler.reschedule();
  h.timers[0].callback();
  await settle();

  assert.deepEqual(h.starts, [newlyDue]);
  assert.equal(h.timers.length, 2);
});

test("reschedule does not duplicate a satisfied or active occurrence", async () => {
  for (const state of ["successful", "active"] as const) {
    let settings: SystemSettingsDto = {
      systemTimezone: "Asia/Taipei",
      exchangeRateUpdateTime: "10:00",
    };
    const h = harness({
      readSettings: () => settings,
      hasSuccessSince: () => state === "successful",
      isTaskActive: () => state === "active",
    });
    h.setNow("2026-07-15T01:00:00.000Z");
    h.scheduler.start();
    await settle();

    settings = { ...settings, exchangeRateUpdateTime: "08:00" };
    h.scheduler.reschedule();
    await settle();

    assert.deepEqual(h.starts, [], state);
  }
});

test("timers arm at the first valid minute after DST gaps and overlaps", () => {
  let settings: SystemSettingsDto = {
    systemTimezone: "America/New_York",
    exchangeRateUpdateTime: "02:30",
  };
  const h = harness({ readSettings: () => settings });
  h.setNow("2026-03-08T06:00:00Z");
  h.scheduler.start();
  assert.equal(h.timers[0]?.ms, 3_600_000);

  settings = {
    systemTimezone: "America/New_York",
    exchangeRateUpdateTime: "01:30",
  };
  h.setNow("2026-11-01T06:30:00Z");
  h.scheduler.reschedule();
  assert.equal(h.timers[1]?.ms, 1_800_000);
});

test("a skipped local date is reported and the following date is armed", () => {
  const h = harness({
    readSettings: () => ({
      systemTimezone: "Pacific/Apia",
      exchangeRateUpdateTime: "23:00",
    }),
  });
  h.setNow("2011-12-30T09:30:00Z");
  h.scheduler.start();
  assert.equal(h.errors.length, 1);
  assert.equal(h.timers[0]?.ms, 84_600_000);
});

test("lookup and start errors are reported without crashing or double-starting", async () => {
  const lookupError = new Error("lookup failed");
  const lookup = harness({ hasSuccessSince: () => { throw lookupError; } });
  assert.doesNotThrow(() => lookup.scheduler.start());
  await settle();
  assert.deepEqual(lookup.errors, [lookupError]);
  assert.deepEqual(lookup.starts, []);

  const startError = new Error("start failed");
  const start = harness({ startTask: () => { throw startError; } });
  start.scheduler.start();
  await settle();
  assert.deepEqual(start.errors, [startError]);
  assert.deepEqual(start.starts, []);
  assert.equal(start.timers.length, 1);
});

test("reschedule reports settings errors without throwing", () => {
  const settingsError = new Error("settings failed");
  let fail = false;
  const h = harness({
    readSettings: () => {
      if (fail) throw settingsError;
      return taipei;
    },
  });
  h.scheduler.start();
  fail = true;
  assert.doesNotThrow(() => h.scheduler.reschedule());
  assert.deepEqual(h.errors, [settingsError]);
});
