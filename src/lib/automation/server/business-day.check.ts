import assert from "node:assert/strict";
import { businessDayUtcRange } from "./business-day.ts";

const range = businessDayUtcRange(new Date("2026-03-08T16:00:00.000Z"), "America/New_York");
assert.equal(range.businessDate, "2026-03-08");
assert.equal(range.startUtc.toISOString(), "2026-03-08T05:00:00.000Z");
assert.equal(range.endUtc.toISOString(), "2026-03-09T04:00:00.000Z");
