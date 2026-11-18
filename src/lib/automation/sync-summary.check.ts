import assert from "node:assert/strict";
import test from "node:test";
import { lastSyncSummary } from "./sync-summary.ts";

const source = (latestRunStatus: string, latestFinishedAt: string | null, credentialGroupId: string | null = "bank") =>
  ({ latestRunStatus, latestFinishedAt, credentialGroupId: credentialGroupId ?? undefined }) as Parameters<typeof lastSyncSummary>[0][number];

test("the summary counts how the latest sync's source runs ended", () => {
  assert.deepEqual(lastSyncSummary([
    source("completed", "2026-11-18T07:20:01Z"),
    source("partial", "2026-11-18T07:22:32Z"),
    source("completed", "2026-11-18T07:21:00Z"),
  ]), { completed: 2, unfinished: 1, finishedAt: "2026-11-18T07:22:32Z" });
});

test("the exchange-rate task is not a source and never sets the time", () => {
  assert.equal(lastSyncSummary([source("completed", "2026-11-18T06:00:01Z", null)]), null);
  assert.equal(lastSyncSummary([
    source("completed", "2026-11-18T07:20:01Z"),
    source("completed", "2026-11-18T09:00:00Z", null),
  ])?.finishedAt, "2026-11-18T07:20:01Z");
});

test("a failure from an earlier sync is not reported as part of the latest one", () => {
  assert.deepEqual(lastSyncSummary([
    source("completed", "2026-11-18T07:20:01Z"),
    source("failed", "2026-10-28T07:00:00Z"),
  ]), { completed: 1, unfinished: 0, finishedAt: "2026-11-18T07:20:01Z" });
});

test("a row that now needs setup still reports how its latest run ended", () => {
  assert.equal(lastSyncSummary([source("completed", "2026-11-18T07:20:01Z")])?.completed, 1);
  assert.equal(lastSyncSummary([source("queued", null)]), null);
});
