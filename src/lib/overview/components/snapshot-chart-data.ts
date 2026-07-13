import { historyPointKey, type DailyHistoryRowDto } from "../../shared-ledger/types.ts";

type HistoryAmountKey = "netAssets" | "assets" | "liabilities" | "dailyChange";

export type SnapshotChartPoint = {
  date: string;
  dateLabel: string;
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

export function buildSnapshotChartPoints(
  rows: DailyHistoryRowDto[],
  currency: string,
  amountKey: HistoryAmountKey,
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
        dateLabel: row.pointAt ? row.pointAt.slice(0, 16).replace("T", " ") : row.date,
        time: baseTime + offset,
        value: amount.value,
      };
    })
    .filter((item): item is SnapshotChartPoint => item !== null);
}

export function buildSnapshotDivergingSeries(
  rows: DailyHistoryRowDto[],
  currency: string,
): SnapshotDivergingSeries[] {
  return DIVERGING_SERIES.map((series) => ({
    key: series.key,
    label: series.label,
    color: series.color,
    data: buildSnapshotChartPoints(rows, currency, series.amountKey).map((point) => {
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
