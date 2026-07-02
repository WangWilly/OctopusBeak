import type { DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";

type HistoryAmountKey = "netAssets" | "assets" | "liabilities" | "dailyChange";

export type SnapshotChartPoint = {
  date: string;
  dateLabel: string;
  value: number;
};

export function buildSnapshotChartPoints(
  rows: DailyHistoryRowDto[],
  currency: string,
  amountKey: HistoryAmountKey,
): SnapshotChartPoint[] {
  return rows
    .map((row) => {
      const amount = row[amountKey].find((item) => item.currency === currency);
      return amount
        ? {
            date: row.date,
            dateLabel: row.date,
            value: amount.value,
          }
        : null;
    })
    .filter((item): item is SnapshotChartPoint => item !== null)
    .sort((left, right) => left.dateLabel.localeCompare(right.dateLabel));
}
