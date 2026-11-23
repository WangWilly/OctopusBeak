import type { SystemSettingsDto } from "../src/lib/settings/system-settings.ts";
import { zonedDateTimeToUtc } from "../src/lib/time/timezone.ts";

type Awaitable<T> = T | Promise<T>;

export type DailySchedule = { time: string; timeZone: string };

type ExchangeRateSettings = Pick<SystemSettingsDto, "systemTimezone" | "exchangeRateUpdateTime">;

type ClockDependencies = {
  now(): Date;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  reportError(error: unknown): void;
};

type DailySchedulerDependencies = ClockDependencies & {
  readSchedule(): DailySchedule;
  fire(occurrenceUtc: string, isCurrent: () => boolean): Awaitable<void>;
  onReschedule: "catch-up" | "skip-passed-occurrence";
  /**
   * A missed occurrence is not caught up when the next one is due within
   * this long: the next one runs soon, and two runs close together would
   * repeat every sign-in for nothing.
   */
  catchUpGraceMs?: number;
};

/**
 * The longest a timer waits before the scheduler reads the clock again.
 * Timers do not count time the Mac sleeps, so one long timer would fire hours
 * late; a short one bounds the drift even when no wake event arrives.
 */
export const MAX_TIMER_MS = 60 * 60 * 1000;

/** Scheduled collection skips a catch-up when its next run is this close. */
export const COLLECTION_CATCH_UP_GRACE_MS = 3 * 60 * 60 * 1000;

export type ExchangeRateSchedulerDependencies = ClockDependencies & {
  readSettings(): ExchangeRateSettings;
  hasOccurrenceBeenAttempted(occurrenceUtc: string): Awaitable<boolean>;
  hasSuccessSince(occurrenceUtc: string): Awaitable<boolean>;
  isTaskActive(): Awaitable<boolean>;
  startTask(scheduledAtUtc: string): Awaitable<void>;
};

function localDate(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function occurrenceOnDate(date: string, schedule: DailySchedule) {
  const [hour, minute] = schedule.time.split(":").map(Number);
  for (let localMinute = hour * 60 + minute; localMinute < 24 * 60; localMinute += 1) {
    const time = `${String(Math.floor(localMinute / 60)).padStart(2, "0")}:${String(localMinute % 60).padStart(2, "0")}:00`;
    try {
      return zonedDateTimeToUtc(date, time, schedule.timeZone);
    } catch (error) {
      if (error instanceof RangeError && error.message.startsWith("Local date-time is nonexistent or ambiguous:")) continue;
      throw error;
    }
  }
}

function scheduleDetails(now: Date, schedule: DailySchedule) {
  const today = localDate(now, schedule.timeZone);
  const skippedDates = new Set<string>();
  const findOccurrence = (date: string, direction: -1 | 1) => {
    for (let offset = 0; offset < 366; offset += 1) {
      const candidateDate = addDays(date, offset * direction);
      const occurrence = occurrenceOnDate(candidateDate, schedule);
      if (occurrence) return occurrence;
      skippedDates.add(candidateDate);
    }
    throw new RangeError(`No valid daily schedule occurrence near ${date}`);
  };
  const todayOccurrence = occurrenceOnDate(today, schedule);
  if (!todayOccurrence) skippedDates.add(today);
  const occurredToday = todayOccurrence && now.getTime() >= Date.parse(todayOccurrence);
  return {
    latestOccurrenceUtc: occurredToday
      ? todayOccurrence
      : findOccurrence(addDays(today, -1), -1),
    nextOccurrenceUtc: todayOccurrence && !occurredToday
      ? todayOccurrence
      : findOccurrence(addDays(today, 1), 1),
    skippedDates: [...skippedDates],
  };
}

function exchangeRateDailySchedule(settings: ExchangeRateSettings): DailySchedule {
  return { time: settings.exchangeRateUpdateTime, timeZone: settings.systemTimezone };
}

export function exchangeRateSchedule(now: Date, settings: ExchangeRateSettings) {
  const { latestOccurrenceUtc, nextOccurrenceUtc } = scheduleDetails(now, exchangeRateDailySchedule(settings));
  return { latestOccurrenceUtc, nextOccurrenceUtc };
}

export function createExchangeRateScheduler(deps: ExchangeRateSchedulerDependencies) {
  return createDailyScheduler({
    ...deps,
    readSchedule: () => exchangeRateDailySchedule(deps.readSettings()),
    onReschedule: "catch-up",
    async fire(occurrenceUtc, isCurrent) {
      const [attempted, successful] = await Promise.all([
        deps.hasOccurrenceBeenAttempted(occurrenceUtc),
        deps.hasSuccessSince(occurrenceUtc),
      ]);
      if (!isCurrent() || attempted || successful) return;
      const active = await deps.isTaskActive();
      if (!isCurrent() || active) return;
      await deps.startTask(occurrenceUtc);
    },
  });
}

export type ScheduledCollectionSchedulerDependencies = ClockDependencies & {
  readSettings(): Pick<SystemSettingsDto, "systemTimezone" | "scheduledCollectionEnabled" | "scheduledCollectionTime">;
  startCollection(occurrenceUtc: string): Awaitable<void>;
};

export function createScheduledCollectionScheduler(deps: ScheduledCollectionSchedulerDependencies) {
  return createDailyScheduler({
    ...deps,
    readSchedule: () => {
      const settings = deps.readSettings();
      return { time: settings.scheduledCollectionTime, timeZone: settings.systemTimezone };
    },
    onReschedule: "skip-passed-occurrence",
    catchUpGraceMs: COLLECTION_CATCH_UP_GRACE_MS,
    async fire(occurrenceUtc, isCurrent) {
      if (!isCurrent() || !deps.readSettings().scheduledCollectionEnabled) return;
      await deps.startCollection(occurrenceUtc);
    },
  });
}

function createDailyScheduler(deps: DailySchedulerDependencies) {
  let timer: unknown;
  let running = false;
  let generation = 0;
  let lastConsideredOccurrenceUtc: string | undefined;

  const report = (error: unknown) => {
    try { deps.reportError(error); } catch {}
  };

  const attempt = async (occurrenceUtc: string, expectedGeneration: number) => {
    try {
      await deps.fire(occurrenceUtc, () => running && generation === expectedGeneration);
    } catch (error) {
      report(error);
    }
  };

  const consider = (occurrenceUtc: string, expectedGeneration: number) => {
    if (occurrenceUtc === lastConsideredOccurrenceUtc) return;
    lastConsideredOccurrenceUtc = occurrenceUtc;
    queueMicrotask(() => { void attempt(occurrenceUtc, expectedGeneration); });
  };

  const readSchedule = () => {
    const now = deps.now();
    const schedule = scheduleDetails(now, deps.readSchedule());
    for (const date of schedule.skippedDates) {
      report(new RangeError(`No valid daily schedule minute on ${date}`));
    }
    return { now, schedule };
  };

  const armNext = (selected?: ReturnType<typeof readSchedule>) => {
    try {
      const { now, schedule: { nextOccurrenceUtc } } = selected ?? readSchedule();
      const due = Date.parse(nextOccurrenceUtc);
      const token = deps.setTimer(() => {
        if (!running || timer !== token) return;
        timer = undefined;
        // An early wake-up only reads the clock again.
        if (deps.now().getTime() < due) {
          armNext();
          return;
        }
        const expectedGeneration = generation;
        armNext();
        consider(nextOccurrenceUtc, expectedGeneration);
      }, Math.min(MAX_TIMER_MS, Math.max(0, due - now.getTime())));
      timer = token;
    } catch (error) {
      report(error);
    }
  };

  /** Runs the latest occurrence if it was missed, unless the next one is about to run anyway. */
  const catchUp = ({ now, schedule }: ReturnType<typeof readSchedule>) => {
    const untilNext = Date.parse(schedule.nextOccurrenceUtc) - now.getTime();
    if (deps.catchUpGraceMs !== undefined && untilNext < deps.catchUpGraceMs) {
      lastConsideredOccurrenceUtc = schedule.latestOccurrenceUtc;
      return;
    }
    consider(schedule.latestOccurrenceUtc, generation);
  };

  const start = () => {
    if (running) return;
    running = true;
    try {
      const selected = readSchedule();
      catchUp(selected);
      armNext(selected);
    } catch (error) {
      report(error);
    }
  };
  const stop = () => {
    running = false;
    generation += 1;
    if (timer !== undefined) deps.clearTimer(timer);
    timer = undefined;
  };

  return {
    start,
    reschedule() {
      if (!running) return;
      try {
        const selected = readSchedule();
        const { latestOccurrenceUtc } = selected.schedule;
        if (latestOccurrenceUtc !== lastConsideredOccurrenceUtc) generation += 1;
        const expectedGeneration = generation;
        if (deps.onReschedule === "catch-up") consider(latestOccurrenceUtc, expectedGeneration);
        else lastConsideredOccurrenceUtc = latestOccurrenceUtc;
        if (timer !== undefined) deps.clearTimer(timer);
        timer = undefined;
        armNext(selected);
      } catch (error) {
        report(error);
      }
    },
    stop,
    /**
     * The Mac woke or the screen unlocked: read the clock again, run an
     * occurrence that passed while it slept, as a start would, and arm the
     * next one from the real time.
     */
    wake() {
      if (!running) return;
      try {
        const selected = readSchedule();
        catchUp(selected);
        if (timer !== undefined) deps.clearTimer(timer);
        timer = undefined;
        armNext(selected);
      } catch (error) {
        report(error);
      }
    },
    /**
     * Stop until the returned resume, which restarts only a scheduler that was
     * running. An occurrence that came due while paused is skipped rather than
     * caught up, so nothing collects by itself right after a Canonical Reset.
     */
    pause() {
      const wasRunning = running;
      stop();
      return () => {
        if (!wasRunning || running) return;
        running = true;
        try {
          const selected = readSchedule();
          lastConsideredOccurrenceUtc = selected.schedule.latestOccurrenceUtc;
          armNext(selected);
        } catch (error) {
          report(error);
        }
      };
    },
  };
}
