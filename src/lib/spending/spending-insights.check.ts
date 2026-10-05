import assert from "node:assert/strict";
import test from "node:test";
import {
  readSpendingMonth,
  readSpendingTrend,
  type CurrencyMonthReading,
  type Money,
  type SpendingSummary,
} from "./spending-insights.ts";

type DayInput = Readonly<Record<string, number | Readonly<Record<string, string>>>>;

function exact(value: string) {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  return { coefficient: `${negative ? "-" : ""}${BigInt(`${whole}${fraction}`)}`, scale: fraction.length };
}

function sumText(values: readonly string[]) {
  const scale = Math.max(0, ...values.map((value) => exact(value).scale));
  const total = values.reduce((sum, value) => {
    const parsed = exact(value);
    return sum + BigInt(parsed.coefficient) * 10n ** BigInt(scale - parsed.scale);
  }, 0n);
  return { coefficient: total.toString(), scale };
}

function summaryOf(days: DayInput, pending: Readonly<Record<string, number | null>> = {}): SpendingSummary {
  const dayTotals = Object.entries(days).sort(([left], [right]) => left.localeCompare(right)).map(([date, amounts]) => {
    const byCurrency = typeof amounts === "number" ? { TWD: String(amounts) } : amounts;
    return {
      month: date.slice(0, 7),
      date,
      recordCount: Object.keys(byCurrency).length,
      totalsByCurrency: Object.entries(byCurrency).map(([currency, value]) => ({ currency, ...exact(value), count: 1 })),
    };
  });
  const months = [...new Set(dayTotals.map((day) => day.month))].sort();
  return {
    dayTotals,
    monthTotals: months.map((month) => {
      const rows = dayTotals.filter((day) => day.month === month);
      const currencies = [...new Set(rows.flatMap((row) => row.totalsByCurrency.map((amount) => amount.currency)))].sort();
      return {
        month,
        recordCount: rows.reduce((sum, row) => sum + row.recordCount, 0),
        activeDayCount: rows.length,
        pendingCandidateCount: month in pending ? pending[month] ?? null : 0,
        totalsByCurrency: currencies.map((currency) => {
          const values = rows.flatMap((row) => row.totalsByCurrency.filter((amount) => amount.currency === currency));
          return {
            currency,
            ...sumText(values.map((amount) => text(amount))),
            count: values.length,
          };
        }),
      };
    }),
  };
}

function text(value: { coefficient: string; scale: number }) {
  const negative = value.coefficient.startsWith("-");
  const digits = (negative ? value.coefficient.slice(1) : value.coefficient).padStart(value.scale + 1, "0");
  const split = digits.length - value.scale;
  return `${negative ? "-" : ""}${digits.slice(0, split)}${value.scale > 0 ? `.${digits.slice(split)}` : ""}`;
}

function money(value: Money) {
  return `${value.currency} ${text(value)}`;
}

function twd(summary: SpendingSummary, month: string, today: string): CurrencyMonthReading {
  const reading = readSpendingMonth(summary, { month, today });
  assert.ok(reading);
  const currency = reading.byCurrency.get("TWD" as never);
  assert.ok(currency);
  return currency;
}

test("quiet months inside history count as zero in usual", () => {
  const summary = summaryOf({
    "2026-05-20": 999,
    "2026-06-10": 3000,
    "2026-07-10": 6000,
    "2026-09-10": 4000,
  });
  const reading = twd(summary, "2026-09", "2026-10-15");
  assert.equal(reading.usual.kind, "available");
  if (reading.usual.kind !== "available") return;
  assert.deepEqual(reading.usual.months, ["2026-06", "2026-07", "2026-08"]);
  assert.equal(money(reading.usual.mean), "TWD 3000");
  assert.equal(money(reading.usual.low), "TWD 0");
  assert.equal(money(reading.usual.high), "TWD 6000");
  assert.equal(reading.standing.kind, "within");
});

test("the first month of history is never a baseline month", () => {
  const summary = summaryOf({
    "2026-05-02": 100,
    "2026-06-02": 100,
    "2026-07-02": 100,
    "2026-08-02": 100,
    "2026-09-02": 100,
  });
  const august = twd(summary, "2026-08", "2026-10-01");
  assert.deepEqual(august.usual, { kind: "unavailable", fullMonthsAvailable: 2 });
  const september = twd(summary, "2026-09", "2026-10-01");
  assert.equal(september.usual.kind, "available");
  if (september.usual.kind === "available") assert.deepEqual(september.usual.months, ["2026-06", "2026-07", "2026-08"]);
});

test("fewer than three full months leaves usual, standing and heavy days unavailable", () => {
  const summary = summaryOf({ "2026-07-02": 100, "2026-08-02": 100, "2026-09-02": 100, "2026-09-03": 90000 });
  const reading = twd(summary, "2026-09", "2026-10-01");
  assert.deepEqual(reading.usual, { kind: "unavailable", fullMonthsAvailable: 1 });
  assert.deepEqual(reading.standing, { kind: "no-usual" });
  assert.equal(reading.heavyThreshold, null);
  assert.ok(reading.days.every((day) => day.tone !== "heavy"));
  assert.ok(reading.pace.every((point) => point.usual === null && point.usualLow === null));
});

test("an in-progress month compares against baseline months cut at the same day", () => {
  const summary = summaryOf({
    "2026-06-01": 1,
    "2026-07-02": 100, "2026-07-20": 1000,
    "2026-08-02": 200, "2026-08-20": 1000,
    "2026-09-02": 300, "2026-09-20": 1000,
    "2026-10-03": 450,
  });
  const reading = readSpendingMonth(summary, { month: "2026-10", today: "2026-10-05" });
  assert.deepEqual(reading?.span, { kind: "in-progress", throughDay: 5, daysInMonth: 31 });
  const october = twd(summary, "2026-10", "2026-10-05");
  assert.equal(october.usual.kind, "available");
  if (october.usual.kind !== "available") return;
  assert.equal(money(october.usual.mean), "TWD 200");
  assert.equal(money(october.usual.low), "TWD 100");
  assert.equal(money(october.usual.high), "TWD 300");
  assert.equal(money(october.usual.fullMonthMean), "TWD 1200");
  assert.deepEqual(october.standing, { kind: "above", differenceFromMean: { currency: "TWD", coefficient: "250", scale: 0 } });
  assert.equal(october.pace[4]?.cumulative, 450);
  assert.equal(october.pace[5]?.cumulative, null);
  assert.equal(october.pace[19]?.usual, 1200);
  assert.equal(october.pace[4]?.amount && money(october.pace[4].amount), "TWD 450");
  assert.equal(october.pace[5]?.amount, null);
  assert.equal(october.pace[1]?.usualAmount && money(october.pace[1].usualAmount), "TWD 200");
  assert.deepEqual(october.days.slice(4, 7).map((day) => day.tone), ["quiet", "future", "future"]);
});

test("a 31st-day cut holds shorter baseline months at their last day", () => {
  const summary = summaryOf({
    "2026-01-01": 1,
    "2026-02-28": 300,
    "2026-03-31": 600,
    "2026-04-01": 0,
    "2026-05-31": 50,
  });
  const may = twd(summary, "2026-05", "2026-05-31");
  assert.equal(may.usual.kind, "available");
  if (may.usual.kind !== "available") return;
  assert.equal(money(may.usual.mean), "TWD 300");
  assert.equal(money(may.usual.high), "TWD 600");
  assert.equal(may.pace[30]?.usual, 300);
  assert.equal(may.pace[29]?.usual, 100);
  assert.equal(may.standing.kind, "within");
});

test("a net refund month stands below usual with an exact signed difference", () => {
  const summary = summaryOf({
    "2026-05-01": 1,
    "2026-06-05": 1000,
    "2026-07-05": 2000,
    "2026-08-05": 3000,
    "2026-09-04": 200,
    "2026-09-05": -700,
  });
  const september = twd(summary, "2026-09", "2026-10-01");
  assert.equal(money(september.total), "TWD -500");
  assert.deepEqual(september.standing, { kind: "below", differenceFromMean: { currency: "TWD", coefficient: "-2500", scale: 0 } });
  assert.equal(september.days[4]?.tone, "refund");
  assert.equal(september.days[3]?.tone, "spend");
});

test("each currency reads against its own usual with its own precision", () => {
  const summary = summaryOf({
    "2026-05-01": { TWD: "1", USD: "1.00" },
    "2026-06-01": { TWD: "300", USD: "10.50" },
    "2026-07-01": { TWD: "300" },
    "2026-08-01": { TWD: "300", USD: "20.25" },
    "2026-09-01": { TWD: "900", USD: "5.00" },
  });
  const reading = readSpendingMonth(summary, { month: "2026-09", today: "2026-10-01" });
  assert.deepEqual(reading?.currencies, ["TWD", "USD"]);
  const usd = reading?.byCurrency.get("USD" as never);
  const taiwan = reading?.byCurrency.get("TWD" as never);
  assert.ok(usd && taiwan && usd.usual.kind === "available" && taiwan.usual.kind === "available");
  assert.equal(money(usd.usual.mean), "USD 10.25");
  assert.equal(money(usd.usual.low), "USD 0");
  assert.equal(usd.standing.kind, "within");
  assert.equal(money(taiwan.usual.mean), "TWD 300");
  assert.equal(taiwan.standing.kind, "above");
  assert.equal(money(usd.total), "USD 5");
});

test("heavy days need twice the median positive baseline day and are capped at three", () => {
  const baseline = {
    "2026-05-01": 1,
    "2026-06-03": 100, "2026-06-04": -50,
    "2026-07-03": 100, "2026-07-04": -50,
    "2026-08-03": 200, "2026-08-04": 300,
  };
  const below = twd(summaryOf({ ...baseline, "2026-09-01": 500, "2026-09-02": 400, "2026-09-03": 290 }), "2026-09", "2026-10-01");
  assert.equal(below.heavyThreshold && money(below.heavyThreshold), "TWD 300");
  assert.deepEqual(below.days.slice(0, 3).map((day) => day.tone), ["heavy", "heavy", "spend"]);

  const capped = twd(summaryOf({
    ...baseline,
    "2026-09-01": 300, "2026-09-02": 900, "2026-09-03": 800, "2026-09-04": 700, "2026-09-05": 600,
  }), "2026-09", "2026-10-01");
  assert.deepEqual(capped.days.slice(0, 5).map((day) => day.tone), ["spend", "heavy", "heavy", "heavy", "spend"]);
});

test("the duplicate caveat follows the month's pending pair count", () => {
  const days = { "2026-08-01": 100, "2026-09-01": 100, "2026-10-01": 100 };
  const caveat = (count: number | null) =>
    readSpendingMonth(summaryOf(days, { "2026-09": count }), { month: "2026-09", today: "2026-10-05" })?.caveat;
  assert.deepEqual(caveat(null), { kind: "checking" });
  assert.deepEqual(caveat(0), { kind: "confirmed" });
  assert.deepEqual(caveat(4), { kind: "may-include-duplicates", pendingPairs: 4 });
});

test("an unknown month falls back to the newest month and an empty summary reads nothing", () => {
  const summary = summaryOf({ "2026-08-01": 100, "2026-09-01": 100 });
  assert.equal(readSpendingMonth(summary, { month: "2026-07", today: "2026-10-05" })?.month, "2026-09");
  assert.equal(readSpendingMonth(summary, { month: null, today: "2026-10-05" })?.month, "2026-09");
  assert.equal(readSpendingMonth({ monthTotals: [], dayTotals: [] }, { month: null, today: "2026-10-05" }), null);
});

test("the trend is a fixed window of zero-filled months that keeps the selected month in view", () => {
  const summary = summaryOf({
    "2025-03-01": 10,
    "2026-06-01": 100,
    "2026-07-01": 100,
    "2026-09-01": 100,
    "2026-10-02": 40,
  });
  const trend = readSpendingTrend(summary, { currency: "TWD", selectedMonth: "2026-09", today: "2026-10-05" });
  assert.equal(trend.length, 12);
  assert.equal(trend[0]?.month, "2025-11");
  assert.equal(trend.at(-1)?.month, "2026-10");
  assert.equal(trend.at(-1)?.status, "in-progress");
  const august = trend.find((month) => month.month === "2026-08");
  assert.equal(august?.value, 0);
  assert.equal(august?.selectable, false);
  assert.equal(trend.find((month) => month.month === "2026-09")?.selectable, true);

  const old = readSpendingTrend(summary, { currency: "TWD", selectedMonth: "2025-03", today: "2026-10-05" });
  assert.equal(old[0]?.month, "2025-03");
  assert.equal(old[0]?.status, "first-imported");
  const early = readSpendingTrend(summaryOf({ "2026-09-01": 1 }), { currency: "TWD", selectedMonth: "2026-09", today: "2026-10-05" });
  assert.equal(early[0]?.status, "before-history");
});
