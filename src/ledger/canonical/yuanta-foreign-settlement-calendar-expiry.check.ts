import assert from "node:assert/strict";
import test from "node:test";
import { YUANTA_FOREIGN_SETTLEMENT_CALENDAR_COVERAGE } from "./yuanta-foreign-settlement-calendar.ts";

/**
 * Past the coverage end every Yuanta overseas settlement fails resolution, so
 * CI fails first, with enough lead time to fetch the next DGPA calendar.
 */
const MINIMUM_LEAD_DAYS = 120;

function calendarExpiryProblem(coverageEnd: string, today: string): string | null {
  const days = (Date.parse(`${coverageEnd}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  if (days >= MINIMUM_LEAD_DAYS) return null;
  const nextYear = Number(coverageEnd.slice(0, 4)) + 1;
  return [
    `The Yuanta settlement calendar ends ${coverageEnd}, ${days} days after ${today} (minimum ${MINIMUM_LEAD_DAYS}).`,
    `Add ${nextYear}: npm run generate:yuanta-settlement-calendar -- ${nextYear} <path or URL of the ${nextYear - 1911}年辦公日曆表 .xlsx>`,
    "DGPA publishes it at https://www.dgpa.gov.tw/ (民眾 > 辦公日曆表), usually in May or June.",
    "Steps: docs/runbooks/yuanta-settlement-calendar.md",
  ].join("\n");
}

test("the alarm stays quiet with at least 120 days of coverage left", () => {
  assert.equal(calendarExpiryProblem("2027-12-31", "2027-09-02"), null);
  assert.equal(calendarExpiryProblem("2027-12-31", "2026-11-09"), null);
});

test("the alarm names the command and the source once fewer than 120 days remain", () => {
  const problem = calendarExpiryProblem("2027-12-31", "2027-09-03");
  assert.ok(problem);
  assert.match(problem, /119 days after 2027-09-03/u);
  assert.match(problem, /npm run generate:yuanta-settlement-calendar -- 2028 /u);
  assert.match(problem, /117年辦公日曆表/u);
  assert.match(problem, /dgpa\.gov\.tw/u);
  assert.match(problem, /May or June/u);
  assert.match(calendarExpiryProblem("2027-12-31", "2028-02-01") ?? "", /-32 days/u);
});

test("the Yuanta settlement calendar covers at least 120 more days", () => {
  const today = new Date().toISOString().slice(0, 10);
  const problem = calendarExpiryProblem(YUANTA_FOREIGN_SETTLEMENT_CALENDAR_COVERAGE.end, today);
  assert.equal(problem, null, problem ?? "");
});
