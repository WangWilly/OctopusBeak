import type { AssetPositionDto, CurrencyAmountDto, TransactionRowDto } from "../shared-ledger/types.ts";
import { addDays, transactionDay } from "./transaction-filters.ts";

const DIVIDEND_WINDOW_DAYS = 90;

function units(row: AssetPositionDto): number | null {
  const value = Number(row.units.replaceAll(",", ""));
  return Number.isFinite(value) ? value : null;
}

/** Value per unit; the canonical position carries no quoted price of its own. */
export function positionPrice(row: AssetPositionDto): number | null {
  const held = units(row);
  if (row.value === null || held === null || held <= 0) return null;
  return row.value / held;
}

/**
 * Each valued holding's share of the account. Shares compare one currency
 * only, the one carrying the most value, since no rates are applied here.
 */
export function positionShares(rows: readonly AssetPositionDto[]): ReadonlyMap<string, number> {
  const valued = rows.filter((row) => row.value !== null && row.value > 0);
  const totals = new Map<string, number>();
  for (const row of valued) totals.set(row.currency, (totals.get(row.currency) ?? 0) + (row.value ?? 0));
  const [currency, total] = [...totals].sort((left, right) => right[1] - left[1])[0] ?? [null, 0];
  return new Map(valued
    .filter((row) => row.currency === currency)
    .map((row) => [row.symbol, (row.value ?? 0) / total]));
}

export function recentDividends(
  rows: readonly TransactionRowDto[],
  today: string,
  timeZone: string,
): { count: number; totals: CurrencyAmountDto[] } {
  const since = addDays(today, -(DIVIDEND_WINDOW_DAYS - 1));
  const dividends = rows.filter((row) => {
    const day = transactionDay(row, timeZone);
    return row.type === "dividend" && row.amount > 0 && day >= since && day <= today;
  });
  const totals = new Map<string, number>();
  for (const row of dividends) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amount);
  return {
    count: dividends.length,
    totals: [...totals].map(([currency, value]) => ({ currency, value: Math.round(value * 1e8) / 1e8 })),
  };
}

function exactDecimal(row: AssetPositionDto): string {
  if (!row.valueExact) return row.value === null ? "" : String(row.value);
  const { coefficient, scale } = row.valueExact;
  const negative = coefficient.startsWith("-");
  const digits = coefficient.replace(/^-/, "").padStart(scale + 1, "0");
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${text}` : text;
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value;
}

export function positionsCsv(
  rows: readonly AssetPositionDto[],
  headers: Readonly<{ symbol: string; name: string; units: string; price: string; value: string; currency: string; share: string }>,
): string {
  const shares = positionShares(rows);
  const lines = [
    [headers.symbol, headers.name, headers.units, headers.price, headers.value, headers.currency, headers.share],
    ...rows.map((row) => {
      const price = positionPrice(row);
      const share = shares.get(row.symbol);
      return [
        row.symbol,
        row.name,
        row.units.replaceAll(",", ""),
        price === null ? "" : String(Number(price.toFixed(5))),
        exactDecimal(row),
        row.currency,
        share === undefined ? "" : `${(share * 100).toFixed(1)}%`,
      ];
    }),
  ];
  // The byte-order mark lets spreadsheet apps read the file as UTF-8.
  return `﻿${lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
