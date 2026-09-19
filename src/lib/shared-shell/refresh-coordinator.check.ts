import assert from "node:assert/strict";
import test from "node:test";
import { createRefreshCoordinator } from "./refresh-coordinator.ts";

test("refreshes the current page first, fans out the rest, and shares one snapshot", async () => {
  const events: string[] = [];
  const snapshots: unknown[] = [];
  let releaseCurrent!: () => void;
  const currentReleased = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  let snapshotReads = 0;
  let acknowledgements = 0;
  const coordinator = createRefreshCoordinator({
    readSnapshot: async () => {
      snapshotReads += 1;
      return { version: 7, stale: true, changedAt: "2026-09-19T00:00:00.000Z" };
    },
    acknowledgeSnapshot: async (version) => {
      assert.equal(version, 7);
      acknowledgements += 1;
      return true;
    },
    loaders: {
      overview: async (snapshot) => {
        events.push("overview:start");
        snapshots.push(snapshot);
        await currentReleased;
        events.push("overview:end");
        return "overview-data";
      },
      assets: async (snapshot) => {
        events.push("assets:start");
        snapshots.push(snapshot);
        return "assets-data";
      },
      spending: async (snapshot) => {
        events.push("spending:start");
        snapshots.push(snapshot);
        throw new Error("spending unavailable");
      },
    },
  });

  const first = coordinator.refresh("overview");
  const duplicate = coordinator.refresh("overview");
  assert.strictEqual(duplicate, first, "in-flight refreshes are deduplicated");
  await Promise.resolve();
  assert.deepEqual(events, ["overview:start"]);

  releaseCurrent();
  const result = await first;
  assert.deepEqual(events, [
    "overview:start",
    "overview:end",
    "assets:start",
    "spending:start",
  ]);
  assert.equal(snapshotReads, 1);
  assert.equal(new Set(snapshots).size, 1, "all loaders receive the same snapshot");
  assert.deepEqual(result.successful, ["overview", "assets"]);
  assert.deepEqual(result.failed, ["spending"]);
  assert.equal(result.status, "partial");
  assert.equal(acknowledgements, 0, "partial refreshes stay stale");
});

test("a successful refresh acknowledges its snapshot and can run again afterwards", async () => {
  let calls = 0;
  let snapshotReads = 0;
  let acknowledgements = 0;
  const coordinator = createRefreshCoordinator({
    readSnapshot: async () => {
      snapshotReads += 1;
      return { version: snapshotReads, stale: true, changedAt: null };
    },
    acknowledgeSnapshot: async () => {
      acknowledgements += 1;
      return true;
    },
    loaders: {
      overview: async () => {
        calls += 1;
        return calls;
      },
    },
  });

  assert.equal((await coordinator.refresh("overview")).status, "complete");
  assert.equal((await coordinator.refresh("overview")).status, "complete");
  assert.equal(calls, 2);
  assert.equal(snapshotReads, 2);
  assert.equal(acknowledgements, 2);
});
