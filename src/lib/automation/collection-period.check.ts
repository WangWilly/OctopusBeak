import assert from "node:assert/strict";
import test from "node:test";
import {
  collectionPeriod,
  collectionWindows,
  periodSpans,
  taipeiToday,
  type CollectionPeriodDeclaration,
  type CollectionSpan,
} from "./collection-period.ts";
import { VERIFIED_SOURCES } from "./server/sources/index.ts";

test("today is the Asia/Taipei calendar date of the run's instant", () => {
  assert.equal(taipeiToday("2026-03-01T16:30:00.000Z"), "2026-03-02", "00:30 in Taipei is 16:30Z the day before");
  assert.equal(taipeiToday("2026-03-01T15:59:59.999Z"), "2026-03-01");
  assert.equal(taipeiToday("2025-12-31T16:00:00.000Z"), "2026-01-01", "a year boundary follows Taipei, not UTC");
  assert.equal(taipeiToday("2028-02-28T16:00:00.000Z"), "2028-02-29");
  assert.equal(taipeiToday("2026-03-02T00:30:00+08:00"), "2026-03-02");
  assert.throws(() => taipeiToday("not an instant"), RangeError);
});

const start = (today: string, lookBack: CollectionSpan) => collectionPeriod({ today, lookBack }).start;

test("a span moves back whole months clamped to the month end, then days, and counts both ends", () => {
  assert.equal(start("2026-07-05", { months: 12 }), "2025-07-06", "twelve months inclusive");
  assert.equal(start("2026-03-31", { months: 1, days: 1 }), "2026-02-28", "one month and one day from a month end");
  assert.equal(start("2024-03-31", { months: 1, days: 1 }), "2024-02-29", "a leap February keeps its 29th");
  assert.equal(start("2026-05-31", { months: 3, days: 1 }), "2026-02-28");
  assert.equal(start("2026-01-31", { months: 1, days: 1 }), "2025-12-31", "across a year boundary");
  assert.equal(start("2026-01-15", { months: 12 }), "2025-01-16");
  assert.equal(start("2028-02-29", { years: 1, days: 1 }), "2027-02-28", "a year back from Feb 29 clamps to Feb 28");
  assert.equal(start("2026-03-31", { years: 1, days: 1 }), "2025-03-31");
  assert.equal(start("2028-02-29", { years: 2, days: 1 }), "2026-02-28");
  assert.equal(start("2026-02-28", { years: 2, days: 1 }), "2024-02-28", "a non-leap end never lands on Feb 29");
  assert.equal(start("2024-02-29", { months: 12, days: 1 }), "2023-02-28");
  assert.equal(start("2026-03-01", { days: 365 }), "2025-03-02", "364 days back");
  assert.equal(start("2024-03-01", { days: 365 }), "2023-03-03", "364 days back across Feb 29");
  assert.equal(start("2026-01-15", { days: 91 }), "2025-10-17", "90 days back");
  assert.equal(start("2026-07-05", { days: 1 }), "2026-07-05", "one day is today only");
});

test("a declaration with no widest request queries its whole period at once", () => {
  assert.deepEqual(collectionPeriod({ today: "2026-02-28", lookBack: { years: 2, days: 1 } }), {
    start: "2024-02-28",
    end: "2026-02-28",
    windows: [{ start: "2024-02-28", end: "2026-02-28" }],
  });
});

test("windows are no wider than the widest request, disjoint, and newest first", () => {
  assert.deepEqual(
    collectionPeriod({ today: "2026-07-05", lookBack: { months: 12 }, maxWindow: { months: 12 } }).windows,
    [{ start: "2025-07-06", end: "2026-07-05" }],
  );
  assert.deepEqual(
    collectionPeriod({ today: "2026-07-05", lookBack: { months: 12 }, maxWindow: { months: 1, days: 1 } }).windows,
    [
      { start: "2026-06-05", end: "2026-07-05" },
      { start: "2026-05-04", end: "2026-06-04" },
      { start: "2026-04-03", end: "2026-05-03" },
      { start: "2026-03-02", end: "2026-04-02" },
      { start: "2026-02-01", end: "2026-03-01" },
      { start: "2025-12-31", end: "2026-01-31" },
      { start: "2025-11-30", end: "2025-12-30" },
      { start: "2025-10-29", end: "2025-11-29" },
      { start: "2025-09-28", end: "2025-10-28" },
      { start: "2025-08-27", end: "2025-09-27" },
      { start: "2025-07-26", end: "2025-08-26" },
      { start: "2025-07-06", end: "2025-07-25" },
    ],
  );
  assert.deepEqual(
    collectionWindows({ start: "2024-01-01", end: "2024-03-31", maxWindow: { months: 1, days: 1 } }),
    [
      { start: "2024-02-29", end: "2024-03-31" },
      { start: "2024-01-28", end: "2024-02-28" },
      { start: "2024-01-01", end: "2024-01-27" },
    ],
    "each window's width is measured back from its own end",
  );
  assert.deepEqual(
    collectionPeriod({ today: "2026-08-31", lookBack: { months: 12, days: 1 }, maxWindow: { months: 6, days: 1 } }).windows,
    [
      { start: "2026-02-28", end: "2026-08-31" },
      { start: "2025-08-31", end: "2026-02-27" },
    ],
  );
  assert.deepEqual(
    collectionWindows({ start: "2026-07-01", end: "2026-07-31", maxWindow: { months: 3 } }),
    [{ start: "2026-07-01", end: "2026-07-31" }],
    "a window never reaches before the period",
  );
});

test("a period spans a provider's quick range only when its start matches exactly", () => {
  const period = collectionPeriod({ today: "2026-05-31", lookBack: { months: 3, days: 1 } });
  assert.equal(periodSpans(period, { months: 3, days: 1 }), true);
  assert.equal(periodSpans(period, { months: 3 }), false);
  assert.equal(periodSpans(period, { months: 6, days: 1 }), false);
});

test("an invalid date or span is refused", () => {
  assert.throws(() => collectionPeriod({ today: "2026-02-29", lookBack: { months: 1 } }), RangeError);
  assert.throws(() => collectionPeriod({ today: "20260228", lookBack: { months: 1 } }), RangeError);
  assert.throws(() => collectionPeriod({ today: "2026-02-28", lookBack: {} }), RangeError);
  assert.throws(() => collectionPeriod({ today: "2026-02-28", lookBack: { months: -1 } }), RangeError);
  assert.throws(() => collectionPeriod({ today: "2026-02-28", lookBack: { months: 1 }, maxWindow: { days: 0 } }), RangeError);
  assert.throws(() => collectionWindows({ start: "2026-03-01", end: "2026-02-28" }), RangeError);
});

/** Every day across two leap years and the years around them. */
function* everyDay(): Generator<string> {
  for (let day = Date.UTC(2023, 0, 1); day <= Date.UTC(2029, 0, 1); day += 86_400_000) {
    yield new Date(day).toISOString().slice(0, 10);
  }
}

const dayBefore = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

function assertCovers(declaration: CollectionPeriodDeclaration, today: string): void {
  const period = collectionPeriod({ today, ...declaration });
  assert.ok(period.windows.length > 0);
  assert.equal(period.windows[0]!.end, today);
  assert.equal(period.windows.at(-1)!.start, period.start);
  for (const [index, window] of period.windows.entries()) {
    assert.ok(window.start <= window.end, `${today}: a window starts on or before its end`);
    const next = period.windows[index + 1];
    if (next) {
      assert.equal(next.end, dayBefore(window.start), `${today}: windows are contiguous and disjoint`);
      if (declaration.maxWindow) assert.ok(periodSpans(window, declaration.maxWindow), `${today}: only the oldest window is narrower`);
    }
  }
}

test("every declared product period covers its whole look-back with contiguous windows on every day", () => {
  const declarations = VERIFIED_SOURCES.flatMap((source) =>
    (source.statementSelection?.products ?? []).flatMap(({ id, collectionPeriod: declaration }) =>
      declaration ? [{ product: `${source.id}/${id}`, declaration }] : []));
  for (const { declaration } of declarations) {
    for (const today of everyDay()) assertCovers(declaration, today);
  }
});
