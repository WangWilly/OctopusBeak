import assert from "node:assert/strict";
import test from "node:test";
import { lastSyncSummary } from "./sync-summary.ts";

test("the summary counts how the last runs ended and keeps the newest finish", () => {
  assert.deepEqual(lastSyncSummary([
    { status: "completed", latestFinishedAt: "2026-11-18T07:20:01Z" },
    { status: "partial", latestFinishedAt: "2026-11-18T07:22:32Z" },
    { status: "failed", latestFinishedAt: "2026-11-17T23:00:00Z" },
    { status: "needs_setup", latestFinishedAt: "2026-11-18T08:00:00Z" },
    { status: "queued", latestFinishedAt: null },
  ]), { completed: 1, unfinished: 2, finishedAt: "2026-11-18T07:22:32Z" });
});

test("nothing finished yet has no summary", () => {
  assert.equal(lastSyncSummary([{ status: "queued", latestFinishedAt: null }]), null);
});
