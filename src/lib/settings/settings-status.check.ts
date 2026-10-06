import assert from "node:assert/strict";
import test from "node:test";

import type { AutomationTaskStatus } from "../automation/types.ts";

import {
  latestExchangeRateRun,
  linkedSourceCount,
  nextDailyRun,
  utcOffsetLabel,
} from "./settings-status.ts";

test("a source counts as linked once it is enabled and every credential is stored", () => {
  const groups = [
    { enabled: true, credentialKeys: ["fubon.user", "fubon.password"] },
    { enabled: true, credentialKeys: ["esun.user"] },
    { enabled: false, credentialKeys: ["post.user"] },
  ];
  assert.equal(linkedSourceCount(groups, { "fubon.user": true, "fubon.password": true, "esun.user": false, "post.user": true }), 1);
  assert.equal(linkedSourceCount([], {}), 0);
});

test("the exchange-rate run reports its last finish and whether it succeeded", () => {
  const run = (status: AutomationTaskStatus, latestFinishedAt: string | null) => ({ id: "exchange-rates", status, latestFinishedAt });
  assert.deepEqual(latestExchangeRateRun([run("completed", "2026-10-04T15:59:00.000Z")]), { finishedAt: "2026-10-04T15:59:00.000Z", succeeded: true });
  assert.deepEqual(latestExchangeRateRun([run("failed", "2026-10-04T15:59:00.000Z")]), { finishedAt: "2026-10-04T15:59:00.000Z", succeeded: false });
  assert.equal(latestExchangeRateRun([run("queued", null)]), null, "never finished");
  assert.equal(latestExchangeRateRun([{ id: "bank", status: "completed", latestFinishedAt: "2026-10-04T15:59:00.000Z" }]), null);
});

test("the next daily run is today's slot until it passes, then tomorrow's", () => {
  const before = new Date("2026-10-05T10:00:00.000Z"); // 18:00 in Taipei
  assert.equal(nextDailyRun("23:59", "Asia/Taipei", before), "2026-10-05T15:59:00.000Z");
  const after = new Date("2026-10-05T16:30:00.000Z"); // 00:30 on 10/6 in Taipei
  assert.equal(nextDailyRun("23:59", "Asia/Taipei", after), "2026-10-06T15:59:00.000Z");
  assert.equal(nextDailyRun("06:00", "UTC", new Date("2026-10-05T06:00:00.000Z")), "2026-10-06T06:00:00.000Z", "a slot at this instant has already run");
});

test("a timezone reads as its UTC offset on the given date", () => {
  assert.equal(utcOffsetLabel("Asia/Taipei", new Date("2026-10-05T00:00:00.000Z")), "UTC+08:00");
  assert.equal(utcOffsetLabel("America/New_York", new Date("2026-01-05T00:00:00.000Z")), "UTC-05:00");
  assert.equal(utcOffsetLabel("UTC", new Date("2026-01-05T00:00:00.000Z")), "UTC+00:00");
});
