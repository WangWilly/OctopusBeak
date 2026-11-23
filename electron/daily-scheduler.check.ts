import assert from "node:assert/strict";
import test from "node:test";
import {
  COLLECTION_CATCH_UP_GRACE_MS,
  createScheduledCollectionScheduler,
  createExchangeRateScheduler,
  exchangeRateSchedule,
  MAX_TIMER_MS,
} from "./daily-scheduler.ts";

/** A timer waits at most MAX_TIMER_MS, then reads the clock again. */
const armedFor = (ms: number) => Math.min(ms, MAX_TIMER_MS);

type SystemSettingsDto = Parameters<typeof exchangeRateSchedule>[1];

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
    hasOccurrenceBeenAttempted: () => false,
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

test("multiple App-closed daily occurrences coalesce to the latest single run", async () => {
  const h = harness();
  h.setNow("2026-07-18T23:00:00Z");
  h.scheduler.start();
  await settle();
  assert.deepEqual(h.starts, ["2026-07-18T22:00:00.000Z"]);
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

test("a new scheduler instance retries an unsatisfied occurrence", async () => {
  const starts: string[] = [];
  const overrides = {
    hasSuccessSince: () => false,
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

test("a persisted occurrence attempt prevents duplicate catch-up after restart", async () => {
  const occurrenceClaims = new Set<string>();
  const starts: string[] = [];
  const first = harness({
    hasSuccessSince: () => false,
    startTask: (occurrenceUtc) => {
      starts.push(occurrenceUtc);
      occurrenceClaims.add(occurrenceUtc);
    },
  });
  first.scheduler.start();
  await settle();
  first.scheduler.stop();

  const second = harness({
    hasSuccessSince: () => false,
    hasOccurrenceBeenAttempted: (occurrenceUtc: string) => occurrenceClaims.has(occurrenceUtc),
    startTask: (occurrenceUtc) => { starts.push(occurrenceUtc); },
  });
  second.scheduler.start();
  await settle();

  assert.deepEqual(starts, ["2026-07-15T22:00:00.000Z"]);
});

test("an active exchange-rate task suppresses a duplicate start", async () => {
  const h = harness({ isTaskActive: () => true });
  h.scheduler.start();
  await settle();
  assert.deepEqual(h.starts, []);
});

test("unchanged settings do not retry an unsatisfied occurrence", async () => {
  const h = harness();
  h.scheduler.start();
  await settle();
  h.scheduler.reschedule();
  await settle();
  assert.deepEqual(h.starts, ["2026-07-15T22:00:00.000Z"]);
  assert.equal(h.timers.length, 2);
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

test("same-occurrence reschedule preserves a pending success lookup", async () => {
  const success = deferred<boolean>();
  const h = harness({ hasSuccessSince: () => success.promise });
  h.scheduler.start();
  await settle();
  h.scheduler.reschedule();
  success.resolve(false);
  await settle();
  assert.deepEqual(h.starts, ["2026-07-15T22:00:00.000Z"]);
});

test("same-occurrence reschedule preserves a pending active-task lookup", async () => {
  const active = deferred<boolean>();
  const h = harness({ isTaskActive: () => active.promise });
  h.scheduler.start();
  await settle();
  h.scheduler.reschedule();
  active.resolve(false);
  await settle();
  assert.deepEqual(h.starts, ["2026-07-15T22:00:00.000Z"]);
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
  assert.equal(h.timers[1].ms, armedFor(86_400_000));
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
  assert.equal(h.timers[1].ms, armedFor(Date.parse("2026-07-16T11:30:00.000Z") - Date.parse("2026-07-15T21:00:00Z")));
});

test("reschedule runs a genuinely changed latest occurrence exactly once", async () => {
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

test("changed-occurrence reschedule cancels a stale pending lookup", async () => {
  let settings: SystemSettingsDto = {
    systemTimezone: "Asia/Taipei",
    exchangeRateUpdateTime: "10:00",
  };
  const staleOccurrence = "2026-07-14T02:00:00.000Z";
  const newlyDue = "2026-07-15T00:00:00.000Z";
  const stale = deferred<boolean>();
  const h = harness({
    readSettings: () => settings,
    hasSuccessSince: (occurrenceUtc) => (
      occurrenceUtc === staleOccurrence ? stale.promise : false
    ),
  });
  h.setNow("2026-07-15T01:00:00.000Z");
  h.scheduler.start();
  await settle();

  settings = { ...settings, exchangeRateUpdateTime: "08:00" };
  h.scheduler.reschedule();
  await settle();
  stale.resolve(false);
  await settle();

  assert.deepEqual(h.starts, [newlyDue]);
});

test("unchanged settings do not reconsider a satisfied or active occurrence", async () => {
  for (const state of ["successful", "active"] as const) {
    let successLookups = 0;
    let activeLookups = 0;
    const h = harness({
      hasSuccessSince: () => {
        successLookups += 1;
        return state === "successful";
      },
      isTaskActive: () => {
        activeLookups += 1;
        return state === "active";
      },
    });
    h.scheduler.start();
    await settle();
    h.scheduler.reschedule();
    await settle();

    assert.deepEqual(h.starts, [], state);
    assert.equal(successLookups, 1, state);
    assert.equal(activeLookups, state === "active" ? 1 : 0, state);
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
  assert.equal(h.timers[0]?.ms, armedFor(84_600_000));
});

test("lookup and start errors are reported without crashing or double-starting", async () => {
  const occurrenceClaimError = new Error("occurrence claim lookup failed");
  const occurrenceClaim = harness({
    hasOccurrenceBeenAttempted: () => { throw occurrenceClaimError; },
  });
  assert.doesNotThrow(() => occurrenceClaim.scheduler.start());
  await settle();
  assert.deepEqual(occurrenceClaim.errors, [occurrenceClaimError]);
  assert.deepEqual(occurrenceClaim.starts, []);

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

test("reschedule settings errors preserve the in-flight attempt and timer", async () => {
  const settingsError = new Error("settings failed");
  const success = deferred<boolean>();
  let fail = false;
  const h = harness({
    readSettings: () => {
      if (fail) throw settingsError;
      return taipei;
    },
    hasSuccessSince: () => success.promise,
  });
  h.setNow("2026-07-15T21:00:00.000Z");
  h.scheduler.start();
  await settle();
  const oldTimer = h.timers[0];
  fail = true;
  assert.doesNotThrow(() => h.scheduler.reschedule());
  assert.deepEqual(h.errors, [settingsError]);
  assert.deepEqual(h.cleared, []);

  fail = false;
  h.setNow("2026-07-15T22:00:00.000Z");
  oldTimer.callback();
  success.resolve(false);
  await settle();
  assert.deepEqual(h.starts, [
    "2026-07-14T22:00:00.000Z",
    "2026-07-15T22:00:00.000Z",
  ]);
  assert.equal(h.timers.length, 2);
});

function collectionHarness(initial: { enabled: boolean; now: string }) {
  let currentNow = new Date(initial.now);
  let settings = {
    systemTimezone: "Asia/Taipei",
    scheduledCollectionEnabled: initial.enabled,
    scheduledCollectionTime: "07:00",
  };
  const timers: Timer[] = [];
  const starts: string[] = [];
  const errors: unknown[] = [];
  const scheduler = createScheduledCollectionScheduler({
    now: () => currentNow,
    setTimer: (callback, ms) => {
      const timer = { callback, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => undefined,
    readSettings: () => settings,
    startCollection: (occurrenceUtc) => { starts.push(occurrenceUtc); },
    reportError: (error) => errors.push(error),
  });
  return {
    scheduler,
    timers,
    starts,
    errors,
    /**
     * Runs the armed timer, and the ones it arms in turn, until one starts a
     * collection or the scheduler arms nothing; at most a day.
     */
    advanceToNextTimer: async () => {
      const started = starts.length;
      let elapsed = 0;
      while (elapsed < 24 * 60 * 60 * 1000) {
        const timer = timers.at(-1)!;
        const armed = timers.length;
        currentNow = new Date(currentNow.getTime() + timer.ms);
        elapsed += timer.ms;
        timer.callback();
        await settle();
        if (starts.length > started || timers.length === armed) return;
      }
    },
    setNow: (value: string) => { currentNow = new Date(value); },
    update: (next: Partial<typeof settings>) => { settings = { ...settings, ...next }; },
  };
}

test("scheduled collection starts once at the daily time on each following day", async () => {
  const h = collectionHarness({ enabled: true, now: "2026-07-14T23:30:00Z" });
  h.scheduler.start();
  await settle();
  assert.deepEqual(h.starts, ["2026-07-14T23:00:00.000Z"], "launch after today's 07:00 catches it up");
  await h.advanceToNextTimer();
  await settle();
  await h.advanceToNextTimer();
  await settle();
  assert.deepEqual(h.starts, [
    "2026-07-14T23:00:00.000Z",
    "2026-07-15T23:00:00.000Z",
    "2026-07-16T23:00:00.000Z",
  ]);
  assert.equal(h.timers.at(-1)!.ms, armedFor(24 * 60 * 60 * 1000), "the next run is armed one day later");
  assert.deepEqual(h.errors, []);
});

test("scheduled collection catches up only the latest occurrence missed while the App was closed", async () => {
  const h = collectionHarness({ enabled: true, now: "2026-07-18T02:00:00Z" });
  h.scheduler.start();
  await settle();
  assert.deepEqual(h.starts, ["2026-07-17T23:00:00.000Z"]);
});

test("scheduled collection does nothing while disabled", async () => {
  const h = collectionHarness({ enabled: false, now: "2026-07-14T23:30:00Z" });
  h.scheduler.start();
  await settle();
  await h.advanceToNextTimer();
  await settle();
  assert.deepEqual(h.starts, []);
});

test("turning scheduled collection on or moving its time does not run a time that already passed", async () => {
  const h = collectionHarness({ enabled: false, now: "2026-07-15T07:00:00Z" });
  h.scheduler.start();
  await settle();
  h.update({ scheduledCollectionEnabled: true });
  h.scheduler.reschedule();
  await settle();
  h.update({ scheduledCollectionTime: "09:00" });
  h.scheduler.reschedule();
  await settle();
  assert.deepEqual(h.starts, [], "15:00 local is after both 07:00 and 09:00");
  await h.advanceToNextTimer();
  await settle();
  assert.deepEqual(h.starts, ["2026-07-16T01:00:00.000Z"], "the next 09:00 runs");
});

test("a paused scheduled collection starts nothing until resumed, and resume leaves a stopped scheduler stopped", async () => {
  const h = collectionHarness({ enabled: true, now: "2026-07-14T18:00:00Z" });
  h.scheduler.start();
  await settle();
  assert.deepEqual(h.starts, ["2026-07-13T23:00:00.000Z"], "launch at 02:00 catches up the previous 07:00");
  const resume = h.scheduler.pause();
  h.timers.at(-1)!.callback();
  h.setNow("2026-07-15T00:00:00Z");
  await settle();
  assert.equal(h.starts.length, 1, "the occurrence that came due while paused did not start");
  resume();
  await settle();
  assert.equal(h.starts.length, 1, "resume skips the occurrence that came due while paused");
  await h.advanceToNextTimer();
  await settle();
  assert.deepEqual(h.starts.slice(1), ["2026-07-15T23:00:00.000Z"], "resume follows the normal schedule");

  const stopped = collectionHarness({ enabled: true, now: "2026-07-14T23:30:00Z" });
  stopped.scheduler.pause()();
  await settle();
  assert.deepEqual(stopped.starts, [], "a scheduler that never started stays stopped");
});

test("a Mac asleep through the scheduled time runs it once on waking, not hours later", async () => {
  const h = collectionHarness({ enabled: true, now: "2026-07-14T18:00:00Z" });
  h.scheduler.start();
  await settle();
  const starts = h.starts.length;
  const armed = h.timers.at(-1)!;
  assert.equal(armed.ms, MAX_TIMER_MS, "no timer waits longer than the cap");

  // Asleep from 02:00 until 10:30 local; 07:00 passed during the sleep.
  h.setNow("2026-07-15T02:30:00Z");
  h.scheduler.wake();
  await settle();
  assert.deepEqual(h.starts.slice(starts), ["2026-07-14T23:00:00.000Z"], "waking runs the missed 07:00 once");
  assert.equal(h.timers.at(-1)!.ms, MAX_TIMER_MS, "the next 07:00 is armed from the real time");

  armed.callback();
  h.timers.at(-1)!.callback();
  h.scheduler.wake();
  await settle();
  assert.equal(h.starts.length, starts + 1, "a late timer or a second wake does not run it again");
});

test("a late timer after a sleep without a wake event still runs the occurrence once", async () => {
  const h = collectionHarness({ enabled: true, now: "2026-07-14T22:30:00Z" });
  h.scheduler.start();
  await settle();
  const timer = h.timers.at(-1)!;
  assert.equal(timer.ms, 30 * 60 * 1000);
  h.setNow("2026-07-15T03:00:00Z");
  timer.callback();
  await settle();
  assert.deepEqual(h.starts, ["2026-07-14T23:00:00.000Z"]);
});

test("waking before the scheduled time starts nothing and re-arms from the real time", async () => {
  const h = collectionHarness({ enabled: true, now: "2026-07-14T18:00:00Z" });
  h.scheduler.start();
  await settle();
  const starts = h.starts.length;
  h.setNow("2026-07-14T22:20:00Z");
  h.scheduler.wake();
  await settle();
  assert.equal(h.starts.length, starts);
  assert.equal(h.timers.at(-1)!.ms, 40 * 60 * 1000);
});

test("a missed collection is not caught up when the next one is due within the grace period", async () => {
  const soon = collectionHarness({ enabled: true, now: "2026-07-14T22:00:00Z" });
  soon.scheduler.start();
  await settle();
  assert.deepEqual(soon.starts, [], "launching at 06:00 leaves yesterday's run to today's 07:00");
  await soon.advanceToNextTimer();
  await settle();
  assert.deepEqual(soon.starts, ["2026-07-14T23:00:00.000Z"], "07:00 runs once");

  const early = collectionHarness({ enabled: true, now: "2026-07-14T19:59:00Z" });
  early.scheduler.start();
  await settle();
  assert.deepEqual(early.starts, ["2026-07-13T23:00:00.000Z"], `more than ${COLLECTION_CATCH_UP_GRACE_MS / 3_600_000} hours ahead, the missed run catches up`);
});

test("a timer that fires days late runs only the latest occurrence, once, with a wake right after", async () => {
  const h = collectionHarness({ enabled: true, now: "2026-07-14T02:00:00Z" });
  h.scheduler.start();
  await settle();
  const starts = h.starts.length;
  // Asleep from day 1 10:30 until day 3 08:20 local; the timer fires before any wake event.
  h.setNow("2026-07-16T00:20:00Z");
  h.timers.at(-1)!.callback();
  await settle();
  h.setNow("2026-07-16T00:25:00Z");
  h.scheduler.wake();
  await settle();
  assert.deepEqual(h.starts.slice(starts), ["2026-07-15T23:00:00.000Z"], "day 3 07:00 once, never the stale day 2");
});

test("a timer that fires late but just before the next run leaves the missed one to it", async () => {
  const h = collectionHarness({ enabled: true, now: "2026-07-14T02:00:00Z" });
  h.scheduler.start();
  await settle();
  const starts = h.starts.length;
  h.setNow("2026-07-15T21:30:00Z");
  h.timers.at(-1)!.callback();
  await settle();
  assert.equal(h.starts.length, starts, "05:30 is within the grace of 07:00");
  await h.advanceToNextTimer();
  assert.deepEqual(h.starts.slice(starts), ["2026-07-15T23:00:00.000Z"]);
});

test("a timer that fires a moment before its occurrence still runs that day", async () => {
  const h = collectionHarness({ enabled: true, now: "2026-07-14T22:30:00Z" });
  h.scheduler.start();
  await settle();
  h.setNow("2026-07-14T22:59:59.999Z");
  h.timers.at(-1)!.callback();
  await settle();
  assert.deepEqual(h.starts, [], "early: nothing yet");
  assert.equal(h.timers.at(-1)!.ms, 1, "re-armed for the remaining millisecond");
  h.setNow("2026-07-14T23:00:00Z");
  h.timers.at(-1)!.callback();
  await settle();
  assert.deepEqual(h.starts, ["2026-07-14T23:00:00.000Z"]);
});

test("waking while paused, before start, or after stop runs nothing", async () => {
  const h = collectionHarness({ enabled: true, now: "2026-07-15T02:00:00Z" });
  h.scheduler.wake();
  await settle();
  assert.deepEqual(h.starts, [], "before start");
  h.scheduler.start();
  await settle();
  const starts = h.starts.length;
  const resume = h.scheduler.pause();
  h.setNow("2026-07-16T02:00:00Z");
  h.scheduler.wake();
  await settle();
  resume();
  h.scheduler.wake();
  await settle();
  assert.equal(h.starts.length, starts, "a pause skips what came due, and a wake does not bring it back");
  h.scheduler.stop();
  h.setNow("2026-07-17T02:00:00Z");
  h.scheduler.wake();
  await settle();
  assert.equal(h.starts.length, starts, "after stop");
});
