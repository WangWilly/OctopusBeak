import type { SystemSettingsDto } from "../src/lib/settings/system-settings.ts";
import { zonedDateTimeToUtc } from "../src/lib/time/timezone.ts";

type Awaitable<T> = T | Promise<T>;

export type ExchangeRateSchedulerDependencies = {
  now(): Date;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  readSettings(): SystemSettingsDto;
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

export function exchangeRateSchedule(now: Date, settings: SystemSettingsDto) {
  const today = localDate(now, settings.systemTimezone);
  const occurrence = (date: string) => zonedDateTimeToUtc(
    date,
    `${settings.exchangeRateUpdateTime}:00`,
    settings.systemTimezone,
  );
  const todayOccurrence = occurrence(today);
  const latestDate = now.getTime() >= Date.parse(todayOccurrence) ? today : addDays(today, -1);
  const nextDate = addDays(latestDate, 1);
  return {
    latestOccurrenceUtc: occurrence(latestDate),
    nextOccurrenceUtc: occurrence(nextDate),
  };
}

export function createExchangeRateScheduler(deps: ExchangeRateSchedulerDependencies) {
  let timer: unknown;
  let running = false;
  let generation = 0;

  const report = (error: unknown) => {
    try { deps.reportError(error); } catch {}
  };

  const attempt = async (occurrenceUtc: string, expectedGeneration: number) => {
    try {
      if (await deps.hasSuccessSince(occurrenceUtc)) return;
      if (!running || generation !== expectedGeneration || await deps.isTaskActive()) return;
      await deps.startTask(occurrenceUtc);
    } catch (error) {
      report(error);
    }
  };

  const armNext = () => {
    try {
      const now = deps.now();
      const { nextOccurrenceUtc } = exchangeRateSchedule(now, deps.readSettings());
      const token = deps.setTimer(() => {
        if (!running || timer !== token) return;
        timer = undefined;
        const expectedGeneration = generation;
        armNext();
        void attempt(nextOccurrenceUtc, expectedGeneration);
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
        const { latestOccurrenceUtc } = exchangeRateSchedule(deps.now(), deps.readSettings());
        const expectedGeneration = generation;
        queueMicrotask(() => { void attempt(latestOccurrenceUtc, expectedGeneration); });
      } catch (error) {
        report(error);
      }
      armNext();
    },
    reschedule() {
      if (!running) return;
      generation += 1;
      if (timer !== undefined) deps.clearTimer(timer);
      timer = undefined;
      armNext();
    },
    stop() {
      running = false;
      generation += 1;
      if (timer !== undefined) deps.clearTimer(timer);
      timer = undefined;
    },
  };
}
