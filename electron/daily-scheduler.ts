import type { SystemSettingsDto } from "../src/lib/settings/system-settings.ts";
import { zonedDateTimeToUtc } from "../src/lib/time/timezone.ts";

type Awaitable<T> = T | Promise<T>;

/** One local time of day in one time zone. */
export type DailySchedule = { time: string; timeZone: string };

type ExchangeRateSettings = Pick<SystemSettingsDto, "systemTimezone" | "exchangeRateUpdateTime">;

export type DailySchedulerDependencies = {
  now(): Date;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  readSchedule(): DailySchedule;
  /** Called at most once per occurrence; `isCurrent` turns false once a stop or a changed schedule supersedes it. */
  fire(occurrenceUtc: string, isCurrent: () => boolean): Awaitable<void>;
  /** False keeps a settings change from running the occurrence that already passed; catch-up then happens only at start. */
  catchUpOnReschedule: boolean;
  reportError(error: unknown): void;
};

export type ExchangeRateSchedulerDependencies = {
  now(): Date;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  readSettings(): ExchangeRateSettings;
  hasOccurrenceBeenAttempted(occurrenceUtc: string): Awaitable<boolean>;
  hasSuccessSince(occurrenceUtc: string): Awaitable<boolean>;
  isTaskActive(): Awaitable<boolean>;
  startTask(scheduledAtUtc: string): Awaitable<void>;
  reportError(error: unknown): void;
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
    now: deps.now,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    readSchedule: () => exchangeRateDailySchedule(deps.readSettings()),
    catchUpOnReschedule: true,
    reportError: deps.reportError,
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

export type ScheduledCollectionSchedulerDependencies = {
  now(): Date;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  readSettings(): Pick<SystemSettingsDto, "systemTimezone" | "scheduledCollectionEnabled" | "scheduledCollectionTime">;
  startCollection(occurrenceUtc: string): Awaitable<void>;
  reportError(error: unknown): void;
};

/** Turning the setting on or moving the time never starts a run on the spot; only launch catches up. */
export function createScheduledCollectionScheduler(deps: ScheduledCollectionSchedulerDependencies) {
  return createDailyScheduler({
    now: deps.now,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    readSchedule: () => {
      const settings = deps.readSettings();
      return { time: settings.scheduledCollectionTime, timeZone: settings.systemTimezone };
    },
    catchUpOnReschedule: false,
    reportError: deps.reportError,
    async fire(occurrenceUtc, isCurrent) {
      if (!isCurrent() || !deps.readSettings().scheduledCollectionEnabled) return;
      await deps.startCollection(occurrenceUtc);
    },
  });
}

export function createDailyScheduler(deps: DailySchedulerDependencies) {
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
      const token = deps.setTimer(() => {
        if (!running || timer !== token) return;
        timer = undefined;
        const expectedGeneration = generation;
        armNext();
        consider(nextOccurrenceUtc, expectedGeneration);
      }, Math.max(0, Date.parse(nextOccurrenceUtc) - now.getTime()));
      timer = token;
    } catch (error) {
      report(error);
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      try {
        const selected = readSchedule();
        const { latestOccurrenceUtc } = selected.schedule;
        const expectedGeneration = generation;
        consider(latestOccurrenceUtc, expectedGeneration);
        armNext(selected);
      } catch (error) {
        report(error);
      }
    },
    reschedule() {
      if (!running) return;
      try {
        const selected = readSchedule();
        const { latestOccurrenceUtc } = selected.schedule;
        if (latestOccurrenceUtc !== lastConsideredOccurrenceUtc) generation += 1;
        const expectedGeneration = generation;
        if (deps.catchUpOnReschedule) consider(latestOccurrenceUtc, expectedGeneration);
        else lastConsideredOccurrenceUtc = latestOccurrenceUtc;
        if (timer !== undefined) deps.clearTimer(timer);
        timer = undefined;
        armNext(selected);
      } catch (error) {
        report(error);
      }
    },
    stop() {
      running = false;
      generation += 1;
      if (timer !== undefined) deps.clearTimer(timer);
      timer = undefined;
    },
  };
}
