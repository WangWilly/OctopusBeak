import assert from "node:assert/strict";
import { buildSnapshotChartPoints } from "./snapshot-chart-data.ts";
import type { DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";

const rows: DailyHistoryRowDto[] = [
  {
    date: "2026-07-02",
    netAssets: [{ currency: "TWD", value: 120 }],
    assets: [{ currency: "TWD", value: 160 }],
    liabilities: [{ currency: "TWD", value: 40 }],
    dailyChange: [{ currency: "TWD", value: -10 }],
    accountChanges: [],
    positionCount: 0,
  },
  {
    date: "2026-07-01",
    netAssets: [
      { currency: "TWD", value: 100 },
      { currency: "USD", value: 3 },
    ],
    assets: [{ currency: "TWD", value: 150 }],
    liabilities: [{ currency: "TWD", value: 50 }],
    dailyChange: [{ currency: "TWD", value: 5 }],
    accountChanges: [],
    positionCount: 0,
  },
  {
    date: "2026-07-03",
    netAssets: [{ currency: "USD", value: 4 }],
    assets: [{ currency: "USD", value: 4 }],
    liabilities: [],
    dailyChange: [{ currency: "USD", value: 1 }],
    accountChanges: [],
    positionCount: 0,
  },
];

assert.deepEqual(buildSnapshotChartPoints(rows, "TWD", "netAssets"), [
  { date: new Date("2026-07-01T00:00:00.000Z"), dateLabel: "2026-07-01", value: 100 },
  { date: new Date("2026-07-02T00:00:00.000Z"), dateLabel: "2026-07-02", value: 120 },
]);

assert.deepEqual(buildSnapshotChartPoints(rows, "TWD", "dailyChange"), [
  { date: new Date("2026-07-01T00:00:00.000Z"), dateLabel: "2026-07-01", value: 5 },
  { date: new Date("2026-07-02T00:00:00.000Z"), dateLabel: "2026-07-02", value: -10 },
]);

assert.deepEqual(buildSnapshotChartPoints(rows, "JPY", "netAssets"), []);
