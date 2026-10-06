import type { TransactionRowDto } from "../shared-ledger/types.ts";
import { dateInTimeZone } from "../shared-ledger/twd-valuation.ts";

/** Inclusive calendar days, `YYYY-MM-DD`. */
export type DateRange = { start: string; end: string };
export type RangePreset = "last7" | "last30" | "thisMonth" | "lastMonth" | "last3Months" | "thisYear" | "all" | "custom";
export type FlowFilter = "all" | "in" | "out";

export const RANGE_PRESETS: readonly Exclude<RangePreset, "custom">[] = [
  "last7",
  "last30",
  "thisMonth",
  "lastMonth",
  "last3Months",
  "thisYear",
  "all",
];

const DAY_MS = 86_400_000;

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** First day of the month `months` away from `day`'s month. */
export function addMonths(day: string, months: number): string {
  const [year, month] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + months, 1)).toISOString().slice(0, 10);
}

export function presetRange(preset: Exclude<RangePreset, "custom">, today: string): DateRange | null {
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (preset) {
    case "last7": return { start: addDays(today, -6), end: today };
    case "last30": return { start: addDays(today, -29), end: today };
    case "thisMonth": return { start: monthStart, end: today };
    case "lastMonth": return { start: addMonths(today, -1), end: addDays(monthStart, -1) };
    case "last3Months": {
      const day = Number(today.slice(8));
      const start = addMonths(today, -3);
      const lastDay = Number(addDays(addMonths(start, 1), -1).slice(8));
      return { start: addDays(`${start.slice(0, 8)}${String(Math.min(day, lastDay)).padStart(2, "0")}`, 1), end: today };
    }
    case "thisYear": return { start: `${today.slice(0, 4)}-01-01`, end: today };
    case "all": return null;
  }
}

export function daysInRange(range: DateRange): number {
  return Math.round((Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / DAY_MS) + 1;
}

/** The calendar day a row belongs to, as the table shows it. */
export function transactionDay(row: TransactionRowDto, timeZone: string): string {
  return row.occurredAtUtc ? dateInTimeZone(new Date(row.occurredAtUtc), timeZone) : row.date;
}

function newestFirst(left: TransactionRowDto, right: TransactionRowDto) {
  return (right.occurredAtUtc ?? right.date).localeCompare(left.occurredAtUtc ?? left.date);
}

export function filterTransactions(
  rows: readonly TransactionRowDto[],
  options: { range: DateRange | null; flow: FlowFilter; timeZone: string },
): TransactionRowDto[] {
  const { range, flow, timeZone } = options;
  return rows
    .filter((row) => {
      if (flow === "in" && !(row.amount > 0)) return false;
      if (flow === "out" && !(row.amount < 0)) return false;
      if (!range) return true;
      const day = transactionDay(row, timeZone);
      return day >= range.start && day <= range.end;
    })
    .sort(newestFirst);
}

export function flowCounts(rows: readonly TransactionRowDto[]): Record<FlowFilter, number> {
  return {
    all: rows.length,
    in: rows.filter((row) => row.amount > 0).length,
    out: rows.filter((row) => row.amount < 0).length,
  };
}

export function pageOf<Row>(rows: readonly Row[], page: number, size: number) {
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, page), pageCount);
  const offset = (current - 1) * size;
  const shown = rows.slice(offset, offset + size);
  return {
    rows: shown,
    page: current,
    pageCount,
    first: shown.length ? offset + 1 : 0,
    last: offset + shown.length,
    total: rows.length,
  };
}

/** The unsigned amount as a plain decimal, exact when the canonical value is kept. */
function unsignedAmount(row: TransactionRowDto): string {
  if (!row.amountExact) return String(Math.abs(row.amount));
  const digits = row.amountExact.coefficient.replace(/^-/, "").padStart(row.amountExact.scale + 1, "0");
  const { scale } = row.amountExact;
  return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value;
}

export function transactionsCsv(
  rows: readonly TransactionRowDto[],
  headers: Readonly<{ date: string; description: string; out: string; in: string; currency: string; note: string }>,
  timeZone: string,
): string {
  const lines = [
    [headers.date, headers.description, headers.out, headers.in, headers.currency, headers.note],
    ...rows.map((row) => [
      transactionDay(row, timeZone),
      row.label,
      row.amount < 0 ? unsignedAmount(row) : "",
      row.amount > 0 ? unsignedAmount(row) : "",
      row.currency,
      row.note ?? "",
    ]),
  ];
  // The byte-order mark lets spreadsheet apps read the file as UTF-8.
  return `﻿${lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
