import { DEFAULT_SYSTEM_TIMEZONE, zonedDateTimeToUtc } from "../../time/timezone.ts";

function dateInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function businessDayUtcRange(
  now = new Date(),
  timeZone = process.env.SYSTEM_TIMEZONE ?? process.env.AUTOMATION_BUSINESS_TIMEZONE ?? DEFAULT_SYSTEM_TIMEZONE,
) {
  const businessDate = dateInTimeZone(now, timeZone);
  const endLocal = new Date(`${businessDate}T00:00:00.000Z`);
  endLocal.setUTCDate(endLocal.getUTCDate() + 1);
  const endDate = endLocal.toISOString().slice(0, 10);
  return {
    businessDate,
    startUtc: new Date(zonedDateTimeToUtc(businessDate, "00:00:00", timeZone)),
    endUtc: new Date(zonedDateTimeToUtc(endDate, "00:00:00", timeZone)),
  };
}
