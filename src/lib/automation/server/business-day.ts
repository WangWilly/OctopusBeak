type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsInTimeZone(date: Date, timeZone: string): DateParts {
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
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return localAsUtc - date.getTime();
}

function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string) {
  let utc = Date.UTC(year, month - 1, day);
  for (let index = 0; index < 3; index += 1) {
    utc = Date.UTC(year, month - 1, day) - offsetMs(new Date(utc), timeZone);
  }
  return new Date(utc);
}

export function businessDayUtcRange(
  now = new Date(),
  timeZone = process.env.AUTOMATION_BUSINESS_TIMEZONE ?? "Asia/Taipei",
) {
  const parts = partsInTimeZone(now, timeZone);
  const startUtc = zonedMidnightUtc(parts.year, parts.month, parts.day, timeZone);
  const endLocal = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const endUtc = zonedMidnightUtc(
    endLocal.getUTCFullYear(),
    endLocal.getUTCMonth() + 1,
    endLocal.getUTCDate(),
    timeZone,
  );
  return {
    businessDate: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    startUtc,
    endUtc,
  };
}
