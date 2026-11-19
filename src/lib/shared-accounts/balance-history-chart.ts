import type { BalanceHistory, HistoryEntry } from "./balance-history.ts";

/** One plotted day, carrying what its tooltip says about that day. */
export type HistoryChartPoint = {
  /** The x band; days are evenly spaced, as on the Assets and Liabilities charts. */
  position: string;
  day: string;
  balance: number;
  /** Change from the previous plotted point; null on the first. */
  change: number | null;
  /** The day's own transactions, for a ledger account. */
  inflow: number;
  outflow: number;
  /** The statement cycle this point closes, for a card. */
  cycle: { start: string; end: string } | null;
};

export function historyChartPoints(history: BalanceHistory): HistoryChartPoint[] {
  const byDay = new Map<string, { inflow: number; outflow: number; cycle: HistoryEntry["cycle"] }>();
  for (const entry of history.entries) {
    const day = byDay.get(entry.day) ?? { inflow: 0, outflow: 0, cycle: null };
    if (entry.kind === "transaction") {
      day.inflow += entry.increase ?? 0;
      day.outflow += entry.decrease ?? 0;
    }
    if (entry.kind === "statement") day.cycle = entry.cycle;
    byDay.set(entry.day, day);
  }
  return history.points.map((point, index) => {
    const day = byDay.get(point.day);
    return {
      position: String(index),
      day: point.day,
      balance: point.balance,
      change: index === 0 ? null : point.balance - history.points[index - 1].balance,
      inflow: day?.inflow ?? 0,
      outflow: day?.outflow ?? 0,
      cycle: day?.cycle ?? null,
    };
  });
}

/**
 * The table row that explains a plotted day: its own record, or else the
 * latest record before it, whose balance the day carries. Entries are newest
 * first; -1 when nothing in the table reaches back that far.
 */
export function entryIndexForDay(entries: readonly HistoryEntry[], day: string): number {
  return entries.findIndex((entry) => entry.day <= day);
}
