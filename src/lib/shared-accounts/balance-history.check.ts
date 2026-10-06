import assert from "node:assert/strict";
import test from "node:test";

import type {
  AccountRowDto,
  CreditCardStatementDto,
  DailyHistoryRowDto,
  TransactionRowDto,
} from "../shared-ledger/types.ts";
import { buildBalanceHistory, historyKind, historyStats } from "./balance-history.ts";

const TZ = "Asia/Taipei";
const today = "2026-10-06";

const account = (kind: AccountRowDto["kind"], value: number, extra: Partial<AccountRowDto> = {}): AccountRowDto => ({
  id: kind,
  label: `Bank · ${kind} · 4821`,
  institution: "Bank",
  product: kind,
  group: kind === "credit-card" || kind === "loan" ? "liability" : "asset",
  kind,
  typeLabel: kind,
  amountLines: [{ currency: "TWD", value }],
  transactionCount: 0,
  assetPositionCount: 0,
  lastUpdated: today,
  valueAvailability: "available",
  ...extra,
});

const tx = (date: string, amount: number, label = "row"): TransactionRowDto => ({
  date, occurredAtUtc: null, label, type: amount < 0 ? "debit" : "credit", amount, currency: "TWD", note: null,
});

const snapshot = (date: string, value: number, side: "assets" | "liabilities" = "assets"): DailyHistoryRowDto => ({
  date,
  netAssets: [{ currency: "TWD", value: side === "assets" ? value : -value }],
  dailyChange: [],
  assets: side === "assets" ? [{ currency: "TWD", value }] : [],
  liabilities: side === "liabilities" ? [{ currency: "TWD", value }] : [],
  accountChanges: [],
  positionCount: 0,
});

const statement = (cycleEnd: string, balance: number, memberships = 1, revisionNumber = 1): CreditCardStatementDto => ({
  statementId: cycleEnd,
  statementRevisionId: `${cycleEnd}#${revisionNumber}`,
  statementKey: cycleEnd,
  revisionNumber,
  cycleStart: `${cycleEnd.slice(0, 8)}01`,
  cycleEnd,
  issueDate: cycleEnd,
  dueDate: cycleEnd,
  currency: "TWD",
  statementBalance: { currency: "TWD", value: balance },
  minimumPayment: null,
  memberships: Array.from({ length: memberships }, (_, index) => ({ transactionId: `t${index}`, transactionRevisionId: "r", sourceRecordId: "s" })),
});

test("cash accounts work back from today's balance, card accounts read statements, the rest read snapshots", () => {
  assert.equal(historyKind(account("bank", 0)), "ledger");
  assert.equal(historyKind(account("foreign", 0)), "ledger");
  assert.equal(historyKind(account("credit-card", 0)), "card");
  for (const kind of ["loan", "brokerage", "fund", "crypto", "other"] as const) assert.equal(historyKind(account(kind, 0)), "snapshots");
});

test("a ledger history gives every transaction the balance it left behind", () => {
  const history = buildBalanceHistory({
    account: account("bank", 486320),
    transactions: [tx("2026-10-01", 68500, "Salary"), tx("2026-10-04", -1286, "全聯"), tx("2026-10-03", -2140, "電費")],
    dailyHistory: [],
    currency: "TWD",
    range: { start: "2026-09-30", end: today },
    today,
    timeZone: TZ,
  });
  assert.deepEqual(history.entries.map((entry) => [entry.kind, entry.day, entry.increase, entry.decrease, entry.balance]), [
    ["today", today, null, null, 486320],
    ["transaction", "2026-10-04", null, 1286, 486320],
    ["transaction", "2026-10-03", null, 2140, 487606],
    ["transaction", "2026-10-01", 68500, null, 489746],
  ]);
  assert.deepEqual(history.points.map((point) => [point.day, point.balance]), [
    ["2026-09-30", 421246],
    ["2026-10-01", 489746],
    ["2026-10-02", 489746],
    ["2026-10-03", 487606],
    ["2026-10-04", 486320],
    ["2026-10-05", 486320],
    [today, 486320],
  ]);
  assert.equal(history.consistent, null, "no recorded snapshot to compare against");
  assert.deepEqual(historyStats(history), {
    kind: "range",
    net: 486320 - 421246,
    high: { day: "2026-10-01", balance: 489746 },
    low: { day: "2026-09-30", balance: 421246 },
  });
});

test("recorded snapshots confirm or contradict the worked-back balances", () => {
  const input = {
    account: account("bank", 1000),
    transactions: [tx("2026-10-05", 200)],
    currency: "TWD",
    range: { start: "2026-10-01", end: today },
    today,
    timeZone: TZ,
  };
  assert.equal(buildBalanceHistory({ ...input, dailyHistory: [snapshot("2026-10-04", 800), snapshot("2026-10-05", 1000)] }).consistent, true);
  assert.equal(buildBalanceHistory({ ...input, dailyHistory: [snapshot("2026-10-04", 950)] }).consistent, false);
});

test("a card history lists each latest statement revision and today's used credit", () => {
  const history = buildBalanceHistory({
    account: account("credit-card", 51192, {
      creditCard: { statements: [statement("2026-08-15", 9563, 31), statement("2026-09-15", 11000, 30), statement("2026-09-15", 11210, 32, 2)] },
    }),
    transactions: [],
    dailyHistory: [],
    currency: "TWD",
    range: { start: "2025-10-07", end: today },
    today,
    timeZone: TZ,
  });
  assert.deepEqual(history.entries.map((entry) => [entry.kind, entry.day, entry.increase, entry.decrease, entry.balance, entry.transactionCount]), [
    ["today", today, 39982, null, 51192, null],
    ["statement", "2026-09-15", 1647, null, 11210, 32],
    ["statement", "2026-08-15", null, null, 9563, 31],
  ]);
  assert.deepEqual(historyStats(history), {
    kind: "card",
    lastStatement: { day: "2026-09-15", balance: 11210 },
    high: { day: "2026-09-15", balance: 11210 },
    average: (9563 + 11210) / 2,
  });
});

test("a snapshot history keeps each day's last recorded balance, on the side the account sits", () => {
  const history = buildBalanceHistory({
    account: account("loan", 500000),
    transactions: [],
    dailyHistory: [snapshot("2026-10-01", 510000, "liabilities"), { ...snapshot("2026-10-02", 505000, "liabilities"), pointAt: "2026-10-02T01:00:00Z" }, { ...snapshot("2026-10-02", 504000, "liabilities"), pointAt: "2026-10-02T09:00:00Z" }],
    currency: "TWD",
    range: { start: "2026-10-01", end: today },
    today,
    timeZone: TZ,
  });
  assert.deepEqual(history.entries.map((entry) => [entry.kind, entry.day, entry.increase, entry.decrease, entry.balance]), [
    ["snapshot", "2026-10-02", null, 6000, 504000],
    ["snapshot", "2026-10-01", null, null, 510000],
  ]);
});

test("the range bounds entries and points; today shows only when the range reaches it", () => {
  const history = buildBalanceHistory({
    account: account("bank", 1000),
    transactions: [tx("2026-09-20", 100), tx("2026-10-05", 50)],
    dailyHistory: [],
    currency: "TWD",
    range: { start: "2026-09-15", end: "2026-09-30" },
    today,
    timeZone: TZ,
  });
  assert.deepEqual(history.entries.map((entry) => [entry.kind, entry.day, entry.balance]), [["transaction", "2026-09-20", 950]]);
  assert.equal(history.points.at(-1)?.day, "2026-09-30");
  assert.equal(history.points.at(-1)?.balance, 950);
});
