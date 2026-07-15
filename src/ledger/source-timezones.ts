import { zonedDateTimeToUtc } from "../lib/time/timezone.ts";

const TAIWAN_BANKS = new Set([
  "cathay",
  "ctbc",
  "fubon",
  "hncb",
  "linebank",
  "post",
  "sinopac",
  "yuanta",
]);

export function sourceTimezone(
  bank: string,
  _product?: string | null,
): string | null {
  return TAIWAN_BANKS.has(bank) ? "Asia/Taipei" : null;
}

export function sourceTransactionAtUtc(
  bank: string,
  date: string | null,
  time: string | null,
  product?: string | null,
): string | null {
  const timeZone = sourceTimezone(bank, product);
  return date && time && timeZone
    ? zonedDateTimeToUtc(date, time, timeZone)
    : null;
}
