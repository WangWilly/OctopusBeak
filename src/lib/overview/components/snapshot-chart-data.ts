import { historyPointKey, type DailyHistoryRowDto } from "../../shared-ledger/types.ts";
import { formatUtcDate } from "../../time/timezone.ts";

type HistoryAmountKey = "netAssets" | "assets" | "liabilities" | "dailyChange";

export type SnapshotChartPoint = {
  date: string;
  dateLabel: string;
  axisLabel: string;
  time: number;
  value: number;
};

export type SnapshotDivergingSeriesKey = "net" | "assets" | "liabilities";

export type SnapshotDivergingSeries = {
  key: SnapshotDivergingSeriesKey;
  label: string;
  color: string;
  data: SnapshotChartPoint[];
};

const DIVERGING_SERIES: Array<{
  key: SnapshotDivergingSeriesKey;
  label: string;
  amountKey: HistoryAmountKey;
  color: string;
  sign: 1 | -1;
}> = [
  { key: "net", label: "Net", amountKey: "netAssets", color: "oklch(49% 0.08 250)", sign: 1 },
  { key: "assets", label: "Assets", amountKey: "assets", color: "oklch(51% 0.07 170)", sign: 1 },
  { key: "liabilities", label: "Liabilities", amountKey: "liabilities", color: "oklch(50% 0.07 35)", sign: -1 },
];

export function formatSnapshotAxisLabel(
  value: unknown,
  timeZone: string,
  locale: string,
  points: SnapshotChartPoint[] = [],
) {
  const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : null;
  const preserved = time === null ? undefined : points.find((point) => point.time === time)?.axisLabel;
  if (preserved) return preserved;
  const text = String(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value.slice(5);
  const date = value instanceof Date ? value : typeof value === "number" || typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return text.length >= 10 ? text.slice(5, 10) : text;
  const parts = new Intl.DateTimeFormat(locale, { timeZone, month: "2-digit", day: "2-digit" }).formatToParts(date);
  return `${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
}

export function buildSnapshotChartPoints(
  rows: DailyHistoryRowDto[],
  currency: string,
  amountKey: HistoryAmountKey,
  timeZone: string,
  locale: string,
): SnapshotChartPoint[] {
  const offsets = new Map<number, number>();
  return [...rows]
    .sort((left, right) => historyPointKey(left).localeCompare(historyPointKey(right)))
    .map((row) => {
      const amount = row[amountKey].find((item) => item.currency === currency);
      if (!amount) return null;
      const baseTime = Date.parse(row.pointAt ?? `${row.date}T00:00:00.000Z`);
      const offset = offsets.get(baseTime) ?? 0;
      offsets.set(baseTime, offset + 1);
      return {
        date: row.date,
        dateLabel: formatUtcDate(row.pointAt ?? row.date, timeZone, locale),
        axisLabel: formatSnapshotAxisLabel(row.pointAt ?? row.date, timeZone, locale),
        time: baseTime + offset,
        value: amount.value,
      };
    })
    .filter((item): item is SnapshotChartPoint => item !== null);
}

export function buildSnapshotDivergingSeries(
  rows: DailyHistoryRowDto[],
  currency: string,
  timeZone: string,
  locale: string,
): SnapshotDivergingSeries[] {
  return DIVERGING_SERIES.map((series) => ({
    key: series.key,
    label: series.label,
    color: series.color,
    data: buildSnapshotChartPoints(rows, currency, series.amountKey, timeZone, locale).map((point) => {
      const value = series.sign === -1 ? -Math.abs(point.value) : point.value;
      return { ...point, value };
    }),
  })).filter((series) => series.data.length > 0);
}

export function selectSnapshotDivergingSeries(
  series: SnapshotDivergingSeries[],
  selectedKeys: SnapshotDivergingSeriesKey[],
) {
  if (selectedKeys.length === 0) return series;
  const selected = new Set(selectedKeys);
  const visible = series.filter((item) => selected.has(item.key));
  return visible.length > 0 ? visible : series;
}
