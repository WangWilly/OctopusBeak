import assert from "node:assert/strict";
import {
  buildSnapshotChartPoints,
  buildSnapshotDivergingSeries,
  selectSnapshotDivergingSeries,
} from "./snapshot-chart-data.ts";
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
  { date: "2026-07-01", dateLabel: "2026-07-01", time: Date.parse("2026-07-01T00:00:00.000Z"), value: 100 },
  { date: "2026-07-02", dateLabel: "2026-07-02", time: Date.parse("2026-07-02T00:00:00.000Z"), value: 120 },
]);

assert.deepEqual(buildSnapshotChartPoints(rows, "TWD", "dailyChange"), [
  { date: "2026-07-01", dateLabel: "2026-07-01", time: Date.parse("2026-07-01T00:00:00.000Z"), value: 5 },
  { date: "2026-07-02", dateLabel: "2026-07-02", time: Date.parse("2026-07-02T00:00:00.000Z"), value: -10 },
]);

assert.deepEqual(buildSnapshotChartPoints(rows, "JPY", "netAssets"), []);

const sameDayCaptureRows: DailyHistoryRowDto[] = [
  { ...rows[0]!, date: "2026-07-12", pointAt: "2026-07-12T10:00:00.000Z", netAssets: [{ currency: "TWD", value: 180 }] },
  { ...rows[0]!, date: "2026-07-12", pointAt: "2026-07-12T08:00:00.000Z", netAssets: [{ currency: "TWD", value: 120 }] },
];
assert.deepEqual(buildSnapshotChartPoints(sameDayCaptureRows, "TWD", "netAssets"), [
  { date: "2026-07-12", dateLabel: "2026-07-12 08:00", time: Date.parse("2026-07-12T08:00:00.000Z"), value: 120 },
  { date: "2026-07-12", dateLabel: "2026-07-12 10:00", time: Date.parse("2026-07-12T10:00:00.000Z"), value: 180 },
]);

const divergingSeries = buildSnapshotDivergingSeries(rows, "TWD");

assert.deepEqual(
  divergingSeries.map((series) => series.key),
  ["net", "assets", "liabilities"],
);

assert.deepEqual(divergingSeries[0].data, [
  { date: "2026-07-01", dateLabel: "2026-07-01", time: Date.parse("2026-07-01T00:00:00.000Z"), value: 100 },
  { date: "2026-07-02", dateLabel: "2026-07-02", time: Date.parse("2026-07-02T00:00:00.000Z"), value: 120 },
]);

assert.deepEqual(divergingSeries[1].data, [
  { date: "2026-07-01", dateLabel: "2026-07-01", time: Date.parse("2026-07-01T00:00:00.000Z"), value: 150 },
  { date: "2026-07-02", dateLabel: "2026-07-02", time: Date.parse("2026-07-02T00:00:00.000Z"), value: 160 },
]);

assert.deepEqual(divergingSeries[2].data, [
  { date: "2026-07-01", dateLabel: "2026-07-01", time: Date.parse("2026-07-01T00:00:00.000Z"), value: -50 },
  { date: "2026-07-02", dateLabel: "2026-07-02", time: Date.parse("2026-07-02T00:00:00.000Z"), value: -40 },
]);

assert.deepEqual(
  selectSnapshotDivergingSeries(divergingSeries, ["assets", "liabilities"]).map((series) => series.key),
  ["assets", "liabilities"],
);

assert.deepEqual(
  selectSnapshotDivergingSeries(divergingSeries, []).map((series) => series.key),
  ["net", "assets", "liabilities"],
);
