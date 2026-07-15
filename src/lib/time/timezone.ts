export const DEFAULT_SYSTEM_TIMEZONE = "Asia/Taipei";

type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsInTimeZone(date: Date, timeZone: string): DateTimeParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function offsetMs(date: Date, timeZone: string) {
  const parts = partsInTimeZone(date, timeZone);
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ) - date.getTime();
}

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function zonedDateTimeToUtc(date: string, time: string, timeZone: string): string {
  if (!isIanaTimezone(timeZone)) throw new RangeError(`Invalid time zone: ${timeZone}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}:\d{2}$/.test(time)) {
    throw new RangeError(`Invalid local date-time: ${date} ${time}`);
  }
  const local = `${date}T${time}`;
  const naiveUtc = Date.parse(`${local}Z`);
  if (!Number.isFinite(naiveUtc) || new Date(naiveUtc).toISOString().slice(0, 19) !== local) {
    throw new RangeError(`Invalid local date-time: ${date} ${time}`);
  }

  const dayMs = 86_400_000;
  const offsets = new Set([-2, -1, 0, 1, 2].map((days) => offsetMs(new Date(naiveUtc + days * dayMs), timeZone)));
  const matches = [...offsets]
    .map((offset) => new Date(naiveUtc - offset))
    .filter((candidate) => {
      const parts = partsInTimeZone(candidate, timeZone);
      return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}` === local;
    });
  if (matches.length !== 1) throw new RangeError(`Local date-time is nonexistent or ambiguous: ${date} ${time} ${timeZone}`);
  return matches[0].toISOString();
}

export function formatUtcDateTime(
  value: string | null | undefined,
  timeZone: string,
  locale: string,
): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError(`Invalid UTC date-time: ${value}`);
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
