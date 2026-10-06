import assert from "node:assert/strict";
import test from "node:test";

import type { TransactionRowDto } from "../shared-ledger/types.ts";
import {
  daysInRange,
  filterTransactions,
  flowCounts,
  pageOf,
  presetRange,
  transactionsCsv,
} from "./transaction-filters.ts";

const row = (date: string, amount: number, label = "row", note: string | null = null): TransactionRowDto => ({
  date,
  occurredAtUtc: null,
  label,
  type: amount < 0 ? "debit" : "credit",
  amount,
  currency: "TWD",
  note,
});

test("presets resolve to inclusive day ranges ending today", () => {
  const today = "2026-10-05";
  assert.deepEqual(presetRange("last7", today), { start: "2026-09-29", end: today });
  assert.deepEqual(presetRange("last30", today), { start: "2026-09-06", end: today });
  assert.deepEqual(presetRange("thisMonth", today), { start: "2026-10-01", end: today });
  assert.deepEqual(presetRange("lastMonth", today), { start: "2026-09-01", end: "2026-09-30" });
  assert.deepEqual(presetRange("last3Months", today), { start: "2026-07-06", end: today });
  assert.deepEqual(presetRange("thisYear", today), { start: "2026-01-01", end: today });
  assert.equal(presetRange("all", today), null);
  assert.deepEqual(presetRange("lastMonth", "2026-03-31"), { start: "2026-02-01", end: "2026-02-28" });
  assert.equal(daysInRange({ start: "2026-09-25", end: "2026-10-04" }), 10);
});

test("rows filter by day range and money direction, newest first", () => {
  const rows = [row("2026-09-24", -50), row("2026-09-25", 212), row("2026-10-04", -1286), row("2026-10-01", 68500)];
  const range = { start: "2026-09-25", end: "2026-10-04" };
  assert.deepEqual(filterTransactions(rows, { range, flow: "all", timeZone: "Asia/Taipei" }).map((item) => item.date), ["2026-10-04", "2026-10-01", "2026-09-25"]);
  assert.deepEqual(filterTransactions(rows, { range, flow: "in", timeZone: "Asia/Taipei" }).map((item) => item.amount), [68500, 212]);
  assert.deepEqual(filterTransactions(rows, { range: null, flow: "out", timeZone: "Asia/Taipei" }).map((item) => item.amount), [-1286, -50]);
  assert.deepEqual(flowCounts(filterTransactions(rows, { range, flow: "all", timeZone: "Asia/Taipei" })), { all: 3, in: 2, out: 1 });
});

test("a timestamped row falls on its day in the system timezone", () => {
  const late = { ...row("2026-10-04", -10), occurredAtUtc: "2026-10-04T17:30:00.000Z" }; // 10/5 01:30 in Taipei
  assert.equal(filterTransactions([late], { range: { start: "2026-10-05", end: "2026-10-05" }, flow: "all", timeZone: "Asia/Taipei" }).length, 1);
});

test("pages report their position in the filtered list", () => {
  const rows = Array.from({ length: 24 }, (_, index) => row(`2026-09-${String(index + 1).padStart(2, "0")}`, -index - 1));
  assert.deepEqual({ ...pageOf(rows, 1, 10), rows: undefined }, { rows: undefined, page: 1, pageCount: 3, first: 1, last: 10, total: 24 });
  assert.deepEqual({ ...pageOf(rows, 3, 10), rows: undefined }, { rows: undefined, page: 3, pageCount: 3, first: 21, last: 24, total: 24 });
  assert.equal(pageOf(rows, 9, 10).page, 3, "a page past the end clamps to the last page");
  assert.deepEqual({ ...pageOf([], 1, 10), rows: undefined }, { rows: undefined, page: 1, pageCount: 1, first: 0, last: 0, total: 0 });
});

test("the CSV export splits money out and in, and quotes cells that need it", () => {
  const csv = transactionsCsv(
    [{ ...row("2026-10-04", -1286, "全聯, 福利中心"), amountExact: { coefficient: "-1286", scale: 0 } }, row("2026-10-01", 68500, "Salary", "pending")],
    { date: "日期", description: "摘要", out: "支出", in: "存入", currency: "幣別", note: "備註" },
    "Asia/Taipei",
  );
  assert.equal(csv, "﻿日期,摘要,支出,存入,幣別,備註\r\n2026-10-04,\"全聯, 福利中心\",1286,,TWD,\r\n2026-10-01,Salary,,68500,TWD,pending\r\n");
});
