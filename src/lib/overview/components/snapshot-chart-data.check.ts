import assert from "node:assert/strict";
import {
  buildSnapshotChartPoints,
  buildSnapshotDivergingSeries,
  formatSnapshotAxisLabel,
  selectSnapshotDivergingSeries,
} from "./snapshot-chart-data.ts";
import type { DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";

const timeZone = "Asia/Taipei";
const locale = "en-CA";

assert.equal(formatSnapshotAxisLabel(Date.parse("2026-07-12T20:00:00.000Z"), timeZone, locale), "07-13");
assert.equal(formatSnapshotAxisLabel("2026-07-12", timeZone, locale), "07-12");

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

const losAngelesDateOnlyPoints = buildSnapshotChartPoints(
  [rows[1]!],
  "TWD",
  "netAssets",
  "America/Los_Angeles",
  locale,
);
assert.equal(
  formatSnapshotAxisLabel(
    losAngelesDateOnlyPoints[0]!.time,
    "America/Los_Angeles",
    locale,
    losAngelesDateOnlyPoints,
  ),
  "07-01",
);

const taipeiStructuredPoints = buildSnapshotChartPoints(
  [{ ...rows[0]!, pointAt: "2026-07-12T20:00:00.000Z" }],
  "TWD",
  "netAssets",
  timeZone,
  locale,
);
assert.equal(
  formatSnapshotAxisLabel(taipeiStructuredPoints[0]!.time, timeZone, locale, taipeiStructuredPoints),
  "07-13",
);

assert.deepEqual(buildSnapshotChartPoints(rows, "TWD", "netAssets", timeZone, locale), [
  { date: "2026-07-01", dateLabel: "2026-07-01", axisLabel: "07-01", time: Date.parse("2026-07-01T00:00:00.000Z"), value: 100 },
  { date: "2026-07-02", dateLabel: "2026-07-02", axisLabel: "07-02", time: Date.parse("2026-07-02T00:00:00.000Z"), value: 120 },
]);

assert.deepEqual(buildSnapshotChartPoints(rows, "TWD", "dailyChange", timeZone, locale), [
  { date: "2026-07-01", dateLabel: "2026-07-01", axisLabel: "07-01", time: Date.parse("2026-07-01T00:00:00.000Z"), value: 5 },
  { date: "2026-07-02", dateLabel: "2026-07-02", axisLabel: "07-02", time: Date.parse("2026-07-02T00:00:00.000Z"), value: -10 },
]);

assert.deepEqual(buildSnapshotChartPoints(rows, "JPY", "netAssets", timeZone, locale), []);

const sameDayCaptureRows: DailyHistoryRowDto[] = [
  { ...rows[0]!, date: "2026-07-12", pointAt: "2026-07-12T08:00:00.000Z", captureId: "capture-bravo", netAssets: [{ currency: "TWD", value: 180 }] },
  { ...rows[0]!, date: "2026-07-12", pointAt: "2026-07-12T08:00:00.000Z", captureId: "capture-alpha", netAssets: [{ currency: "TWD", value: 120 }] },
];
assert.deepEqual(buildSnapshotChartPoints(sameDayCaptureRows, "TWD", "netAssets", timeZone, locale), [
  { date: "2026-07-12", dateLabel: "2026-07-12, 16:00:00", axisLabel: "07-12", time: Date.parse("2026-07-12T08:00:00.000Z"), value: 120 },
  { date: "2026-07-12", dateLabel: "2026-07-12, 16:00:00", axisLabel: "07-12", time: Date.parse("2026-07-12T08:00:00.000Z") + 1, value: 180 },
]);

const sameTimestampFilteredRows: DailyHistoryRowDto[] = [
  { ...rows[0]!, date: "2026-07-12", pointAt: "2026-07-12T08:00:00.000Z", captureId: "capture-alpha", netAssets: [] },
  { ...rows[0]!, date: "2026-07-12", pointAt: "2026-07-12T08:00:00.000Z", captureId: "capture-bravo", netAssets: [{ currency: "TWD", value: 180 }] },
];
assert.deepEqual(buildSnapshotChartPoints(sameTimestampFilteredRows, "TWD", "netAssets", timeZone, locale), [
  { date: "2026-07-12", dateLabel: "2026-07-12, 16:00:00", axisLabel: "07-12", time: Date.parse("2026-07-12T08:00:00.000Z"), value: 180 },
]);

const divergingSeries = buildSnapshotDivergingSeries(rows, "TWD", timeZone, locale);

assert.deepEqual(
  divergingSeries.map((series) => series.key),
  ["net", "assets", "liabilities"],
);

assert.deepEqual(divergingSeries[0].data, [
  { date: "2026-07-01", dateLabel: "2026-07-01", axisLabel: "07-01", time: Date.parse("2026-07-01T00:00:00.000Z"), value: 100 },
  { date: "2026-07-02", dateLabel: "2026-07-02", axisLabel: "07-02", time: Date.parse("2026-07-02T00:00:00.000Z"), value: 120 },
]);

assert.deepEqual(divergingSeries[1].data, [
  { date: "2026-07-01", dateLabel: "2026-07-01", axisLabel: "07-01", time: Date.parse("2026-07-01T00:00:00.000Z"), value: 150 },
  { date: "2026-07-02", dateLabel: "2026-07-02", axisLabel: "07-02", time: Date.parse("2026-07-02T00:00:00.000Z"), value: 160 },
]);

assert.deepEqual(divergingSeries[2].data, [
  { date: "2026-07-01", dateLabel: "2026-07-01", axisLabel: "07-01", time: Date.parse("2026-07-01T00:00:00.000Z"), value: -50 },
  { date: "2026-07-02", dateLabel: "2026-07-02", axisLabel: "07-02", time: Date.parse("2026-07-02T00:00:00.000Z"), value: -40 },
]);

assert.deepEqual(
  selectSnapshotDivergingSeries(divergingSeries, ["assets", "liabilities"]).map((series) => series.key),
  ["assets", "liabilities"],
);

assert.deepEqual(
  selectSnapshotDivergingSeries(divergingSeries, []).map((series) => series.key),
  ["net", "assets", "liabilities"],
);
