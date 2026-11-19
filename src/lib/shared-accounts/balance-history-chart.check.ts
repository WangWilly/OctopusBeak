import assert from "node:assert/strict";
import test from "node:test";

import type { BalanceHistory, HistoryEntry } from "./balance-history.ts";
import { entryIndexForDay, historyChartPoints } from "./balance-history-chart.ts";

const row = (day: string, kind: HistoryEntry["kind"], change: number | null, balance: number, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
  kind,
  day,
  label: null,
  cycle: null,
  transactionCount: null,
  increase: change !== null && change > 0 ? change : null,
  decrease: change !== null && change < 0 ? -change : null,
  balance,
  note: null,
  ...extra,
});

// Newest first, as buildBalanceHistory lists them.
const ledger: BalanceHistory = {
  kind: "ledger",
  consistent: null,
  points: [
    { day: "2026-10-01", balance: 1000 },
    { day: "2026-10-02", balance: 1300 },
    { day: "2026-10-03", balance: 1300 },
    { day: "2026-10-04", balance: 1100 },
  ],
  entries: [
    row("2026-10-04", "today", null, 1100),
    row("2026-10-04", "transaction", -200, 1100),
    row("2026-10-02", "transaction", 500, 1300),
    row("2026-10-02", "transaction", -200, 800),
  ],
};

test("a plotted day carries its own money in and out and its change from the day before", () => {
  const points = historyChartPoints(ledger);
  assert.deepEqual(points.map((point) => point.position), ["0", "1", "2", "3"]);
  assert.deepEqual(points.map(({ inflow, outflow }) => [inflow, outflow]), [[0, 0], [500, 200], [0, 0], [0, 200]]);
  assert.deepEqual(points.map((point) => point.change), [null, 300, 0, -200]);
});

test("a card's statement point names the cycle it closes", () => {
  const cycle = { start: "2026-08-21", end: "2026-09-20" };
  const points = historyChartPoints({
    kind: "card",
    consistent: null,
    points: [{ day: "2026-09-20", balance: 4200 }, { day: "2026-10-04", balance: 900 }],
    entries: [row("2026-10-04", "today", -3300, 900), row("2026-09-20", "statement", null, 4200, { cycle })],
  });
  assert.deepEqual(points.map((point) => point.cycle), [cycle, null]);
});

test("a picked day finds its own row, or the latest row whose balance it still carries", () => {
  assert.equal(entryIndexForDay(ledger.entries, "2026-10-04"), 0, "the day's first row");
  assert.equal(entryIndexForDay(ledger.entries, "2026-10-03"), 2, "a quiet day leads to the movement before it");
  assert.equal(entryIndexForDay(ledger.entries, "2026-10-01"), -1, "nothing in the table reaches back that far");
});
