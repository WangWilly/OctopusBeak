import type { DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";

type HistoryAmountKey = "netAssets" | "assets" | "liabilities" | "dailyChange";

export type SnapshotChartPoint = {
  date: Date;
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
            date: new Date(`${row.date}T00:00:00.000Z`),
            dateLabel: row.date,
            value: amount.value,
          }
        : null;
    })
    .filter((item): item is SnapshotChartPoint => item !== null)
    .sort((left, right) => left.dateLabel.localeCompare(right.dateLabel));
}
